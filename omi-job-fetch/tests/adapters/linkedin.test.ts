import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extractTotalResults,
  linkedInAdapter,
  parseDetail,
  parseListPage,
} from "../../src/portals/linkedin.js";

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

const LIST = readFixture("linkedin-list.html");
const SHELL = readFixture("linkedin-shell.html");
const MAIN = readFixture("linkedin-main.html");
const DETAIL = readFixture("linkedin-detail.html");

/** Test knobs: no pacing, no backoff sleeps. */
const FAST = { delayMs: 0, retryBackoffMs: [0, 0, 0], detailDelayMs: 0 };

/**
 * Mock fetch routed by endpoint:
 *  - /jobs/search (main) → totalResults blob
 *  - /jobPosting/<id> (detail) → detail fixture
 *  - seeMoreJobPostings/search (list) → per-offset behavior via opts.list(start, callIndex)
 */
function mockFetch(opts: {
  list?: (start: number, callIndex: number) => Response | string;
  totalResults?: () => Response;
  detail?: (id: string) => Response;
  throwOnList?: boolean;
} = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const perOffset = new Map<number, number>();
  const state = {
    calls,
    listCallsFor: (start: number) => perOffset.get(start) ?? 0,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.includes("/jobPosting/")) {
      const id = url.split("/jobPosting/")[1] ?? "?";
      return opts.detail
        ? opts.detail(id)
        : new Response(DETAIL, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.includes("/jobs/search")) {
      return opts.totalResults
        ? opts.totalResults()
        : new Response(MAIN, { status: 200, headers: { "content-type": "text/html" } });
    }
    const sm = url.match(/start=(\d+)/);
    const start = sm ? Number(sm[1]) : 0;
    const idx = perOffset.get(start) ?? 0;
    perOffset.set(start, idx + 1);
    if (opts.throwOnList) throw new Error("list fetch network error");
    if (opts.list) {
      const out = opts.list(start, idx);
      return typeof out === "string"
        ? new Response(out, { status: 200, headers: { "content-type": "text/html" } })
        : out;
    }
    return new Response(LIST, { status: 200, headers: { "content-type": "text/html" } });
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseListPage", () => {
  it("parses real cards from the guest search page", () => {
    const cards = parseListPage(LIST);
    expect(cards).toHaveLength(2);
    expect(cards[0].id).toBe("4397220687");
    expect(String(cards[0].title)).toContain("Binance Accelerator Program");
    expect(cards[0].company).toBe("Binance");
    expect(cards[0].location).toBe("Hong Kong, Hong Kong SAR");
    expect(cards[0].postedAt).toBe("2026-08-15");
    expect(cards[0].isOpen).toBe(true);
    expect(cards[1].id).toBe("4434835417");
    expect(cards[1].company).toBe("Sapientia Technologies Limited");
    expect(cards[1].postedAt).toBe("2026-07-08");
    expect(cards[1].isOpen).toBeNull();
  });

  it("parses cards whose company has no linked page (bare subtitle text)", () => {
    const cards = parseListPage(readFixture("linkedin-list-unlinked-company.html"));
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("4418589518");
    expect(cards[0].company).toBe("VisionMatrix Technology Limited");
    expect(cards[0].title).toBe("Intern - Mobile Developer");
    expect(cards[0].location).toBe("Hong Kong, Hong Kong SAR");
    expect(cards[0].postedAt).toBe("2026-07-30");
    expect(cards[0].isOpen).toBeNull();
  });

  it("returns [] for a 200-empty-shell", () => {
    expect(parseListPage(SHELL)).toEqual([]);
  });
});

describe("parseDetail", () => {
  it("extracts the full JD as plain text plus the structured criteria", () => {
    const d = parseDetail(DETAIL);
    expect(d.description).toBeTruthy();
    expect(String(d.description)).toContain("Binance is a leading global blockchain ecosystem");
    expect(String(d.description)).not.toContain("<p");
    expect(String(d.description)).not.toContain("Show less");
    expect(d.employmentType).toBe("Internship");
    expect(d.seniority).toBe("Not Applicable");
  });
});

describe("extractTotalResults", () => {
  it("extracts the pool size from the main page blob", () => {
    expect(extractTotalResults(MAIN)).toBe(376);
    expect(extractTotalResults("<html>no results</html>")).toBeNull();
  });
});

