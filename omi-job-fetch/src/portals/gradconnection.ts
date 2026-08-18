import type { Adapter, AdapterResult } from "../types.js";

/**
 * GradConnection adapter — the three non-obvious behaviors, for reference:
 *
 * 1. Location. `config.country` selects the site SUBDOMAIN (hk / sg / au); the site
 *    is partitioned per subdomain, so the search only ever sees that country's jobs.
 *    The `--location` input is a filter ON TOP of the subdomain. GradConnection only
 *    accepts structured values `{slug},{code},Country` (or `remote,{code},Remote`);
 *    free text and city/region values are silently ignored, so resolve them against
 *    /api/locations/ first — a city/region expands to its parent country.
 *
 * 2. Quick-apply. Campaigns with no external target URL and no target email are
 *    quick-apply listings: the job listing page IS the application link, so apply_url
 *    falls back to the GC job page (`/employers/<company>/jobs/<slug>/`). An
 *    empty-string origin_target_url counts as absent.
 *
 * 3. Full JD. The search response's `description` is a one-line snippet; the real JD
 *    lives in /api/campaigns/<id>/content.body (HTML, same as the job page). Enrich
 *    each job after the search (concurrency-capped), fall back to the snippet on
 *    fetch failure, and report coverage via meta.jdFetched / meta.jdFailed.
 */
const JOB_TYPE_SLUGS: Record<string, string> = {
  internship: "internships",
  intern: "internships",
  internships: "internships",
  graduate: "graduate-jobs",
  "graduate job": "graduate-jobs",
  "graduate jobs": "graduate-jobs",
  "entry-level": "entry-level-jobs",
  "entry level": "entry-level-jobs",
  "part-time": "part-time-student-jobs",
  "part time": "part-time-student-jobs",
};

const SEARCH_LIMIT = 20;
/** Concurrent campaign-detail fetches when enriching descriptions with the full JD. */
const DETAIL_CONCURRENCY = 4;

interface GcCampaign {
  id?: string;
  slug?: string;
  title?: string;
  description?: string | null;
  interval?: { start?: string | null; end?: string | null } | null;
  is_event?: boolean;
  item_type?: string;
  origin_target_url?: string | null;
  target_email?: string | null;
  locations?: string[];
  job_type?: string | { name?: string } | null;
}

interface GcGroup {
  campaigns?: GcCampaign[];
  customer_organization?: { name?: string; slug?: string };
}

interface GcLocation {
  slug?: string;
  name?: string;
  country?: { code?: string } | null;
  parent?: { slug?: string; country?: { code?: string } | null } | null;
  count?: number;
}

/**
 * GradConnection's campaignsearch `location=` param only accepts country-level
 * values of the form `{slug},{code},Country` (or the virtual `remote,{code},Remote`).
 * Free text and city/region values are silently ignored by the API.
 * Resolve free text against /api/locations/ so the filter actually applies.
 */
