import { describe, it, expect } from "vitest";
import { INPUT_KEYS, OUTPUT_KEYS } from "../src/types.js";

describe("types", () => {
  it("defines the v0.1 contract input keys", () => {
    expect(INPUT_KEYS).toEqual([
      "query",
      "location",
      "posted_within_days",
      "employment_type",
      "sort",
      "page",
      "seniority",
    ]);
  });

  it("defines the v0.1 contract output keys", () => {
    expect(OUTPUT_KEYS).toContain("apply_url");
    expect(OUTPUT_KEYS).toContain("job_page_url");
    expect(OUTPUT_KEYS).toContain("external_id");
    expect(OUTPUT_KEYS).toContain("source");
  });
});
