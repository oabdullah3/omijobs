import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformingVersion, countAnalysis, deleteJobRow, listAnalysisRows, parsedAnalysis, setJobAnalysis } from "../src/analysisDb.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-db-"));
  const file = join(dir, "jobs.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("high", "2026-08-20", JSON.stringify({ title: "High" }), "applied", JSON.stringify({ schemaVersion: 1, domain: ["finance"] }), "created", "old");
  insert.run("low", "2026-08-19", JSON.stringify({ title: "Low" }), "applied", JSON.stringify({ score: 2, reason: "poor" }), "created", "old");
  insert.run("bad", "2026-08-18", JSON.stringify({ title: "Bad" }), "unapplied", "not json", "created", "old");
  db.close();
  return { dir, file };
}

describe("analysisDb", () => {
  it("lists rows with status and raw analysis text", async () => {
    const { dir, file } = await fixture();
    try {
      const rows = listAnalysisRows(file);
      expect(rows.map((r) => r.signature)).toEqual(["high", "low", "bad"]);
      expect(rows[0].status).toBe("applied");
      expect(rows[1].analysis).toBe(JSON.stringify({ score: 2, reason: "poor" }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("stores an extraction and parses it back, conforming only on version match", async () => {
    const { dir, file } = await fixture();
    try {
      setJobAnalysis(file, "high", { schemaVersion: 1, domain: ["finance"] });
      const db = new DatabaseSync(file);
      const raw = (db.prepare("SELECT analysis FROM jobs WHERE signature = ?").get("high") as Record<string, unknown>).analysis;
      db.close();
      expect(parsedAnalysis(raw)).toEqual({ schemaVersion: 1, domain: ["finance"] });
      expect(conformingVersion(raw, 1)).toBe(true);
      expect(conformingVersion(raw, 2)).toBe(false);
      expect(conformingVersion(JSON.stringify({ score: 2, reason: "poor" }), 1)).toBe(false); // legacy
      expect(parsedAnalysis("not json")).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("counts analyzed vs pending without a threshold", async () => {
    const { dir, file } = await fixture();
    try {
      expect(countAnalysis(file)).toEqual({ total: 3, analyzed: 1, pending: 2 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("lists newest rows and deletes by signature", async () => {
    const { dir, file } = await fixture();
    try { expect(listAnalysisRows(file).map((row) => row.signature)).toEqual(["high", "low", "bad"]); expect(deleteJobRow(file, "bad")).toBe(true); expect(deleteJobRow(file, "missing")).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
