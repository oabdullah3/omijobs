import { describe, it, expect } from "vitest";
import { normalizeJob } from "../src/normalize.js";

const provided = ["apply_url", "title", "company", "location", "external_id"];

describe("normalizeJob", () => {
  it("fills provided outputs, nulls the rest, sets source, preserves extras", () => {
    const job = normalizeJob(
      { title: "T", company: "C", location: "HK", apply_url: "https://a", external_id: "123", extra: "keep" },
      "gc",
      provided,
      ["apply_url", "title", "company", "location", "source"],
    );
    expect(job).not.toBeNull();
    expect(job!.title).toBe("T");
    expect(job!.description).toBeNull();
    expect(job!.source).toBe("gc");
    expect(job!.extra).toBe("keep");
  });

  it("returns null when a required output is missing", () => {
    const job = normalizeJob({ title: "T", company: "C", location: "HK" }, "gc", provided, ["apply_url", "title"]);
    expect(job).toBeNull();
  });

  it("treats an empty string as missing for required outputs", () => {
    const job = normalizeJob({ title: "", company: "C", location: "HK", apply_url: "https://a" }, "gc", provided, ["title"]);
    expect(job).toBeNull();
  });
});
