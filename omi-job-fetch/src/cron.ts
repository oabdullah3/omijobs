import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger, errorData, type Logger } from "./logger.js";
import type { CronFile, CronJob, CronSchedule } from "./types.js";

/**
 * Human-friendly schedule grammar → parsed CronSchedule.
 *
 * Accepted forms (lowercase, trimmed, whitespace collapsed):
 *   every <n> min|hour|day|week      e.g. "every 30m", "every 6 hours", "every 2 days"
 *   daily at <HH:MM>                 e.g. "daily at 09:00"
 *   weekdays at <HH:MM>              e.g. "weekdays at 09:00"  (Mon–Fri)
 *   weekends at <HH:MM>              e.g. "weekends at 10:00"  (Sat–Sun)
 *   <day> at <HH:MM>                 e.g. "monday at 09:00"    (mon/sun/… full or 3-letter)
 *   hourly | daily | weekly          aliases → "every 1 hour" / "daily at 00:00" / "every 1 week"
 *
 * Clock times are interpreted in UTC (matching every other timestamp the tool
 * writes — run.json startedAt, DB posted_at). Throws with the accepted forms
 * listed on any mismatch.
 */
export const ACCEPTED_SCHEDULES = `Accepted schedules:
  every <n> min|hour|day|week   e.g. "every 30m", "every 6 hours", "every 2 days"
  daily at <HH:MM>              e.g. "daily at 09:00"
  weekdays at <HH:MM>           e.g. "weekdays at 09:00"
  weekends at <HH:MM>           e.g. "weekends at 10:00"
  <day> at <HH:MM>              e.g. "monday at 09:00"  (mon..sun)
  hourly | daily | weekly`;

const DAY_LOOKUP: Record<string, number[] | null> = {
  daily: null,
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  sun: [0],
  mon: [1],
  tue: [2],
  wed: [3],
  thu: [4],
  fri: [5],
  sat: [6],
  sunday: [0],
  monday: [1],
  tuesday: [2],
  wednesday: [3],
  thursday: [4],
  friday: [5],
  saturday: [6],
};

function scheduleError(): Error {
  return new Error(`Invalid schedule. ${ACCEPTED_SCHEDULES}`);
}

export function parseSchedule(raw: string): CronSchedule {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "") throw scheduleError();

  if (s === "hourly") return { type: "interval", minutes: 60 };
  if (s === "daily") return { type: "clock", hour: 0, minute: 0, days: null };
  if (s === "weekly") return { type: "interval", minutes: 7 * 24 * 60 };

  const interval = /^every\s+(\d+)\s?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(s);
  if (interval) {
    const n = Number(interval[1]);
    if (n < 1) throw scheduleError();
    const unit = interval[2];
    const perUnit = unit[0] === "m"
      ? 1
      : unit[0] === "h"
        ? 60
        : unit[0] === "d"
          ? 24 * 60
          : 7 * 24 * 60;
    return { type: "interval", minutes: n * perUnit };
  }

  const clock = /^([a-z]+)\s+at\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const hour = Number(clock[2]);
    const minute = Number(clock[3]);
    if (hour > 23 || minute > 59) throw scheduleError();
    const days = DAY_LOOKUP[clock[1]];
    if (days === undefined) throw scheduleError();
    return { type: "clock", hour, minute, days };
  }

  throw scheduleError();
}

/**
 * Next firing time strictly after `after`. UTC interpretation for clock
 * schedules (day boundary + wall time both UTC, so this is deterministic on
 * any machine). Interval schedules fire `minutes` after `after`.
 */
export function nextDueAt(schedule: CronSchedule, after: Date): Date {
  if (schedule.type === "interval") {
    return new Date(after.getTime() + schedule.minutes * 60_000);
  }
  // Walk today up to 8 days forward: a 7-day window covers every allowed-day
  // pattern, and starting at today's slot (offset 0) lets the "> after" check
  // below decide whether today's occurrence is still ahead or already passed.
  const startDay = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate());
  for (let offset = 0; offset <= 8; offset++) {
    const dayMs = startDay + offset * 86_400_000;
    const dow = new Date(dayMs).getUTCDay();
    if (schedule.days !== null && !schedule.days.includes(dow)) continue;
    const candidate = new Date(dayMs + schedule.hour * 3_600_000 + schedule.minute * 60_000);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("unreachable: no next clock occurrence"); // valid schedules always find one
}

