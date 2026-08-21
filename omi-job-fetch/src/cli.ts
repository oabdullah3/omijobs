#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCronCommand } from "./cronCli.js";
import { runAnalyzeCommand } from "./analysisCli.js";
import { runDbCommand } from "./dbCli.js";
import { resolveBaseRetention } from "./dashboardConfig.js";
import { startDashboard } from "./dashboardServer.js";
import { adapters } from "./registry.js";
import { exitCode, normalizeQueries, runPipeline } from "./runtime.js";
import type { AdapterStatus, DedupedCase, DroppedCase, RunConfig, RunSummary } from "./types.js";
import { ensureUserFiles } from "./userPaths.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_STATE_DIR = resolve(homedir(), ".omijobs");

export interface ParsedArgs {
  configPath?: string;
  help: boolean;
}

/** Parse CLI flags: the only accepted flag is --config <path> (or --config=<path>). */
export function parseArgs(argv: string[]): ParsedArgs {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "help") return { configPath, help: true };
    if (name === "config") {
      let value: unknown = eq === -1 ? undefined : arg.slice(eq + 1);
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        }
      }
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("--config requires a file path");
      }
      configPath = value;
      continue;
    }
    throw new Error(`Unknown flag: --${name}`);
  }
  return { configPath, help: false };
}

export function parseDashboardFlags(argv: string[]): { port?: number; error?: string } {
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const raw = argv[++i];
      if (raw === undefined) return { error: "--port requires a number" };
      port = Number(raw);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice(7));
    } else {
      return { error: `Unknown dashboard flag: ${a}` };
    }
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { error: "--port must be an integer in 1–65535" };
  }
  return { port };
}

async function runDashboardCommand(argv: string[]): Promise<number> {
  const { port, error } = parseDashboardFlags(argv);
  if (error) {
    console.error(`Error: ${error}`);
    console.log("Usage: omijobs dashboard [--port <number>]");
    return 2;
  }
  try {
    const { url } = await startDashboard({ port });
    console.log(`omijobs dashboard: ${url}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise(() => {}); // keep running until the user presses Ctrl+C
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Locate + parse config.json: explicit --config path, else the fixed realtime config. */
export function findConfig(explicit?: string): { path: string; config: RunConfig } {
  const path = explicit ? resolve(explicit) : ensureUserFiles(PACKAGE_DIR, USER_STATE_DIR).baseConfig;
  if (!existsSync(path)) {
    throw new Error(`No config.json at ${path}. Pass --config <path> to point at a different file.`);
  }
  return { path, config: JSON.parse(readFileSync(path, "utf8")) as RunConfig };
}

function printHelp(): void {
  console.log(`Usage: omijobs <command>

Commands:
  run [--config <path>]   Run a job sweep now (the default when no command is given)
  cron ...                Manage the cron gateway and scheduled jobs
  db ...                  List and delete aggregate DBs
  dashboard [--port N]    Open the web dashboard (default port 5211)

Options:
  --config <path>  Path to config.json (default: ~/.omijobs/dashboard.configs/realtime/config.json, auto-seeded from config.base.json)
  --help           Show this help

On first run the base config is seeded from config.base.json into ~/.omijobs/dashboard.configs/realtime/config.json — see config.guide.md.
Cron jobs, schedules, and the gateway: omijobs cron --help`);
}

/** Compact count formatting for progress lines: 1878 -> "1,878". */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Duration: >= 1s as whole seconds, else ms. */
function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * Progress renderer. Boundary lines always print (clear the live line first);
 * the single in-place live line only shows on a TTY, so piped/redirected
 * output stays a clean list of boundaries with no control chars.
 */
export function createRenderer(): {
  isTTY: boolean;
  boundary: (line: string) => void;
  live: (text: string) => void;
} {
  const isTTY = process.stdout.isTTY === true;
  let liveLen = 0;
  return {
    isTTY,
    boundary(line: string) {
      if (liveLen > 0) process.stdout.write(`\r${" ".repeat(liveLen)}\r`);
      liveLen = 0;
      console.log(line);
    },
    live(text: string) {
      if (!isTTY) return; // stay quiet when output is piped/redirected
      if (liveLen > 0) process.stdout.write(`\r${" ".repeat(liveLen)}\r`);
      process.stdout.write(text);
      liveLen = text.length;
    },
  };
}

/**
 * Optional file-side channel mirroring the run's console lines into
 * OMI_JOB_FETCH_PROGRESS_FILE when set. Purely additive — stdout/stderr are
 * untouched (the dashboard spawns runs with piped stdout, so it can't read the
 * live line any other way). The file is truncated at run start and persists
 * after, so the dashboard tails it while the run is live and reads the final
 * `result:` line once it completes.
 */
export function createProgressFile(): { line: (text: string) => void; result: (text: string) => void } {
  const file = process.env.OMI_JOB_FETCH_PROGRESS_FILE;
  if (!file) return { line: () => {}, result: () => {} };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "", "utf8"); // truncate per run
  } catch {
    return { line: () => {}, result: () => {} }; // never fatal — best effort only
  }
  return {
    line(text: string) {
      try {
        appendFileSync(file, `${text}\n`, "utf8");
      } catch {
        /* best effort */
      }
    },
    result(text: string) {
      try {
        appendFileSync(file, `result: ${text}\n`, "utf8");
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Optional running-marker file: writes `{ pid, startedAt }` to
 * OMI_JOB_FETCH_RUN_MARKER when set, and returns a `clear()` that deletes it.
 * The CLI owns this file — it writes its PID at run start and clears it on exit
 * (finally), so a restarted dashboard can tell the run is still in flight even
 * if every parent process is gone. Purely additive like the progress file.
 */
export function createRunMarker(): { pid: number | null; clear: () => void } {
  const file = process.env.OMI_JOB_FETCH_RUN_MARKER;
  if (!file) return { pid: null, clear: () => {} };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  } catch {
    return { pid: null, clear: () => {} }; // best effort — never fatal
  }
  return {
    pid: process.pid,
    clear: () => {
      try {
        rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Stop-marker watch. When OMI_JOB_FETCH_STOP_FILE is set, polls the marker
 * file every 250ms (and treats SIGINT/SIGTERM as an abort) so a dashboard Stop
 * click lands without killing the process — the run then finalizes with the
 * partial results it already collected. Returns an `aborted()` probe for
 * runPipeline and a `dispose()` to stop polling once the run is done.
 */
export function createStopWatch(
  stopFile?: string,
): { aborted: () => boolean; dispose: () => void } {
  let aborted = false;
  const timer = stopFile
    ? setInterval(() => {
        if (existsSync(stopFile)) aborted = true;
      }, 250)
    : null;
  const onSignal = () => {
    aborted = true;
  };
  if (stopFile) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return {
    aborted: () => aborted,
    dispose: () => {
      if (timer) clearInterval(timer);
      if (stopFile) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    },
  };
}

/** One line per adapter result, printed right after the adapter finishes. */
function statusLine(status: AdapterStatus): string {
  const mark = status.status === "ok" ? "✓" : status.status === "skipped" ? "–" : "✗";
  const detail =
    status.status === "ok"
      ? ` — ${fmt(status.jobCount ?? 0)} raw, ${status.dropped ?? 0} dropped, ${fmtDuration(status.durationMs ?? 0)}`
      : status.reason
        ? ` — skipped: ${status.reason}`
        : status.error
          ? ` — ${status.error}`
          : "";
  return `${mark} ${status.adapter}${detail}`;
}

/** Reduce a job URL to its distinguishing tail (the job-ID segment) for compact display. */
export function compactLink(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    let tail = segs.length ? (segs[segs.length - 1] ?? "") : "";
    // Drop a trailing generic action segment (e.g. jobsdb ".../{id}/apply").
    if (segs.length > 1 && /^(apply|detail|job|view)$/i.test(tail)) tail = segs[segs.length - 2] ?? "";
    if (!tail) return u.hostname;
    return /^\d+$/.test(tail) ? `#${tail}` : tail;
  } catch {
    return url;
  }
}

/** Cut a string to maxLen chars, appending "…" when truncated. */
function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, maxLen - 1)}…`;
}

function plural(n: number, word: string): string {
  return `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** Sort the review trail by title (then company) so identical listings cluster. */
