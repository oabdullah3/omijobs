import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEDUP_FIELDS, exitCode, runPipeline } from "../src/runtime.js";
import type { Adapter, RunConfig } from "../src/types.js";

function makeAdapter(
  id: string,
  family: "portal" | "ats",
  jobs: Record<string, unknown>[],
  manifest: Partial<Adapter["manifest"]> = {},
): Adapter {
  return {
    manifest: {
      id,
      family,
      name: id,
      requiredInputs: ["query"],
      optionalInputs: [],
      providedOutputs: ["apply_url", "title", "company", "location"],
      ...manifest,
    },
    async run() {
      return { jobs, meta: { note: "fake" } };
    },
  };
}

function config(enabled: string[]): RunConfig {
  return {
    portals: { enabled, config: {} },
    ats: { enabled: [], config: {} },
    dedup: { fields: DEFAULT_DEDUP_FIELDS },
  };
}

describe("runPipeline", () => {
  it("runs adapters, writes jobs.json and run.json, exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a" },
      ]);
      const result = await runPipeline(config(["gc"]), { query: "grad" }, [adapter], { outputDir: dir });
      expect(result.summary.adapters[0].status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
      const jobs = JSON.parse(await readFile(result.jobsFile, "utf8"));
      expect(jobs[0].source).toBe("gc");
      const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
      expect(runMeta.contract.inputs.query.required).toBe(true);
      expect(exitCode(result.summary)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues after an adapter error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const bad: Adapter = {
        manifest: { id: "bad", family: "portal", name: "Bad", requiredInputs: ["query"], optionalInputs: [], providedOutputs: [] },
        async run() {
          throw new Error("boom");
        },
      };
      const good = makeAdapter("gc", "portal", [{ title: "T", company: "C", location: "HK", apply_url: "https://a" }]);
      const result = await runPipeline(config(["bad", "gc"]), { query: "q" }, [bad, good], { outputDir: dir });
      const statuses = result.summary.adapters;
      expect(statuses.find((s) => s.adapter === "bad")!.status).toBe("error");
      expect(statuses.find((s) => s.adapter === "bad")!.error).toContain("boom");
      expect(statuses.find((s) => s.adapter === "gc")!.status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips an adapter whose required input is missing (no fallback)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [], { requiredInputs: ["location"], providedOutputs: [] });
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      const status = result.summary.adapters[0];
      expect(status.status).toBe("skipped");
      expect(status.reason).toContain("location");
      expect(result.summary.jobs).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies a fallback when a required input is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const seen: unknown[] = [];
      const adapter: Adapter = {
        manifest: {
          id: "gc",
          family: "portal",
          name: "GC",
          requiredInputs: ["location"],
          optionalInputs: [],
          providedOutputs: [],
          fallbacks: { location: "HK" },
        },
        async run(ctx) {
          seen.push(ctx.input.location);
          return { jobs: [], meta: {} };
        },
      };
      await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      expect(seen).toEqual(["HK"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedups across adapters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const a = makeAdapter("gc", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://a" }]);
      const b = makeAdapter("jobsdb", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://b" }]);
      const result = await runPipeline(config(["gc", "jobsdb"]), { query: "q" }, [a, b], { outputDir: dir });
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.duplicatesRemoved).toBe(1);
      expect(result.summary.dedupedCases).toHaveLength(1);
      expect(result.summary.dedupedCases[0]).toMatchObject({
        title: "Grad",
        company: "HSBC",
        link: "https://b",
        keptLink: "https://a",
      });
      const jobs = JSON.parse(await readFile(result.jobsFile, "utf8"));
      expect(jobs[0].sources).toEqual(["gc", "jobsdb"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops jobs missing a required output and counts them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "T", company: "C", location: "HK", apply_url: "https://a" },
        { title: "NoUrl", company: "C", location: "HK" },
      ]);
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      const status = result.summary.adapters[0];
      expect(status.jobCount).toBe(2);
      expect(status.dropped).toBe(1);
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.dropped).toBe(1);
      const cases = result.summary.droppedCases;
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({
        adapter: "gc",
        missing: ["apply_url"],
        title: "NoUrl",
        link: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a dropped job's job_page_url link when apply_url is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "PageOnly", company: "C", location: "HK", job_page_url: "https://page" },
      ]);
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      expect(result.summary.droppedCases[0].link).toBe("https://page");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exitCode is non-zero when nothing produced jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", []);
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      expect(exitCode(result.summary)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
