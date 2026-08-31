import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayAlive, getCronState, nextRunAt, runCronMutation, tailLog } from "../src/dashboardCron.js";
import type { CronSchedule } from "../src/types.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

async function makeDir(): Promise<{ dir: string; cronFile: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
  return { dir, cronFile: join(dir, "cron.json"), stateDir: join(dir, "state") };
}

describe("nextRunAt", () => {
  const interval: CronSchedule = { type: "interval", minutes: 30 };
  const clock: CronSchedule = { type: "clock", hour: 9, minute: 0, days: null };

  it("interval never-run fires immediately", () => {
    expect(nextRunAt(interval, null, NOW)).toBe(NOW.toISOString());
  });
  it("interval since lastRun fires after the window (or now when overdue)", () => {
    // lastRun 11:00 → next 11:30 already past at now 12:00 → overdue → clamped to now
    expect(nextRunAt(interval, "2026-08-19T11:00:00.000Z", NOW)).toBe(NOW.toISOString());
    // lastRun 11:45 → next 12:15 is in the future → returned unclamped
    expect(nextRunAt(interval, "2026-08-19T11:45:00.000Z", NOW)).toBe("2026-08-19T12:15:00.000Z");
  });
  it("clock never-run fires immediately (catch-up); a lastRun uses the next occurrence", () => {
    expect(nextRunAt(clock, null, NOW)).toBe(NOW.toISOString());
    // lastRun 08-18T09:00 → next occurrence 08-19T09:00 already past at now 12:00 → clamped to now
    expect(nextRunAt(clock, "2026-08-18T09:00:00.000Z", NOW)).toBe("2026-08-19T12:00:00.000Z");
  });
});

describe("gatewayAlive", () => {
  it("reports not running without a pidfile, stale with a dead pid, running with a live one", async () => {
    const { dir, stateDir } = await makeDir();
    try {
      expect(gatewayAlive(stateDir).running).toBe(false);
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "gateway.pid"), "99999999");
      const stale = gatewayAlive(stateDir);
      expect(stale.running).toBe(false);
      expect(stale.stale).toBe(true);
      await writeFile(join(stateDir, "gateway.pid"), String(process.pid));
      expect(gatewayAlive(stateDir).running).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getCronState", () => {
  it("maps cron.json into job states with running flag and countdowns", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      await writeFile(
        cronFile,
        JSON.stringify({
          paused: false,
          jobs: [
            { id: "a", config: "config.json", schedule: "every 30m", enabled: true, lastRun: "2026-08-19T11:00:00.000Z", lastStatus: "running" },
            { id: "b", config: "other.json", schedule: "daily at 09:00", enabled: false, lastRun: "2026-08-19T09:00:00.000Z", lastStatus: "ok" },
          ],
        }),
      );
      const state = getCronState({ cronFile, stateDir, now: NOW });
      expect(state.paused).toBe(false);
      expect(state.gateway.running).toBe(false);
      expect(state.jobs[0]).toMatchObject({ id: "a", running: true, nextRunAt: "2026-08-19T12:00:00.000Z" });
      expect(state.jobs[1]).toMatchObject({ id: "b", running: false, enabled: false, nextRunAt: "2026-08-20T09:00:00.000Z" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces analysis jobs without instructions", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      await writeFile(
        cronFile,
        JSON.stringify({
          paused: false,
          jobs: [{ id: "a", kind: "analysis", dbKey: "base", schedule: "every 6 hours", enabled: true, lastRun: null, lastStatus: null }],
        }),
      );
      const state = getCronState({ cronFile, stateDir, now: NOW });
      expect(state.jobs[0]).toMatchObject({ id: "a", kind: "analysis", dbKey: "base" });
      expect("instructions" in state.jobs[0]).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces an unreadable cron.json as an error", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      await writeFile(cronFile, "{nope");
      const state = getCronState({ cronFile, stateDir, now: NOW });
      expect(state.error).toBeDefined();
      expect(state.jobs).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runCronMutation", () => {
  it("spawns `node <cli> cron <args>` and returns the captured output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const cli = join(dir, "stub.cjs");
      await writeFile(cli, "console.log('saw: ' + process.argv.slice(2).join(' ')); process.exit(0);\n");
      const r = await runCronMutation({ cliPath: cli, args: ["pause"] });
      expect(r.ok).toBe(true);
      // The spawn always inserts the "cron" subcommand, so argv.slice(2) is ["cron", "pause"].
      expect(r.output).toContain("saw: cron pause");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tailLog", () => {
  it("returns the last N lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const stateDir = join(dir, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "cron.log"), Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
      expect(tailLog(stateDir, 3)).toEqual(["line 7", "line 8", "line 9"]);
      expect(tailLog(join(dir, "missing"), 3)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
