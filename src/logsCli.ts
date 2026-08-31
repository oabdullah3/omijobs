import { homedir } from "node:os";
import { join } from "node:path";
import { queryLogs, type LogFilter } from "./logger.js";

export interface ParsedLogs {
  filter: LogFilter;
  json: boolean;
}

const RELATIVE = /^(\d+)(m|h|d)$/;

function relativeToIso(value: string): string | null {
  const m = RELATIVE.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

function splitCsv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseLogsArgs(argv: string[]): ParsedLogs | { error: string } {
  const filter: LogFilter = {};
  let json = false;

  const takeValue = (i: number, inline: string | undefined): { value: string; next: number } | { error: string } => {
    if (inline !== undefined) return { value: inline, next: i };
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith("--")) return { error: `missing value` };
    return { value: raw, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    switch (name) {
      case "--json":
        json = true;
        break;
      case "--source": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.source = splitCsv(t.value);
        i = t.next;
        break;
      }
      case "--level": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.level = splitCsv(t.value);
        i = t.next;
        break;
      }
      case "--from": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.from = relativeToIso(t.value) ?? t.value;
        i = t.next;
        break;
      }
      case "--to": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.to = t.value;
        i = t.next;
        break;
      }
      case "--run": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.runId = t.value;
        i = t.next;
        break;
      }
      case "--q": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.q = t.value;
        i = t.next;
        break;
      }
      case "--limit": {
        const t = takeValue(i, inline);
        if ("error" in t) return t;
        filter.limit = Number(t.value);
        i = t.next;
        break;
      }
      default:
        return { error: `unknown flag ${name}` };
    }
  }
  return { filter, json };
}

const COLORS: Record<string, string> = { debug: "\x1b[90m", info: "", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function renderTable(events: { ts: string; level: string; source: string; event: string; message: string }[]): string {
  const color = process.stdout.isTTY;
  const lines: string[] = [];
  for (const e of events) {
    const ts = e.ts.replace("T", " ").replace(/\.\d{3}Z$/, "");
    const c = color ? COLORS[e.level] ?? "" : "";
    const level = e.level.toUpperCase().padEnd(5);
    lines.push(`${c}${ts}  ${level}  ${e.source.padEnd(9)}  ${e.event.padEnd(24)}  ${e.message}${color ? RESET : ""}`);
  }
  return lines.join("\n");
}

export function runLogsCommand(argv: string[]): number {
  const parsed = parseLogsArgs(argv);
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    console.error(`Usage: omijobs logs [--source <s>] [--level <l>] [--from <iso|30m>] [--to <iso>] [--run <runId>] [--q <text>] [--limit <n>] [--json]`);
    return 2;
  }
  const { filter, json } = parsed;
  const result = queryLogs(filter, join(homedir(), ".omijobs", "logs"));
  if (json) {
    console.log(JSON.stringify(result.events, null, 2));
  } else if (result.events.length === 0) {
    console.log("(no matching events)");
  } else {
    console.log(renderTable(result.events));
    if (result.total > result.events.length) console.log(`… ${result.total - result.events.length} more (use --limit to raise)`);
  }
  return 0;
}
