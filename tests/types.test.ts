import { describe, it, expect } from "vitest";
import { OUTPUT_KEYS } from "../src/types.js";

describe("types", () => {
  it("defines the v0.1 contract output keys", () => {
    expect(OUTPUT_KEYS).toContain("apply_url");
    expect(OUTPUT_KEYS).toContain("job_page_url");
    expect(OUTPUT_KEYS).toContain("external_id");
    expect(OUTPUT_KEYS).toContain("source");
  });
});
