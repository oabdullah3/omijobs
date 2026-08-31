import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { timestampId } from "./runtime.js";

export interface RunSpawnInput {
  cliPath: string;
  configPath: string;
  trigger?: string;
  onExit?: (code: number | null) => void;
  /** Progress file the CLI mirrors its console lines into (dashboard tails it). */
  progressFile?: string;
  /** Stop marker the dashboard writes to abort this run. */
  stopFile?: string;
  /** Running-marker file the CLI writes its PID into while in flight (dashboard reads it to reattach). */
  runMarkerFile?: string;
  /** Optional cron/dashboard job id, threaded to the child as OMI_JOB_FETCH_JOB_ID for log correlation. */
  jobId?: string;
}
export interface RunSpawnResult { id: string; }

export interface RunMeta {
  id: string;
  path: string;
  startedAt: string | null;
  durationMs: number | null;
  jobs: number;
  trigger?: string;
  adapters: { adapter: string; status: string; jobCount?: number; durationMs?: number; error?: string }[];
}

/**
 * Spawn one run: `node <cli> run --config <path>` with the dashboard trigger env.
 * The child is fully detached (`stdio: "ignore"`, like the gateway's runs) so it
 * survives this dashboard dying — a restarted dashboard reattaches via the
 * run-marker file the CLI writes its PID into, and tails the progress file.
 */
export function startRun(input: RunSpawnInput): RunSpawnResult {
  const id = timestampId(new Date());
  // Clear stale stop/run markers from a previous run before this one starts.
  if (input.stopFile) rmSync(input.stopFile, { force: true });
  if (input.runMarkerFile) rmSync(input.runMarkerFile, { force: true });
  const child = spawn(process.execPath, [input.cliPath, "run", "--config", input.configPath], {
    env: {
      ...process.env,
      OMI_JOB_FETCH_TRIGGER: input.trigger ?? "dashboard",
      ...(input.jobId ? { OMI_JOB_FETCH_JOB_ID: input.jobId } : {}),
      ...(input.progressFile ? { OMI_JOB_FETCH_PROGRESS_FILE: input.progressFile } : {}),
      ...(input.stopFile ? { OMI_JOB_FETCH_STOP_FILE: input.stopFile } : {}),
      ...(input.runMarkerFile ? { OMI_JOB_FETCH_RUN_MARKER: input.runMarkerFile } : {}),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => input.onExit?.(null));
  child.on("close", (code) => input.onExit?.(code));
  return { id };
}

/**
 * Read per-config live progress + persisted result from the progress files the
 * CLI writes into `<stateDir>/runs/<id>.log`. Returns one entry per config that
 * has a progress file (so a completed run's result persists on its card until
 * the next run). `lastLines` excludes the file-only `result:` line (kept
 * separate); `running` is set from the caller's running-id set.
 */
export function readRunStatus(
  stateDir: string,
  runningIds: Set<string>,
  maxLines = 40,
): Record<string, { running: boolean; lastLines: string[]; result: string | null; updatedAt: string | null }> {
  const runsDir = resolve(stateDir, "runs");
  const out: Record<string, { running: boolean; lastLines: string[]; result: string | null; updatedAt: string | null }> = {};
  if (!existsSync(runsDir)) return out;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const id = entry.name.slice(0, -".log".length);
    let lines: string[];
    let updatedAt: string | null = null;
    try {
      lines = readFileSync(join(runsDir, entry.name), "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
      updatedAt = statSync(join(runsDir, entry.name)).mtime.toISOString();
    } catch {
      continue;
    }
    let result: string | null = null;
    const body: string[] = [];
    for (const line of lines) {
      if (line.startsWith("result: ")) result = line.slice("result: ".length);
      else if (line.trim() !== "") body.push(line);
    }
    out[id] = { running: runningIds.has(id), lastLines: body.slice(-maxLines), result, updatedAt };
  }
  return out;
}

/**
 * Read the run markers the CLI writes into `<stateDir>/runs/<id>.running`
 * (`{ pid, startedAt }`), returning only the ids whose PID is still alive — the
 * source of truth for "is this config's run in flight" across dashboard
 * restarts. Dead or corrupt markers are deleted (opportunistic cleanup); EPERM
 * counts as alive, matching `gatewayAlive` in dashboardCron.ts.
 */
export function readRunningMarkers(stateDir: string): Map<string, number> {
  const runsDir = resolve(stateDir, "runs");
  const out = new Map<string, number>();
  if (!existsSync(runsDir)) return out;
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".running")) continue;
    const id = entry.name.slice(0, -".running".length);
    const file = join(runsDir, entry.name);
    let pid = Number.NaN;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
    } catch {
      rmSync(file, { force: true }); // corrupt marker — clean it up
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      rmSync(file, { force: true });
      continue;
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!alive) rmSync(file, { force: true });
    else out.set(id, pid);
  }
  return out;
}

/** List run metadata from outputDir/runs/<id>/run.json, newest first. */
export function listRuns(outputDir: string, limit = 20): RunMeta[] {
  const runsDir = resolve(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  const metas: RunMeta[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(runsDir, entry.name, "run.json");
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      metas.push({
        id: String(raw.id ?? entry.name),
        path: file,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        durationMs: typeof raw.durationMs === "number" ? raw.durationMs : null,
        jobs: typeof raw.jobs === "number" ? raw.jobs : 0,
        trigger: typeof raw.trigger === "string" ? raw.trigger : undefined,
        adapters: Array.isArray(raw.adapters) ? (raw.adapters as RunMeta["adapters"]) : [],
      });
    } catch {
      // Corrupt run.json — skip.
    }
  }
  metas.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return metas.slice(0, limit);
}
