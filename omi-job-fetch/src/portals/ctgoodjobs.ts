import type { Adapter, AdapterResult, Job } from "../types.js";

/**
 * CTgoodjobs adapter — the non-obvious behaviors, for reference:
 *
 * 1. Session bootstrap. The search API (api01) requires a `visitor-id` header. It's
 *    obtained from a public, login-free endpoint on www: /vid/vid-jobs.asp returns a
 *    one-line CSV whose first field is the visitor id. One request, no cookies, no
 *    login; fetch it fresh every run (cheap) rather than trusting a cached value.
 *
 * 2. Sweep-all pagination + mandatory jobId dedup. The search POST returns
 *    data.meta.jobsTotal (total count) and data.jobs (pageSize 33 by default), so
 *    the sweep is deterministic: pageCount = ceil(jobsTotal/33), walk every page.
 *    Pinned/boosted jobs are PREPENDED to every page AND can appear twice within a
 *    single page (verified: pageSize 33 → 37 items returned, 36 unique). Dedup by
 *    jobId across the whole sweep is therefore mandatory, or pinned jobs are
 *    collected as noise on every page. `page` is ignored (noted in meta).
 *
 * 3. Location. The list's `locations` array is null on roughly two-thirds of jobs
 *    (verified: 6 of 9 in a "finance" pool) — but `location` is a required contract
 *    output, so those jobs would be dropped wholesale. The detail page's JSON-LD
 *    JobPosting always carries jobLocation[].address.addressLocality, so the detail
 *    enrichment backfills location for jobs the list omits it for (the specific
 *    list value is kept when present). Jobs whose detail fetch fails keep location
 *    null and are dropped by the runtime, which is honest.
 *
 * 4. Full JD. The list has no description (jobIdJobInfo is null). The full JD lives
 *    in the detail page's JSON-LD JobPosting.description (HTML, ~3K chars) on
 *    jobs.ctgoodjobs.hk — extracted via the url field, converted to plain text.
 *    Enrich after the sweep (concurrency-capped); there is no list fallback, so a
 *    failed detail fetch leaves description null (counted in meta.jdFailed).
 *
 * 5. Filters. All body-driven: employment_type → employmentTypeIds (001 Full-time …
 *    007 Internship), seniority → gradeIds (001/002/004/006), posted_within_days →
 *    startPostDate (days as string), sort → body sort (1 relevance, 2 = the site's
 *    keyword-search default; deterministic per value). location is IGNORED: the
 *    /search/criteria endpoint that maps free text → locationIds is behind an AWS WAF
 *    CAPTCHA, and the API only exposes Hong Kong jobs anyway. An HK-aligned location
 *    ("Hong Kong", "HK") is accepted silently; anything else raises a warning; the
 *    search stays whole-HK (locationIds []) either way. The enums are hardcoded (they
 *    are small and stable); nothing needs a criteria fetch.
 *
 * 6. Timestamps. publishTime/validThrough carry structured `timestamp` fields that
 *    are naive HK local time (no offset). They're normalized to +08:00 so is_open
 *    and any downstream sorting compare correctly.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const VID_URL = "https://www.ctgoodjobs.hk/vid/vid-jobs.asp?visitor_id=&sid=&logincookie=";
const SEARCH_URL = "https://api01.ctgoodjobs.hk/job/api/jobs/search";
const APPLY_PREFIX = "https://www.ctgoodjobs.hk/ctjob/apply/jobApply.asp?m_jobid=";
const PAGE_SIZE = 33;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [4000, 8000, 16000];
const DEFAULT_DELAY_MS = 1000; // pacing between sweep requests
// 200 pages × 33 = 6,600-job ceiling. Higher than the other adapters' 100-page cap
// because at 33/page a 100-page cap would truncate "finance"-scale pools (4,435 jobs).
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const DEFAULT_DETAIL_DELAY_MS = 0;

/** employment_type contract value → CTgoodjobs employmentTypeIds (001 Full-time … 007 Internship). */
const EMPTYPE_IDS: Record<string, string> = {
  "full-time": "001",
  "full time": "001",
  fulltime: "001",
  "part-time": "002",
  "part time": "002",
  parttime: "002",
  temporary: "003",
  temp: "003",
  contract: "004",
  freelance: "005",
  permanent: "006",
  internship: "007",
  intern: "007",
};

