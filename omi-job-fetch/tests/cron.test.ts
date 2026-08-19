import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDue, loadCron, nextDueAt, parseSchedule, runGateway, saveCron } from "../src/cron.js";
import type { CronJob, CronSchedule } from "../src/types.js";

function job(over: Partial<CronJob> = {}): CronJob {
  const schedule = over.schedule ?? "every 30m";
  return {
    id: "job",
    config: "config.json",
    schedule,
    enabled: true,
    lastRun: null,
    lastStatus: null,
    ...over,
    parsed: over.parsed ?? parseSchedule(schedule),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function makeDir(): Promise<{ dir: string; cronFile: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
  // The gateway checks the config file exists before spawning a run.
  await writeFile(join(dir, "config.json"), "{}");
  return { dir, cronFile: join(dir, "cron.json"), stateDir: join(dir, "state") };
}

describe("parseSchedule", () => {
  it("parses interval schedules", () => {
    expect(parseSchedule("every 30m")).toEqual({ type: "interval", minutes: 30 });
    expect(parseSchedule("every 6 hours")).toEqual({ type: "interval", minutes: 6 * 60 });
    expect(parseSchedule("every 2 days")).toEqual({ type: "interval", minutes: 2 * 24 * 60 });
    expect(parseSchedule("every 1 week")).toEqual({ type: "interval", minutes: 7 * 24 * 60 });
  });

  it("parses the hourly/daily/weekly aliases", () => {
    expect(parseSchedule("hourly")).toEqual({ type: "interval", minutes: 60 });
    expect(parseSchedule("weekly")).toEqual({ type: "interval", minutes: 7 * 24 * 60 });
    expect(parseSchedule("daily")).toEqual({ type: "clock", hour: 0, minute: 0, days: null });
  });

  it("parses clock schedules and day filters", () => {
    expect(parseSchedule("daily at 09:30")).toEqual({ type: "clock", hour: 9, minute: 30, days: null });
    expect(parseSchedule("weekdays at 09:00")).toEqual({ type: "clock", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] });
    expect(parseSchedule("weekends at 10:00")).toEqual({ type: "clock", hour: 10, minute: 0, days: [0, 6] });
    expect(parseSchedule("monday at 09:00")).toEqual({ type: "clock", hour: 9, minute: 0, days: [1] });
    expect(parseSchedule("sun at 23:59")).toEqual({ type: "clock", hour: 23, minute: 59, days: [0] });
  });

  it("rejects invalid schedules and lists the accepted forms", () => {
    const bad = ["", "every", "every 0 hours", "every 5 seconds", "at 09:00", "daily at 25:00", "daily at 09", "banana", "monday at"];
    for (const s of bad) {
      expect(() => parseSchedule(s), `should reject "${s}"`).toThrow(/Accepted schedules/);
    }
  });
});

describe("nextDueAt", () => {
  it("fires an interval N minutes after the reference", () => {
    const s: CronSchedule = { type: "interval", minutes: 30 };
    expect(nextDueAt(s, new Date("2026-08-19T00:00:00.000Z")).toISOString()).toBe("2026-08-19T00:30:00.000Z");
  });

  it("fires at the next clock occurrence strictly after the reference", () => {
    const daily: CronSchedule = { type: "clock", hour: 9, minute: 0, days: null };
    expect(nextDueAt(daily, new Date("2026-08-19T00:00:00.000Z")).toISOString()).toBe("2026-08-19T09:00:00.000Z");
    expect(nextDueAt(daily, new Date("2026-08-19T09:30:00.000Z")).toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("skips non-allowed days (weekdays → next Monday after Friday)", () => {
    const weekdays: CronSchedule = { type: "clock", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] };
    // 2026-08-21 is a Friday.
    expect(nextDueAt(weekdays, new Date("2026-08-21T20:00:00.000Z")).toISOString()).toBe("2026-08-24T09:00:00.000Z");
  });

  it("respects a single-day filter", () => {
    const monday: CronSchedule = { type: "clock", hour: 9, minute: 0, days: [1] };
    // 2026-08-23 is a Sunday.
    expect(nextDueAt(monday, new Date("2026-08-23T10:00:00.000Z")).toISOString()).toBe("2026-08-24T09:00:00.000Z");
  });
});

describe("isDue", () => {
  const NOW = new Date("2026-08-19T12:00:00.000Z");

  it("interval: first-ever run fires immediately (catch-up)", () => {
    expect(isDue(job({ schedule: "every 30m" }), NOW)).toBe(true);
  });

  it("interval: fires once the interval has elapsed since lastRun", () => {
    expect(isDue(job({ schedule: "every 30m", lastRun: "2026-08-19T11:00:00.000Z" }), NOW)).toBe(true);
    expect(isDue(job({ schedule: "every 30m", lastRun: "2026-08-19T11:45:00.000Z" }), NOW)).toBe(false);
  });

  it("clock: never-run job waits for its slot instead of firing immediately", () => {
    expect(isDue(job({ schedule: "daily at 09:00" }), NOW)).toBe(false);
  });

  it("clock: fires when today's occurrence has passed since lastRun", () => {
    expect(isDue(job({ schedule: "daily at 09:00", lastRun: "2026-08-18T09:00:00.000Z" }), NOW)).toBe(true);
    expect(isDue(job({ schedule: "daily at 09:00", lastRun: "2026-08-19T09:30:00.000Z" }), NOW)).toBe(false);
  });
});

describe("cron.json load/save", () => {
  it("treats a missing file as an empty, unpaused store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      expect(loadCron(join(dir, "cron.json"))).toEqual({ paused: false, jobs: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a job and re-parses its schedule on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const file = join(dir, "cron.json");
      saveCron(file, {
        paused: false,
        jobs: [job({ id: "a", schedule: "daily at 07:15", lastRun: "2026-08-19T07:15:00.000Z", lastStatus: "ok" })],
      });
      expect(existsSync(file)).toBe(true);
      const stored = JSON.parse(readFileSync(file, "utf8"));
      expect(stored).toEqual({
        paused: false,
        jobs: [{ id: "a", config: "config.json", schedule: "daily at 07:15", enabled: true, lastRun: "2026-08-19T07:15:00.000Z", lastStatus: "ok" }],
      });
      const loaded = loadCron(file);
      expect(loaded.jobs[0].parsed).toEqual({ type: "clock", hour: 7, minute: 15, days: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults enabled/lastRun/lastStatus and pauses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const file = join(dir, "cron.json");
      writeFileSync(file, JSON.stringify({ jobs: [{ id: "a", config: "config.json", schedule: "every 6 hours" }] }));
      const loaded = loadCron(file);
      expect(loaded.paused).toBe(false);
      expect(loaded.jobs[0].enabled).toBe(true);
      expect(loaded.jobs[0].lastRun).toBeNull();
      expect(loaded.jobs[0].lastStatus).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid schedule with the job id named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const file = join(dir, "cron.json");
      writeFileSync(file, JSON.stringify({ jobs: [{ id: "a", config: "config.json", schedule: "someday" }] }));
      expect(() => loadCron(file)).toThrow(/invalid schedule "someday"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const file = join(dir, "cron.json");
      writeFileSync(file, "{not json");
      expect(() => loadCron(file)).toThrow(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runGateway", () => {
  it("spawns a due interval job, records lastRun/lastStatus, and cleans up state", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      const NOW = new Date("2026-08-19T12:00:00.000Z");
      saveCron(cronFile, { paused: false, jobs: [job({ id: "a", lastRun: "2026-08-19T11:00:00.000Z" })] });
      const spawned: string[] = [];
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => NOW,
        tickMs: 10,
        log: () => {},
        spawnJob: async (j) => {
          spawned.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 60);
      await done;
      expect(spawned).toEqual(["a"]);
      const cron = loadCron(cronFile);
      expect(cron.jobs[0].lastRun).toBe(NOW.toISOString());
      expect(cron.jobs[0].lastStatus).toBe("ok");
      expect(existsSync(join(stateDir, "gateway.pid"))).toBe(false);
      expect(existsSync(join(stateDir, "stop"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not spawn a never-run clock job before its slot", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      saveCron(cronFile, { paused: false, jobs: [job({ id: "a", schedule: "daily at 09:00" })] });
      const spawned: string[] = [];
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        tickMs: 10,
        log: () => {},
        spawnJob: async (j) => {
          spawned.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 40);
      await done;
      expect(spawned).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips jobs when the store is paused or the job is disabled", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      saveCron(cronFile, {
        paused: true,
        jobs: [job({ id: "a", lastRun: "2026-08-19T11:00:00.000Z" })],
      });
      const spawned: string[] = [];
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        tickMs: 10,
        log: () => {},
        spawnJob: async (j) => {
          spawned.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 40);
      await done;
      expect(spawned).toEqual([]);

      // Disabled (not paused) is the other skip path.
      const cron = loadCron(cronFile);
      cron.paused = false;
      cron.jobs[0].enabled = false;
      saveCron(cronFile, cron);
      const spawned2: string[] = [];
      const done2 = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        tickMs: 10,
        log: () => {},
        spawnJob: async (j) => {
          spawned2.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 40);
      await done2;
      expect(spawned2).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a job failed when its config path is missing, without spawning", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      saveCron(cronFile, {
        paused: false,
        jobs: [job({ id: "a", config: "missing.json", lastRun: "2026-08-19T11:00:00.000Z" })],
      });
      const spawned: string[] = [];
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        tickMs: 10,
        log: () => {},
        spawnJob: async (j) => {
          spawned.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 40);
      await done;
      expect(spawned).toEqual([]);
      expect(loadCron(cronFile).jobs[0].lastStatus).toMatch(/missing config/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sees a stop marker written mid-tick and exits before the tick elapses", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      saveCron(cronFile, { paused: false, jobs: [job({ id: "a" })] }); // every 30m, never run → due once
      const spawned: string[] = [];
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        tickMs: 2000, // long tick — a stop marker mid-wait must cut it short
        log: () => {},
        spawnJob: async (j) => {
          spawned.push(j.id);
          return { ok: true, code: 0 };
        },
      });
      setTimeout(() => writeFileSync(join(stateDir, "stop"), ""), 60);
      const winner = await Promise.race([
        done.then(() => "done" as const),
        sleep(1500).then(() => "timeout" as const),
      ]);
      expect(winner).toBe("done");
      expect(spawned).toEqual(["a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overlap guard: a due job is not re-spawned while its run is in flight", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      let t = new Date("2026-08-19T00:00:00.000Z");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      saveCron(cronFile, { paused: false, jobs: [job({ id: "a" })] }); // every 30m, never run
      const done = runGateway({
        cronFile,
        cliPath: "cli",
        stateDir,
        // Each tick advances 30m so the job stays due while its first run hangs.
        now: () => {
          t = new Date(t.getTime() + 30 * 60_000);
          return t;
        },
        tickMs: 10,
        log: () => {},
        spawnJob: async () => {
          calls++;
          if (calls === 1) await gate;
          return { ok: true, code: 0 };
        },
      });
      await sleep(80); // several due ticks — the guard must hold
      expect(calls).toBe(1);
      release();
      await sleep(60); // once the run finishes, a later tick may spawn again
      expect(calls).toBeGreaterThanOrEqual(2);
      writeFileSync(join(stateDir, "stop"), "");
      await done;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
