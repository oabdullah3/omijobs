import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Load node:sqlite through createRequire rather than a static import: vitest's
// vite-node server strips "node:" from ids it doesn't recognize (its static
// builtinModules list lacks sqlite) and then fails to load them as files. A
// require() call is a plain runtime call, untouched by Vite's transform, so
// Node resolves node:sqlite natively — under vitest and under the real CLI.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DbConnection = InstanceType<typeof DatabaseSync>;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "gateway" | "run" | "analysis" | "dashboard";

export interface LogEvent {
  ts: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  runId: string | null;
  jobId: string | null;
  pid: number;
  message: string;
  data: Record<string, unknown> | null;
}

export interface LoggerContext {
  source: LogSource;
  runId?: string | null;
  jobId?: string | null;
}

export interface Logger {
  debug(event: string, message: string, data?: Record<string, unknown> | null): void;
  info(event: string, message: string, data?: Record<string, unknown> | null): void;
  warn(event: string, message: string, data?: Record<string, unknown> | null): void;
  error(event: string, message: string, data?: Record<string, unknown> | null): void;
  child(ctx: Partial<LoggerContext>): Logger;
}

const DEFAULT_RETENTION_DAYS = 14;
const RETENTION_ENV = "OMIJOBS_LOG_RETENTION_DAYS";
const PURGE_INTERVAL_MS = 86_400_000; // once per day

let defaultDir: string | null = null;

export function setLogDir(dir: string): void {
  defaultDir = dir;
}

function resolveDir(logDir?: string): string {
  return logDir ?? defaultDir ?? join(homedir(), ".omijobs", "logs");
}

