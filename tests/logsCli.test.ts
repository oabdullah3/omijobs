import { describe, it, expect } from "vitest";
import { parseLogsArgs } from "../src/logsCli.js";

describe("parseLogsArgs", () => {
  it("parses filters and the json flag", () => {
    const r = parseLogsArgs(["--source", "run,analysis", "--level", "error", "--run", "r1", "--q", "timeout", "--limit", "50", "--json"]);
    expect(r).not.toHaveProperty("error");
    if ("error" in r) return;
    expect(r.filter.source).toEqual(["run", "analysis"]);
    expect(r.filter.level).toEqual(["error"]);
    expect(r.filter.runId).toBe("r1");
    expect(r.filter.q).toBe("timeout");
    expect(r.filter.limit).toBe(50);
    expect(r.json).toBe(true);
  });

  it("parses a relative --from", () => {
    const r = parseLogsArgs(["--from", "30m"]);
    if ("error" in r) throw new Error("unexpected error");
    expect(typeof r.filter.from).toBe("string");
    expect(r.filter.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an unknown flag", () => {
    expect(parseLogsArgs(["--bogus"])).toHaveProperty("error");
  });
});
