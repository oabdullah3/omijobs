import { describe, it, expect } from "vitest";
import { DEFAULT_CONTRACT, buildInput, requiredOutputs, resolveContract } from "../src/contract.js";

describe("resolveContract", () => {
  it("returns the default contract when no config is given", () => {
    const c = resolveContract();
    expect(c.inputs.query.required).toBe(true);
    expect(c.inputs.page.default).toBe(1);
    expect(requiredOutputs(c)).toEqual(["apply_url", "title", "company", "location", "source"]);
  });

  it("merges config overrides on top of defaults", () => {
    const c = resolveContract({
      inputs: { location: { required: true } },
      outputs: { description: { required: true } },
    });
    expect(c.inputs.location.required).toBe(true);
    expect(c.inputs.query.required).toBe(true); // unchanged
    expect(c.outputs.description.required).toBe(true);
    expect(c.outputs.title.required).toBe(true); // unchanged
  });

  it("adds brand-new inputs from config", () => {
    const c = resolveContract({ inputs: { discipline: { required: false, default: "finance" } } });
    expect(c.inputs.discipline).toEqual({ required: false, default: "finance" });
  });
});

describe("buildInput", () => {
  it("applies defaults for unset non-required inputs", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad" });
    expect(input.query).toBe("grad");
    expect(input.page).toBe(1);
  });

  it("prefers CLI values over defaults", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad", page: 3 });
    expect(input.page).toBe(3);
  });

  it("throws when a required input is missing", () => {
    expect(() => buildInput(DEFAULT_CONTRACT, {})).toThrow(/Missing required contract inputs: query/);
  });

  it("passes through CLI keys not in the contract", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad", country: "sg" });
    expect(input.country).toBe("sg");
  });
});