function caseSort(a: { title: unknown; company?: unknown }, b: { title: unknown; company?: unknown }): number {
  const byTitle = String(a.title ?? "").localeCompare(String(b.title ?? ""));
  if (byTitle !== 0) return byTitle;
  return String(a.company ?? "").localeCompare(String(b.company ?? ""));
}

function dropLine(c: DroppedCase): string {
  return `  drop   ${truncate(String(c.title ?? "<no title>"), 62)} — missing ${c.missing.join(", ")} — ${compactLink(c.link)}`;
}

function dedupLine(c: DedupedCase): string {
  return `  dedup  ${truncate(String(c.title ?? "<no title>"), 46)} @ ${truncate(String(c.company ?? "<no company>"), 26)} — ${compactLink(c.link)} → ${compactLink(c.keptLink)}`;
}

/**
 * The manual-review trail, rendered compact: full URLs reduced to their job-ID
 * tails, lines sorted so identical titles cluster. run.json always keeps the
 * full structured list (untruncated titles + full links).
 */
export function renderTrail(summary: Pick<RunSummary, "droppedCases" | "dedupedCases">): string[] {
  const lines: string[] = [];
  const dropped = summary.droppedCases ?? [];
  const deduped = summary.dedupedCases ?? [];
  if (dropped.length > 0) {
    lines.push(`Dropped ${plural(dropped.length, "listing")}`);
    for (const c of [...dropped].sort(caseSort)) lines.push(dropLine(c));
  }
  if (deduped.length > 0) {
    const unique = new Set(deduped.map((c) => `${String(c.title ?? "")}${String.fromCharCode(0)}${String(c.company ?? "")}`)).size;
    lines.push(`Deduplicated ${plural(deduped.length, "duplicate listing")} · ${plural(unique, "unique title")}`);
    for (const c of [...deduped].sort(caseSort)) lines.push(dedupLine(c));
  }
  return lines;
}