describe("linkedInAdapter", () => {
  it("sweeps offsets, dedups by id, enriches the full JD, reports coverage", async () => {
    mockFetch();
    const result = await linkedInAdapter.run({
      input: { query: "tech intern", location: "Hong Kong" },
      env: {},
      config: { ...FAST, maxOffset: 20 },
    });

    expect(result.jobs).toHaveLength(2);
    const binance = result.jobs.find((j) => j.external_id === "4397220687")!;
    expect(binance.title).toBeTruthy();
    expect(String(binance.title)).toContain("Binance Accelerator Program");
    expect(binance.company).toBe("Binance");
    expect(binance.location).toBe("Hong Kong, Hong Kong SAR");
    expect(binance.posted_at).toBe("2026-08-15");
    expect(binance.is_open).toBe(true);
    expect(binance.apply_url).toBe("https://www.linkedin.com/jobs/view/4397220687/");
    expect(binance.job_page_url).toBe(binance.apply_url);
    expect(String(binance.description)).toContain("Binance is a leading global blockchain ecosystem");
    expect(binance.employment_type).toBe("Internship");
    expect(binance.seniority).toBe("Not Applicable");

    const sapientia = result.jobs.find((j) => j.external_id === "4434835417")!;
    expect(sapientia.is_open).toBeNull();
    expect(sapientia.posted_at).toBe("2026-07-08");

    expect(result.meta?.totalResults).toBe(376);
    expect(result.meta?.maxOffset).toBe(20);
    expect(result.meta?.uniqueFound).toBe(2);
    expect(result.meta?.coverage).toBe(0.5);
    expect(result.meta?.rounds).toBe(1);
    expect(result.meta?.requests).toBe(3);
    expect(result.meta?.jdFetched).toBe(2);
    expect(result.meta?.jdFailed).toBe(0);
  });

  it("retries 200-shells and revisits still-empty offsets in a later round", async () => {
    mockFetch({ list: (start, idx) => (start === 10 && idx < 4 ? SHELL : LIST) });
    const result = await linkedInAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxOffset: 10, maxRounds: 3 },
    });
    expect(result.meta?.rounds).toBe(2);
    expect(result.jobs).toHaveLength(2);
    expect(String(result.meta?.note)).not.toMatch(/still empty/);
  });

  it("stops sweeping once a round adds nothing new (saturation)", async () => {
    mockFetch({ list: (start) => (start === 10 ? SHELL : LIST) });
    const result = await linkedInAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxOffset: 10, maxRounds: 5 },
    });
    // Offset 0 serves (2 cards); offset 10 stays empty in every round. Round 2 adds
    // nothing new → saturation stops at 2 rounds instead of grinding to maxRounds 5.
    expect(result.meta?.rounds).toBe(2);
    expect(result.jobs).toHaveLength(2);
    expect(String(result.meta?.note)).toMatch(/still empty after 2 round/);
    expect(result.meta?.requests).toBe(9); // r1: offset0(1) + offset10(4 retries); r2: offset10(4)
  });

  it("degrades to an empty result with a block note when nothing serves", async () => {
    mockFetch({ list: () => SHELL });
    const result = await linkedInAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxOffset: 10 },
    });
    expect(result.jobs).toHaveLength(0);
    expect(result.meta?.rounds).toBe(1);
    expect(String(result.meta?.note)).toMatch(/block|served any cards/);
  });

  it("derives maxOffset from totalResults when not configured", async () => {
    mockFetch();
    const result = await linkedInAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.meta?.totalResults).toBe(376);
    expect(result.meta?.maxOffset).toBe(370);
    expect(result.meta?.requests).toBe(38);
  });

  it("handles a zero-result pool gracefully", async () => {
    mockFetch({
      totalResults: () =>
        new Response('<code id="totalResults" style="display: none"><!--0--></code>', { status: 200 }),
    });
    const result = await linkedInAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.jobs).toHaveLength(0);
    expect(result.meta?.totalResults).toBe(0);
    expect(result.meta?.coverage).toBeNull();
  });

  it("uses the LI_UA env var, falling back to a bundled Chrome UA", async () => {
    const custom = mockFetch();
    await linkedInAdapter.run({ input: { query: "x" }, env: { LI_UA: "MyUA/1.0" }, config: { ...FAST, maxOffset: 10 } });
    const listCall = custom.calls.find((c) => c.url.includes("/seeMoreJobPostings"));
    expect(listCall?.headers["user-agent"]).toBe("MyUA/1.0");

    const fallback = mockFetch();
    await linkedInAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxOffset: 10 } });
    const fbCall = fallback.calls.find((c) => c.url.includes("/seeMoreJobPostings"));
    expect(fbCall?.headers["user-agent"]).toMatch(/Chrome\/126\.0\.0\.0/);
  });

  it("fails the run when the first list request hits a network error", async () => {
    mockFetch({ throwOnList: true });
    await expect(
      linkedInAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxOffset: 10 } }),
    ).rejects.toThrow();
  });

  it("retries a rate-limited detail fetch before enriching the job", async () => {
    let attempts = 0;
    mockFetch({
      detail: () => {
        attempts++;
        return attempts % 2 === 1
          ? new Response("", { status: 429 })
          : new Response(DETAIL, { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    const result = await linkedInAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxOffset: 10 },
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.meta?.jdFetched).toBe(2);
    expect(result.meta?.jdFailed).toBe(0);
    expect(String(result.jobs[0].description)).toContain("Binance is a leading global blockchain ecosystem");
  });

  it("keeps list-only fields when a detail fetch fails", async () => {
    mockFetch({ detail: () => new Response("oops", { status: 500 }) });
    const result = await linkedInAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxOffset: 10 },
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0].description).toBeUndefined();
    expect(result.meta?.jdFetched).toBe(0);
    expect(result.meta?.jdFailed).toBe(2);
    expect(String(result.meta?.note)).toMatch(/detail fetch\(es\) failed/);
  });

  it("notes unsupported contract inputs instead of silently ignoring them", async () => {
    mockFetch();
    const result = await linkedInAdapter.run({
      input: { query: "x", employment_type: "internship", posted_within_days: 7, sort: "date", seniority: "intern", page: 2 },
      env: {},
      config: { ...FAST, maxOffset: 10 },
    });
    const note = String(result.meta?.note ?? "");
    expect(note).toMatch(/employment_type filter is a verified no-op/);
    expect(note).toMatch(/posted_within_days has no reliable/);
    expect(note).toMatch(/sort is unsupported/);
    expect(note).toMatch(/seniority filter unsupported/);
    expect(note).toMatch(/page input ignored/);
  });
});
