import { createRequire } from "node:module";
import { extractScoreReason, type ScoreReason } from "./analysisProvider.js";

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
function parsedAnalysis(raw: unknown): ScoreReason | null {
  if (raw === null || raw === undefined) return null;
  try { return extractScoreReason(JSON.stringify(JSON.parse(String(raw)))); } catch { return null; }
}

export interface AnalysisRow { signature: string; postedAt: string | null; analysis: unknown; job: Record<string, unknown>; }
export interface AnalysisCounts { total: number; analyzed: number; pending: number; recommended: number; }

export function listAnalysisRows(file: string): AnalysisRow[] {
  const { db, close } = open(file);
  try {
    return (db.prepare("SELECT signature, posted_at, analysis, job FROM jobs ORDER BY posted_at DESC").all() as Row[]).map((row) => ({
      signature: String(row.signature), postedAt: row.posted_at == null ? null : String(row.posted_at), analysis: row.analysis ?? null, job: parseJob(row.job),
    }));
  } finally { close(); }
}

export function setJobAnalysis(file: string, signature: string, verdict: ScoreReason): void {
  const parsed = extractScoreReason(JSON.stringify(verdict));
  if (!parsed) throw new Error("invalid analysis verdict");
  const { db, close } = open(file);
  try { db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?").run(JSON.stringify(parsed), new Date().toISOString(), signature); }
  finally { close(); }
}

export function deleteJobRow(file: string, signature: string): boolean {
  const { db, close } = open(file);
  try { return Number(db.prepare("DELETE FROM jobs WHERE signature = ?").run(signature).changes) > 0; }
  finally { close(); }
}

export function countAnalysis(file: string, threshold: number): AnalysisCounts {
  const rows = listAnalysisRows(file);
  const analyzed = rows.filter((row) => parsedAnalysis(row.analysis) !== null).length;
  const recommended = rows.filter((row) => { const verdict = parsedAnalysis(row.analysis); return verdict !== null && verdict.score >= threshold; }).length;
  return { total: rows.length, analyzed, pending: rows.length - analyzed, recommended };
}

export function bulkMarkBelowThreshold(file: string, threshold: number): number {
  const { db, close } = open(file);
  try {
    const signatures = (db.prepare("SELECT signature, analysis FROM jobs").all() as Row[]).filter((row) => {
      const verdict = parsedAnalysis(row.analysis);
      return verdict !== null && verdict.score < threshold;
    }).map((row) => String(row.signature));
    const update = db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE signature = ?");
    const now = new Date().toISOString();
    let changed = 0;
    for (const signature of signatures) changed += Number(update.run("uninterested", now, signature).changes);
    return changed;
  } finally { close(); }
}
