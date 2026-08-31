import type { Adapter, AdapterResult, Job } from "../types.js";

/**
 * JobsDB adapter — the non-obvious behaviors, for reference:
 *
 * 1. Sweep-all pagination. The REST search API (page=<n>) returns exactly 20 jobs per
 *    request and exposes totalCount, so the sweep is deterministic: pageCount =
 *    ceil(totalCount/20), walk every page (config maxPages caps it). Unlike LinkedIn
 *    there is no rotation — pages are stable and disjoint (verified: 0 id overlap
 *    between consecutive pages). `page` is therefore ignored (noted in meta).
 *
 * 2. apply_url. The detail page's apply anchor is href="/job/<id>/apply" and the job
 *    page URL is /job/<id> — both derivable from the id with no HTML parsing (the
 *    anchor's href and data-automation attributes don't share one clean tag anyway).
 *
 * 3. Full JD. The search response carries only a `teaser` snippet; the full JD lives
 *    in the jobAdDetails block of /job/<id> (server-rendered HTML), extracted with a
 *    depth-aware <div> scan and converted to plain text. Enrich after the sweep
 *    (concurrency-capped), falling back to the teaser on fetch failure (counted in
 *    meta.jdFailed / meta.jdFetched).
 *
 * 4. Filters. where (location) and daterange (posted_within_days) take free text /
 *    days directly; employment_type maps to the Seek worktype id (242 Full time, 243
 *    Part time, 244 Contract/Temp, 245 Casual/Vacation — the API exposes no facet
 *    metadata, so the table is hardcoded); sort maps to sortmode (date → ListedDate,
 *    relevance → KeywordRelevance, the default). seniority has no equivalent.
 *    is_open / expires_at are not exposed by the API.
 *
 * 5. Company. `companyName` is absent on some listings (verified: 49 of 198 in a
 *    tech-intern pool); those still carry the company name in `advertiser.description`,
 *    which parseSearch falls back to. The value matches the detail page's
 *    advertiser-name element (including placeholders like "Private Advertiser" for
 *    anonymous postings).
 *
 * Session discipline mirrors the other adapters: browser UA ($JD_UA, falling back to
 * a bundled Chrome UA), no cookies, retry-with-backoff on rate-limit signals.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SEARCH_ENDPOINT = "https://hk.jobsdb.com/api/jobsearch/v5/search";
const PAGE_SIZE = 20;
const DEFAULT_SITE_KEY = "HK-Main";
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [4000, 8000, 16000];
const DEFAULT_DELAY_MS = 1000; // pacing between sweep requests
const DEFAULT_MAX_PAGES = 100; // safety cap: 100 pages × 20 = 2000 jobs
const DEFAULT_DETAIL_CONCURRENCY = 4;
const DEFAULT_DETAIL_DELAY_MS = 0; // no throttling observed at ~15 detail requests

/** employment_type contract value → JobsDB worktype id (Seek taxonomy). */
const WORKTYPE_IDS: Record<string, string> = {
  "full-time": "242",
  "full time": "242",
  fulltime: "242",
  "part-time": "243",
  "part time": "243",
  parttime: "243",
  contract: "244",
  temp: "244",
  "contract/temp": "244",
  "contract/temporary": "244",
  casual: "245",
  vacation: "245",
};

/** sort contract value → JobsDB sortmode. */
const SORT_MODES: Record<string, string> = {
  date: "ListedDate",
  newest: "ListedDate",
  listed: "ListedDate",
  "listed date": "ListedDate",
  relevance: "KeywordRelevance",
  "best match": "KeywordRelevance",
};