/**
 * Whether a job is due at `now`.
 * - Never-run (null lastRun) → due immediately for any schedule (catch-up): the
 *   first ever run fires on the next gateway tick, then the schedule takes over.
 * - Interval: otherwise due when the interval has elapsed since lastRun.
 * - Clock: otherwise due when that next occurrence has been reached.
 */
export function isDue(job: CronJob, now: Date): boolean {
  if (job.lastRun === null) return true;
  const last = new Date(job.lastRun);
  if (Number.isNaN(last.getTime())) return false;
  return now.getTime() >= nextDueAt(job.parsed, last).getTime();
}

/** Read + validate cron.json. Missing file → an empty (paused:false) store. */
export function loadCron(file: string): CronFile {
  if (!existsSync(file)) return { paused: false, jobs: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cron.json at ${file} is not valid JSON: ${errMsg(error)}`);
  }
  const obj = raw as Record<string, unknown>;
  const paused = obj.paused === undefined ? false : Boolean(obj.paused);
  const jobsRaw = Array.isArray(obj.jobs) ? obj.jobs : [];
  const jobs: CronJob[] = [];
  for (const entry of jobsRaw) {
    const job = entry as Record<string, unknown>;
    if (typeof job.id !== "string" || job.id === "") throw new Error(`cron.json: every job needs a non-empty "id"`);
    const kind = job.kind === "analysis" ? "analysis" : "run";
    if (kind === "run" && (typeof job.config !== "string" || job.config === "")) throw new Error(`cron.json job "${job.id}" needs "config"`);
    if (kind === "analysis" && (typeof job.dbKey !== "string" || job.dbKey === "")) throw new Error(`cron.json analysis job "${job.id}" needs "dbKey"`);
    if (typeof job.schedule !== "string" || job.schedule === "") throw new Error(`cron.json job "${job.id}" needs "schedule"`);
    let parsed: CronSchedule;
    try {
      parsed = parseSchedule(job.schedule);
    } catch {
      throw new Error(`cron.json job "${job.id}" has an invalid schedule "${job.schedule}". ${ACCEPTED_SCHEDULES}`);
    }
    jobs.push({
      id: job.id,
      kind,
      ...(typeof job.config === "string" ? { config: job.config } : {}),
      ...(typeof job.dbKey === "string" ? { dbKey: job.dbKey } : {}),
      ...(typeof job.instructions === "string" ? { instructions: job.instructions } : {}),
      schedule: job.schedule,
      parsed,
      enabled: job.enabled === undefined ? true : Boolean(job.enabled),
      lastRun: typeof job.lastRun === "string" ? job.lastRun : null,
      lastStatus: typeof job.lastStatus === "string" ? job.lastStatus : null,
    });
  }
  return { paused, jobs };
}

/** Write cron.json, stripping the derived `parsed` field back out. */
export function saveCron(file: string, cron: CronFile): void {
  const stored = {
    paused: cron.paused,
    jobs: cron.jobs.map(({ id, kind, config, dbKey, instructions, schedule, enabled, lastRun, lastStatus }) => ({
      id,
      kind,
      ...(config ? { config } : {}),
      ...(dbKey ? { dbKey } : {}),
      ...(instructions ? { instructions } : {}),
      schedule,
      enabled,
      lastRun,
      lastStatus,
    })),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

export interface SpawnOutcome {
  ok: boolean;
  code: number;
  error?: string;
}

/**
 * Spawn one run: `node <cli> run --config <path>` with the cron trigger env set.
 * Also wires the run's progress file, stop-marker file, and running-marker file in
 * `<stateDir>/runs/<job.id>.{log,stop,running}` — the dashboard tails the .log for
 * live progress, writes the .stop marker when the user hits Stop, and reattaches
 * to a run in flight via the .running marker (the CLI writes its PID there at
 * start and clears it on exit). Stale markers from any previous run are cleared
 * before spawn.
 */
export function defaultSpawnJob(cliPath: string, stateDir: string) {
  return (job: CronJob, configPath: string): Promise<SpawnOutcome> => {
    const runsDir = resolve(stateDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const analysis = job.kind === "analysis";
    const dir = analysis ? resolve(stateDir, "analysis") : runsDir;
    const progressFile = resolve(dir, `${job.id}.log`);
    const stopFile = resolve(dir, `${job.id}.stop`);
    const markerFile = analysis ? resolve(dir, "active") : resolve(dir, `${job.id}.running`);
    rmSync(stopFile, { force: true });
    rmSync(markerFile, { force: true });
    return new Promise((resolveOutcome) => {
      const args = analysis
        ? [cliPath, "analyze", "run", job.dbKey ?? "", ...(job.instructions ? ["--instructions", job.instructions] : [])]
        : [cliPath, "run", "--config", configPath];
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          OMI_JOB_FETCH_TRIGGER: "cron",
          OMI_JOB_FETCH_PROGRESS_FILE: progressFile,
          OMI_JOB_FETCH_STOP_FILE: stopFile,
          OMI_JOB_FETCH_RUN_MARKER: markerFile,
          OMI_JOB_FETCH_JOB_ID: job.id,
        },
        stdio: "ignore",
      });
      child.on("error", (error) => resolveOutcome({ ok: false, code: 1, error: error.message }));
      child.on("exit", (code) => resolveOutcome({ ok: true, code: code ?? 1 }));
    });
  };
}

export function outcomeText(outcome: SpawnOutcome): string {
  return outcome.ok ? (outcome.code === 0 ? "ok" : `exit ${outcome.code}`) : `error: ${outcome.error ?? "unknown"}`;
}

export interface GatewayOptions {
  /** Path to cron.json. */
  cronFile: string;
  /** Absolute path to the CLI entry (dist/cli.js) used to spawn runs. */
  cliPath: string;
  /** Directory for the pidfile, stop marker, and cron.log. */
  stateDir: string;
  /** Injectable clock for tests (default: real now). */
  now?: () => Date;
  /** Tick interval in ms (default 60s). */
  tickMs?: number;
  /** Injectable log sink (default: console + append to stateDir/cron.log). */
  log?: (line: string) => void;
  /** Injectable structured logger (default: createLogger({ source: "gateway" })). */
  logger?: Logger;
  /** Injectable run spawner for tests (default: defaultSpawnJob(cliPath)). */
  spawnJob?: (job: CronJob, configPath: string) => Promise<SpawnOutcome>;
}

/**
 * Sleep up to `ms` in small chunks, checking for the stop marker so a `cron
 * stop` lands within ~200ms instead of waiting out the whole tick.
 * Returns true when the stop marker appeared mid-wait.
 */
async function sleepUntil(ms: number, stopFile: string): Promise<boolean> {
  const chunk = 200;
  let waited = 0;
  while (waited < ms) {
    const step = Math.min(chunk, ms - waited);
    await sleep(step);
    waited += step;
    if (existsSync(stopFile)) return true;
  }
  return false;
}

/**
 * The gateway loop: every tick, spawn every enabled, not-in-flight, due job,
 * record lastRun at spawn and lastStatus at completion. Exits when a stop
 * marker appears in stateDir. Writes its pidfile on start and removes it (and
 * the stop marker) on exit.
 */
export async function runGateway(options: GatewayOptions): Promise<void> {
  mkdirSync(options.stateDir, { recursive: true });
  const clock = options.now ?? (() => new Date());
  const tickMs = options.tickMs ?? 5_000;
  const logFile = resolve(options.stateDir, "cron.log");
  const log =
    options.log ??
    ((line: string) => {
      appendFileSync(logFile, `${line}\n`);
    });
  const spawnJob = options.spawnJob ?? defaultSpawnJob(options.cliPath, options.stateDir);
  const pidFile = resolve(options.stateDir, "gateway.pid");
  const stopFile = resolve(options.stateDir, "stop");
  const logger = options.logger ?? createLogger({ source: "gateway" });
  let lastTickLog = 0;

  // Serialize cron.json writes so concurrent job completions can't clobber
  // each other's lastRun/lastStatus updates (single-writer within the process).
  let writeChain: Promise<void> = Promise.resolve();
  const writeCron = (mutate: (cron: CronFile) => void): Promise<void> => {
    writeChain = writeChain.then(() => {
      const cron = loadCron(options.cronFile);
      mutate(cron);
      saveCron(options.cronFile, cron);
    });
    return writeChain;
  };

  const inFlight = new Set<string>();
  log(`gateway started (pid ${process.pid}, ${Math.round(tickMs / 1000)}s tick, cron: ${options.cronFile})`);
  logger.info("gateway.started", `gateway started (pid ${process.pid})`, { tickMs, cronFile: options.cronFile });
  writeFileSync(pidFile, String(process.pid));

  try {
    for (;;) {
      if (existsSync(stopFile)) {
        log("stop marker seen — shutting down");
        logger.info("gateway.stopped", "stop marker seen — shutting down");
        break;
      }
      let cron: CronFile | undefined;
      try {
        cron = loadCron(options.cronFile);
      } catch (error) {
        log(`cron.json error: ${errMsg(error)} — skipping tick`);
        logger.warn("gateway.tick_error", `cron.json error: ${errMsg(error)} — skipping tick`, errorData(error));
      }
      if (cron && !cron.paused) {
        const now = clock();
        if (now.getTime() - lastTickLog >= 60_000) {
          lastTickLog = now.getTime();
          logger.debug("gateway.tick", "gateway tick", { enabled: cron.jobs.filter((j) => j.enabled).length, inFlight: inFlight.size });
        }
        for (const job of cron.jobs) {
          if (!job.enabled) continue;
          if (inFlight.has(job.id)) continue;
          if (!isDue(job, now)) continue;
          const configPath = job.kind === "run" && job.config ? resolve(dirname(options.cronFile), job.config) : "";
          if (job.kind === "run" && !existsSync(configPath)) {
            await writeCron((c) => {
              const target = c.jobs.find((j) => j.id === job.id);
              if (target) target.lastStatus = `missing config: ${job.config}`;
            });
            log(`[${job.id}] missing config ${job.config} — marked failed`);
            logger.warn("job.missing_config", `[${job.id}] missing config ${job.config}`, { jobId: job.id, config: job.config });
            continue;
          }
          await writeCron((c) => {
            const target = c.jobs.find((j) => j.id === job.id);
            if (target) target.lastRun = now.toISOString();
            if (target) target.lastStatus = "running";
          });
          inFlight.add(job.id);
          log(`[${job.id}] spawn ${job.kind === "analysis" ? `analysis ${job.dbKey}` : job.config} (${job.schedule})`);
          logger.info("job.spawned", `[${job.id}] spawn ${job.kind === "analysis" ? `analysis ${job.dbKey}` : job.config}`, { jobId: job.id, kind: job.kind, schedule: job.schedule });
          spawnJob(job, configPath)
            .then((outcome) => {
              inFlight.delete(job.id);
              const text = outcomeText(outcome);
              return writeCron((c) => {
                const target = c.jobs.find((j) => j.id === job.id);
                if (target) target.lastStatus = text;
              }).then(() => {
                log(`[${job.id}] finished: ${text}`);
                logger.info("job.finished", `[${job.id}] finished: ${text}`, { jobId: job.id, outcome: text });
              });
            })
            .catch((error) => {
              inFlight.delete(job.id);
              log(`[${job.id}] error: ${errMsg(error)}`);
              logger.error("job.spawn_error", `[${job.id}] error: ${errMsg(error)}`, { jobId: job.id, ...errorData(error) });
            });
        }
      }
      if (await sleepUntil(tickMs, stopFile)) {
        log("stop marker seen — shutting down");
        logger.info("gateway.stopped", "stop marker seen — shutting down");
        break;
      }
    }
  } finally {
    rmSync(stopFile, { force: true });
    rmSync(pidFile, { force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
