import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradConnectionAdapter } from "../../src/portals/gradconnection.js";

function loadFixture(name: "gradconnection-search" | "gradconnection-locations" = "gradconnection-search"): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const DEFAULT_DETAIL = { content: { banner: null, body: "<p>Full JD body</p>" } };

/** Test knobs: no pacing, no retry sleeps. */
const FAST = { country: "hk", delayMs: 0, retryBackoffMs: [0, 0, 0] };

/**
 * Mock fetch routed by endpoint:
 *  - /api/locations/ → locations fixture
 *  - /api/campaigns/ → campaign detail fixture
 *  - campaignsearch → the search fixture at offset 0, an empty array at every offset ≥ 20
 *    (the sweep stops on the first empty page).
 */
function mockFetch(
  campaignBody: unknown,
  locationsBody: unknown | null = null,
  campaignDetailBody: unknown = DEFAULT_DETAIL,
) {
  const state = {
    searchRequests: [] as string[],
    locationsCount: 0,
    locationsCalls: () => state.locationsCount,
    campaignDetailCount: 0,
    campaignDetailCalls: () => state.campaignDetailCount,
    searchCount: () => state.searchRequests.length,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/locations/")) {
      state.locationsCount++;
      if (locationsBody === null) throw new Error("locations fetch not mocked");
      return new Response(JSON.stringify(locationsBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/campaigns/")) {
      state.campaignDetailCount++;
      if (campaignDetailBody === null) throw new Error("campaign detail fetch not mocked");
      return new Response(JSON.stringify(campaignDetailBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    state.searchRequests.push(url);
    const offset = Number(url.match(/offset=(\d+)/)?.[1] ?? 0);
    const body = offset === 0 ? campaignBody : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gradConnectionAdapter", () => {
  it("builds the search URL from contract inputs and notes that page is ignored", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "finance intern", location: "Hong Kong", employment_type: "internship", page: 2 },
      env: {},
      config: { ...FAST },
    });
    const first = state.searchRequests[0];
    expect(first).toContain("https://hk.gradconnection.com/api/campaignsearch/?");
    expect(first).toContain("query=finance+intern");
    expect(first).toContain("location=hong-kong%2CHK%2CCountry");
    expect(first).toContain("job_type=internships");
    expect(first).toContain("limit=20");
    expect(first).toContain("offset=0");
    expect(String(result.meta?.note ?? "")).toMatch(/page input ignored/);
  });

  it("sweeps every offset until the API returns an empty page", async () => {
    const state = mockFetch(loadFixture());
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { ...FAST } });
    expect(state.searchCount()).toBe(2); // offset 0 (2 campaigns) then offset 20 ([])
    expect(state.searchRequests[1]).toContain("offset=20");
    expect(result.jobs).toHaveLength(2);
    expect(result.meta?.pages).toBe(2);
    expect(result.meta?.requests).toBe(2);
    expect(result.meta?.uniqueFound).toBe(2);
  });

  it("dedups campaigns repeated across pages", async () => {
    // Same fixture served at every offset — the repeated campaigns must not double.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/campaigns/")) return new Response(JSON.stringify(DEFAULT_DETAIL), { status: 200 });
      return new Response(JSON.stringify(loadFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxPages: 3 } });
    expect(result.jobs).toHaveLength(2);
    expect(result.meta?.uniqueFound).toBe(2);
    expect(result.meta?.pages).toBe(3);
  });

  it("stops at the maxPages cap and notes when the pool is larger", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/campaigns/")) return new Response(JSON.stringify(DEFAULT_DETAIL), { status: 200 });
      return new Response(JSON.stringify(loadFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST, maxPages: 3 } });
    expect(String(result.meta?.note ?? "")).toMatch(/maxPages cap/);
  });

  it("resolves a country location to the structured {slug},{code},Country param", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Hong Kong" },
      env: {},
      config: { ...FAST },
    });
    expect(state.searchRequests[0]).toContain("location=hong-kong%2CHK%2CCountry");
    expect(state.searchRequests[0]).not.toContain("location=Hong+Kong");
    expect(state.locationsCalls()).toBe(1);
    const note = String(result.meta?.note ?? "");
    expect(note).not.toMatch(/not found|resolution failed|city\/region-level/);
  });

  it("expands a city location to its parent country with a note", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Beijing" },
      env: {},
      config: { ...FAST },
    });
    expect(state.searchRequests[0]).toContain("location=china%2CCN%2CCountry");
    expect(String(result.meta?.note ?? "")).toMatch(/city\/region-level/);
    expect(String(result.meta?.note ?? "")).toContain("scoped to china");
  });

  it("aborts the run when the free text matches no location node", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    await expect(
      gradConnectionAdapter.run({
        input: { query: "tech intern", location: "Nowhereville" },
        env: {},
        config: { ...FAST },
      }),
    ).rejects.toThrow(/not found in GradConnection/);
    expect(state.locationsCalls()).toBe(1);
    expect(state.searchCount()).toBe(0); // no unfiltered fallback sweep
  });

  it("uses the virtual Remote location", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "remote" },
      env: {},
      config: { ...FAST },
    });
    expect(state.searchRequests[0]).toContain("location=remote%2CHK%2CRemote");
  });

  it("aborts the run when the locations API fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/locations/")) throw new Error("boom");
      return new Response(JSON.stringify(loadFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(
      gradConnectionAdapter.run({
        input: { query: "tech intern", location: "Hong Kong" },
        env: {},
        config: { ...FAST },
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it("maps campaigns to contract fields and filters events + notify-me placeholders", async () => {
    mockFetch(loadFixture());
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { ...FAST } });
    expect(result.jobs).toHaveLength(2);
    expect(result.meta?.jdFetched).toBe(2);
    expect(result.meta?.jdFailed).toBe(0);
    const job = result.jobs[0];
    expect(job.title).toBe("2027 HSBC Hong Kong CIB Summer Internship Programmes");
    expect(job.company).toBe("HSBC");
    expect(job.location).toBe("Hong Kong");
    // Full JD from /api/campaigns/<id>/ replaces the one-line search snippet.
    expect(String(job.description)).toContain("Full JD body");
    expect(String(job.description)).not.toContain("Begin your career");
    expect(job.apply_url).toBe(
      "https://www.hsbc.com/careers/students-and-graduates/find-a-programme?location=hong-kong-sar&page=1&programme-type=graduate-programme",
    );
    expect(job.external_id).toBe("ba203332-7dac-4f0c-a6dc-67feea884367");
    expect(job.job_page_url).toBe(
      "https://hk.gradconnection.com/employers/hsbc/jobs/hsbc-2027-hsbc-hong-kong-cib-summer-internship-programmes/",
    );
    expect(job.posted_at).toBe("2026-07-15T00:00:50+00:00");
    expect(job.expires_at).toBe("2099-12-31T12:59:00+00:00");
    expect(job.is_open).toBe(true);
    expect(job.employment_type).toBe("Internships");
  });

  it("falls back to the GC job page as apply_url for quick-apply listings (no external target/email)", async () => {
    mockFetch(loadFixture());
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { ...FAST } });
    const quick = result.jobs[1];
    expect(quick.title).toBe("Group Fitness Intern (Junior Trainer)");
    expect(quick.apply_url).toBe(
      "https://hk.gradconnection.com/employers/hybrid/jobs/hybrid-group-fitness-intern-junior-trainer-74/",
    );
    expect(quick.apply_url).toBe(quick.job_page_url);
  });

  it("falls back to the search snippet when a campaign detail fetch fails", async () => {
    mockFetch(loadFixture(), null, null); // null detail body → detail fetch throws
    const result = await gradConnectionAdapter.run({
      input: { query: "finance intern" },
      env: {},
      config: { ...FAST },
    });
    expect(result.jobs).toHaveLength(2);
    expect(String(result.jobs[0].description)).toContain("Begin your career in Corporate and Institutional Banking.");
    expect(result.meta?.jdFetched).toBe(0);
    expect(result.meta?.jdFailed).toBe(2);
  });

  it("omits the location param when location is not provided", async () => {
    const state = mockFetch(loadFixture());
    await gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } });
    expect(state.searchRequests[0]).not.toContain("location=");
  });

  it("throws a descriptive error on non-200", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(
      gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { ...FAST } }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("emits sweep and JD progress via ctx.log", async () => {
    mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const logs: string[] = [];
    await gradConnectionAdapter.run({
      input: { query: "finance intern" },
      env: {},
      config: { ...FAST },
      log: (s) => logs.push(s),
    });
    expect(logs[0]).toBe("offset 20 · 2 found");
    expect(logs[logs.length - 1]).toBe("JD 2/2");
  });
});