function retentionDays(): number {
  const raw = process.env[RETENTION_ENV];
  const n = raw === undefined ? DEFAULT_RETENTION_DAYS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function errorData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { error: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { error: String(error) };
}

function migrate(db: DbConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      event TEXT NOT NULL,
      runId TEXT,
      jobId TEXT,
      pid INTEGER,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, level);
    CREATE INDEX IF NOT EXISTS idx_events_runId  ON events(runId);
    CREATE INDEX IF NOT EXISTS idx_events_jobId  ON events(jobId);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function purge(db: DbConnection, logDir: string, now: Date): void {
  const days = retentionDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const cutoffIso = cutoff.toISOString();
  db.prepare("DELETE FROM events WHERE ts < ?").run(cutoffIso);
  // Delete daily JSONL files whose date is before the cutoff day.
  const cutoffDay = cutoffIso.slice(0, 10);
  for (const name of readdirSync(logDir)) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (m && m[1] < cutoffDay) rmSync(join(logDir, name), { force: true });
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('lastPurgeAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now.toISOString());
}

function maybePurge(db: DbConnection, logDir: string): void {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'lastPurgeAt'").get() as { value?: string } | undefined;
    const last = row?.value ? Date.parse(row.value) : 0;
    if (Date.now() - last < PURGE_INTERVAL_MS) return;
    purge(db, logDir, new Date());
  } catch {
    /* purge is best-effort */
  }
}

function openDb(logDir: string): DbConnection {
  mkdirSync(logDir, { recursive: true });
  const db = new DatabaseSync(join(logDir, "events.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  maybePurge(db, logDir);
  return db;
}

function writeEvent(logDir: string, event: LogEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  const day = event.ts.slice(0, 10);
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, `events-${day}.jsonl`), line, "utf8");
  } catch {
    /* best effort */
  }
  let db: DbConnection | null = null;
  try {
    db = openDb(logDir);
    db.prepare(
      "INSERT INTO events (ts, level, source, event, runId, jobId, pid, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(event.ts, event.level, event.source, event.event, event.runId, event.jobId, event.pid, event.message, event.data ? JSON.stringify(event.data) : null);
  } catch {
    /* best effort */
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

export function createLogger(ctx: LoggerContext, logDir?: string): Logger {
  const dir = resolveDir(logDir);
  const emit = (level: LogLevel, event: string, message: string, data?: Record<string, unknown> | null): void => {
    const full: LogEvent = {
      ts: new Date().toISOString(),
      level,
      source: ctx.source,
      event,
      runId: ctx.runId ?? null,
      jobId: ctx.jobId ?? null,
      pid: process.pid,
      message,
      data: data ?? null,
    };
    writeEvent(dir, full);
  };
  return {
    debug: (e, m, d) => emit("debug", e, m, d),
    info: (e, m, d) => emit("info", e, m, d),
    warn: (e, m, d) => emit("warn", e, m, d),
    error: (e, m, d) => emit("error", e, m, d),
    child: (childCtx) => createLogger({ ...ctx, ...childCtx }, logDir),
  };
}

// --- query layer ---

export interface LogFilter {
  source?: string | string[];
  level?: string | string[];
  from?: string;
  to?: string;
  q?: string;
  runId?: string;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  total: number;
  events: LogEvent[];
}

export interface LogMeta {
  sources: string[];
  levels: string[];
  minTs: string | null;
  maxTs: string | null;
  counts: Record<string, Record<string, number>>;
  recentRunIds: string[];
  recentJobIds: string[];
}

function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : value.split(",");
  return arr.map((s) => s.trim()).filter(Boolean);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function rowToEvent(row: Record<string, unknown>): LogEvent {
  return {
    ts: String(row.ts),
    level: row.level as LogLevel,
    source: row.source as LogSource,
    event: String(row.event),
    runId: row.runId == null ? null : String(row.runId),
    jobId: row.jobId == null ? null : String(row.jobId),
    pid: Number(row.pid ?? 0),
    message: String(row.message),
    data: row.data ? (JSON.parse(String(row.data)) as Record<string, unknown>) : null,
  };
}

function buildWhere(filter: LogFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const sources = toList(filter.source);
  if (sources?.length) { where.push(`source IN (${placeholders(sources.length)})`); params.push(...sources); }
  const levels = toList(filter.level);
  if (levels?.length) { where.push(`level IN (${placeholders(levels.length)})`); params.push(...levels); }
  if (filter.from) { where.push("ts >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("ts <= ?"); params.push(filter.to); }
  if (filter.q) { where.push("(message LIKE ? OR event LIKE ? OR data LIKE ?)"); const like = `%${filter.q}%`; params.push(like, like, like); }
  if (filter.runId) { where.push("runId = ?"); params.push(filter.runId); }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function queryLogs(filter: LogFilter, logDir?: string): LogQueryResult {
  const db = openDb(resolveDir(logDir));
  try {
    const { sql, params } = buildWhere(filter);
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const offset = Math.max(0, filter.offset ?? 0);
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM events ${sql}`).get(...params) as { c: number };
    const rows = db.prepare(`SELECT * FROM events ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];
    return { total: totalRow.c, events: rows.map(rowToEvent) };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

export function logMeta(logDir?: string): LogMeta {
  const db = openDb(resolveDir(logDir));
  try {
    const sources = (db.prepare("SELECT DISTINCT source FROM events ORDER BY source").all() as { source: string }[]).map((r) => r.source);
    const levels = (db.prepare("SELECT DISTINCT level FROM events ORDER BY level").all() as { level: string }[]).map((r) => r.level);
    const bounds = db.prepare("SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM events").get() as { minTs: string | null; maxTs: string | null };
    const countRows = db.prepare("SELECT source, level, COUNT(*) AS n FROM events GROUP BY source, level").all() as { source: string; level: string; n: number }[];
    const counts: Record<string, Record<string, number>> = {};
    for (const r of countRows) { (counts[r.source] ??= {})[r.level] = r.n; }
    const recentRunIds = (db.prepare("SELECT runId FROM (SELECT runId, MAX(id) AS mx FROM events WHERE runId IS NOT NULL GROUP BY runId ORDER BY mx DESC LIMIT 20)").all() as { runId: string }[]).map((r) => r.runId);
    const recentJobIds = (db.prepare("SELECT jobId FROM (SELECT jobId, MAX(id) AS mx FROM events WHERE jobId IS NOT NULL GROUP BY jobId ORDER BY mx DESC LIMIT 20)").all() as { jobId: string }[]).map((r) => r.jobId);
    return { sources, levels, minTs: bounds.minTs, maxTs: bounds.maxTs, counts, recentRunIds, recentJobIds };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}
