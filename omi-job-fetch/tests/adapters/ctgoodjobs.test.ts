import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ctGoodJobsAdapter, parseDetail, parseSearch, withTz } from "../../src/portals/ctgoodjobs.js";

function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

const SEARCH = JSON.parse(readFixture("ctgoodjobs-search.json")) as {
  data: {
    meta: { jobsTotal: number };
    jobs: {
      jobId: string;
      jobTitle: string;
      url: string;
      companyName: string;
      publishTime: { timestamp: string };
      validThrough: { timestamp: string };
      empTypes: { name: string }[];
      locations: string[] | null;
    }[];
  };
};
const DETAIL = readFixture("ctgoodjobs-detail.html");
const VID = readFixture("ctgoodjobs-vid.txt");

/** Test knobs: no pacing, no retry sleeps. */
const FAST = { delayMs: 0, retryBackoffMs: [0, 0, 0] };

/**
 * Mock fetch routed by URL substring:
 *  - /vid/vid-jobs.asp → the visitor-id CSV
 *  - /job/api/jobs/search → the search fixture at every page (jobsTotal 66 → 2 pages),
 *    capturing the POST body/headers
 *  - jobs.ctgoodjobs.hk/job/ (detail) → the detail fixture, unless opts.detail overrides
 */
function mockFetch(opts: { detail?: () => Response } = {}) {
  const state = {
    searchBodies: [] as Record<string, unknown>[],
    searchHeaders: [] as Record<string, string>[],
    vidCalls: 0,
    detailCalls: 0,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/vid/vid-jobs.asp")) {
      state.vidCalls++;
      return new Response(VID, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("/job/api/jobs/search")) {
      state.searchHeaders.push((init?.headers as Record<string, string>) ?? {});
      state.searchBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(SEARCH), { status: 200, headers: { "content-type": "application/json" } });
    }
    state.detailCalls++;
    if (opts.detail) return opts.detail();
    return new Response(DETAIL, { status: 200, headers: { "content-type": "text/html" } });
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withTz", () => {
  it("appends +08:00 to naive timestamps and leaves offset ones alone", () => {
    expect(withTz("2026-08-12T10:50:00")).toBe("2026-08-12T10:50:00+08:00");
    expect(withTz("2026-08-12T10:50:00Z")).toBe("2026-08-12T10:50:00Z");
    expect(withTz("2026-08-12T10:50:00+00:00")).toBe("2026-08-12T10:50:00+00:00");
    expect(withTz(null)).toBeNull();
    expect(withTz("")).toBeNull();
  });
});

describe("parseSearch", () => {
  it("extracts jobsTotal and the first card's contract fields", () => {
    const { totalCount, cards } = parseSearch(SEARCH);
    expect(totalCount).toBe(66);
    expect(cards).toHaveLength(4);
    const c = cards[0];
    expect(c.id).toBe("10222384");
    expect(c.title).toBe("Wealth Management Internship Program (Welcome Fresh Graduates)");
    expect(c.company).toBe("AMG Financial Group Limited");
    expect(c.location).toBe("Wan Chai");
    expect(c.postedAt).toBe("2026-08-12T10:50:00+08:00");
    expect(c.expiresAt).toBe("2026-09-11T00:00:00+08:00");
    expect(c.empType).toBe("Full-time");
    expect(c.url).toBe(
      "https://jobs.ctgoodjobs.hk/job/10222384/wealth-management-internship-program-welcome-fresh-graduates",
    );
  });

  it("strips <strong> highlight tags and leaves location null when the list omits it", () => {
    const { cards } = parseSearch(SEARCH);
    const strong = cards.find((c) => c.id === "10219150")!;
    expect(strong.title).toBe("Finance Transformation Assistant Manager (2-year contract)");
    expect(strong.location).toBeNull();
  });

  it("strips <strong> highlight tags from the company too", () => {
    const { cards } = parseSearch({
      data: {
        meta: { jobsTotal: 1 },
        jobs: [{ jobId: "1", jobTitle: "T", companyName: "AIA <strong>Intern</strong>ational Limited" }],
      },
    });
    expect(cards[0].company).toBe("AIA International Limited");
  });
});

describe("parseDetail", () => {
  it("extracts the JD as plain text and the jobLocation locality", () => {
    const { description, location } = parseDetail(DETAIL);
    expect(description).toBeTruthy();
    expect(String(description)).toContain("Job Description");
    expect(String(description)).not.toContain("<p");
    expect(String(description)).not.toContain("<strong>");
    expect(location).toBe("Hong Kong");
  });

  it("returns nulls for a page with no JSON-LD JobPosting", () => {
    expect(parseDetail("<html><body>oops</body></html>")).toEqual({ description: null, location: null });
  });
});

