import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobsDbAdapter, parseDetail, parseSearch } from "../../src/portals/jobsdb.js";

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

const SEARCH = JSON.parse(readFixture("jobsdb-search.json")) as {
  totalCount: number;
  data: { id: string; title: string; companyName: string; teaser: string; listingDate: string; workTypes: string[] }[];
};
const DETAIL = readFixture("jobsdb-detail.html");

/** Test knobs: no pacing, no retry sleeps. */
const FAST = { siteKey: "HK-Main", delayMs: 0, retryBackoffMs: [0, 0, 0] };

/**
 * Mock fetch routed by endpoint:
 *  - /api/jobsearch/v5/search → the search fixture at every page (totalCount 198,
 *    20 jobs/page), unless opts.search overrides per page
 *  - /job/<id> (detail) → the detail fixture
 */
function mockFetch(opts: { search?: (page: number) => unknown; detail?: (id: string) => Response } = {}) {
  const state = {
    searchCalls: [] as { url: string; headers: Record<string, string> }[],
    detailCalls: 0,
    searchCount: () => state.searchCalls.length,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/jobsearch/v5/search")) {
      state.searchCalls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      const body = opts.search ? opts.search(page) : SEARCH;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    state.detailCalls++;
    if (opts.detail) return opts.detail(String(url));
    return new Response(DETAIL, { status: 200, headers: { "content-type": "text/html" } });
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSearch", () => {
  it("extracts totalCount and the first card's contract fields", () => {
    const { totalCount, cards } = parseSearch(SEARCH);
    expect(totalCount).toBe(198);
    expect(cards).toHaveLength(20);
    const c = cards[0];
    expect(c.id).toBe("94002843");
    expect(c.title).toBe("Summer Associate, Software Engineering");
    expect(c.company).toBe("Balyasny Asset Management");
    expect(c.location).toBe("Hong Kong SAR");
    expect(c.postedAt).toBe("2026-08-16T11:10:20Z");
    expect(c.workTypes).toBe("Full time");
    expect(c.teaser).toBeTruthy();
  });

  it("falls back to advertiser.description when companyName is absent", () => {
    const { cards } = parseSearch({
      totalCount: 2,
      data: [
        { id: "1", title: "No CompanyName Job", advertiser: { description: "Balyasny" } },
        { id: "2", title: "Empty CompanyName", companyName: "", advertiser: { description: "Nokia (China) Investment Co Ltd" } },
        { id: "3", title: "No advertiser either" },
      ],
    });
    expect(cards[0].company).toBe("Balyasny");
    expect(cards[1].company).toBe("Nokia (China) Investment Co Ltd");
    expect(cards[2].company).toBeNull();
  });
});

describe("parseDetail", () => {
  it("extracts the full JD as plain text from the jobAdDetails block", () => {
    const { description } = parseDetail(DETAIL);
    expect(description).toBeTruthy();
    expect(String(description)).toContain("unique 10-week software engineering internship");
    expect(String(description)).not.toContain("<div");
    expect(String(description)).not.toContain("<p");
  });
});

