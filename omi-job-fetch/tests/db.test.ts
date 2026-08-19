import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dbFile, syncDb } from "../src/db.js";
import { signature } from "../src/dedup.js";
import type { Job, RunConfig } from "../src/types.js";

// Same createRequire approach as src/db.ts: a static node:sqlite import trips
// vitest's vite-node loader (it strips "node:" from unrecognized builtins).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const FIELDS = ["title", "company", "location"];
const NOW = new Date("2026-08-19T00:00:00.000Z");

function job(over: Record<string, unknown> = {}): Job {
  return {
    title: "Finance Intern",
    company: "HSBC",
    location: "Hong Kong",
    apply_url: "https://apply/1",
    source: "jobsdb",
    ...over,
  };
}

function row(db: DatabaseSync, sig: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM jobs WHERE signature = ?").get(sig);
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jobfetch-db-"));
}

describe("syncDb", () => {
  it("inserts new rows with status 'unapplied' and analysis NULL", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const stats = syncDb(file, [job()], FIELDS, NOW, 30);
      expect(stats).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
      const db = new DatabaseSync(file);
      try {
        const r = row(db, signature(job(), FIELDS));
        expect(r).toBeDefined();
        expect(r.status).toBe("unapplied");
        expect(r.analysis).toBeNull();
        expect(r.posted_at).toBeNull();
        expect(r.created_at).toBe("2026-08-19T00:00:00.000Z");
        expect(r.updated_at).toBe("2026-08-19T00:00:00.000Z");
        expect(JSON.parse(r.job as string)).toMatchObject({
          title: "Finance Intern",
          company: "HSBC",
          location: "Hong Kong",
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing signature but preserves status, analysis and created_at", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const first = job({ apply_url: "https://apply/old", posted_at: "2026-08-01T00:00:00.000Z" });
      expect(syncDb(file, [first], FIELDS, NOW, 30).added).toBe(1);

      // Simulate the user having tracked this job: status + analysis are ours to keep.
      const db = new DatabaseSync(file);
      const sig = signature(first, FIELDS);
      db.prepare("UPDATE jobs SET status = ?, analysis = ?, created_at = ? WHERE signature = ?").run(
        "applied",
        '{"priority":"high"}',
        "2020-01-01T00:00:00.000Z",
        sig,
      );
      db.close();

      // Same title/company/location → same signature → overwrite, not append.
      const updated = job({ apply_url: "https://apply/new", posted_at: "2026-08-10T00:00:00.000Z" });
      const stats = syncDb(file, [updated], FIELDS, NOW, 30);
      expect(stats).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });

      const db2 = new DatabaseSync(file);
      try {
        const r = row(db2, sig);
        expect(JSON.parse(r.job as string)).toMatchObject({ title: "Finance Intern", apply_url: "https://apply/new" });
        expect(r.posted_at).toBe("2026-08-10T00:00:00.000Z");
        expect(r.status).toBe("applied");
        expect(r.analysis).toBe('{"priority":"high"}');
        expect(r.created_at).toBe("2020-01-01T00:00:00.000Z");
        expect(r.updated_at).toBe("2026-08-19T00:00:00.000Z");
      } finally {
        db2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keys rows on the same signature as run dedup (case/whitespace-insensitive)", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const first = job({ title: "Finance Intern" });
      const retyped = job({ title: "  finance   intern " });
      expect(syncDb(file, [first], FIELDS, NOW, 30).added).toBe(1);
      expect(syncDb(file, [retyped], FIELDS, NOW, 30)).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores posted_at and expires rows older than retentionDays", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const stale = job({ title: "Stale", posted_at: "2026-06-01T00:00:00.000Z" }); // > 30 days before NOW
      const fresh = job({ title: "Fresh", posted_at: "2026-08-18T00:00:00.000Z" });
      const stats = syncDb(file, [stale, fresh], FIELDS, NOW, 30);
      expect(stats).toEqual({ added: 2, updated: 0, removed: 1, total: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps rows whose posted_at is missing or unparseable", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const none = job({ title: "NoDate", posted_at: null });
      const garbage = job({ title: "Garbage", posted_at: "not-a-date" });
      const stats = syncDb(file, [none, garbage], FIELDS, NOW, 30);
      expect(stats).toEqual({ added: 2, updated: 0, removed: 0, total: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors a configurable retentionDays, and 0 disables expiry", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const weekOld = job({ title: "WeekOld", posted_at: "2026-08-12T00:00:00.000Z" }); // 7 days before NOW
      // 7-day window: 7 days old is NOT older than 7 days (strict <), so kept.
      expect(syncDb(file, [weekOld], FIELDS, NOW, 7).removed).toBe(0);
      const tenDaysOld = job({ title: "TenDays", posted_at: "2026-08-09T00:00:00.000Z" }); // 10 days before NOW
      expect(syncDb(file, [tenDaysOld], FIELDS, NOW, 7).removed).toBe(1);
      // 0 / negative → never expire anything. Fresh file: the prior run already
      // deleted tenDaysOld, so reuse would re-insert it instead of updating.
      const keepAll = join(dir, "keep-all.db");
      expect(syncDb(keepAll, [weekOld, tenDaysOld], FIELDS, NOW, 0)).toEqual({ added: 2, updated: 0, removed: 0, total: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips jobs with no dedup signature (empty title/company/location)", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "jobs.db");
      const stats = syncDb(file, [job({ title: "", company: "", location: "" })], FIELDS, NOW, 30);
      expect(stats).toEqual({ added: 0, updated: 0, removed: 0, total: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dbFile", () => {
  const base: RunConfig = { portals: { enabled: [] }, ats: { enabled: [] }, dedup: {} };

  it("defaults to <outputDir>/jobs.db", () => {
    expect(dbFile(base, "out")).toBe(resolve("out", "jobs.db"));
  });

  it("uses config.db.file when set", () => {
    expect(dbFile({ ...base, db: { file: "custom.db" } }, "out")).toBe(resolve("out", "custom.db"));
  });

  it("respects an absolute file path", () => {
    expect(dbFile({ ...base, db: { file: "/abs/path/jobs.db" } }, "out")).toBe(resolve("/abs/path/jobs.db"));
  });
});
