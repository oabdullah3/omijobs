import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_SCHEDULES, defaultSpawnJob, loadCron, outcomeText, parseSchedule, runGateway, saveCron } from "./cron.js";
import { autostartStatus, registerAutostart, unregisterAutostart } from "./platform.js";
import type { CronFile, CronJob } from "./types.js";
import { discoverConfigs } from "./dashboardConfig.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(homedir(), ".omijobs");
const PID_FILE = join(STATE_DIR, "gateway.pid");
const STOP_FILE = join(STATE_DIR, "stop");
const LOG_FILE = join(STATE_DIR, "cron.log");
const CLI_PATH = resolve(PACKAGE_DIR, "dist", "cli.js");

function resolveCronFile(explicit?: string): string {
  return explicit ? resolve(explicit) : resolve(PACKAGE_DIR, "cron.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "job";
}

function uniqueId(cron: CronFile, base: string): string {
  const taken = new Set(cron.jobs.map((j) => j.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function forceKill(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function printCronHelp(): void {
  console.log(`Usage: omijobs cron <command>

Manage the scheduler ("gateway") and its cron jobs.

  add --config <path> --schedule "<str>" [--name <id>]
      Add a cron job. <path> is resolved relative to the cron.json folder.
      <str> is a human-friendly schedule:

${ACCEPTED_SCHEDULES.split("\n").map((l) => (l ? `      ${l}` : "")).join("\n")}

  list                       Show jobs + last run status
  enable <id> | disable <id> Toggle one job
  pause | resume             Pause/resume ALL jobs (top-level switch)
  remove <id>                Delete a job
  start                      Start the gateway (background) + register auto-start at login
  stop                       Stop the gateway + remove auto-start registration
  restart                    Stop, then start
  status                     Gateway state, autostart state, last log lines, jobs
  run                        Run every enabled job now (ignores the schedule) and exit
  gateway                    Internal: run the gateway loop in the foreground

State lives in ${STATE_DIR} (pidfile, cron.log).`);
}

interface AddArgs {
  config: string;
  schedule: string;
  name?: string;
}

function parseAddArgs(argv: string[]): AddArgs {
  const args: AddArgs = { config: "", schedule: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i] ?? "";
    else if (a === "--schedule") args.schedule = argv[++i] ?? "";
    else if (a === "--name") args.name = argv[++i] ?? "";
    else throw new Error(`Unknown cron add flag: ${a}`);
  }
  if (!args.config) throw new Error('cron add requires --config <path>');
  if (!args.schedule) throw new Error('cron add requires --schedule "<str>"');
  return args;
}

function parseAnalysisAddArgs(argv: string[]): { name: string; schedule: string; db: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const key = argv[i].replace(/^--/, ""); values[key] = argv[++i] ?? ""; }
  if (!values.name || !values.schedule || !values.db) throw new Error("cron add-analysis requires --name, --schedule, and --db");
  return { name: values.name, schedule: values.schedule, db: values.db };
}

async function cmdAdd(argv: string[], cronFile: string): Promise<number> {
  const args = parseAddArgs(argv);
  parseSchedule(args.schedule); // throws with the accepted forms on mismatch
  const configPath = resolve(dirname(cronFile), args.config);
  if (!existsSync(configPath)) {
    console.error(`Error: no config at ${configPath} (paths resolve relative to ${dirname(cronFile)}).`);
    return 1;
  }
  const cron = loadCron(cronFile);
  const id = uniqueId(cron, args.name ? slugify(args.name) : slugify(args.config.replace(/\.json$/, "")));
  cron.jobs.push({
    id,
    kind: "run",
    config: args.config,
    schedule: args.schedule,
    parsed: parseSchedule(args.schedule),
    enabled: true,
    lastRun: null,
    lastStatus: null,
  });
  saveCron(cronFile, cron);
  console.log(`Added cron job ${id} — every scheduled run: omijobs run --config ${args.config} (${args.schedule})`);
  console.log(`File: ${cronFile}`);
  return 0;
}

async function cmdAddAnalysis(argv: string[], cronFile: string): Promise<number> {
  const args = parseAnalysisAddArgs(argv); parseSchedule(args.schedule);
  const packageDir = resolve(dirname(cronFile));
  const valid = discoverConfigs({ packageDir, cronFile }).some((meta) => meta.id === args.db);
  if (!valid) { console.error(`Error: no DB config "${args.db}"`); return 1; }
  const cron = loadCron(cronFile); const id = uniqueId(cron, slugify(args.name));
  cron.jobs.push({ id, kind: "analysis", dbKey: args.db, schedule: args.schedule, parsed: parseSchedule(args.schedule), enabled: true, lastRun: null, lastStatus: null });
  saveCron(cronFile, cron); console.log(`Added analysis cron job ${id} for ${args.db}`); return 0;
}

async function cmdList(cronFile: string): Promise<number> {
  const cron = loadCron(cronFile);
  console.log(`paused: ${cron.paused}${cron.jobs.length === 0 ? " — no jobs yet (omijobs cron add --help)" : ""}`);
  for (const job of cron.jobs) {
    const when = job.lastRun ? new Date(job.lastRun).toISOString() : "never";
    const status = job.lastStatus ?? "—";
    console.log(`  ${job.id}${job.enabled ? "" : " [disabled]"}  ${job.schedule}  last=${when} (${status})  config=${job.config}`);
  }
  return 0;
}

async function cmdEnableDisable(argv: string[], cronFile: string, enabled: boolean): Promise<number> {
  const id = argv[0];
  if (!id) {
    console.error(`Error: cron ${enabled ? "enable" : "disable"} requires a job id`);
    return 1;
  }
  const cron = loadCron(cronFile);
  const job = cron.jobs.find((j) => j.id === id);
  if (!job) {
    console.error(`Error: no cron job "${id}" (see: omijobs cron list)`);
    return 1;
  }
  job.enabled = enabled;
  saveCron(cronFile, cron);
  console.log(`Cron job ${id} ${enabled ? "enabled" : "disabled"}`);
  return 0;
}

async function cmdPauseResume(cronFile: string, paused: boolean): Promise<number> {
  const cron = loadCron(cronFile);
  cron.paused = paused;
  saveCron(cronFile, cron);
  console.log(`Cron scheduling ${paused ? "paused (all jobs)" : "resumed"}`);
  return 0;
}

async function cmdRemove(argv: string[], cronFile: string): Promise<number> {
  const id = argv[0];
  if (!id) {
    console.error("Error: cron remove requires a job id");
    return 1;
  }
  const cron = loadCron(cronFile);
  const before = cron.jobs.length;
  cron.jobs = cron.jobs.filter((j) => j.id !== id);
  if (cron.jobs.length === before) {
    console.error(`Error: no cron job "${id}" (see: omijobs cron list)`);
    return 1;
  }
  saveCron(cronFile, cron);
  console.log(`Removed cron job ${id}`);
  return 0;
}

/**
 * Launch the gateway process and return its pid (or null on failure).
 *
 * Unix: a plain detached spawn is windowless and survives the shell — this is
 * the classic daemon pattern.
 *
 * Windows: `detached: true` would force a brand-new console window, and a
 * non-detached child is terminated when this parent process exits — so launch
 * through wscript with a hidden window (SW_HIDE) instead, which is how Windows
 * starts a truly background daemon. The gateway self-registers its pidfile, so
 * we poll briefly for it to report the real pid. Falls back to a detached spawn
 * (visible window) if wscript is unavailable.
 */
async function launchGateway(): Promise<number | null> {
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, [CLI_PATH, "cron", "gateway"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const childPid = child.pid ?? null;
    if (childPid !== null) writeFileSync(PID_FILE, String(childPid));
    return childPid;
  }
  try {
    const vbsPath = join(STATE_DIR, "start-gateway.vbs");
    // WScript.Shell.Run(cmd, 0, False): window style 0 = hidden, don't wait.
    const cmd = `"${process.execPath}" "${CLI_PATH}" cron gateway`;
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
    writeFileSync(vbsPath, vbs);
    const r = spawnSync("wscript.exe", [vbsPath], { stdio: "ignore", windowsHide: true });
    if (r.error) throw r.error;
  } catch {
    // Fall back to a detached spawn — it survives parent exit but shows a
    // console window on Windows. Better than refusing to start.
    const child = spawn(process.execPath, [CLI_PATH, "cron", "gateway"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const childPid = child.pid ?? null;
    if (childPid !== null) writeFileSync(PID_FILE, String(childPid));
    return childPid;
  }
  // wscript launched the gateway hidden; it writes its own pidfile on startup.
  for (let i = 0; i < 25; i++) {
    const pid = readPid();
    if (pid !== null) return pid;
    await sleep(200);
  }
  return null;
}

async function cmdStart(): Promise<number> {
  const pid = readPid();
  if (pid !== null && pidAlive(pid)) {
    console.log(`cron gateway already running (pid ${pid})`);
    return 0;
  }
  if (pid !== null) {
    rmSync(PID_FILE, { force: true }); // stale pidfile from a crashed gateway
    console.log("[warn] stale pidfile cleared (previous gateway was not running)");
  }
  // Make sure STATE_DIR exists before writing the pidfile / VBS launcher into it.
  mkdirSync(STATE_DIR, { recursive: true });
  const autostart = registerAutostart({ node: process.execPath, cliPath: CLI_PATH });
  const launchedPid = await launchGateway();
  if (launchedPid === null) {
    console.error("Error: failed to launch the cron gateway");
    return 1;
  }
  console.log(`cron gateway started (pid ${launchedPid})`);
  console.log(`  logs:  ${LOG_FILE}`);
  if (autostart.registered) {
    console.log(`  auto-start at login: registered (${autostart.mechanism})`);
  } else if (autostart.error) {
    console.log(`  [warn] auto-start registration failed (${autostart.mechanism}): ${autostart.error}`);
  }
  return 0;
}

async function cmdStop(): Promise<number> {
  const pid = readPid();
  if (pid === null) {
    console.log("cron gateway not running");
  } else if (!pidAlive(pid)) {
    console.log("cron gateway not running (stale pidfile)");
    rmSync(PID_FILE, { force: true });
  } else {
    writeFileSync(STOP_FILE, "");
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (!existsSync(PID_FILE)) break;
    }
    if (existsSync(PID_FILE)) {
      forceKill(pid);
      rmSync(PID_FILE, { force: true });
      rmSync(STOP_FILE, { force: true });
      console.log("cron gateway force-killed");
    } else {
      console.log("cron gateway stopped");
    }
  }
  unregisterAutostart();
  console.log("auto-start at login: removed");
  return 0;
}

async function cmdRestart(): Promise<number> {
  await cmdStop();
  return cmdStart();
}

async function cmdStatus(cronFile: string): Promise<number> {
  const pid = readPid();
  const alive = pid !== null && pidAlive(pid);
  console.log(`gateway:   ${alive ? `running (pid ${pid})` : "not running"}${pid !== null && !alive ? " (stale pidfile)" : ""}`);
  console.log(`state:     ${STATE_DIR}`);
  console.log(`auto-start at login: ${autostartStatus()}`);
  if (existsSync(LOG_FILE)) {
    const tail = readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-10);
    console.log("log (last lines):");
    for (const line of tail) console.log(`  ${line}`);
  } else {
    console.log("log: (none yet)");
  }
  let cron: CronFile;
  try {
    cron = loadCron(cronFile);
  } catch (error) {
    console.error(`cron.json error: ${errMsg(error)}`);
    return 1;
  }
  console.log(`jobs (${cron.jobs.length}, paused: ${cron.paused}):`);
  for (const job of cron.jobs) {
    console.log(`  ${job.id}${job.enabled ? "" : " [disabled]"}  ${job.schedule}  last=${job.lastRun ?? "never"} (${job.lastStatus ?? "—"})`);
  }
  return 0;
}

async function cmdRun(cronFile: string): Promise<number> {
  const cron = loadCron(cronFile);
  const jobs = cron.jobs.filter((j) => j.enabled);
  if (jobs.length === 0) {
    console.log("no enabled cron jobs to run (see: omijobs cron list)");
    return 0;
  }
  const spawnJob = defaultSpawnJob(CLI_PATH, STATE_DIR);
  let failed = 0;
  await Promise.all(
    jobs.map(async (job: CronJob) => {
      const configPath = job.config ? resolve(dirname(cronFile), job.config) : "";
      if (!existsSync(configPath)) {
        console.log(`  ${job.id} — missing config ${job.config}`);
        failed++;
        return;
      }
      console.log(`  ${job.id} — running (${job.config}) …`);
      const outcome = await spawnJob(job, configPath);
      const text = outcomeText(outcome);
      console.log(`  ${job.id} — ${text}`);
      if (!(outcome.ok && outcome.code === 0)) failed++;
    }),
  );
  console.log(`done: ${jobs.length - failed}/${jobs.length} succeeded`);
  return failed === 0 ? 0 : 1;
}

/**
 * Entry point for `omijobs cron ...`. Returns the process exit code.
 */
export async function runCronCommand(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const cronFile = resolveCronFile();
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printCronHelp();
      return 0;
    case "add":
      return cmdAdd(rest, cronFile);
    case "add-analysis":
      return cmdAddAnalysis(rest, cronFile);
    case "list":
      return cmdList(cronFile);
    case "enable":
      return cmdEnableDisable(rest, cronFile, true);
    case "disable":
      return cmdEnableDisable(rest, cronFile, false);
    case "pause":
      return cmdPauseResume(cronFile, true);
    case "resume":
      return cmdPauseResume(cronFile, false);
    case "remove":
      return cmdRemove(rest, cronFile);
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "restart":
      return cmdRestart();
    case "status":
      return cmdStatus(cronFile);
    case "run":
      return cmdRun(cronFile);
    case "gateway":
      await runGateway({ cronFile, cliPath: CLI_PATH, stateDir: STATE_DIR });
      return 0;
    default:
      console.error(`Error: unknown cron command "${cmd}"`);
      printCronHelp();
      return 2;
  }
}