async function resolveLocationParam(
  country: string,
  freeText: string,
): Promise<{ param: string | null; note: string | null }> {
  const code = country.toUpperCase();

  // "Remote" is a virtual location accepted by search but absent from /api/locations/.
  if (/remote|work from home/i.test(freeText.trim())) {
    return { param: `remote,${code},Remote`, note: null };
  }

  let nodes: GcLocation[] = [];
  try {
    const res = await fetch(`https://${country}.gradconnection.com/api/locations/`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    nodes = (await res.json()) as GcLocation[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { param: null, note: `location resolution failed (${detail}); location filter skipped` };
  }

  // Names are "{Place} ({Country})"; match on the base name, case-insensitively.
  const target = freeText.trim().toLowerCase();
  const base = (name: string | undefined) => ((name ?? "").split(" (")[0]).toLowerCase();
  const exact = nodes.find((n) => base(n.name) === target);
  const prefix = target.length >= 3 ? nodes.find((n) => base(n.name).startsWith(target)) : undefined;
  const node = exact ?? prefix;
  if (!node) {
    return { param: null, note: `location "${freeText}" not found in GradConnection; location filter skipped` };
  }

  // Country-level nodes filter by country; city/region nodes expand to their parent country.
  const anchor = node.parent ?? node;
  const anchorCode = anchor.country?.code ?? code;
  if (node.parent) {
    return {
      param: `${anchor.slug},${anchorCode},Country`,
      note: `"${freeText}" is city/region-level; GradConnection search only supports country-level, scoped to ${anchor.slug}`,
    };
  }
  return { param: `${node.slug},${anchorCode},Country`, note: null };
}

interface CampaignDetail {
  content?: { body?: string | null } | null;
}

/**
 * Fetch the full JD body (HTML) for a campaign. The search response only carries
 * a one-line snippet; the real JD lives in /api/campaigns/<id>/content.body
 * (the same content the job page renders). Returns errored=true on HTTP/network
 * failure so the caller can fall back to the snippet.
 */
async function fetchCampaignDetail(
  base: string,
  id: string,
): Promise<{ body: string | null; errored: boolean }> {
  try {
    const res = await fetch(`${base}/api/campaigns/${id}/`, { headers: { accept: "application/json" } });
    if (!res.ok) return { body: null, errored: true };
    const detail = (await res.json()) as CampaignDetail;
    const body = detail.content?.body?.trim() ?? "";
    return { body: body || null, errored: false };
  } catch {
    return { body: null, errored: true };
  }
}

/** Run fn over items with at most `limit` in flight; fn mutates items in place. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function toJobTypeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return JOB_TYPE_SLUGS[value.trim().toLowerCase()] ?? null;
}

function normalizeJobType(value: GcCampaign["job_type"]): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return value.name ?? null;
  return null;
}

export const gradConnectionAdapter: Adapter = {
  manifest: {
    id: "gradconnection",
    family: "portal",
    name: "GradConnection",
    requiredInputs: ["query"],
    optionalInputs: ["location", "employment_type", "page"],
    providedOutputs: [
      "apply_url",
      "job_page_url",
      "external_id",
      "title",
      "company",
      "location",
      "description",
      "posted_at",
      "expires_at",
      "is_open",
      "employment_type",
    ],
    extraInputs: {
      country: { desc: "GradConnection country subdomain (hk, sg, au). Default: hk." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const country = String(ctx.config.country ?? "hk");
    const base = `https://${country}.gradconnection.com`;
    const page = Number(ctx.input.page ?? 1);
    const offset = (page - 1) * SEARCH_LIMIT;

    const params = new URLSearchParams();
    if (typeof ctx.input.query === "string" && ctx.input.query.trim()) params.set("query", ctx.input.query.trim());

    const notes: string[] = [];
    if (typeof ctx.input.location === "string" && ctx.input.location.trim()) {
      const resolved = await resolveLocationParam(country, ctx.input.location);
      if (resolved.param) params.set("location", resolved.param);
      if (resolved.note) notes.push(resolved.note);
    }

    const jobTypeSlug = toJobTypeSlug(ctx.input.employment_type);
    if (jobTypeSlug) params.set("job_type", jobTypeSlug);
    params.set("limit", String(SEARCH_LIMIT));
    params.set("offset", String(offset));

    const url = `${base}/api/campaignsearch/?${params.toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GradConnection search failed: HTTP ${res.status} (${url})`);
    const groups = (await res.json()) as GcGroup[];

    const jobs = [];
    for (const group of groups) {
      const employer = group.customer_organization?.name ?? null;
      const employerSlug = group.customer_organization?.slug ?? "";
      for (const campaign of group.campaigns ?? []) {
        // Non-job entries mixed into results: "notify me" placeholders and events.
        if (campaign.item_type !== "keyword_searched_campaign") continue;
        if (campaign.is_event) continue;
        const origin =
          typeof campaign.origin_target_url === "string" && campaign.origin_target_url.trim()
            ? campaign.origin_target_url.trim()
            : null;
        const slug = campaign.slug ?? "";
        const jobPageUrl = slug && employerSlug ? `${base}/employers/${employerSlug}/jobs/${slug}/` : null;
        // No external target or email: the GC job listing itself is the application
        // (quick-apply campaigns), so apply_url falls back to the job page URL.
        const applyUrl =
          origin ?? (campaign.target_email ? `mailto:${campaign.target_email}` : null) ?? jobPageUrl;
        const end = campaign.interval?.end ?? null;
        jobs.push({
          title: campaign.title ?? null,
          company: employer,
          location: (campaign.locations ?? []).join(", ") || null,
          description: campaign.description ?? null,
          apply_url: applyUrl,
          job_page_url: jobPageUrl,
          external_id: campaign.id ?? null,
          posted_at: campaign.interval?.start ?? null,
          expires_at: end,
          is_open: end === null ? true : Date.parse(end) > Date.now(),
          employment_type: normalizeJobType(campaign.job_type),
        });
      }
    }

    // Enrich each job's description with the full JD from /api/campaigns/<id>/.
    let jdFetched = 0;
    let jdFailed = 0;
    if (jobs.length > 0) {
      await mapLimit(jobs, DETAIL_CONCURRENCY, async (job) => {
        const id = job.external_id;
        if (typeof id !== "string" || !id) return;
        const detail = await fetchCampaignDetail(base, id);
        if (detail.body) {
          job.description = detail.body;
          jdFetched++;
        } else if (detail.errored) {
          jdFailed++;
        }
      });
    }
    if (jdFailed > 0) notes.push(`${jdFailed} campaign detail fetch(es) failed; search snippet retained for those`);

    return {
      jobs,
      meta: {
        country,
        searchUrl: url,
        limit: SEARCH_LIMIT,
        offset,
        jdFetched,
        jdFailed,
        note: [
          "description is the full JD (HTML) from /api/campaigns/<id>/content.body, falling back to the search snippet when the detail fetch fails; posted_at = interval.start (programme open date, not posting date); no posted-within filter (GC has no reliable posted date); apply_url falls back to the GC job page when a campaign has no external target or email (quick-apply listings).",
          ...notes,
        ].join(" "),
      },
    };
  },
};
