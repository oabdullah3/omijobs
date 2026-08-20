import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadCron, nextDueAt } from "./cron.js";
import { autostartStatus } from "./platform.js";
import type { CronSchedule } from "./types.js";

export interface CronJobState {
  id: string;
  config: string;
  configPath: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: string | null;
  nextRunAt: string;
  running: boolean;
}
export interface CronGatewayState {
  file: string;
  paused: boolean;
  error?: string;
  gateway: { running: boolean; pid: number | null; stale: boolean; autostart: string };
  jobs: CronJobState[];
}
export interface MutationResult { ok: boolean; code: number; output: string; }
export interface CronStateInput {
  cronFile: string;
  stateDir: string;
  now?: Date;
  /** Config ids with a live run (dashboard-triggered or PID-verified marker). When provided, overrides the lastStatus heuristic. */
  runningIds?: Set<string>;
}

/** Next firing time as an ISO string, clamped to `now` when overdue. */
export function nextRunAt(schedule: CronSchedule, lastRun: string | null, now: Date): string {
  if (lastRun === null) {
    // Never-run jobs of any schedule are due immediately (matches isDue()'s
    // catch-up), so they show "due now" until the gateway's next tick fires them.
    return now.toISOString();
  }
  const last = new Date(lastRun);
  if (Number.isNaN(last.getTime())) {
    // Corrupted lastRun — treat the job as never-run.
    return now.toISOString();
  }
  const next = nextDueAt(schedule, last);
  return next.getTime() <= now.getTime() ? now.toISOString() : next.toISOString();
}

export function gatewayAlive(stateDir: string): { running: boolean; pid: number | null; stale: boolean } {
  const pidFile = join(stateDir, "gateway.pid");
  if (!existsSync(pidFile)) return { running: false, pid: null, stale: false };
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return { running: false, pid: null, stale: true };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null, stale: true };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return { running: alive, pid, stale: !alive };
}

/** Read cron.json into a view model the UI can render directly. */
export function getCronState(input: CronStateInput): CronGatewayState {
  let cron: ReturnType<typeof loadCron>;
  try {
    cron = loadCron(input.cronFile);
  } catch (error) {
    return {
      file: input.cronFile,
      paused: false,
      error: error instanceof Error ? error.message : String(error),
      gateway: { ...gatewayAlive(input.stateDir), autostart: autostartStatus() },
      jobs: [],
    };
  }
  const gw = gatewayAlive(input.stateDir);
  const now = input.now ?? new Date();
  const jobs = cron.jobs.map((job) => ({
    id: job.id,
    config: job.config,
    configPath: resolve(resolve(input.cronFile, ".."), job.config),
    schedule: job.schedule,
    enabled: job.enabled,
    lastRun: job.lastRun,
    lastStatus: job.lastStatus,
    // A supplied running set (live-PID markers + in-process inflight) is
    // authoritative — `lastStatus === "running"` goes stale forever if the
    // gateway is killed mid-run.
    running: input.runningIds ? input.runningIds.has(job.id) : job.lastStatus === "running",
    nextRunAt: nextRunAt(job.parsed, job.lastRun, now),
  }));
  return {
    file: input.cronFile,
    paused: cron.paused,
    gateway: { ...gw, autostart: autostartStatus() },
    jobs,
  };
}

/** Spawn `node <cliPath> cron <args>` and capture its output + exit code. */
export function runCronMutation(input: { cliPath: string; args: string[] }): Promise<MutationResult> {
  return new Promise((resolveMutation) => {
    const child = spawn(process.execPath, [input.cliPath, "cron", ...input.args], {
      windowsHide: true,
      env: { ...process.env, OMI_JOB_FETCH_TRIGGER: "dashboard" },
    });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("error", (error) => resolveMutation({ ok: false, code: 1, output: error.message }));
    child.on("close", (code) => resolveMutation({ ok: code === 0, code: code ?? 1, output }));
  });
}

/** Last N lines of the gateway log (empty array when absent). */
export function tailLog(stateDir: string, lines = 30): string[] {
  const file = resolve(stateDir, "cron.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").slice(-lines);
}
