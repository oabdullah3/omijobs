import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAnalysisDashboardState } from "../src/dashboardAnalysis.js";
import type { RunConfig } from "../src/types.js";

const BASE: RunConfig = {
  global: { queries: ["intern"] },
  portals: { enabled: ["gradconnection"], config: {} },
  ats: { enabled: [], config: {} },
  outputDir: "output",
};

async function makeEnv(): Promise<{ dir: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-dash-analysis-"));
  await mkdir(join(dir, "dashboard.configs", "realtime"), { recursive: true });
  await writeFile(join(dir, "dashboard.configs", "realtime", "config.json"), JSON.stringify({ ...BASE, outputDir: dir }));
  const stateDir = join(dir, "state");
  await mkdir(join(stateDir, "analysis"), { recursive: true });
  return { dir, stateDir };
}

const completedSummary = {
  startedAt: "2026-08-26T00:00:00.000Z",
  finishedAt: "2026-08-26T00:10:00.000Z",
  outcome: "completed",
  error: null,
  total: 10,
  analyzed: 10,
  skipped: 0,
  failed: 0,
  deleted: 0,
  provider: "openrouter",
  model: "openrouter/auto",
};

describe("getAnalysisDashboardState summary", () => {
  it("shows the live progress line (string) while a db is running, not the stale summary object", async () => {
    const { dir, stateDir } = await makeEnv();
    try {
      const dbPath = resolve(dir, "jobs.db");
      await writeFile(join(stateDir, "analysis", "active"), JSON.stringify({ dbPath, pid: process.pid, startedAt: new Date().toISOString() }));
      await writeFile(join(stateDir, "analysis", "base.status.json"), `${JSON.stringify(completedSummary)}\n`);
      await writeFile(join(stateDir, "analysis", "base.log"), "0/10 jobs analyzed\n5/10 jobs analyzed\n");
      const state = getAnalysisDashboardState({ packageDir: dir, stateDir, cronFile: join(dir, "cron.json") });
      const db = state.dbs[0];
      expect(db.running).toBe(true);
      expect(typeof db.summary).toBe("string");
      expect(db.summary).toBe("5/10 jobs analyzed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the completed summary object for a db that is not running", async () => {
    const { dir, stateDir } = await makeEnv();
    try {
      await writeFile(join(stateDir, "analysis", "base.status.json"), `${JSON.stringify(completedSummary)}\n`);
      const state = getAnalysisDashboardState({ packageDir: dir, stateDir, cronFile: join(dir, "cron.json") });
      const db = state.dbs[0];
      expect(db.running).toBe(false);
      expect(db.summary).toEqual(completedSummary);
      expect(db.status).toBe("completed");
      expect(db.lastRun).toBe(completedSummary.finishedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
