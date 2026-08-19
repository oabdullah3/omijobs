import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DEDUP_FIELDS, exitCode, normalizeQueries, runPipeline } from "../src/runtime.js";
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

function config(enabled: string[], queries: string[] = ["q"]): RunConfig {
  return {
    global: { queries },
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
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
      expect(result.summary.adapters[0].status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
      const jobs = JSON.parse(await readFile(result.jobsFile, "utf8"));
      expect(jobs[0].source).toBe("gc");
      const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
      expect(runMeta.queries).toEqual(["q"]);
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
      const result = await runPipeline(config(["bad", "gc"]), [bad, good], { outputDir: dir });
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
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
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
      await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
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
      const result = await runPipeline(config(["gc", "jobsdb"]), [a, b], { outputDir: dir });
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
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
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
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
      expect(result.summary.droppedCases[0].link).toBe("https://page");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exitCode is non-zero when nothing produced jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", []);
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
      expect(exitCode(result.summary)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wires onAdapterStart/onAdapterDone/onProgress and passes ctx.log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const events: string[] = [];
      const progress: string[] = [];
      const adapter: Adapter = {
        manifest: {
          id: "gc",
          family: "portal",
          name: "GC",
          requiredInputs: ["query"],
          optionalInputs: [],
          providedOutputs: [],
        },
        async run(ctx) {
          ctx.log?.("page 1/2 · 3 found");
          ctx.log?.("page 2/2 · 5 found");
          return { jobs: [], meta: {} };
        },
      };
      await runPipeline(config(["gc"]), [adapter], {
        outputDir: dir,
        onAdapterStart: (index, total, adapterId) => events.push(`start ${index}/${total} ${adapterId}`),
        onAdapterDone: (index, total, status) => events.push(`done ${index}/${total} ${status.status} ${status.adapter}`),
        onProgress: (adapterId, status) => progress.push(`${adapterId}:${status}`),
      });
      expect(events).toEqual(["start 1/1 gc", "done 1/1 ok gc"]);
      expect(progress).toEqual(["gc:page 1/2 · 3 found", "gc:page 2/2 · 5 found"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fires start/done for skipped adapters in order with 1-based index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const events: string[] = [];
      const missing = makeAdapter("missing", "portal", [], { requiredInputs: ["location"], providedOutputs: [] });
      const ok = makeAdapter("gc", "portal", [{ title: "T", company: "C", location: "HK", apply_url: "https://a" }]);
      await runPipeline(config(["missing", "gc"]), [missing, ok], {
        outputDir: dir,
        onAdapterStart: (index, total, adapterId) => events.push(`start ${index}/${total} ${adapterId}`),
        onAdapterDone: (index, total, status) => events.push(`done ${index}/${total} ${status.status} ${status.adapter}`),
      });
      expect(events).toEqual([
        "start 1/2 missing",
        "done 1/2 skipped missing",
        "start 2/2 gc",
        "done 2/2 ok gc",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs each query against each adapter and dedups across all queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const events: string[] = [];
      const a = makeAdapter("gc", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://a" }]);
      const b = makeAdapter("jobsdb", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://b" }]);
      const result = await runPipeline(config(["gc", "jobsdb"], ["q1", "q2"]), [a, b], {
        outputDir: dir,
        onAdapterStart: (index, total, adapterId, query) => events.push(`start ${index}/${total} ${adapterId}@${query}`),
      });
      // 2 queries × 2 adapters = 4 runs, query-outer order, each run tagged with its query.
      expect(result.summary.adapters.map((s) => `${s.adapter}@${s.query}`)).toEqual([
        "gc@q1",
        "jobsdb@q1",
        "gc@q2",
        "jobsdb@q2",
      ]);
      // All four jobs are the same listing → deduped to one across queries + platforms.
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.duplicatesRemoved).toBe(3);
      expect(events).toEqual([
        "start 1/4 gc@q1",
        "start 2/4 jobsdb@q1",
        "start 3/4 gc@q2",
        "start 4/4 jobsdb@q2",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("feeds per-adapter search params to ctx.input and merges global knobs with per-adapter overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const seen: { input: Record<string, unknown>; config: Record<string, unknown> }[] = [];
      const adapter: Adapter = {
        manifest: {
          id: "gc",
          family: "portal",
          name: "GC",
          requiredInputs: ["query"],
          optionalInputs: ["location"],
          providedOutputs: [],
        },
        async run(ctx) {
          seen.push({ input: ctx.input, config: ctx.config });
          return { jobs: [], meta: {} };
        },
      };
      const cfg: RunConfig = {
        global: { queries: ["q"], delayMs: 500, retryBackoffMs: [1000, 2000], detailConcurrency: 9 },
        portals: { enabled: ["gc"], config: { gc: { location: "Hong Kong", delayMs: 700 } } },
        ats: { enabled: [], config: {} },
        dedup: { fields: DEFAULT_DEDUP_FIELDS },
      };
      await runPipeline(cfg, [adapter], { outputDir: dir });
      // location is a manifest input key → ctx.input; delayMs overrides the global default;
      // retryBackoffMs / detailConcurrency flow through from global.
      expect(seen).toEqual([
        {
          input: { query: "q", location: "Hong Kong" },
          config: { delayMs: 700, retryBackoffMs: [1000, 2000], detailConcurrency: 9 },
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when no queries are configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", []);
      await expect(runPipeline(config(["gc"], []), [adapter], { outputDir: dir })).rejects.toThrow(/No queries configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses config.outputDir when no options.outputDir is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", []);
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
      expect(result.jobsFile.startsWith(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes aggregate-db stats into run.json when db.enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const cfg = config(["gc"]);
      cfg.db = { enabled: true };
      const adapter = makeAdapter("gc", "portal", [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a", posted_at: "2026-08-18T00:00:00.000Z" },
      ]);
      const result = await runPipeline(cfg, [adapter], { outputDir: dir, now: new Date("2026-08-19T00:00:00.000Z") });
      expect(result.summary.db).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
      expect(existsSync(join(dir, "jobs.db"))).toBe(true);
      const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
      expect(runMeta.db).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aggregates across runs: same signature overwrites, new jobs append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const cfg = config(["gc"]);
      cfg.db = { enabled: true };
      const now = new Date("2026-08-19T00:00:00.000Z");
      const first = { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a", posted_at: "2026-08-18T00:00:00.000Z" };
      await runPipeline(cfg, [makeAdapter("gc", "portal", [first])], { outputDir: dir, now });
      // Second run: same title/company/location (new apply_url) + a brand-new job.
      const second = await runPipeline(
        cfg,
        [
          makeAdapter("gc", "portal", [
            { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://b", posted_at: "2026-08-18T00:00:00.000Z" },
            { title: "Analyst", company: "JPM", location: "Hong Kong", apply_url: "https://c", posted_at: "2026-08-18T00:00:00.000Z" },
          ]),
        ],
        { outputDir: dir, now },
      );
      expect(second.summary.db).toEqual({ added: 1, updated: 1, removed: 0, total: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits db stats when db is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a" },
      ]);
      const result = await runPipeline(config(["gc"]), [adapter], { outputDir: dir });
      expect(result.summary.db).toBeUndefined();
      expect(result.summary.dbError).toBeUndefined();
      const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
      expect("db" in runMeta).toBe(false);
      expect("dbError" in runMeta).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a DB sync failure as a non-fatal warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      // Make the DB path uncreatable: a regular file sits where a directory would go.
      const blocker = join(dir, "blocker");
      await writeFile(blocker, "i am a file");
      const cfg = config(["gc"]);
      cfg.db = { enabled: true, file: resolve(blocker, "sub/jobs.db") };
      const adapter = makeAdapter("gc", "portal", [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a" },
      ]);
      const result = await runPipeline(cfg, [adapter], { outputDir: dir });
      expect(result.summary.dbError).toBeDefined();
      expect(result.summary.db).toBeUndefined();
      // The run itself is unaffected.
      expect(result.summary.adapters[0].status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.dbError).not.toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeQueries", () => {
  it("splits a comma-separated string into trimmed distinct queries", () => {
    expect(normalizeQueries("finance, grad program, finance ")).toEqual(["finance", "grad program"]);
    expect(normalizeQueries("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("normalizes a string array", () => {
    expect(normalizeQueries(["finance", " grad ", "finance"])).toEqual(["finance", "grad"]);
    expect(normalizeQueries(["a", "b"])).toEqual(["a", "b"]);
  });

  it("drops empty and blank entries and treats missing / invalid input as empty", () => {
    expect(normalizeQueries("")).toEqual([]);
    expect(normalizeQueries(" , , ")).toEqual([]);
    expect(normalizeQueries("a,,b,")).toEqual(["a", "b"]);
    expect(normalizeQueries(undefined)).toEqual([]);
    expect(normalizeQueries([])).toEqual([]);
    expect(normalizeQueries(42)).toEqual([]); // not an array or comma string → nothing to run
  });
});
