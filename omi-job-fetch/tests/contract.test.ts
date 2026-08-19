import { describe, it, expect } from "vitest";
import { DEFAULT_REQUIRED_OUTPUTS, requiredOutputs } from "../src/contract.js";
import type { RunConfig } from "../src/types.js";

function config(partial: Partial<RunConfig> = {}): RunConfig {
  return { portals: { enabled: [] }, ats: { enabled: [] }, dedup: {}, ...partial };
}

describe("requiredOutputs", () => {
  it("returns the defaults when outputs.required is unset", () => {
    expect(DEFAULT_REQUIRED_OUTPUTS).toEqual(["apply_url", "title", "company", "location", "source"]);
    expect(requiredOutputs(config())).toEqual(DEFAULT_REQUIRED_OUTPUTS);
  });

  it("uses outputs.required when set", () => {
    const cfg = config({ outputs: { required: ["title", "company"] } });
    expect(requiredOutputs(cfg)).toEqual(["title", "company"]);
  });

  it("honors an explicit empty list (require nothing)", () => {
    const cfg = config({ outputs: { required: [] } });
    expect(requiredOutputs(cfg)).toEqual([]);
  });
});
