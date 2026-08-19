import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eFinancialCareersAdapter, parseApply, parseSearch } from "../../src/portals/efinancialcareers.js";

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

const SEARCH = JSON.parse(readFixture("efinancial-search.json")) as {
  data: {
    id: string;
    jobId: string;
    title: string;
    detailsPageUrl: string;
    jobLocation: { displayName: string };
    postedDate: string;
    expirationDate: string;
    employmentType: string;
    isExternalApplication: boolean;
    companyName: string;
    clientBrandName: string;
    description: string;
  }[];
  meta: { totalResults: number };
};
const APPLY_EXT = readFixture("efinancial-apply-ext.json");
const APPLY_INAPP = readFixture("efinancial-apply-inapp.json");

/** Test knobs: no pacing, no retry sleeps. */
const FAST = { delayMs: 0, retryBackoffMs: [0, 0, 0] };

/**
 * Mock fetch routed by host:
 *  - job-search-ui.efinancialcareers.com → the search fixture at every page (totalResults 400 →
 *    2 pages), capturing the query string/headers
 *  - job-application.efinancialcareers.com → the external-apply fixture, except the Risk Manager
 *    (Mx88fgh9900WwWe) which returns 500 to exercise the fallback
 */
function mockFetch() {
  const state = {
    searchUrls: [] as string[],
    searchHeaders: [] as Record<string, string>[],
    applyCalls: 0,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("job-search-ui.efinancialcareers.com")) {
      state.searchUrls.push(url);
      state.searchHeaders.push((init?.headers as Record<string, string>) ?? {});
      return new Response(JSON.stringify(SEARCH), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("job-application.efinancialcareers.com")) {
      state.applyCalls++;
      if (url.includes("Mx88fgh9900WwWe")) return new Response("oops", { status: 500 });
      return new Response(APPLY_EXT, { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSearch", () => {
  it("extracts totalCount and a card's contract fields, stripping HTML from the description", () => {
    const { totalCount, cards } = parseSearch(SEARCH);
    expect(totalCount).toBe(400);
    expect(cards).toHaveLength(3);
    const c = cards[0];
    expect(c.id).toBe("RY1tpMWK0JoBaoL3");
    expect(c.jobId).toBe("24569180");
    expect(c.title).toBe("Quantitative Systematic Trading Internship - Master's: Summer 2027");
    expect(c.company).toBe("Susquehanna International Group");
    expect(c.location).toBe("Hong Kong");
    expect(c.url).toBe(
      "/jobs-Hong_Kong-Hong_Kong-Quantitative_Systematic_Trading_Internship-Masters_Summer_2027.id24569180",
    );
    expect(c.postedAt).toBe("2026-08-16T11:40:00.250Z");
    expect(c.expiresAt).toBe("2026-09-03T23:45:00.000Z");
    expect(c.employmentType).toBe("Full time");
    expect(c.isExternal).toBe(true);
    expect(String(c.description)).toContain("Quantitative Systematic Trading");
    expect(String(c.description)).toContain("Python");
    expect(String(c.description)).not.toContain("<strong>");
    expect(String(c.description)).not.toContain("<p>");
    expect(String(c.description)).not.toContain("<li>");
  });

  it("marks in-app jobs isExternal=false and tolerates a missing clientBrandName", () => {
    const { cards } = parseSearch({
      data: [
        { id: "Kd9abcXYZ12opQr", jobId: "24569181", title: "Compliance Analyst, Officer", isExternalApplication: false },
        { jobId: "1", title: "T", companyName: "A", description: "<p>Hello</p>" },
      ],
    });
    expect(cards[0].isExternal).toBe(false);
    expect(cards[1].company).toBe("A"); // companyName used when clientBrandName is absent
    expect(cards[1].id).toBeNull();
  });
});

describe("parseApply", () => {
  it("returns the employer-ATS URL for external applications", () => {
    expect(parseApply(JSON.parse(APPLY_EXT))).toEqual({
      externalUrl: "https://careers.sig.com/jobs/11122?utm_source=efinancialcareers",
      loginRequired: true,
    });
  });

  it("returns null externalUrl for in-app jobs (questionnaire flow)", () => {
    expect(parseApply(JSON.parse(APPLY_INAPP))).toEqual({ externalUrl: null, loginRequired: true });
  });
});

describe("eFinancialCareersAdapter", () => {
  it("sweeps pages from totalResults, dedups by jobId, fetches apply URLs for external jobs", async () => {
    const state = mockFetch();
    const result = await eFinancialCareersAdapter.run({ input: { query: "finance" }, env: {}, config: { ...FAST } });
    expect(result.meta?.totalCount).toBe(400);
    expect(result.meta?.pageCount).toBe(2);
    expect(result.meta?.pages).toBe(2);
    expect(result.meta?.requests).toBe(2);
    expect(result.meta?.uniqueFound).toBe(3);
    expect(result.meta?.coverage).toBe(0.8);
    // 2 external jobs → 1 success (1 call) + 1 failure (MAX_RETRIES+1 = 4 calls) = 5.
    expect(state.applyCalls).toBe(5);
    expect(result.meta?.applyFetched).toBe(1);
    expect(result.meta?.applyFailed).toBe(1);
    expect(result.jobs).toHaveLength(3);

    // External job → direct employer-ATS URL from the apply-information API.
    const ext = result.jobs.find((j) => j.external_id === "24569180")!;
    expect(ext.apply_url).toBe("https://careers.sig.com/jobs/11122?utm_source=efinancialcareers");
    expect(ext.job_page_url).toBe(
      "https://www.efinancialcareers.hk/jobs-Hong_Kong-Hong_Kong-Quantitative_Systematic_Trading_Internship-Masters_Summer_2027.id24569180",
    );
    expect(ext.title).toBe("Quantitative Systematic Trading Internship - Master's: Summer 2027");
    expect(ext.company).toBe("Susquehanna International Group");
    expect(ext.location).toBe("Hong Kong");
    expect(ext.posted_at).toBe("2026-08-16T11:40:00.250Z");
    expect(ext.is_open).toBe(true);
    expect(String(ext.description)).toContain("Quantitative Systematic Trading");

    // In-app job → no apply fetch; detail page is the entry point.
    const inapp = result.jobs.find((j) => j.external_id === "24569181")!;
    expect(inapp.apply_url).toBe(inapp.job_page_url);
    expect(inapp.job_page_url).toContain("id24569181");

    // Failed apply fetch → falls back to the detail page so the job isn't dropped.
    const failed = result.jobs.find((j) => j.external_id === "24569182")!;
    expect(failed.apply_url).toBe(failed.job_page_url);
    expect(String(result.meta?.note ?? "")).toMatch(/apply-URL fetch\(es\) failed/);
  });

  it("maps filters into dot-notation query params and reports no-ops as warnings", async () => {
    const state = mockFetch();
    const result = await eFinancialCareersAdapter.run({
      input: {
        query: "tech intern",
        location: "Hong Kong",
        posted_within_days: 7,
        employment_type: "internship",
        seniority: "entry",
        sort: "date",
        page: 2,
      },
      env: {},
      config: { ...FAST },
    });
    const params = new URL(state.searchUrls[0]).searchParams;
    expect(params.get("q")).toBe("tech intern");
    expect(params.get("location")).toBe("Hong Kong");
    expect(params.get("countryCode2")).toBe("HK");
    expect(params.get("culture")).toBe("en");
    expect(params.get("filters.positionType")).toBe("INTERNSHIPS_AND_GRADUATE_TRAINEE");
    expect(params.get("filters.seniority")).toBe("INTERN_GRADUATE");
    expect(params.get("filters.postedDate")).toBe("SEVEN");
    expect(params.get("filters.employmentType")).toBeNull(); // internship → positionType, not employmentType
    expect(params.get("pageSize")).toBe("200");
    expect(params.get("page")).toBe("1");
    expect(result.meta?.warnings).toContain(
      `sort "date" unsupported (eFinancialCareers sortBy is a server-side no-op); results are relevance-ordered`,
    );
    expect(result.meta?.warnings).toContain("page input ignored; adapter sweeps every page for coverage");
  });

  it("maps full-time to filters.employmentType and drops no filters", async () => {
    const state = mockFetch();
    await eFinancialCareersAdapter.run({
      input: { query: "x", employment_type: "full-time" },
      env: {},
      config: { ...FAST },
    });
    const params = new URL(state.searchUrls[0]).searchParams;
    expect(params.get("filters.employmentType")).toBe("FULL_TIME");
    expect(params.get("filters.positionType")).toBeNull();
  });

  it("skips posted_within_days beyond 7 with a warning instead of narrowing", async () => {
    const state = mockFetch();
    const result = await eFinancialCareersAdapter.run({
      input: { query: "x", posted_within_days: 30 },
      env: {},
      config: { ...FAST },
    });
    const params = new URL(state.searchUrls[0]).searchParams;
    expect(params.get("filters.postedDate")).toBeNull();
    expect(result.meta?.warnings).toContain(
      "posted_within_days 30 not supported beyond 7 days (eFinancialCareers filters.postedDate is ONE/THREE/SEVEN); filter not applied, post-filter client-side",
    );
  });

  it("notes unsupported filter values and skips them", async () => {
    const state = mockFetch();
    const result = await eFinancialCareersAdapter.run({
      input: { query: "x", employment_type: "freelance", seniority: "guru" },
      env: {},
      config: { ...FAST },
    });
    const params = new URL(state.searchUrls[0]).searchParams;
    expect(params.get("filters.employmentType")).toBeNull();
    expect(params.get("filters.positionType")).toBeNull();
    expect(params.get("filters.seniority")).toBeNull();
    expect(result.meta?.warnings).toContain(
      `employment_type "freelance" has no known eFinancialCareers filter; skipped`,
    );
    expect(result.meta?.warnings).toContain(`seniority "guru" has no known eFinancialCareers level; skipped`);
  });

  it("honors the countryCode2 config override and omits location when absent", async () => {
    const state = mockFetch();
    await eFinancialCareersAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, countryCode2: "SG" } });
    const params = new URL(state.searchUrls[0]).searchParams;
    expect(params.get("countryCode2")).toBe("SG");
    expect(params.get("location")).toBeNull();
  });

  it("uses the EF_UA env var for all requests, falling back to a bundled Chrome UA", async () => {
    const custom = mockFetch();
    await eFinancialCareersAdapter.run({ input: { query: "x" }, env: { EF_UA: "MyUA/1.0" }, config: { ...FAST } });
    expect(custom.searchHeaders[0]["user-agent"]).toBe("MyUA/1.0");

    const fallback = mockFetch();
    await eFinancialCareersAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(fallback.searchHeaders[0]["user-agent"]).toMatch(/Chrome\/126\.0\.0\.0/);
  });

  it("handles a zero-result pool gracefully", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("job-search-ui.efinancialcareers.com")) {
        return new Response(JSON.stringify({ data: [], meta: { totalResults: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(APPLY_EXT, { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await eFinancialCareersAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.jobs).toHaveLength(0);
    expect(result.meta?.totalCount).toBe(0);
    expect(result.meta?.coverage).toBeNull();
  });

  it("stops at the maxPages cap and notes when the pool is larger", async () => {
    const state = mockFetch();
    const result = await eFinancialCareersAdapter.run({
      input: { query: "x" },
      env: {},
      config: { ...FAST, maxPages: 1 },
    });
    expect(result.meta?.pages).toBe(1);
    expect(result.meta?.pageCount).toBe(1);
    expect(String(result.meta?.note ?? "")).toMatch(/maxPages cap/);
    expect(state.searchUrls).toHaveLength(1);
  });

  it("fails the run on a non-200 search response", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(eFinancialCareersAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("emits sweep and apply-URL progress via ctx.log", async () => {
    mockFetch();
    const logs: string[] = [];
    await eFinancialCareersAdapter.run({
      input: { query: "finance" },
      env: {},
      config: { ...FAST },
      log: (s) => logs.push(s),
    });
    expect(logs[0]).toBe("page 1/2 · 3 found");
    expect(logs).toContain("page 2/2 · 3 found");
    expect(logs[logs.length - 1]).toBe("apply URLs 3/3");
  });
});