/** One card from a search response. */
export interface JobsDbCard {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: string | null;
  workTypes: string | null;
  teaser: string | null;
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
 * Parse a search response. The API returns `{ totalCount, data: [...], ... }` with
 * 20 jobs per page; each job carries id/title/locations/listingDate/workTypes/teaser.
 * totalCount drives the sweep. company comes from `companyName`, but some listings
 * omit it — those still carry the company name in `advertiser.description` (verified
 * to match the detail page's advertiser-name element), so fall back to that.
 */
export function parseSearch(json: unknown): { totalCount: number | null; cards: JobsDbCard[] } {
  const obj = json as { totalCount?: unknown; data?: unknown[] };
  const totalCount = typeof obj?.totalCount === "number" ? obj.totalCount : null;
  const cards: JobsDbCard[] = [];
  for (const item of obj?.data ?? []) {
    const j = item as Record<string, unknown>;
    const id = typeof j.id === "string" ? j.id : String(j.id ?? "");
    const title = typeof j.title === "string" ? j.title : null;
    const companyName = typeof j.companyName === "string" ? j.companyName.trim() : "";
    const advertiser = j.advertiser as { description?: unknown } | undefined;
    const advName =
      typeof advertiser?.description === "string" && advertiser.description.trim()
        ? advertiser.description.trim()
        : null;
    const company = companyName || advName;
    const locations = Array.isArray(j.locations)
      ? (j.locations as { label?: unknown }[]).map((l) => (typeof l?.label === "string" ? l.label : "")).filter(Boolean)
      : [];
    const workTypes = Array.isArray(j.workTypes)
      ? (j.workTypes as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    const listingDate = typeof j.listingDate === "string" ? j.listingDate : null;
    const teaser = typeof j.teaser === "string" ? j.teaser : null;
    cards.push({
      id,
      title,
      company,
      location: locations.join(", ") || null,
      postedAt: listingDate,
      workTypes: workTypes[0] ?? null,
      teaser,
    });
  }
  return { totalCount, cards };
}

/**
 * Parse a job detail page: the full JD lives in the jobAdDetails div. The block
 * contains nested divs, so extract it with a depth-aware <div> scan rather than a
 * non-greedy match, then convert to plain text.
 */
export function parseDetail(html: string): { description: string | null } {
  const markerIdx = html.indexOf('data-automation="jobAdDetails">');
  if (markerIdx === -1) return { description: null };
  const openStart = html.indexOf("<div", markerIdx);
  if (openStart === -1) return { description: null };
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = openStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith("<div")) depth++;
    else depth--;
    if (depth === 0) {
      const text = toText(html.slice(openStart, tagRe.lastIndex));
      return { description: text || null };
    }
  }
  return { description: null };
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

/**
 * Fetch the full JD for one job. Returns errored=true after exhausting retries; the
 * caller keeps the search teaser for that job.
 */
async function fetchDetail(
  id: string,
  ua: string,
  backoff: number[],
): Promise<{ description: string | null; errored: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
    try {
      const res = await fetch(`https://hk.jobsdb.com/job/${id}`, {
        headers: { accept: "text/html", "user-agent": ua },
      });
      if (!res.ok) continue;
      const parsed = parseDetail(await res.text());
      return { description: parsed.description, errored: false };
    } catch {
      continue;
    }
  }
  return { description: null, errored: true };
}

export const jobsDbAdapter: Adapter = {
  manifest: {
    id: "jobsdb",
    family: "portal",
    name: "JobsDB",
    requiredInputs: ["query"],
    optionalInputs: ["location", "posted_within_days", "employment_type", "sort", "page", "seniority"],
    providedOutputs: [
      "apply_url",
      "job_page_url",
      "external_id",
      "title",
      "company",
      "location",
      "description",
      "posted_at",
      "employment_type",
    ],
    extraInputs: {
      siteKey: { desc: "JobsDB site partition (HK-Main, SG-Main, ...). Default HK-Main." },
      ua: { desc: "Browser User-Agent for the endpoints. Reads JD_UA from env. Default: bundled Chrome UA.", env: "JD_UA" },
      delayMs: { desc: "Pacing (ms) between sweep requests. Default 1000." },
      maxPages: { desc: "Hard cap on pages swept (20 jobs each). Default 100." },
      retryBackoffMs: { desc: "Backoff schedule (ms) for retries. Default [4000, 8000, 16000]." },
      detailConcurrency: { desc: "Concurrent JD-enrichment fetches. Default 4." },
      detailDelayMs: { desc: "Pacing (ms) between JD-enrichment requests. Default 0." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const siteKey =
      typeof ctx.config.siteKey === "string" && ctx.config.siteKey.trim() ? ctx.config.siteKey.trim() : DEFAULT_SITE_KEY;
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

    const params = new URLSearchParams();
    params.set("siteKey", siteKey);
    if (query) params.set("keywords", query);
    if (typeof ctx.input.location === "string" && ctx.input.location.trim())
      params.set("where", ctx.input.location.trim());
    const within = Number(ctx.input.posted_within_days);
    if (Number.isFinite(within) && within > 0) params.set("daterange", String(Math.floor(within)));
    const worktypeId =
      typeof ctx.input.employment_type === "string"
        ? WORKTYPE_IDS[ctx.input.employment_type.trim().toLowerCase()]
        : undefined;
    if (worktypeId) params.set("worktype", worktypeId);
    else if (ctx.input.employment_type)
      notes.push(`employment_type "${String(ctx.input.employment_type)}" has no known JobsDB worktype; skipped`);
    const sortMode =
      typeof ctx.input.sort === "string" ? SORT_MODES[ctx.input.sort.trim().toLowerCase()] : undefined;
    if (sortMode) params.set("sortmode", sortMode);
    else if (ctx.input.sort) notes.push(`sort "${String(ctx.input.sort)}" unsupported; skipped`);
    if (ctx.input.seniority) notes.push("seniority filter unsupported on JobsDB; skipped");
    if (Number(ctx.input.page ?? 1) > 1) notes.push("page input ignored; adapter sweeps every page for coverage");

    const baseUrl = `${SEARCH_ENDPOINT}?${params.toString()}`;

    let requests = 0;
    const fetchSearchPage = async (page: number): Promise<{ totalCount: number | null; cards: JobsDbCard[] }> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
        requests++;
        try {
          const res = await fetch(`${baseUrl}&page=${page}`, {
            headers: { accept: "application/json", "user-agent": ua },
          });
          if (!res.ok) throw new Error(`JobsDB search failed: HTTP ${res.status}`);
          return parseSearch(await res.json());
        } catch (error) {
          if (attempt === MAX_RETRIES) throw error;
        }
      }
      throw new Error("JobsDB search failed");
    };

    const first = await fetchSearchPage(1);
    const totalCount = first.totalCount;
    const pageCount = totalCount !== null ? Math.min(Math.ceil(totalCount / PAGE_SIZE), maxPages) : maxPages;

    const seen = new Map<string, JobsDbCard>();
    let pages = 0;
    let earlyBreak = false;
    for (let page = 1; page <= pageCount; page++) {
      if (ctx.aborted?.()) break; // stop button — keep the partial sweep
      await sleep(delayMs);
      const { cards } = page === 1 ? first : await fetchSearchPage(page);
      pages++;
      if (cards.length === 0) {
        earlyBreak = true;
        break;
      }
      for (const card of cards) {
        if (!seen.has(card.id)) seen.set(card.id, card);
      }
      ctx.log?.(`page ${pages}/${pageCount} · ${seen.size} found`);
    }
    if (ctx.aborted?.()) notes.push("sweep stopped early (run aborted)");
    if (earlyBreak)
      notes.push(`search page ${pages} returned no jobs before the expected ${pageCount} pages; sweep stopped early`);
    if (pages >= maxPages)
      notes.push(`sweep hit the maxPages cap (${maxPages}); the pool may hold more than ${maxPages * PAGE_SIZE} jobs`);

    const jobs: Job[] = [];
    for (const card of seen.values()) {
      const jobPageUrl = `https://hk.jobsdb.com/job/${card.id}`;
      jobs.push({
        apply_url: `${jobPageUrl}/apply`,
        job_page_url: jobPageUrl,
        external_id: card.id,
        title: card.title,
        company: card.company,
        location: card.location,
        posted_at: card.postedAt,
        employment_type: card.workTypes,
        description: card.teaser, // fallback; replaced by the full JD below
      });
    }

    let jdDone = 0;
    let jdFetched = 0;
    let jdFailed = 0;
    if (jobs.length > 0) {
      await mapLimit(jobs, detailConcurrency, async (job) => {
        const id = job.external_id;
        jdDone++;
        if (typeof id !== "string" || !id) return;
        if (ctx.aborted?.()) return; // stop button — keep the teaser fallback
        await sleep(detailDelayMs);
        const detail = await fetchDetail(id, ua, backoff);
        if (detail.errored || !detail.description) {
          // keep the teaser fallback
          jdFailed++;
        } else {
          job.description = detail.description;
          jdFetched++;
        }
        if (jdDone % 25 === 0 || jdDone === jobs.length) ctx.log?.(`JD ${jdDone}/${jobs.length}`);
      });
    }
    if (jdFailed > 0) notes.push(`${jdFailed} job detail fetch(es) failed; search teaser retained for those`);

    return {
      jobs,
      meta: {
        siteKey,
        totalCount,
        pageCount,
        pages,
        requests,
        uniqueFound: seen.size,
        coverage: totalCount !== null && totalCount > 0 ? Math.round((seen.size / totalCount) * 1000) / 10 : null,
        jdFetched,
        jdFailed,
        note: [
          "deterministic REST search (20/page, page=<n>) driven by totalCount; apply_url and job_page_url are derived from the id (/job/<id>/apply, /job/<id>); description = full JD from /job/<id> jobAdDetails as plain text, falling back to the search teaser when the detail fetch fails; posted_at = listingDate (ISO UTC); no expires_at or is_open (JobsDB exposes neither).",
          ...notes,
        ].join(" "),
      },
    };
  },
};