/**
 * Run a job sweep now — the `run` subcommand (also the default when invoked
 * with no command). Reads OMI_JOB_FETCH_TRIGGER so a cron-spawned run marks
 * itself in run.json. Returns the process exit code.
 */
async function runCommand(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    return 2;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }

  // Write the running marker before anything that can throw: the finally clears
  // it on every exit path (normal return, stop-abort, and thrown errors that
  // otherwise skip straight to process.exit(1) in main()).
  const marker = createRunMarker();
  try {
    const found = findConfig(parsed.configPath);
    const { config } = found;
    const queries = normalizeQueries(config.global?.queries);
    const multiQuery = queries.length > 1;
    const trigger = process.env.OMI_JOB_FETCH_TRIGGER;

    const renderer = createRenderer();
    const progress = createProgressFile();
    // Mirror every console line to the progress file so the dashboard can tail it.
    const boundary = (line: string) => {
      renderer.boundary(line);
      progress.line(line);
    };
    const live = (text: string) => {
      renderer.live(text);
      progress.line(text);
    };
    const note = (line: string) => {
      console.log(line);
      progress.line(line);
    };

    const stop = createStopWatch(process.env.OMI_JOB_FETCH_STOP_FILE);
    const { jobsFile, summary } = await runPipeline(config, adapters, {
      outputDir: resolve(dirname(found.path), config.outputDir ?? "output"),
      retentionDays: resolveBaseRetention(parsed.configPath ? dirname(found.path) : USER_STATE_DIR),
      ...(trigger ? { trigger } : {}),
      aborted: stop.aborted,
      onAdapterStart: (index, total, adapterId, query) => {
        boundary(`[${index}/${total}] running ${adapterId}${multiQuery ? ` · "${query}"` : ""} …`);
      },
      onAdapterDone: (index, total, status, query) => {
        boundary(`[${index}/${total}]${statusLine(status)}${multiQuery ? ` · "${query}"` : ""}`);
      },
      onProgress: (adapterId, status) => {
        live(`  ${adapterId} · ${status}`);
      },
    });
    stop.dispose();
    boundary(`Wrote ${fmt(summary.jobs)} jobs to ${jobsFile}`);
    if (summary.db) {
      const { added, updated, removed, total } = summary.db;
      boundary(`[db] +${fmt(added)} new, ${fmt(updated)} updated, ${fmt(removed)} expired, ${fmt(total)} total`);
    }
    if (summary.dbError) {
      boundary(`[db] sync failed: ${summary.dbError} (run results saved normally)`);
    }
    // Adapter operational warnings (ignored inputs, caps, failures) — meta.warnings.
    // With multiple queries the same warning repeats per run; print each one once.
    const warned = new Set<string>();
    for (const s of summary.adapters) {
      const warnings = Array.isArray(s.meta?.warnings) ? (s.meta.warnings as unknown[]) : [];
      for (const w of warnings) {
        if (typeof w === "string" && w.trim() && !warned.has(`${s.adapter}::${w}`)) {
          warned.add(`${s.adapter}::${w}`);
          note(`  [warn]  ${s.adapter} — ${w}`);
        }
      }
    }
    // Manual-review trail: every dropped / deduped case, compacted and grouped by title.
    for (const line of renderTrail(summary)) note(line);
    // File-only result line for the dashboard card (stdout stays byte-identical).
    const resultText = [
      `${fmt(summary.jobs)} jobs, ${fmt(summary.dropped)} dropped, ${fmt(summary.duplicatesRemoved)} deduped`,
      ...(summary.db
        ? [`db +${fmt(summary.db.added)} new, ${fmt(summary.db.updated)} updated, ${fmt(summary.db.removed)} removed`]
        : []),
      ...(summary.stopped ? ["stopped"] : []),
    ].join(" · ");
    progress.result(resultText);
    return summary.stopped ? 130 : exitCode(summary);
  } finally {
    marker.clear();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let code: number;
  if (argv[0] === "cron") {
    code = await runCronCommand(argv.slice(1));
  } else if (argv[0] === "analyze") {
    try { code = await runAnalyzeCommand(argv.slice(1)); }
    catch (error) { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); code = 1; }
  } else if (argv[0] === "run") {
    code = await runCommand(argv.slice(1));
  } else if (argv[0] === "dashboard") {
    code = await runDashboardCommand(argv.slice(1));
  } else if (argv[0] === "db") {
    code = await runDbCommand(argv.slice(1));
  } else {
    // Bare `omijobs [--config …]` behaves as `omijobs run`.
    code = await runCommand(argv);
  }
  process.exit(code);
}

// Only run when executed directly (e.g. `node dist/cli.js`), not when imported by tests.
const isMain = process.argv[1] !== undefined && /(?:^|[\\/])cli\.js$/i.test(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
