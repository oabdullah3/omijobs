import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  discoverDbs,
  getJob,
  isBusyError,
  listJobs,
  setJobStatus,
} from "../src/dashboardDb.js";
import type { ConfigMeta } from "../src/dashboardConfig.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const NOW = "2026-08-19T00:00:00.000Z";

function seed(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE jobs (
      signature  TEXT PRIMARY KEY,
      posted_at  TEXT,
      job        TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'unapplied',
      analysis   TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const ins = db.prepare(
    "INSERT INTO jobs (signature, posted_at, job, status, analysis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  ins.run("a", "2026-08-18T00:00:00.000Z", JSON.stringify({ title: "Grad Program", company: "HSBC", location: "Hong Kong" }), "unapplied", null, NOW, NOW);
  ins.run("b", "2026-08-19T00:00:00.000Z", JSON.stringify({ title: "Analyst", company: "JPM", location: "Singapore" }), "applied", JSON.stringify({ fit: 0.8 }), NOW, NOW);
  ins.run("c", "2026-08-17T00:00:00.000Z", JSON.stringify({ title: "Internship", company: "GS", location: "Hong Kong" }), "uninterested", null, NOW, NOW);
  db.close();
}

function meta(file: string): ConfigMeta {
  return {
    id: "base",
    kind: "base",
    path: "config.json",
    rel: "config.json",
    queries: ["q"],
    enabledPortals: [],
    outputDir: "output",
    db: { enabled: true, file: "jobs.db", path: file, exists: existsSync(file) },
  };
}

describe("discoverDbs", () => {
  it("reports a missing db as absent with zero counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const info = discoverDbs([meta(join(dir, "jobs.db"))])[0];
      expect(info.exists).toBe(false);
      expect(info.total).toBe(0);
      expect(info.byStatus).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts totals and by-status for an existing db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const info = discoverDbs([meta(file)])[0];
      expect(info.exists).toBe(true);
      expect(info.total).toBe(3);
      expect(info.byStatus).toEqual({ unapplied: 1, applied: 1, uninterested: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("listJobs", () => {
  async function withDb(): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    const file = join(dir, "jobs.db");
    seed(file);
    return { dir, file };
  }

  it("defaults to posted_at desc, most recent first", async () => {
    const { dir, file } = await withDb();
    try {
      const { rows, total } = listJobs(file);
      expect(total).toBe(3);
      expect(rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters by status and by text across title/company/location", async () => {
    const { dir, file } = await withDb();
    try {
      expect(listJobs(file, { status: "applied" }).rows.map((r) => r.signature)).toEqual(["b"]);
      // Case-insensitive substring on company.
      expect(listJobs(file, { q: "hsbc" }).rows.map((r) => r.signature)).toEqual(["a"]);
      // Matches location, not just title.
      expect(listJobs(file, { q: "singapore" }).rows.map((r) => r.signature)).toEqual(["b"]);
      // Sort by title asc.
      expect(listJobs(file, { sort: "title", dir: "asc" }).rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
      // Unknown sort keys fall back to the posted_at default instead of crashing.
      expect(listJobs(file, { sort: "banana" }).rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("paginates", async () => {
    const { dir, file } = await withDb();
    try {
      const page = listJobs(file, { limit: 1, offset: 1 });
      expect(page.rows.map((r) => r.signature)).toEqual(["a"]);
      expect(page.total).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getJob", () => {
  it("returns the full row including analysis, null for unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const detail = getJob(file, "b");
      expect(detail?.status).toBe("applied");
      expect(detail?.analysis).toEqual({ fit: 0.8 });
      expect((detail?.job as Record<string, unknown>).title).toBe("Analyst");
      expect(getJob(file, "zzz")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("setJobStatus", () => {
  it("updates a row's status and returns ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const r = setJobStatus(file, "a", "applied");
      expect(r.ok).toBe(true);
      expect(getJob(file, "a")?.status).toBe("applied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports not-found for an unknown signature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const r = setJobStatus(file, "zzz", "applied");
      expect(r.ok).toBe(false);
      expect(r.error).toBe("not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      expect(() => setJobStatus(file, "a", "nonsense")).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isBusyError", () => {
  it("recognizes busy messages", () => {
    expect(isBusyError("database is locked")).toBe(true);
    expect(isBusyError(new Error("SQLITE_BUSY: cannot commit"))).toBe(true);
    expect(isBusyError("disk I/O error")).toBe(false);
  });
});
