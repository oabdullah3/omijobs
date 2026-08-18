import { describe, it, expect } from "vitest";
import { dedupJobs, normalizeForHash, signature } from "../src/dedup.js";

describe("normalizeForHash", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeForHash("  HSBC   HONG KONG ")).toBe("hsbc hong kong");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeForHash(null)).toBe("");
    expect(normalizeForHash(undefined)).toBe("");
  });
});

describe("signature", () => {
  it("joins normalized fields with |", () => {
    expect(
      signature({ title: "Graduate Program", company: "  HSBC", location: "Hong Kong" }, ["title", "company", "location"]),
    ).toBe("graduate program|hsbc|hong kong");
  });
});

describe("dedupJobs", () => {
  it("dedups identical title/company/location and merges sources", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "gradconnection" },
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "jobsdb" },
      ],
      ["title", "company", "location"],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sources).toEqual(["gradconnection", "jobsdb"]);
  });

  it("keeps distinct jobs", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "gc" },
        { title: "Trading Intern", company: "Jane Street", location: "Hong Kong", source: "gc" },
      ],
      ["title", "company", "location"],
    );
    expect(jobs).toHaveLength(2);
  });

  it("does not dedup when a config-extended field differs", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a", source: "gc" },
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://b", source: "gc" },
      ],
      ["title", "company", "location", "apply_url"],
    );
    expect(jobs).toHaveLength(2);
  });

  it("keeps jobs with an empty signature without deduping", () => {
    const jobs = dedupJobs([{ title: "", company: "", location: "", source: "gc" }], ["title", "company", "location"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sources).toEqual(["gc"]);
  });
});
