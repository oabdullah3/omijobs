import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bulkMarkBelowThreshold, countAnalysis, deleteJobRow, listAnalysisRows, setJobAnalysis } from "../src/analysisDb.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-db-"));
  const file = join(dir, "jobs.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("high", "2026-08-20", JSON.stringify({ title: "High" }), "applied", null, "created", "old");
  insert.run("low", "2026-08-19", JSON.stringify({ title: "Low" }), "applied", JSON.stringify({ score: 2, reason: "poor" }), "created", "old");
  insert.run("bad", "2026-08-18", JSON.stringify({ title: "Bad" }), "unapplied", "not json", "created", "old");
  db.close();
  return { dir, file };
}

describe("analysisDb", () => {
  it("writes verdicts without changing status or created_at", async () => {
    const { dir, file } = await fixture();
    try {
      setJobAnalysis(file, "high", { score: 8, reason: "strong" });
      const db = new DatabaseSync(file);
      const row = db.prepare("SELECT status, analysis, created_at, updated_at FROM jobs WHERE signature = ?").get("high") as Record<string, unknown>;
      db.close();
      expect(row.status).toBe("applied");
      expect(JSON.parse(String(row.analysis))).toEqual({ score: 8, reason: "strong" });
      expect(row.created_at).toBe("created");
      expect(row.updated_at).not.toBe("old");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("counts parsed verdicts and marks only parsed low scores", async () => {
    const { dir, file } = await fixture();
    try {
      expect(countAnalysis(file, 5)).toEqual({ total: 3, analyzed: 1, pending: 2, recommended: 0 });
      expect(bulkMarkBelowThreshold(file, 5)).toBe(1);
      const db = new DatabaseSync(file);
      expect((db.prepare("SELECT status FROM jobs WHERE signature = ?").get("low") as Record<string, unknown>).status).toBe("uninterested");
      expect((db.prepare("SELECT status FROM jobs WHERE signature = ?").get("bad") as Record<string, unknown>).status).toBe("unapplied");
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("lists newest rows and deletes by signature", async () => {
    const { dir, file } = await fixture();
    try { expect(listAnalysisRows(file).map((row) => row.signature)).toEqual(["high", "low", "bad"]); expect(deleteJobRow(file, "bad")).toBe(true); expect(deleteJobRow(file, "missing")).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
