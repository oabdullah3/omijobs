import type { Adapter, AdapterResult, Job } from "../types.js";

/**
 * eFinancialCareers adapter — the non-obvious behaviors, for reference:
 *
 * 1. Search API. job-search-ui.efinancialcareers.com/v1/efc/jobs/search returns
 *    { data[], meta{totalResults,pageCount}, _links } with the FULL description
 *    inline on every job — no separate detail request (unlike LinkedIn/JobsDB).
 *    The sweep is deterministic: pageCount = ceil(totalResults/200), walk every
 *    page, dedup by jobId (defensive; eFC pages are disjoint, unlike CTgoodjobs'
 *    pinned jobs). _links hrefs are relative paths — ignored; the page walk is
 *    computed from totalResults instead.
 *
 * 2. Apply URL. The list does NOT carry the apply URL. job-application.
 *    efinancialcareers.com/v1/jobs/<internal id>/apply-information returns
 *    external_job_application_url for external-application jobs (≈73% of HK — the
 *    direct employer-ATS page) and null for in-app jobs (questionnaire form). We
 *    fetch it only for isExternalApplication jobs; in-app jobs and fetch failures
 *    fall back to the detail page URL so apply_url never drops a job.
 *    login_required=true gates submission, not reading the URL.
 *
 * 3. Filters. Dot-notation query params: filters.postedDate (ONE/THREE/SEVEN —
 *    capped at 7 days; larger requests are ignored with a warning), filters.
 *    employmentType (FULL_TIME/PART_TIME) + filters.positionType (CONTRACT/
 *    TEMPORARY/PERMANENT/INTERNSHIPS_AND_GRADUATE_TRAINEE), filters.seniority
 *    (INTERN_GRADUATE … AVP_SENIOR). sortBy is a server-side no-op (verified
 *    identical orderings) — skipped with a note. location is free text, georesolved
 *    server-side (meta.searchedLocation echoes the resolution); countryCode2
 *    (config, default HK) scopes the country.
 *
 * 4. is_open. No structured open/closed field — infer expirationDate > now. Caveat:
 *    expirationDateType INVENTORY marks evergreen employer posts (validThrough can
 *    be years out) — the date is still the best available open signal.
 *
 * 5. Timestamps. postedDate/expirationDate are ISO with offsets — passed through
 *    as-is.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SEARCH_HOST = "https://job-search-ui.efinancialcareers.com";
const SEARCH_PATH = "/v1/efc/jobs/search";
const APPLY_HOST = "https://job-application.efinancialcareers.com";
const DETAIL_PREFIX = "https://www.efinancialcareers.hk";
// Verified live (2026-08-18): pageSize=200 returns 200 OK; the HK pool (~2,875 jobs)
// then needs ~15 sweep requests instead of ~96 at the research's pageSize=30.
const PAGE_SIZE = 200;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [4000, 8000, 16000];
const DEFAULT_DELAY_MS = 1000; // pacing between sweep requests
// 100 pages × 200 = 20,000-job ceiling (matches the other adapters' maxPages default).
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const DEFAULT_DETAIL_DELAY_MS = 0;
const DEFAULT_COUNTRY_CODE = "HK";

/** employment_type contract value → eFC filter params (employmentType vs positionType). */
const EMPTYPE_FILTERS: Record<string, { employmentType?: string; positionType?: string }> = {
  "full-time": { employmentType: "FULL_TIME" },
  "full time": { employmentType: "FULL_TIME" },
  fulltime: { employmentType: "FULL_TIME" },
  "part-time": { employmentType: "PART_TIME" },
  "part time": { employmentType: "PART_TIME" },
  parttime: { employmentType: "PART_TIME" },
  permanent: { positionType: "PERMANENT" },
  contract: { positionType: "CONTRACT" },
  temporary: { positionType: "TEMPORARY" },
  temp: { positionType: "TEMPORARY" },
  internship: { positionType: "INTERNSHIPS_AND_GRADUATE_TRAINEE" },
  intern: { positionType: "INTERNSHIPS_AND_GRADUATE_TRAINEE" },
  // freelance has no eFC equivalent → falls through to a "no known filter" note.
};

