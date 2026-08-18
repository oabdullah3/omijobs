import type { Adapter, AdapterResult, Job } from "../types.js";

/**
 * LinkedIn adapter — non-obvious behaviors, for reference:
 *
 * 1. Coverage / non-deterministic pagination. The guest search endpoint
 *    (seeMoreJobPostings) serves a TIME-VARYING subset of the search pool. The main
 *    search page reports totalResults, but the guest API only serves a subset of that
 *    in a given session, and many offsets answer HTTP 200 with an empty HTML shell
 *    (`<!DOCTYPE html>` + comment) — indistinguishable from end-of-results by status
 *    code. There is no deterministic linear pagination. The adapter therefore sweeps
 *    EVERY offset 0..maxOffset (maxOffset from totalResults), retries shells with
 *    exponential backoff (default 4s/8s/16s ×3), then repeats rounds over the
 *    still-empty offsets until a round adds zero new job IDs (min 2 rounds, capped by
 *    config maxRounds). meta.coverage = uniqueFound/totalResults tells you how much of
 *    the pool was actually captured — a restricted day shows a low ratio instead of
 *    silently returning fewer jobs.
 *
 * 2. apply_url. External ATS URLs are not exposed to guests. The job view page
 *    (https://www.linkedin.com/jobs/view/<id>/) is the only guest-accessible
 *    application entry, so apply_url = job_page_url = that page, built from the id.
 *
 * 3. Full JD + criteria. The list HTML carries only a card (title/company/location/
 *    date/is_open badge). The full JD lives in /api/jobPosting/<id> inside the
 *    `description__text` block — converted to plain text here (paragraph structure
 *    preserved) — alongside structured criteria (Employment type, Seniority level).
 *    Enrich after the sweep at concurrency 2, paced ~1.2s/request (the detail
 *    endpoint rate-limits bursts with HTTP 429, 0 bytes; measured threshold ~1.6
 *    req/s), retrying with the sweep's backoff schedule; on exhaustion the job is
 *    kept with list-only fields and counted in meta.jdFailed.
 *
 * 4. employment_type filter (f_JT) is a verified NO-OP on the guest endpoint; it is
 *    skipped and noted in meta rather than silently sent. posted_within_days, sort
 *    and seniority are likewise unsupported and noted. is_open = "Actively Hiring" /
 *    "Be an early applicant" badge present on the list card, else unknown (null).
 *
 * Session discipline mirrors JobSpy's LinkedIn scraper: browser UA ($LI_UA, falling
 * back to a bundled Chrome UA), no cookies, retry-with-backoff on rate-limit signals
 * (427/429 HTML and the 200-shell both parse to 0 cards and are retried uniformly).
 * If hard blocks start appearing, the next levers are rotating proxies then
 * TLS-fingerprint impersonation (curl-impersonate) — both deferred until needed.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SEARCH_ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const DETAIL_ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";
const MAIN_PAGE = "https://www.linkedin.com/jobs/search";

const PAGE_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [4000, 8000, 16000];
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_OFFSET = 500; // fallback when totalResults is unavailable
const DEFAULT_DELAY_MS = 1500; // pacing between sweep requests
const DEFAULT_DETAIL_CONCURRENCY = 2;
const DEFAULT_DETAIL_DELAY_MS = 1200; // pacing between JD-enrichment requests

/** One card from a guest search page. is_open is null when no badge is shown. */
export interface LiCard {
  id: string;
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: string | null;
  isOpen: boolean | null;
}

/** Parsed detail page: full JD + structured criteria. */
export interface LiDetail {
  description: string | null;
  employmentType: string | null;
  seniority: string | null;
}

