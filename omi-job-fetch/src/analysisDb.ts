import { createRequire } from "node:module";
import type { ExtractionResult } from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Row = Record<string, unknown>;

function open(file: string): { db: InstanceType<typeof DatabaseSync>; close: () => void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, close: () => db.close() };
}
function parseJob(raw: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(raw ?? "{}")); return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

export interface AnalysisRow { signature: string; postedAt: string | null; status: string; analysis: string | null; job: Record<string, unknown>; }
export interface AnalysisCounts { total: number; analyzed: number; pending: number; }

export function listAnalysisRows(file: string): AnalysisRow[] {
  const { db, close } = open(file);
  try {
    return (db.prepare("SELECT signature, posted_at, status, analysis, job FROM jobs ORDER BY posted_at DESC").all() as Row[]).map((row) => ({
      signature: String(row.signature),
      postedAt: row.posted_at == null ? null : String(row.posted_at),
      status: String(row.status),
      analysis: row.analysis == null ? null : String(row.analysis),
      job: parseJob(row.job),
    }));
  } finally { close(); }
}

export function parsedAnalysis(raw: unknown): ExtractionResult | null {
  if (raw === null || raw === undefined) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return null; }
  if (typeof obj !== "object" || obj === null || typeof obj.schemaVersion !== "number") return null;
  return obj as unknown as ExtractionResult;
}

export function conformingVersion(raw: unknown, version: number): boolean {
  const parsed = parsedAnalysis(raw);
  return parsed !== null && parsed.schemaVersion === version;
}

export function setJobAnalysis(file: string, signature: string, result: ExtractionResult): void {
  if (!Number.isInteger(result.schemaVersion) || result.schemaVersion < 1) throw new Error("invalid extraction result");
  const { db, close } = open(file);
  try { db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?").run(JSON.stringify(result), new Date().toISOString(), signature); }
  finally { close(); }
}

export function deleteJobRow(file: string, signature: string): boolean {
  const { db, close } = open(file);
  try { return Number(db.prepare("DELETE FROM jobs WHERE signature = ?").run(signature).changes) > 0; }
  finally { close(); }
}

export function countAnalysis(file: string): AnalysisCounts {
  const rows = listAnalysisRows(file);
  const analyzed = rows.filter((row) => parsedAnalysis(row.analysis) !== null).length;
  return { total: rows.length, analyzed, pending: rows.length - analyzed };
}