/** seniority contract value → filters.seniority (research enum). */
const SENIORITY_FILTERS: Record<string, string> = {
  entry: "INTERN_GRADUATE",
  "entry level": "INTERN_GRADUATE",
  "entry-level": "INTERN_GRADUATE",
  intern: "INTERN_GRADUATE",
  junior: "ANALYST",
  "non management": "ANALYST",
  "non-management": "ANALYST",
  middle: "ASSOCIATE_MID_LEVEL",
  mid: "ASSOCIATE_MID_LEVEL",
  "middle management": "ASSOCIATE_MID_LEVEL",
  "middle-management": "ASSOCIATE_MID_LEVEL",
  senior: "AVP_SENIOR",
};

/**
 * posted_within_days → filters.postedDate. The enum caps at 7 days; asking for more
 * is not honor-able, so the filter is dropped with a warning (post-filter client-side)
 * rather than silently narrowing to the last 7 days.
 */
function postedDateFilter(days: number): { filter: string | null; note?: string } {
  if (days === 1) return { filter: "ONE" };
  if (days <= 3) return { filter: "THREE" };
  if (days <= 7) return { filter: "SEVEN" };
  return {
    filter: null,
    note: `posted_within_days ${days} not supported beyond 7 days (eFinancialCareers filters.postedDate is ONE/THREE/SEVEN); filter not applied, post-filter client-side`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intInRange(value: unknown, fallback: number, min: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Run fn over items with at most `limit` in flight; fn mutates items in place. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
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

/** One job from a search response. */
export interface EfSearchCard {
  /** Internal id — the apply-information lookup key. */
  id: string | null;
  /** Numeric job id — the dedup key. */
  jobId: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  /** Relative detailsPageUrl from the list. */
  url: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  employmentType: string | null;
  isExternal: boolean;
  description: string | null;
}

/**
 * Parse a search response: `{ data[], meta{totalResults} }`. The full description is
 * inline (HTML → plain text); jobLocation.displayName is the location; companyName
 * falls back to clientBrandName.
 */
export function parseSearch(json: unknown): { totalCount: number | null; cards: EfSearchCard[] } {
  const obj = json as { data?: unknown[]; meta?: { totalResults?: unknown } };
  const totalCount = typeof obj.meta?.totalResults === "number" ? obj.meta.totalResults : null;
  const cards: EfSearchCard[] = [];
  for (const item of obj.data ?? []) {
    const j = item as Record<string, unknown>;
    const jobLocation = (j.jobLocation && typeof j.jobLocation === "object" ? j.jobLocation : {}) as {
      displayName?: unknown;
    };
    const companyName = typeof j.companyName === "string" && j.companyName.trim() ? j.companyName.trim() : null;
    const brandName = typeof j.clientBrandName === "string" && j.clientBrandName.trim() ? j.clientBrandName.trim() : null;
    const description = typeof j.description === "string" && j.description.trim() ? j.description.trim() : "";
    cards.push({
      id: typeof j.id === "string" && j.id.trim() ? j.id.trim() : null,
      jobId: typeof j.jobId === "string" && j.jobId.trim() ? j.jobId.trim() : null,
      title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : null,
      company: companyName ?? brandName,
      location:
        typeof jobLocation.displayName === "string" && jobLocation.displayName.trim()
          ? jobLocation.displayName.trim()
          : null,
      url: typeof j.detailsPageUrl === "string" && j.detailsPageUrl.trim() ? j.detailsPageUrl.trim() : null,
      postedAt: typeof j.postedDate === "string" && j.postedDate.trim() ? j.postedDate.trim() : null,
      expiresAt: typeof j.expirationDate === "string" && j.expirationDate.trim() ? j.expirationDate.trim() : null,
      employmentType: typeof j.employmentType === "string" && j.employmentType.trim() ? j.employmentType.trim() : null,
      isExternal: j.isExternalApplication === true,
      description: description ? toText(description) || null : null,
    });
  }
  return { totalCount, cards };
}

/** One apply-information response: `{ data{ external_job_application_url, … } }`. */
export interface EfApplyInfo {
  externalUrl: string | null;
  loginRequired: boolean;
}

/** Parse an apply-information response; in-app jobs carry external_job_application_url: null. */
export function parseApply(json: unknown): EfApplyInfo {
  const data = (json as { data?: unknown }).data;
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const externalUrl =
    typeof d.external_job_application_url === "string" && d.external_job_application_url.trim()
      ? d.external_job_application_url.trim()
      : null;
  return { externalUrl, loginRequired: d.login_required === true };
}

/** Fetch the apply URL for one external job. errored=true after exhausting retries. */
async function fetchApply(
  internalId: string,
  ua: string,
  backoff: number[],
): Promise<{ externalUrl: string | null; errored: boolean }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
    try {
      const res = await fetch(`${APPLY_HOST}/v1/jobs/${internalId}/apply-information`, {
        headers: { accept: "application/json", "user-agent": ua },
      });
      if (!res.ok) continue;
      return { ...parseApply(await res.json()), errored: false };
    } catch {
      continue;
    }
  }
  return { externalUrl: null, errored: true };
}

export const eFinancialCareersAdapter: Adapter = {
  manifest: {
    id: "efinancialcareers",
    family: "portal",
    name: "eFinancialCareers",
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
      ua: { desc: "Browser User-Agent for the endpoints. Reads EF_UA from env. Default: bundled Chrome UA.", env: "EF_UA" },
      countryCode2: { desc: "Country scope for the search. Default: HK." },
      delayMs: { desc: "Pacing (ms) between sweep requests. Default 1000." },
      maxPages: { desc: "Hard cap on pages swept (200 jobs each). Default 100." },
      retryBackoffMs: { desc: "Backoff schedule (ms) for retries. Default [4000, 8000, 16000]." },
      detailConcurrency: { desc: "Concurrent apply-URL fetches (external jobs only). Default 4." },
      detailDelayMs: { desc: "Pacing (ms) between apply-URL requests. Default 0." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const ua = typeof ctx.env.EF_UA === "string" && ctx.env.EF_UA.trim() ? ctx.env.EF_UA.trim() : DEFAULT_UA;
    const countryCode =
      typeof ctx.config.countryCode2 === "string" && ctx.config.countryCode2.trim()
        ? ctx.config.countryCode2.trim()
        : DEFAULT_COUNTRY_CODE;
    const delayMs = intInRange(ctx.config.delayMs, DEFAULT_DELAY_MS, 0);
    const maxPages = intInRange(ctx.config.maxPages, DEFAULT_MAX_PAGES, 1);
    const detailConcurrency = intInRange(ctx.config.detailConcurrency, DEFAULT_DETAIL_CONCURRENCY, 1);
    const detailDelayMs = intInRange(ctx.config.detailDelayMs, DEFAULT_DETAIL_DELAY_MS, 0);
    const backoff = Array.isArray(ctx.config.retryBackoffMs)
      ? (ctx.config.retryBackoffMs as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : RETRY_BACKOFF_MS;

    const query = typeof ctx.input.query === "string" ? ctx.input.query.trim() : "";
    const location =
      typeof ctx.input.location === "string" && ctx.input.location.trim() ? ctx.input.location.trim() : null;
    const notes: string[] = [];

    // Dot-notation filter params; prefixed with "filters." at build time.
    const filters: Record<string, string> = {};
    if (typeof ctx.input.employment_type === "string") {
      const f = EMPTYPE_FILTERS[ctx.input.employment_type.trim().toLowerCase()];
      if (f?.employmentType) filters.employmentType = f.employmentType;
      else if (f?.positionType) filters.positionType = f.positionType;
      else notes.push(`employment_type "${ctx.input.employment_type}" has no known eFinancialCareers filter; skipped`);
    }
    if (typeof ctx.input.seniority === "string") {
      const level = SENIORITY_FILTERS[ctx.input.seniority.trim().toLowerCase()];
      if (level) filters.seniority = level;
      else notes.push(`seniority "${ctx.input.seniority}" has no known eFinancialCareers level; skipped`);
    }
    const within = Number(ctx.input.posted_within_days);
    if (Number.isFinite(within) && within > 0) {
      const pd = postedDateFilter(Math.floor(within));
      if (pd.filter) filters.postedDate = pd.filter;
      if (pd.note) notes.push(pd.note);
    }
    if (ctx.input.sort)
      notes.push(`sort "${ctx.input.sort}" unsupported (eFinancialCareers sortBy is a server-side no-op); results are relevance-ordered`);
    if (Number(ctx.input.page ?? 1) > 1) notes.push("page input ignored; adapter sweeps every page for coverage");

    const buildUrl = (page: number): string => {
      const params = new URLSearchParams();
      params.set("q", query);
      if (location) params.set("location", location);
      params.set("countryCode2", countryCode);
      params.set("culture", "en");
      for (const [k, v] of Object.entries(filters)) params.set(`filters.${k}`, v);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      return `${SEARCH_HOST}${SEARCH_PATH}?${params.toString()}`;
    };

    let requests = 0;
    const fetchSearchPage = async (page: number): Promise<{ totalCount: number | null; cards: EfSearchCard[] }> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
        requests++;
        try {
          const res = await fetch(buildUrl(page), { headers: { accept: "application/json", "user-agent": ua } });
          if (!res.ok) throw new Error(`eFinancialCareers search failed: HTTP ${res.status}`);
          return parseSearch(await res.json());
        } catch (error) {
          if (attempt === MAX_RETRIES) throw error;
        }
      }
      throw new Error("eFinancialCareers search failed");
    };

    const first = await fetchSearchPage(1);
    const totalCount = first.totalCount;
    const pageCount = totalCount !== null ? Math.min(Math.ceil(totalCount / PAGE_SIZE), maxPages) : maxPages;

    const seen = new Map<string, EfSearchCard>();
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
        if (card.jobId && !seen.has(card.jobId)) seen.set(card.jobId, card);
      }
      ctx.log?.(`page ${pages}/${pageCount} · ${seen.size} found`);
    }
    if (earlyBreak)
      notes.push(`search page ${pages} returned no jobs before the expected ${pageCount} pages; sweep stopped early`);
    if (pages >= maxPages)
      notes.push(`sweep hit the maxPages cap (${maxPages}); the pool may hold more than ${maxPages * PAGE_SIZE} jobs`);

    const jobs: Job[] = [];
    for (const card of seen.values()) {
      const pageUrl = card.url ? `${DETAIL_PREFIX}${card.url}` : null;
      jobs.push({
        apply_url: null, // filled by the apply enrichment below
        job_page_url: pageUrl,
        external_id: card.jobId,
        title: card.title,
        company: card.company,
        location: card.location,
        posted_at: card.postedAt,
        expires_at: card.expiresAt,
        is_open: card.expiresAt ? Date.parse(card.expiresAt) > Date.now() : null,
        employment_type: card.employmentType,
        description: card.description,
      });
    }

    let applyDone = 0;
    let applyFetched = 0;
    let applyFailed = 0;
    if (jobs.length > 0) {
      const cards = [...seen.values()];
      await mapLimit(jobs, detailConcurrency, async (job, i) => {
        const card = cards[i];
        applyDone++;
        // In-app jobs have no external URL to fetch — the detail page is their entry point.
        if (card.isExternal && card.id) {
          await sleep(detailDelayMs);
          const apply = await fetchApply(card.id, ua, backoff);
          if (apply.errored) applyFailed++;
          else {
            applyFetched++;
            if (apply.externalUrl) job.apply_url = apply.externalUrl;
          }
        }
        // In-app jobs and apply-fetch failures fall back to the detail page so apply_url
        // never drops a valid job.
        if (!job.apply_url) job.apply_url = job.job_page_url;
        if (applyDone % 25 === 0 || applyDone === jobs.length) ctx.log?.(`apply URLs ${applyDone}/${jobs.length}`);
      });
    }
    if (applyFailed > 0)
      notes.push(`${applyFailed} apply-URL fetch(es) failed; fell back to the job detail page`);

    return {
      jobs,
      meta: {
        totalCount,
        pageCount,
        pages,
        requests,
        uniqueFound: seen.size,
        coverage: totalCount !== null && totalCount > 0 ? Math.round((seen.size / totalCount) * 1000) / 10 : null,
        applyFetched,
        applyFailed,
        note: [
          "deterministic GET search (200/page, page param) driven by meta.totalResults; description is inline in the list (HTML → plain text, no detail request); dedups by jobId across the sweep (defensive — eFC pages are disjoint); apply_url = external_job_application_url from the apply-information API for external jobs (fetched concurrency-capped, ~73% of HK), else the job detail page; job_page_url = detailsPageUrl prefixed with the www.efinancialcareers.hk host; posted_at/expires_at = postedDate/expirationDate ISO; is_open = expirationDate > now (expirationDateType INVENTORY marks evergreen employer posts); countryCode2 (config, default HK) scopes the search; location is free text georesolved server-side.",
          ...notes,
        ].join(" "),
        // Short operational notes surfaced by the CLI as [warn] lines (ignored inputs, caps, failures).
        warnings: notes,
      },
    };
  },
};
