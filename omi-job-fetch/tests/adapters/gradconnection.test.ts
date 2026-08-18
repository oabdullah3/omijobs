import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradConnectionAdapter } from "../../src/portals/gradconnection.js";

function loadFixture(name: "gradconnection-search" | "gradconnection-locations" = "gradconnection-search"): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const DEFAULT_DETAIL = { content: { banner: null, body: "<p>Full JD body</p>" } };

function mockFetch(
  campaignBody: unknown,
  locationsBody: unknown | null = null,
  campaignDetailBody: unknown = DEFAULT_DETAIL,
) {
  const state = {
    capturedUrl: null as string | null,
    locationsCount: 0,
    locationsCalls: () => state.locationsCount,
    campaignDetailCount: 0,
    campaignDetailCalls: () => state.campaignDetailCount,
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
    state.capturedUrl = url;
    return new Response(JSON.stringify(campaignBody), {
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
  it("builds the search URL from contract inputs", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    await gradConnectionAdapter.run({
      input: { query: "finance intern", location: "Hong Kong", employment_type: "internship", page: 2 },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).toContain("https://hk.gradconnection.com/api/campaignsearch/?");
    expect(state.capturedUrl).toContain("query=finance+intern");
    expect(state.capturedUrl).toContain("location=hong-kong%2CHK%2CCountry");
    expect(state.capturedUrl).toContain("job_type=internships");
    expect(state.capturedUrl).toContain("limit=20");
    expect(state.capturedUrl).toContain("offset=20");
  });

  it("resolves a country location to the structured {slug},{code},Country param", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Hong Kong" },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).toContain("location=hong-kong%2CHK%2CCountry");
    expect(state.capturedUrl).not.toContain("location=Hong+Kong");
    expect(state.locationsCalls()).toBe(1);
    const note = String(result.meta?.note ?? "");
    expect(note).not.toMatch(/not found|resolution failed|city\/region-level/);
  });

  it("expands a city location to its parent country with a note", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Beijing" },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).toContain("location=china%2CCN%2CCountry");
    expect(String(result.meta?.note ?? "")).toMatch(/city\/region-level/);
    expect(String(result.meta?.note ?? "")).toContain("scoped to china");
  });

  it("omits the location param when the free text matches no node, and notes it", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Nowhereville" },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).not.toContain("location=");
    expect(String(result.meta?.note ?? "")).toMatch(/not found/);
  });

  it("uses the virtual Remote location", async () => {
    const state = mockFetch(loadFixture(), loadFixture("gradconnection-locations"));
    await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "remote" },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).toContain("location=remote%2CHK%2CRemote");
  });

  it("skips the location filter with a note when the locations API fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/locations/")) throw new Error("boom");
      return new Response(JSON.stringify(loadFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await gradConnectionAdapter.run({
      input: { query: "tech intern", location: "Hong Kong" },
      env: {},
      config: { country: "hk" },
    });
    expect(String(result.meta?.note ?? "")).toMatch(/location resolution failed/);
  });

  it("maps campaigns to contract fields and filters events + notify-me placeholders", async () => {
    mockFetch(loadFixture());
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { country: "hk" } });
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
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { country: "hk" } });
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
      config: { country: "hk" },
    });
    expect(result.jobs).toHaveLength(2);
    expect(String(result.jobs[0].description)).toContain("Begin your career in Corporate and Institutional Banking.");
    expect(result.meta?.jdFetched).toBe(0);
    expect(result.meta?.jdFailed).toBe(2);
  });

  it("omits the location param when location is not provided", async () => {
    const state = mockFetch(loadFixture());
    await gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { country: "hk" } });
    expect(state.capturedUrl).not.toContain("location=");
  });

  it("throws a descriptive error on non-200", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(
      gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: {} }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