/** Strip tags and collapse whitespace for single-line fields (title, company, ...). */
export function collapse(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
 * Parse a guest search page into cards. Cards are split on the per-card
 * data-entity-urn anchor; each chunk holds title/company/location/date/badge.
 * A 200-empty-shell (or rate-limit HTML) yields zero cards.
 */
export function parseListPage(html: string): LiCard[] {
  const anchors: { id: string; index: number }[] = [];
  const re = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) anchors.push({ id: m[1], index: m.index });

  const cards: LiCard[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const chunk = html.slice(anchors[i].index, i + 1 < anchors.length ? anchors[i + 1].index : html.length);
    const title = chunk.match(/<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/)?.[1];
    // Company sits in the subtitle h4, wrapped in a hidden-nested-link anchor only
    // when the employer has a linked company page. Unverified companies render as
    // bare text, so fall back to the subtitle when the anchor is absent.
    const company =
      chunk.match(/<a class="hidden-nested-link"[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
      chunk.match(/<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/)?.[1];
    const location = chunk.match(/<span class="job-search-card__location">([\s\S]*?)<\/span>/)?.[1];
    const postedAt = chunk.match(/<time class="job-search-card__listdate"[^>]*datetime="([^"]*)"/)?.[1] ?? null;
    const badge = chunk.match(/class="job-posting-benefits__text"[\s\S]*?>([\s\S]*?)<\/span>/);
    const isOpen = badge ? /Actively Hiring|Be an early applicant/i.test(badge[1]) ? true : null : null;
    cards.push({
      id: anchors[i].id,
      title: title ? collapse(title) : null,
      company: company ? collapse(company) : null,
      location: location ? collapse(location) : null,
      postedAt,
      isOpen,
    });
  }
  return cards;
}

/**
 * Parse a job detail page: the full JD (show-more-less markup block, converted to
 * text, terminated by the Show-more button or the section close) plus the
 * structured criteria list (Employment type / Seniority level / ...).
 */
export function parseDetail(html: string): LiDetail {
  const descM = html.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)(?=<button|<\/section>)/);
  const description = descM ? toText(descM[1]) || null : null;

  const criteria = new Map<string, string>();
  const re =
    /<h3 class="description__job-criteria-subheader">\s*([\s\S]*?)\s*<\/h3>\s*<span class="description__job-criteria-text[^"]*">\s*([\s\S]*?)\s*<\/span>/g;
  let cm: RegExpExecArray | null;
  while ((cm = re.exec(html)) !== null) criteria.set(collapse(cm[1]), collapse(cm[2]));

  return {
    description,
    employmentType: criteria.get("Employment type") ?? null,
    seniority: criteria.get("Seniority level") ?? null,
  };
}

