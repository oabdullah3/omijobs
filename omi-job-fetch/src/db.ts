import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { normalizeForHash, signature } from "./dedup.js";
import type { DbStats, Job, RunConfig } from "./types.js";

// Load node:sqlite through createRequire rather than a static import: vitest's
// vite-node server strips "node:" from ids it doesn't recognize (its static
// builtinModules list lacks sqlite) and then fails to load them as files. A
// require() call is a plain runtime call, untouched by Vite's transform, so
// Node resolves node:sqlite natively — under vitest and under the real CLI.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** Default retention window for the aggregate DB (days). */
export const DEFAULT_RETENTION_DAYS = 30;

/** Resolve the aggregate-DB file path: config.db.file, else <outputDir>/jobs.db. */
export function dbFile(config: RunConfig, outputDir: string): string {
  return resolve(outputDir, config.db?.file ?? "jobs.db");
}

/** ISO-8601 string for a job's posted_at, or null when absent/unparseable (kept forever). */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Sync a run's deduped jobs into the aggregate DB (one row per job) and expire
 * rows past the retention window.
 *
 * - Key: the same content signature the run dedup used (`dedup.fields`), so the
 *   DB aggregates across runs: same title+company+location from a later run
 *   overwrites the earlier row instead of duplicating it.
 * - New signature → INSERT with status 'unapplied' and analysis NULL.
 * - Existing signature → overwrite job/posted_at/updated_at, preserving the
 *   row's status, analysis, and created_at.
 * - Retention: rows whose posted_at is older than `retentionDays` are deleted;
 *   rows with no parseable posted_at are kept.
 */
export function syncDb(
  file: string,
  jobs: Job[],
  fields: string[],
  now: Date,
  retentionDays: number,
): DbStats {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // Concurrent runs may finish together and both write the same jobs.db. Wait
    // (up to 5s) for the other writer's transaction to COMMIT instead of failing
    // immediately with "database is locked" and silently dropping this run's jobs
    // from the dashboard. Mirrors the busy_timeout the read path already sets
    // (dashboardDb.ts). Writes are short, so 5s is a generous bound.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        signature  TEXT PRIMARY KEY,
        posted_at  TEXT,
        job        TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'unapplied',
        analysis   TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const timestamp = now.toISOString();
    const insert = db.prepare(
      `INSERT INTO jobs (signature, posted_at, job, status, analysis, created_at, updated_at)
       VALUES (?, ?, ?, 'unapplied', NULL, ?, ?)`,
    );
    const update = db.prepare(
      "UPDATE jobs SET posted_at = ?, job = ?, updated_at = ? WHERE signature = ?",
    );

    let added = 0;
    let updated = 0;
    db.exec("BEGIN");
    try {
      for (const job of jobs) {
        const sig = signature(job, fields);
        // Every dedup field empty/absent → nothing to key on; skip. (With the
        // default 3 fields the signature would be "||", not "", so check the
        // normalized fields directly.)
        if (fields.every((field) => normalizeForHash(job[field]) === "")) continue;
        const postedAt = toIsoOrNull(job.posted_at);
        const json = JSON.stringify(job);
        // SQLite changes() counts rows matched by the WHERE, so >0 ⇒ row existed.
        const changes = Number(update.run(postedAt, json, timestamp, sig).changes);
        if (changes > 0) {
          updated++;
        } else {
          insert.run(sig, postedAt, json, timestamp, timestamp);
          added++;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    let removed = 0;
    if (retentionDays > 0) {
      const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
      removed = Number(
        db.prepare("DELETE FROM jobs WHERE posted_at IS NOT NULL AND posted_at < ?").run(cutoff).changes,
      );
    }
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0);

    return { added, updated, removed, total };
  } finally {
    db.close();
  }
}