describe("ctGoodJobsAdapter", () => {
  it("bootstraps a visitor id, sweeps pages from jobsTotal, dedups by jobId, enriches", async () => {
    const state = mockFetch();
    const result = await ctGoodJobsAdapter.run({ input: { query: "finance" }, env: {}, config: { ...FAST } });
    expect(state.vidCalls).toBe(1);
    expect(result.meta?.totalCount).toBe(66);
    expect(result.meta?.pageCount).toBe(2);
    expect(result.meta?.pages).toBe(2);
    expect(result.meta?.requests).toBe(2);
    expect(result.meta?.uniqueFound).toBe(3);
    expect(result.meta?.coverage).toBe(4.5);
    expect(result.meta?.jdFetched).toBe(3);
    expect(result.meta?.jdFailed).toBe(0);
    expect(result.jobs).toHaveLength(3);

    const job = result.jobs.find((j) => j.external_id === "10222384")!;
    expect(job.apply_url).toBe("https://www.ctgoodjobs.hk/ctjob/apply/jobApply.asp?m_jobid=10222384");
    expect(job.job_page_url).toContain("jobs.ctgoodjobs.hk/job/10222384");
    expect(job.title).toBe("Wealth Management Internship Program (Welcome Fresh Graduates)");
    expect(job.company).toBe("AMG Financial Group Limited");
    expect(job.location).toBe("Wan Chai"); // specific list value kept
    expect(job.posted_at).toBe("2026-08-12T10:50:00+08:00");
    expect(job.employment_type).toBe("Full-time");
    expect(job.is_open).toBe(true);
    expect(String(job.description)).toContain("Job Description");

    // List locations null → backfilled from the detail JSON-LD's jobLocation.
    const backfilled = result.jobs.find((j) => j.external_id === "10226717")!;
    expect(backfilled.location).toBe("Hong Kong");
    expect(backfilled.description).toBeTruthy();
  });

  it("maps the supported filters into the search body and ignores location (HK-only)", async () => {
    const state = mockFetch();
    const result = await ctGoodJobsAdapter.run({
      input: {
        query: "tech intern",
        location: "Wan Chai",
        posted_within_days: 7,
        employment_type: "internship",
        sort: "date",
        seniority: "entry",
      },
      env: {},
      config: { ...FAST },
    });
    const body = state.searchBodies[0];
    expect(body.keyword).toBe("tech intern");
    expect(body.employmentTypeIds).toEqual(["007"]);
    expect(body.gradeIds).toEqual(["006"]);
    expect(body.locationIds).toEqual([]); // location ignored, whole-HK search
    expect(body.startPostDate).toBe("7");
    expect(body.sort).toBe(2);
    expect(body.pagingInputs.page).toBe("1");
    expect(body.pagingInputs.pageSize).toBe("33");
    const headers = state.searchHeaders[0];
    expect(headers["visitor-id"]).toBe(VID.trim().split(",")[0]);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["channel-id"]).toBe("001");
    expect(headers.lang).toBe("en-US");
    // The ignore surfaces as a warning the CLI prints.
    expect(result.meta?.warnings).toEqual([
      `location "Wan Chai" ignored — CTgoodjobs is Hong Kong-only; all results are HK jobs`,
    ]);
  });

  it("accepts HK-aligned locations silently (no warning)", async () => {
    for (const location of ["Hong Kong", "HK", "hong kong", "HKG"]) {
      const state = mockFetch();
      const result = await ctGoodJobsAdapter.run({ input: { query: "x", location }, env: {}, config: { ...FAST } });
      expect(result.meta?.warnings).toEqual([]); // already matches the whole-HK scope
      expect(state.searchBodies[0].locationIds).toEqual([]); // still whole-HK
    }
  });

  it("notes unsupported filter values and skips them", async () => {
    const state = mockFetch();
    const result = await ctGoodJobsAdapter.run({
      input: { query: "x", employment_type: "weird", seniority: "guru", sort: "salary" },
      env: {},
      config: { ...FAST },
    });
    const body = state.searchBodies[0];
    expect(body.employmentTypeIds).toEqual([]);
    expect(body.gradeIds).toEqual([]);
    expect("sort" in body).toBe(false);
    const note = String(result.meta?.note ?? "");
    expect(note).toMatch(/no known CTgoodjobs emptype/);
    expect(note).toMatch(/no known CTgoodjobs grade/);
    expect(note).toMatch(/sort "salary" unsupported/);
  });

  it("fails the run when the visitor-id bootstrap fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/vid/vid-jobs.asp")) throw new Error("network down");
      return new Response(JSON.stringify(SEARCH), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(ctGoodJobsAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } })).rejects.toThrow();
  });

  it("keeps null description and null location when detail fetches fail", async () => {
    const state = mockFetch({ detail: () => new Response("oops", { status: 500 }) });
    const result = await ctGoodJobsAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.meta?.jdFetched).toBe(0);
    expect(result.meta?.jdFailed).toBe(3);
    expect(String(result.meta?.note ?? "")).toMatch(/detail fetch\(es\) failed/);
    const job = result.jobs.find((j) => j.external_id === "10222384")!;
    expect(job.description).toBeNull();
    expect(job.location).toBe("Wan Chai"); // list value survives
    const missing = result.jobs.find((j) => j.external_id === "10226717")!;
    expect(missing.location).toBeNull(); // runtime drops it, which is honest
  });

  it("stops at the maxPages cap and notes when the pool is larger", async () => {
    const state = mockFetch();
    const result = await ctGoodJobsAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxPages: 1 } });
    expect(result.meta?.pages).toBe(1);
    expect(result.meta?.pageCount).toBe(1);
    expect(String(result.meta?.note ?? "")).toMatch(/maxPages cap/);
    expect(state.searchBodies).toHaveLength(1);
  });

  it("handles a zero-result pool gracefully", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/vid/vid-jobs.asp")) return new Response(VID, { status: 200 });
      return new Response(
        JSON.stringify({ data: { meta: { jobsTotal: 0 }, jobs: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await ctGoodJobsAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(result.jobs).toHaveLength(0);
    expect(result.meta?.totalCount).toBe(0);
    expect(result.meta?.coverage).toBeNull();
  });

  it("uses the JD_UA env var for all requests, falling back to a bundled Chrome UA", async () => {
    const custom = mockFetch();
    await ctGoodJobsAdapter.run({ input: { query: "x" }, env: { JD_UA: "MyUA/1.0" }, config: { ...FAST } });
    expect(custom.searchHeaders[0]["user-agent"]).toBe("MyUA/1.0");

    const fallback = mockFetch();
    await ctGoodJobsAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(fallback.searchHeaders[0]["user-agent"]).toMatch(/Chrome\/126\.0\.0\.0/);
  });
});