/** Extract the search-pool size from the main search page's totalResults blob. */
export function extractTotalResults(html: string): number | null {
  const m = html.match(/totalResults" style="display: none"><!--(\d+)-->/);
  if (m) return Number(m[1]);
  const json = html.match(/"totalResults":(\d+)/);
  return json ? Number(json[1]) : null;
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
 * Fetch the full JD for one job. The detail endpoint rate-limits bursts (HTTP 429,
 * 0 bytes), so retry 429/5xx/network-error with the same backoff schedule as the
 * sweep. Returns errored=true after exhausting retries; the caller keeps the
 * list-only fields for that job.
 */
async function fetchDetail(
  id: string,
  headers: Record<string, string>,
  backoff: number[],
): Promise<LiDetail & { errored: boolean }> {
  const EMPTY: LiDetail & { errored: boolean } = { description: null, employmentType: null, seniority: null, errored: true };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
    try {
      const res = await fetch(`${DETAIL_ENDPOINT}/${id}`, { headers });
      if (!res.ok) continue;
      const parsed = parseDetail(await res.text());
      return { ...parsed, errored: false };
    } catch {
      continue;
    }
  }
  return EMPTY;
}

export const linkedInAdapter: Adapter = {
  manifest: {
    id: "linkedin",
    family: "portal",
    name: "LinkedIn",
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
      "is_open",
      "employment_type",
    ],
    extraInputs: {
      ua: { desc: "Browser User-Agent for the guest endpoints. Reads LI_UA from env. Default: bundled Chrome UA.", env: "LI_UA" },
      delayMs: { desc: "Pacing (ms) between sweep requests. Default 1500." },
      maxRounds: { desc: "Saturation rounds over still-empty offsets. Default 5." },
      maxOffset: { desc: "Hard cap on the last offset swept. Default: derived from totalResults, else 500." },
      retryBackoffMs: { desc: "Backoff schedule (ms) for shell/rate-limit retries. Default [4000, 8000, 16000]." },
      detailConcurrency: { desc: "Concurrent JD enrichment fetches. Default 2 (the detail endpoint rate-limits bursts)." },
      detailDelayMs: { desc: "Pacing (ms) between JD-enrichment requests. Default 1200." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const query = typeof ctx.input.query === "string" ? ctx.input.query.trim() : "";
    const location = typeof ctx.input.location === "string" ? ctx.input.location.trim() : "";
    const ua = typeof ctx.env.LI_UA === "string" && ctx.env.LI_UA.trim() ? ctx.env.LI_UA.trim() : DEFAULT_UA;
    const headers = { accept: "text/html,application/xhtml+xml", "user-agent": ua };
    const delayMs = intInRange(ctx.config.delayMs, DEFAULT_DELAY_MS, 0);
    const maxRounds = intInRange(ctx.config.maxRounds, DEFAULT_MAX_ROUNDS, 1);
    const detailConcurrency = intInRange(ctx.config.detailConcurrency, DEFAULT_DETAIL_CONCURRENCY, 1);
    const detailDelayMs = intInRange(ctx.config.detailDelayMs, DEFAULT_DETAIL_DELAY_MS, 0);
    const configMaxOffset =
      ctx.config.maxOffset === undefined || ctx.config.maxOffset === null
        ? null
        : intInRange(ctx.config.maxOffset, DEFAULT_MAX_OFFSET, 0);
    const backoff = Array.isArray(ctx.config.retryBackoffMs)
      ? (ctx.config.retryBackoffMs as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      : RETRY_BACKOFF_MS;

    const notes: string[] = [];
    if (ctx.input.employment_type) notes.push("employment_type filter is a verified no-op on the guest search endpoint; skipped");
    if (ctx.input.posted_within_days) notes.push("posted_within_days has no reliable guest-endpoint equivalent; skipped");
    if (ctx.input.sort) notes.push("sort is unsupported on the guest search endpoint; skipped");
    if (ctx.input.seniority) notes.push("seniority filter unsupported on the guest search endpoint; skipped");
    if (Number(ctx.input.page ?? 1) > 1) notes.push("page input ignored; adapter sweeps every page for coverage");

    // totalResults is informational (meta.coverage) — never a hard bound on the sweep.
    let totalResults: number | null = null;
    try {
      const p = new URLSearchParams();
      if (query) p.set("keywords", query);
      if (location) p.set("location", location);
      const res = await fetch(`${MAIN_PAGE}?${p.toString()}`, { headers });
      if (res.ok) totalResults = extractTotalResults(await res.text());
    } catch {
      /* best effort */
    }

    const maxOffset =
      configMaxOffset !== null
        ? configMaxOffset
        : totalResults !== null
          ? Math.floor((totalResults - 1) / PAGE_SIZE) * PAGE_SIZE
          : DEFAULT_MAX_OFFSET;

    const seen = new Map<string, LiCard>();
    let requests = 0;

    const fetchOffset = async (start: number): Promise<{ served: number; added: number }> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? RETRY_BACKOFF_MS[0]);
        requests++;
        let html: string;
        try {
          const p = new URLSearchParams();
          if (query) p.set("keywords", query);
          if (location) p.set("location", location);
          p.set("start", String(start));
          const res = await fetch(`${SEARCH_ENDPOINT}?${p.toString()}`, { headers });
          html = await res.text();
        } catch (error) {
          // Network-level failure (DNS/conn reset). Fail the run on the very first
          // list request; degrade individual offsets afterwards so one blip can't
          // abort the whole sweep.
          if (requests === 1) throw error;
          continue;
        }
        const cards = parseListPage(html);
        if (cards.length === 0) continue; // 200-shell, rate-limit HTML, or empty pool → retry
        let added = 0;
        for (const card of cards) {
          if (!seen.has(card.id)) {
            seen.set(card.id, card);
            added++;
          }
        }
        return { served: cards.length, added };
      }
      return { served: 0, added: 0 };
    };

    let emptySet: number[] = [];
    for (let start = 0; start <= maxOffset; start += PAGE_SIZE) emptySet.push(start);

    let rounds = 0;
    let roundAdded = 0;
    let servedTotal = 0;
    while (rounds < maxRounds && emptySet.length > 0) {
      rounds++;
      roundAdded = 0;
      const stillEmpty: number[] = [];
      for (const start of emptySet) {
        await sleep(delayMs);
        const { served, added } = await fetchOffset(start);
        if (served === 0) stillEmpty.push(start);
        servedTotal += served;
        roundAdded += added;
      }
      emptySet = stillEmpty;
      // Saturate: stop once a full round over the remaining offsets adds nothing new.
      // Round 1 alone is never enough (rotation), hence the min-2-rounds floor.
      if (roundAdded === 0 && rounds >= 2) break;
      // Hard-block guard: zero cards served anywhere and nothing seen yet.
      if (servedTotal === 0 && seen.size === 0) break;
    }

    const jobs: Job[] = [];
    for (const card of seen.values()) {
      const viewUrl = `https://www.linkedin.com/jobs/view/${card.id}/`;
      jobs.push({
        apply_url: viewUrl,
        job_page_url: viewUrl,
        external_id: card.id,
        title: card.title,
        company: card.company,
        location: card.location,
        posted_at: card.postedAt,
        is_open: card.isOpen,
      });
    }

    let jdFetched = 0;
    let jdFailed = 0;
    if (jobs.length > 0) {
      await mapLimit(jobs, detailConcurrency, async (job) => {
        const id = job.external_id;
        if (typeof id !== "string" || !id) return;
        await sleep(detailDelayMs); // pace: the detail endpoint rate-limits bursts (HTTP 429, 0 bytes)
        const detail = await fetchDetail(id, headers, backoff);
        if (detail.errored) {
          jdFailed++;
          return;
        }
        if (detail.description) {
          job.description = detail.description;
          jdFetched++;
        } else {
          jdFailed++;
        }
        if (detail.employmentType) job.employment_type = detail.employmentType;
        if (detail.seniority) job.seniority = detail.seniority;
      });
    }
    if (jdFailed > 0) notes.push(`${jdFailed} job detail fetch(es) failed; list-only fields retained for those`);
    if (servedTotal === 0 && seen.size === 0) notes.push("no list pages served any cards; possible guest-endpoint block or empty pool");
    if (emptySet.length > 0)
      notes.push(`${emptySet.length} offset(s) still empty after ${rounds} round(s); those jobs were unreachable this run`);

    return {
      jobs,
      meta: {
        totalResults,
        maxOffset,
        rounds,
        requests,
        uniqueFound: seen.size,
        coverage:
          totalResults !== null && totalResults > 0 ? Math.round((seen.size / totalResults) * 1000) / 10 : null,
        jdFetched,
        jdFailed,
        ua: ctx.env.LI_UA ? "custom (LI_UA)" : "default",
        note: [
          "coverage = uniqueFound/totalResults; LinkedIn's guest endpoint serves a time-varying subset of the pool and answers many offsets with HTTP-200 empty shells, so every offset is swept with shell retries (exponential backoff, 3 tries) and repeat rounds over still-empty offsets until a round adds no new jobs (min 2 rounds); apply_url = the LinkedIn job view page (external ATS URLs are not exposed to guests); description = full JD from /api/jobPosting/<id> as plain text, list-only fields retained on detail-fetch failure; is_open = 'Actively Hiring'/'Be an early applicant' badge on the list card, else null.",
          ...notes,
        ].join(" "),
      },
    };
  },
};
