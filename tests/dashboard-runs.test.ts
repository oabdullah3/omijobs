import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, readRunStatus, startRun } from "../src/dashboardRuns.js";

describe("startRun", () => {
  it("spawns the run detached, sets the trigger env, reports the exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-runs-"));
    try {
      const cli = join(dir, "stub.cjs");
      const stubOut = join(dir, "stub-out.txt");
      // stdout is not piped (stdio: ignore), so the stub records its env into a file.
      await writeFile(cli, [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.STUB_OUT, [",
        "  'trigger=' + (process.env.OMI_JOB_FETCH_TRIGGER || ''),",
        "  'cfg=' + process.argv[process.argv.indexOf('--config') + 1],",
        "].join('\\n'));",
        "process.exit(0);",
      ].join("\n"));
      process.env.STUB_OUT = stubOut;
      try {
        const exited = new Promise<number | null>((r) => {
          startRun({
            cliPath: cli,
            configPath: join(dir, "config.json"),
            trigger: "dashboard",
            onExit: r,
          });
        });
        const code = await exited;
        expect(code).toBe(0);
        const seen = readFileSync(stubOut, "utf8");
        expect(seen).toContain("trigger=dashboard");
        expect(seen).toContain(`cfg=${join(dir, "config.json")}`);
      } finally {
        delete process.env.STUB_OUT;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes progress/stop/marker file env vars and clears stale markers at spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-runs-"));
    try {
      const cli = join(dir, "stub.cjs");
      const stubOut = join(dir, "stub-out.txt");
      await writeFile(cli, [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.STUB_OUT, [",
        "  'progress=' + (process.env.OMI_JOB_FETCH_PROGRESS_FILE || ''),",
        "  'stop=' + (process.env.OMI_JOB_FETCH_STOP_FILE || ''),",
        "  'marker=' + (process.env.OMI_JOB_FETCH_RUN_MARKER || ''),",
        "].join('\\n'));",
        "process.exit(0);",
      ].join("\n"));
      const runsDir = join(dir, "runs");
      await mkdir(runsDir, { recursive: true });
      const stopFile = join(runsDir, "x.stop");
      const markerFile = join(runsDir, "x.running");
      await writeFile(stopFile, "stale stop marker from a previous run");
      await writeFile(markerFile, "stale run marker from a previous run");
      process.env.STUB_OUT = stubOut;
      try {
        const exited = new Promise<number | null>((r) => {
          startRun({
            cliPath: cli,
            configPath: join(dir, "config.json"),
            progressFile: join(runsDir, "x.log"),
            stopFile,
            runMarkerFile: markerFile,
            onExit: r,
          });
        });
        const code = await exited;
        expect(code).toBe(0);
        const seen = readFileSync(stubOut, "utf8");
        expect(seen).toContain(`progress=${join(runsDir, "x.log")}`);
        expect(seen).toContain(`stop=${stopFile}`);
        expect(seen).toContain(`marker=${markerFile}`);
        // The stale markers are cleared before spawn so the fresh run isn't aborted
        // the moment it starts (stop) or misread as still running (marker).
        expect(existsSync(stopFile)).toBe(false);
        expect(existsSync(markerFile)).toBe(false);
      } finally {
        delete process.env.STUB_OUT;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readRunStatus", () => {
  it("returns per-config entries: result parsed, lastLines exclude result, running from the set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-status-"));
    try {
      const runs = join(dir, "runs");
      await mkdir(runs, { recursive: true });
      await writeFile(join(runs, "finance.log"), [
        "  gc · page 1/2 · 3 found",
        "  jd · 5/10",
        "result: 3 jobs, 1 dropped, 0 deduped",
        "",
      ].join("\n"));
      await writeFile(join(runs, "base.log"), "  gc · page 2/2 · 5 found\n");
      const status = readRunStatus(dir, new Set(["base"]));
      expect(status["finance"]).toBeDefined();
      expect(status["finance"].running).toBe(false);
      expect(status["finance"].lastLines).toEqual(["  gc · page 1/2 · 3 found", "  jd · 5/10"]);
      expect(status["finance"].result).toBe("3 jobs, 1 dropped, 0 deduped");
      expect(typeof status["finance"].updatedAt).toBe("string");
      expect(status["base"].running).toBe(true);
      expect(status["base"].result).toBeNull();
      expect(status["base"].lastLines).toEqual(["  gc · page 2/2 · 5 found"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns {} when the runs dir does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-status-"));
    try {
      expect(readRunStatus(dir, new Set())).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("listRuns", () => {
  it("lists run.json entries newest-first with parsed metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-runs-"));
    try {
      const runs = join(dir, "runs");
      await mkdir(join(runs, "20260818-000000-01"), { recursive: true });
      await writeFile(
        join(runs, "20260818-000000-01", "run.json"),
        JSON.stringify({ id: "20260818-000000-01", startedAt: "2026-08-18T00:00:00.000Z", durationMs: 10, jobs: 1, adapters: [{ adapter: "a", status: "ok" }] }),
      );
      await mkdir(join(runs, "20260819-000000-02"), { recursive: true });
      await writeFile(
        join(runs, "20260819-000000-02", "run.json"),
        JSON.stringify({ id: "20260819-000000-02", startedAt: "2026-08-19T00:00:00.000Z", durationMs: 20, jobs: 2, trigger: "dashboard", adapters: [{ adapter: "b", status: "error", error: "boom" }] }),
      );
      const list = listRuns(dir);
      expect(list.map((r) => r.id)).toEqual(["20260819-000000-02", "20260818-000000-01"]);
      expect(list[0].jobs).toBe(2);
      expect(list[0].trigger).toBe("dashboard");
      expect(list[0].adapters[0].status).toBe("error");
      // Missing run.json is skipped.
      expect(list.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
