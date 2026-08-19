#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCronCommand } from "./cronCli.js";
import { adapters } from "./registry.js";
import { exitCode, normalizeQueries, runPipeline } from "./runtime.js";
import type { AdapterStatus, DedupedCase, DroppedCase, RunConfig, RunSummary } from "./types.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Locate + parse config.json: explicit --config path, else package dir. */
export function findConfig(explicit?: string): { path: string; config: RunConfig } {
  const path = explicit ? resolve(explicit) : resolve(PACKAGE_DIR, "config.json");
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

Options:
  --config <path>  Path to config.json (default: the folder containing package.json)
  --help           Show this help

Queries, enabled adapters, and per-adapter search params all live in config.json — see config.guide.md.
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

  const { config } = findConfig(parsed.configPath);
  const queries = normalizeQueries(config.global?.queries);
  const multiQuery = queries.length > 1;
  const trigger = process.env.OMI_JOB_FETCH_TRIGGER;

  const renderer = createRenderer();
  const { jobsFile, summary } = await runPipeline(config, adapters, {
    ...(trigger ? { trigger } : {}),
    onAdapterStart: (index, total, adapterId, query) => {
      renderer.boundary(`[${index}/${total}] running ${adapterId}${multiQuery ? ` · "${query}"` : ""} …`);
    },
    onAdapterDone: (index, total, status, query) => {
      renderer.boundary(`[${index}/${total}]${statusLine(status)}${multiQuery ? ` · "${query}"` : ""}`);
    },
    onProgress: (adapterId, status) => {
      renderer.live(`  ${adapterId} · ${status}`);
    },
  });
  renderer.boundary(`Wrote ${fmt(summary.jobs)} jobs to ${jobsFile}`);
  if (summary.db) {
    const { added, updated, removed, total } = summary.db;
    renderer.boundary(`[db] +${fmt(added)} new, ${fmt(updated)} updated, ${fmt(removed)} expired, ${fmt(total)} total`);
  }
  if (summary.dbError) {
    renderer.boundary(`[db] sync failed: ${summary.dbError} (run results saved normally)`);
  }
  // Adapter operational warnings (ignored inputs, caps, failures) — meta.warnings.
  // With multiple queries the same warning repeats per run; print each one once.
  const warned = new Set<string>();
  for (const s of summary.adapters) {
    const warnings = Array.isArray(s.meta?.warnings) ? (s.meta.warnings as unknown[]) : [];
    for (const w of warnings) {
      if (typeof w === "string" && w.trim() && !warned.has(`${s.adapter}::${w}`)) {
        warned.add(`${s.adapter}::${w}`);
        console.log(`  [warn]  ${s.adapter} — ${w}`);
      }
    }
  }
  // Manual-review trail: every dropped / deduped case, compacted and grouped by title.
  for (const line of renderTrail(summary)) console.log(line);
  return exitCode(summary);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let code: number;
  if (argv[0] === "cron") {
    code = await runCronCommand(argv.slice(1));
  } else if (argv[0] === "run") {
    code = await runCommand(argv.slice(1));
  } else {
    // Bare `omijobs [--config …]` behaves as `omijobs run`.
    code = await runCommand(argv);
  }
  process.exit(code);
}

// Only run when executed directly (e.g. `node dist/cli.js`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
