#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInput, resolveContract } from "./contract.js";
import { adapters } from "./registry.js";
import { exitCode, runPipeline } from "./runtime.js";
import type { RunConfig } from "./types.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Coerce obvious types: "true"/"false" -> boolean, number-like strings -> number. */
export function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export interface ParsedArgs {
  flags: Record<string, unknown>;
  configPath?: string;
  help: boolean;
}

/** Parse CLI flags: --key value, --key=value. A flag with no value is boolean true. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, unknown> = {};
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "help") return { flags, configPath, help: true };
    let value: unknown = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (name === "config") {
      configPath = String(value);
      continue;
    }
    flags[name] = coerce(value);
  }
  return { flags, configPath, help: false };
}

/** Locate + parse config.json: explicit path, else cwd, else package dir. */
export function findConfig(explicit?: string): { path: string; config: RunConfig } {
  const candidates = explicit ? [resolve(explicit)] : [resolve("config.json"), resolve(PACKAGE_DIR, "config.json")];
  for (const path of candidates) {
    if (existsSync(path)) {
      return { path, config: JSON.parse(readFileSync(path, "utf8")) as RunConfig };
    }
  }
  throw new Error("No config.json found. Pass --config <path> or create config.json in cwd.");
}

function printHelp(): void {
  const contract = resolveContract();
  console.log("Usage: omi-job-fetch [options]");
  console.log("Contract input flags:");
  for (const [key, def] of Object.entries(contract.inputs)) {
    console.log(`  --${key}  ${def.required ? "(required) " : ""}default: ${JSON.stringify(def.default ?? null)}`);
  }
  console.log("  --config <path>  Path to config.json (default: cwd or package dir)");
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  const { config } = findConfig(parsed.configPath);
  const contract = resolveContract(config.contract);
  const input = buildInput(contract, parsed.flags);

  const { jobsFile, summary } = await runPipeline(config, input, adapters);
  console.log(`Wrote ${summary.jobs} jobs to ${jobsFile}`);
  for (const s of summary.adapters) {
    const detail =
      s.status === "ok"
        ? ` (${s.jobCount} raw, ${s.dropped ?? 0} dropped)`
        : s.reason
          ? ` — ${s.reason}`
          : s.error
            ? ` — ${s.error}`
            : "";
    console.log(`  [${s.status}] ${s.adapter}${detail}`);
  }
  // Manual-review trail: every dropped / deduped case with its link.
  for (const c of summary.droppedCases) {
    const link = c.link ?? "—";
    console.log(`  [drop]   ${String(c.title ?? "<no title>")} — missing ${c.missing.join(", ")} — ${link}`);
  }
  for (const c of summary.dedupedCases) {
    const link = c.link ?? "—";
    const kept = c.keptLink ?? "—";
    console.log(`  [dedup]  ${String(c.title ?? "<no title>")} @ ${String(c.company ?? "<no company>")} — ${link}  == kept ${kept}`);
  }
  process.exit(exitCode(summary));
}

// Only run when executed directly (e.g. `node dist/cli.js`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