/** seniority contract value → CTgoodjobs gradeIds (career levels). */
const GRADE_IDS: Record<string, string> = {
  entry: "006",
  "entry level": "006",
  "entry-level": "006",
  intern: "006",
  junior: "004",
  "non management": "004",
  "non-management": "004",
  middle: "002",
  mid: "002",
  "middle management": "002",
  "middle-management": "002",
  senior: "001",
};

/** sort contract value → body sort (1 relevance, 2 = the site's keyword-search default). */
const SORT_VALUES: Record<string, number> = {
  relevance: 1,
  "best match": 1,
  date: 2,
  newest: 2,
  listed: 2,
  "listed date": 2,
};

/** Locations that already describe CTgoodjobs' whole-HK scope — accepted silently, no warning. */
const HK_SCOPED_LOCATIONS = new Set(["hk", "hongkong", "hkg"]);

/** True when a location string already means Hong Kong (case/whitespace-insensitive). */
function isHkScopedLocation(value: string): boolean {
  return HK_SCOPED_LOCATIONS.has(value.trim().toLowerCase().replace(/\s+/g, ""));
}

/** One card from a search response. */
export interface CtSearchCard {
  id: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  empType: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intInRange(value: unknown, fallback: number, min: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? n : fallback;
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

/** Convert a JD block to plain text, preserving paragraph/list structure. */
export function toText(html: string): string {
  return html
    .replace(/<\/(p|li|ul|ol|h1|h2|h3|h4|h5|h6|div|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * List timestamps are naive HK local time (no offset), e.g. "2026-08-12T10:50:00".
 * Normalize to +08:00 so is_open and downstream sorting compare correctly; leave
 * timestamps that already carry an offset alone.
 */
export function withTz(ts: unknown): string | null {
  if (typeof ts !== "string" || !ts.trim()) return null;
  const value = ts.trim();
  if (/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return value;
  return `${value}+08:00`;
}

/** Strip the <strong> highlight tags CTgoodjobs wraps keyword matches in. */
function stripStrong(title: unknown): string | null {
  if (typeof title !== "string") return null;
  return title.replace(/<\/?strong>/gi, "").trim() || null;
}

function nameOf(value: unknown): string | null {
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

/**
 * Parse a search response: `{ data: { meta: { jobsTotal }, jobs: [...] } }`. jobsTotal
 * drives the sweep; each job carries jobId/jobTitle/url/companyName/publishTime/
 * validThrough/empTypes/locations/jobLocations. locations can be null on many jobs —
 * the detail enrichment backfills those (see the header note).
 */
export function parseSearch(json: unknown): { totalCount: number | null; cards: CtSearchCard[] } {
  const obj = json as {
    data?: { meta?: { jobsTotal?: unknown }; jobs?: unknown[] };
  };
  const meta = obj?.data?.meta;
  const totalCount = typeof meta?.jobsTotal === "number" ? meta.jobsTotal : null;
  const cards: CtSearchCard[] = [];
  for (const item of obj?.data?.jobs ?? []) {
    const j = item as Record<string, unknown>;
    const id = typeof j.jobId === "string" ? j.jobId : String(j.jobId ?? "");
    const locations = Array.isArray(j.locations)
      ? (j.locations as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    const jobLocations = Array.isArray(j.jobLocations) ? (j.jobLocations as unknown[]) : [];
    const firstLoc = (v: unknown): string | null => {
      if (typeof v === "string" && v.trim()) return v.trim();
      return null;
    };
    const jobLocFirst =
      jobLocations.length > 0 && typeof jobLocations[0] === "object" && jobLocations[0] !== null
        ? (jobLocations[0] as { nameLang?: { eng?: unknown } }).nameLang?.eng
        : undefined;
    const empTypes = Array.isArray(j.empTypes) ? (j.empTypes as unknown[]) : [];
    cards.push({
      id: id || null,
      title: stripStrong(j.jobTitle),
      company: stripStrong(j.companyName),
      location: firstLoc(locations[0]) ?? firstLoc(jobLocFirst),
      url: typeof j.url === "string" && j.url.trim() ? j.url.trim() : null,
      postedAt: withTz(j.publishTime && typeof j.publishTime === "object" ? (j.publishTime as { timestamp?: unknown }).timestamp : null),
      expiresAt: withTz(j.validThrough && typeof j.validThrough === "object" ? (j.validThrough as { timestamp?: unknown }).timestamp : null),
      empType: empTypes.length > 0 ? nameOf(empTypes[0]) : null,
    });
  }
  return { totalCount, cards };
}

/**
 * Parse a job detail page: the full JD lives in the JSON-LD JobPosting block.
 * Returns the description as plain text and the jobLocation locality (used to
 * backfill jobs whose list `locations` was null).
 */
export function parseDetail(html: string): { description: string | null; location: string | null } {
  const m = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return { description: null, location: null };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[1].trim()) as Record<string, unknown>;
  } catch {
    return { description: null, location: null };
  }
  if (obj["@type"] !== "JobPosting") return { description: null, location: null };
  const description = typeof obj.description === "string" ? toText(obj.description) || null : null;
  const jobLocation = Array.isArray(obj.jobLocation) ? (obj.jobLocation as unknown[]) : [];
  let locality: unknown = undefined;
  if (jobLocation[0] && typeof jobLocation[0] === "object") {
    locality = (jobLocation[0] as { address?: { addressLocality?: unknown } }).address?.addressLocality;
  }
  return {
    description,
    location: typeof locality === "string" && locality.trim() ? locality.trim() : null,
  };
}


/** Fetch a fresh visitor-id from the public bootstrap endpoint (CSV, first field). */
async function fetchVisitorId(ua: string, backoff: number[]): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
    try {
      const res = await fetch(VID_URL, { headers: { accept: "text/plain", "user-agent": ua } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vid = (await res.text()).split(",")[0]?.trim();
      if (vid) return vid;
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
    }
  }
  throw new Error("CTgoodjobs visitor-id bootstrap failed");
}

/**
 * Fetch the full JD for one job from its detail page (the url field). Returns
 * errored=true after exhausting retries; the caller keeps whatever the list carried.
 */
async function fetchDetail(
  url: string,
  ua: string,
  backoff: number[],
): Promise<{ description: string | null; location: string | null; errored: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
    try {
      const res = await fetch(url, { headers: { accept: "text/html", "user-agent": ua } });
      if (!res.ok) continue;
      return { ...parseDetail(await res.text()), errored: false };
    } catch {
      continue;
    }
  }
  return { description: null, location: null, errored: true };
}

export const ctGoodJobsAdapter: Adapter = {
  manifest: {
    id: "ctgoodjobs",
    family: "portal",
    name: "CTgoodjobs",
    requiredInputs: ["query"],
    optionalInputs: ["location", "posted_within_days", "employment_type", "sort", "seniority", "page"],
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
      ua: { desc: "Browser User-Agent for the endpoints. Reads JD_UA from env. Default: bundled Chrome UA.", env: "JD_UA" },
      delayMs: { desc: "Pacing (ms) between sweep requests. Default 1000." },
      maxPages: { desc: "Hard cap on pages swept (33 jobs each). Default 200." },
      retryBackoffMs: { desc: "Backoff schedule (ms) for retries. Default [4000, 8000, 16000]." },
      detailConcurrency: { desc: "Concurrent JD-enrichment fetches. Default 4." },
      detailDelayMs: { desc: "Pacing (ms) between JD-enrichment requests. Default 0." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const ua = typeof ctx.env.JD_UA === "string" && ctx.env.JD_UA.trim() ? ctx.env.JD_UA.trim() : DEFAULT_UA;
    const delayMs = intInRange(ctx.config.delayMs, DEFAULT_DELAY_MS, 0);
    const maxPages = intInRange(ctx.config.maxPages, DEFAULT_MAX_PAGES, 1);
    const detailConcurrency = intInRange(ctx.config.detailConcurrency, DEFAULT_DETAIL_CONCURRENCY, 1);
    const detailDelayMs = intInRange(ctx.config.detailDelayMs, DEFAULT_DETAIL_DELAY_MS, 0);
    const backoff = Array.isArray(ctx.config.retryBackoffMs)
      ? (ctx.config.retryBackoffMs as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : RETRY_BACKOFF_MS;

    const query = typeof ctx.input.query === "string" ? ctx.input.query.trim() : "";
    const notes: string[] = [];

    // Body fragments; every request carries the same filters, only page varies.
    const filters: Record<string, unknown> = {
      keyword: query,
      channelIds: [],
      employmentTypeIds: [] as string[],
      gradeIds: [] as string[],
      locationIds: [] as string[],
    };
    if (typeof ctx.input.employment_type === "string") {
      const id = EMPTYPE_IDS[ctx.input.employment_type.trim().toLowerCase()];
      if (id) (filters.employmentTypeIds as string[]).push(id);
      else notes.push(`employment_type "${ctx.input.employment_type}" has no known CTgoodjobs emptype; skipped`);
    }
    if (typeof ctx.input.seniority === "string") {
      const id = GRADE_IDS[ctx.input.seniority.trim().toLowerCase()];
      if (id) (filters.gradeIds as string[]).push(id);
      else notes.push(`seniority "${ctx.input.seniority}" has no known CTgoodjobs grade; skipped`);
    }
    const within = Number(ctx.input.posted_within_days);
    if (Number.isFinite(within) && within > 0) filters.startPostDate = String(Math.floor(within));
    const sortValue =
      typeof ctx.input.sort === "string" ? SORT_VALUES[ctx.input.sort.trim().toLowerCase()] : undefined;
    if (sortValue !== undefined) filters.sort = sortValue;
    else if (ctx.input.sort) notes.push(`sort "${ctx.input.sort}" unsupported; skipped`);
    if (typeof ctx.input.location === "string" && ctx.input.location.trim()) {
      const loc = ctx.input.location.trim();
      // "Hong Kong"/"HK" already describe the portal's whole-HK scope — accepting them
      // is a no-op, not a surprise, so no warning. Any other value is a scope the portal
      // can't honor, so it warns and the search stays whole-HK.
      if (!isHkScopedLocation(loc)) {
        notes.push(`location "${loc}" ignored — CTgoodjobs is Hong Kong-only; all results are HK jobs`);
      }
    }
    if (Number(ctx.input.page ?? 1) > 1) notes.push("page input ignored; adapter sweeps every page for coverage");

    const visitorId = await fetchVisitorId(ua, backoff);

    let requests = 0;
    const fetchSearchPage = async (page: number): Promise<{ totalCount: number | null; cards: CtSearchCard[] }> => {
      const body = {
        pagingInputs: { page: String(page), pageSize: String(PAGE_SIZE), pageOneSize: String(PAGE_SIZE) },
        ...filters,
      };
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
        requests++;
        try {
          const res = await fetch(SEARCH_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "channel-id": "001",
              "visitor-id": visitorId,
              sid: "0",
              lang: "en-US",
              "user-id": "",
              login: "false",
              "user-agent": ua,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`CTgoodjobs search failed: HTTP ${res.status}`);
          return parseSearch(await res.json());
        } catch (error) {
          if (attempt === MAX_RETRIES) throw error;
        }
      }
      throw new Error("CTgoodjobs search failed");
    };

    const first = await fetchSearchPage(1);
    const totalCount = first.totalCount;
    const pageCount = totalCount !== null ? Math.min(Math.ceil(totalCount / PAGE_SIZE), maxPages) : maxPages;

    const seen = new Map<string, CtSearchCard>();
    let pages = 0;
    let earlyBreak = false;
    for (let page = 1; page <= pageCount; page++) {
      await sleep(delayMs);
      const { cards } = page === 1 ? first : await fetchSearchPage(page);
      pages++;
      if (cards.length === 0) {
        earlyBreak = true;
        break;
      }
      for (const card of cards) {
        if (card.id && !seen.has(card.id)) seen.set(card.id, card);
      }
      ctx.log?.(`page ${pages}/${pageCount} · ${seen.size} found`);
    }
    if (earlyBreak)
      notes.push(`search page ${pages} returned no jobs before the expected ${pageCount} pages; sweep stopped early`);
    if (pages >= maxPages)
      notes.push(`sweep hit the maxPages cap (${maxPages}); the pool may hold more than ${maxPages * PAGE_SIZE} jobs`);

    const jobs: Job[] = [];
    for (const card of seen.values()) {
      const id = card.id ?? "";
      jobs.push({
        apply_url: id ? `${APPLY_PREFIX}${id}` : null,
        job_page_url: card.url,
        external_id: id || null,
        title: card.title,
        company: card.company,
        location: card.location,
        posted_at: card.postedAt,
        expires_at: card.expiresAt,
        is_open: card.expiresAt ? Date.parse(card.expiresAt) > Date.now() : null,
        employment_type: card.empType,
        description: null, // filled by the detail enrichment below
      });
    }

    let jdDone = 0;
    let jdFetched = 0;
    let jdFailed = 0;
    if (jobs.length > 0) {
      await mapLimit(jobs, detailConcurrency, async (job) => {
        const url = job.job_page_url;
        jdDone++;
        if (typeof url !== "string" || !url) return;
        await sleep(detailDelayMs);
        const detail = await fetchDetail(url, ua, backoff);
        if (detail.errored) {
          // keep the list fields; location may stay null (runtime drops it, which is honest)
          jdFailed++;
        } else {
          if (detail.description) job.description = detail.description;
          if (detail.location && !job.location) job.location = detail.location;
          jdFetched++;
        }
        if (jdDone % 25 === 0 || jdDone === jobs.length) ctx.log?.(`JD ${jdDone}/${jobs.length}`);
      });
    }
    if (jdFailed > 0) notes.push(`${jdFailed} job detail fetch(es) failed; no list description fallback exists (kept null)`);

    return {
      jobs,
      meta: {
        totalCount,
        pageCount,
        pages,
        requests,
        uniqueFound: seen.size,
        coverage: totalCount !== null && totalCount > 0 ? Math.round((seen.size / totalCount) * 1000) / 10 : null,
        jdFetched,
        jdFailed,
        note: [
          "deterministic POST search (33/page, pagingInputs.page) driven by data.meta.jobsTotal; dedups by jobId across the whole sweep because pinned/boosted jobs are prepended to every page and can duplicate intra-page; apply_url derived from jobId (/ctjob/apply/jobApply.asp?m_jobid=<id>); job_page_url = list url field; description = full JD from the detail page JSON-LD JobPosting as plain text (no list fallback); location backfilled from the detail JSON-LD when the list omits it; posted_at/expires_at = publishTime/validThrough timestamps normalized to +08:00 (naive HK local in the API); is_open = validThrough > now; visitor-id bootstrapped per run from /vid/vid-jobs.asp.",
          ...notes,
        ].join(" "),
        // Short operational notes surfaced by the CLI as [warn] lines (ignored inputs, caps, failures).
        warnings: notes,
      },
    };
  },
};
