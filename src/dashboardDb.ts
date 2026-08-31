import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { ConfigMeta } from "./dashboardConfig.js";

// node:sqlite via createRequire — see the note in src/db.ts for why.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const JOB_STATUSES = ["unapplied", "applied", "uninterested"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface DbInfo {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  total: number;
  byStatus: Record<string, number>;
  error: string | null;
}
export interface JobListQuery {
  status?: string;
  q?: string;
  sort?: string;   // "posted_at" | "title" | "company" | "location" | "status"
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
export interface JobListRow { signature: string; status: string; postedAt: string | null; analysis: Record<string, unknown> | null; job: Record<string, unknown>; }
export interface JobListResult { total: number; rows: JobListRow[]; }
export interface JobDetail {
  signature: string;
  status: string;
  postedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  analysis: unknown;
  job: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function open(file: string): { db: InstanceType<typeof DatabaseSync>; close: () => void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, close: () => db.close() };
}

function parseJob(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nullOrString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function discoverDbs(metas: ConfigMeta[]): DbInfo[] {
  return metas.map((m) => {
    if (!m.db.exists) return { key: m.id, label: m.rel, path: m.db.path, exists: false, total: 0, byStatus: {}, error: null };
    try {
      const { db, close } = open(m.db.path);
      try {
        const total = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0);
        const byStatus: Record<string, number> = {};
        for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as Row[]) {
          byStatus[String(row.status)] = Number(row.n);
        }
        return { key: m.id, label: m.rel, path: m.db.path, exists: true, total, byStatus, error: null };
      } finally {
        close();
      }
    } catch (error) {
      return {
        key: m.id,
        label: m.rel,
        path: m.db.path,
        exists: true,
        total: 0,
        byStatus: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

const TEXT_FIELDS = ["title", "company", "location"] as const;
const SORTERS: Record<string, (r: JobListRow) => string | null> = {
  posted_at: (r) => r.postedAt,
  title: (r) => String(r.job.title ?? ""),
  company: (r) => String(r.job.company ?? ""),
  location: (r) => String(r.job.location ?? ""),
  status: (r) => r.status,
};

export function listJobs(file: string, query: JobListQuery = {}): JobListResult {
  const { db, close } = open(file);
  try {
    let sql = "SELECT signature, status, posted_at, analysis, job FROM jobs";
    const params: unknown[] = [];
    if (query.status) {
      sql += " WHERE status = ?";
      params.push(query.status);
    }
    sql += " ORDER BY posted_at DESC";
    const rows = (db.prepare(sql).all(...params) as Row[]).map(
      (r): JobListRow => ({
        signature: String(r.signature),
        status: String(r.status),
        postedAt: nullOrString(r.posted_at),
        analysis: r.analysis === null || r.analysis === undefined ? null : (() => { try { return JSON.parse(String(r.analysis)) as Record<string, unknown>; } catch { return null; } })(),
        job: parseJob(r.job),
      }),
    );

    // Text filter in JS so it matches title/company/location precisely.
    let filtered = rows;
    if (query.q) {
      const needle = query.q.toLowerCase();
      filtered = rows.filter((r) => {
        const hay = TEXT_FIELDS.map((f) => String(r.job[f] ?? "")).join(" ").toLowerCase();
        return hay.includes(needle);
      });
    }

    const sort = query.sort && Object.hasOwn(SORTERS, query.sort) ? query.sort : "posted_at";
    const dir = query.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const va = SORTERS[sort](a);
      const vb = SORTERS[sort](b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // nulls last
      if (vb === null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * dir;
    });

    const total = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    return { total, rows: filtered.slice(offset, offset + limit) };
  } finally {
    close();
  }
}

export function getJob(file: string, signature: string): JobDetail | null {
  const { db, close } = open(file);
  try {
    const row = db
      .prepare("SELECT signature, status, posted_at, created_at, updated_at, analysis, job FROM jobs WHERE signature = ?")
      .get(signature) as Row | undefined;
    if (!row) return null;
    return {
      signature: String(row.signature),
      status: String(row.status),
      postedAt: nullOrString(row.posted_at),
      createdAt: nullOrString(row.created_at),
      updatedAt: nullOrString(row.updated_at),
      analysis: row.analysis === null || row.analysis === undefined ? null : JSON.parse(String(row.analysis)),
      job: parseJob(row.job),
    };
  } finally {
    close();
  }
}

export function setJobStatus(file: string, signature: string, status: string): { ok: boolean; error?: string } {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of ${JOB_STATUSES.join(", ")}`);
  }
  const { db, close } = open(file);
  try {
    const changed = Number(
      db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE signature = ?").run(status, new Date().toISOString(), signature).changes,
    );
    if (changed > 0) return { ok: true };
    return { ok: false, error: "not found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    close();
  }
}

export function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return lower.includes("busy") || lower.includes("locked") || msg.includes("SQLITE_BUSY");
}

/**
 * Permanently delete an aggregate DB: the main SQLite file plus its `-wal` /
 * `-shm` sidecar files (which SQLite may leave behind in WAL mode). Missing
 * files are ignored. Returns `{ ok: false, error }` when the file is locked by
 * a live writer (e.g. an in-flight run or the cron gateway) so callers can
 * surface a clear message instead of silently half-deleting.
 */
export function deleteDbFile(path: string): { ok: boolean; error?: string } {
  const candidates = [path, `${path}-wal`, `${path}-shm`];
  for (const file of candidates) {
    try {
      rmSync(file, { force: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true };
}