describe("jobsDbAdapter", () => {
  it("sweeps all pages derived from totalCount, dedups by id, enriches the full JD", async () => {
    // The fixture (20 jobs) is served at every page → totalCount 198 wants 10 pages;
    // dedup collapses them to 20 unique jobs.
    mockFetch();
    const result = await jobsDbAdapter.run({ input: { query: "tech intern" }, env: {}, config: { ...FAST } });
    expect(result.meta?.totalCount).toBe(198);
    expect(result.meta?.pageCount).toBe(10);
    expect(result.meta?.pages).toBe(10);
    expect(result.meta?.requests).toBe(10);
    expect(result.meta?.uniqueFound).toBe(20);
    expect(result.meta?.coverage).toBe(10.1);
    expect(result.meta?.jdFetched).toBe(20);
    expect(result.meta?.jdFailed).toBe(0);
    expect(result.jobs).toHaveLength(20);
    const job = result.jobs.find((j) => j.external_id === "94002843")!;
    expect(job.title).toBe("Summer Associate, Software Engineering");
    expect(job.company).toBe("Balyasny Asset Management");
    expect(job.apply_url).toBe("https://hk.jobsdb.com/job/94002843/apply");
    expect(job.job_page_url).toBe("https://hk.jobsdb.com/job/94002843");
    expect(job.posted_at).toBe("2026-08-16T11:10:20Z");
    expect(job.employment_type).toBe("Full time");
    expect(String(job.description)).toContain("unique 10-week software engineering internship");
  });

  it("builds filter params and notes unsupported inputs", async () => {
    const state = mockFetch();
    const result = await jobsDbAdapter.run({
      input: {
        query: "tech intern",
        location: "Hong Kong",
        posted_within_days: 7,
        employment_type: "full-time",
        sort: "date",
        seniority: "intern",
        page: 2,
      },
      env: {},
      config: { ...FAST },
    });
    const first = state.searchCalls[0].url;
    expect(first).toContain("siteKey=HK-Main");
    expect(first).toContain("keywords=tech+intern");
    expect(first).toContain("where=Hong+Kong");
    expect(first).toContain("daterange=7");
    expect(first).toContain("worktype=242");
    expect(first).toContain("sortmode=ListedDate");
    const note = String(result.meta?.note ?? "");
    expect(note).toMatch(/seniority filter unsupported/);
    expect(note).toMatch(/page input ignored/);
  });

  it("skips unknown employment_type and sort values with notes", async () => {
    const state = mockFetch();
    const result = await jobsDbAdapter.run({
      input: { query: "x", employment_type: "internship", sort: "salary" },
      env: {},
      config: { ...FAST },
    });
    expect(state.searchCalls[0].url).not.toContain("worktype=");
    expect(state.searchCalls[0].url).not.toContain("sortmode=");
    const note = String(result.meta?.note ?? "");
    expect(note).toMatch(/no known JobsDB worktype/);
    expect(note).toMatch(/unsupported/);
  });

  it("stops early with a note when a page comes back empty before pageCount", async () => {
    mockFetch({ search: (page) => (page === 1 ? SEARCH : { totalCount: 198, data: [] }) });
    const result = await jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.meta?.pages).toBe(2);
    expect(result.jobs).toHaveLength(20);
    expect(String(result.meta?.note ?? "")).toMatch(/returned no jobs/);
  });

  it("falls back to the search teaser when a detail fetch fails", async () => {
    mockFetch({ detail: () => new Response("oops", { status: 500 }) });
    const result = await jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.meta?.jdFetched).toBe(0);
    expect(result.meta?.jdFailed).toBe(20);
    expect(String(result.meta?.note ?? "")).toMatch(/detail fetch\(es\) failed/);
    const job = result.jobs[0];
    expect(job.description).toBe(SEARCH.data[0].teaser);
  });

  it("uses the JD_UA env var, falling back to a bundled Chrome UA", async () => {
    const custom = mockFetch();
    await jobsDbAdapter.run({ input: { query: "x" }, env: { JD_UA: "MyUA/1.0" }, config: { ...FAST } });
    expect(custom.searchCalls[0].headers["user-agent"]).toBe("MyUA/1.0");

    const fallback = mockFetch();
    await jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(fallback.searchCalls[0].headers["user-agent"]).toMatch(/Chrome\/126\.0\.0\.0/);
  });

  it("handles a zero-result pool gracefully", async () => {
    mockFetch({ search: () => ({ totalCount: 0, data: [] }) });
    const result = await jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.jobs).toHaveLength(0);
    expect(result.meta?.totalCount).toBe(0);
    expect(result.meta?.coverage).toBeNull();
  });

  it("stops at the maxPages cap and notes when the pool is larger", async () => {
    mockFetch(); // 20 jobs on every page → dedup collapses; the cap bounds the sweep
    const result = await jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxPages: 3 } });
    expect(result.meta?.pages).toBe(3);
    expect(result.meta?.pageCount).toBe(3);
    expect(String(result.meta?.note ?? "")).toMatch(/maxPages cap/);
  });

  it("fails the run when the first search request hits a network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(
      jobsDbAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } }),
    ).rejects.toThrow();
  });

  it("emits sweep and JD progress via ctx.log", async () => {
    mockFetch();
    const logs: string[] = [];
    await jobsDbAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST },
      log: (s) => logs.push(s),
    });
    expect(logs[0]).toBe("page 1/10 · 20 found");
    expect(logs).toContain("page 10/10 · 20 found");
    expect(logs[logs.length - 1]).toBe("JD 20/20");
  });
});
