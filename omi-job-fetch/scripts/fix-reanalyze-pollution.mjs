// Repair rows polluted by the pre-fix parser bug: when the model omitted an
// array's closing bracket, readArrayValue harvested every following `"key":`
// pair and value into the unterminated list field.
//   - If the known-clean backup (pre-backfill + pre-reanalyze) has a clean
//     analysis for the row, restore it.
//   - Otherwise set analysis = NULL so the next run re-analyzes with the
//     fixed parser (A4 auto-retries NULL rows).
// Safe: copies the DB to a timestamped backup before any write.
//   dry-run (default): node scripts/fix-reanalyze-pollution.mjs
//   apply:             node scripts/fix-reanalyze-pollution.mjs --apply
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const apply = process.argv.includes("--apply");
const BACKUP = join(homedir(), ".omijobs", "dashboard.configs", "cron", "output", "tech-internship.db.bak-2026-08-27T06-37-12-292Z");
const dbPath = join(homedir(), ".omijobs", "dashboard.configs", "cron", "output", "tech-internship.db");
if (!existsSync(dbPath)) { console.error("DB not found:", dbPath); process.exit(1); }
if (!existsSync(BACKUP)) { console.error("Backup not found:", BACKUP); process.exit(1); }

if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.bak-${stamp}`;
  copyFileSync(dbPath, backup);
  console.log("backup written:", backup);
}

const db = new DatabaseSync(dbPath);
const backupDb = new DatabaseSync(BACKUP, { readOnly: true });

// Field keys that can appear as list values when an array bleeds into the next key.
const FIELD_KEYS = new Set([
  "domain", "industry", "skills", "licenses", "mandatory_languages",
  "preferred_languages", "employment_type", "job_duration", "seniority",
  "work_arrangement", "years_experience", "contract_length_months",
  "education", "job_start_date", "salary", "unmatched", "schemaVersion",
]);

function isPolluted(analysis) {
  if (!analysis || analysis.schemaVersion !== 1) return false;
  // Count distinct field-key values across all list fields. A single field-key
  // word can be a legit value (e.g. VTC's industry: ["education", ...]) — real
  // pollution bleeds into MULTIPLE following keys at once.
  const seen = new Set();
  for (const key of ["domain", "industry", "skills", "licenses", "mandatory_languages", "preferred_languages"]) {
    const list = analysis[key];
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const s = String(v).trim().toLowerCase();
      if (FIELD_KEYS.has(s)) seen.add(s);
    }
  }
  return seen.size >= 2;
}

const rows = db.prepare("SELECT signature, analysis FROM jobs").all();
const changes = [];
for (const row of rows) {
  const analysis = JSON.parse(row.analysis ?? "null");
  if (!isPolluted(analysis)) continue;

  // Look for a clean analysis of the same row in the backup.
  const backupRow = backupDb.prepare("SELECT analysis FROM jobs WHERE signature = ?").get(row.signature);
  const backupAnalysis = backupRow ? JSON.parse(backupRow.analysis ?? "null") : null;
  let action;
  let after;
  if (backupAnalysis && !isPolluted(backupAnalysis)) {
    action = "RESTORE from backup";
    after = JSON.stringify(backupAnalysis);
  } else {
    action = "NULL for re-analysis";
    after = null;
  }
  changes.push({ signature: row.signature, action, after });
  if (apply) {
    db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?").run(after, new Date().toISOString(), row.signature);
  }
}
db.close();
backupDb.close();

console.log(`\n${apply ? "APPLIED" : "DRY-RUN"} — ${changes.length} polluted row(s):\n`);
for (const c of changes) {
  console.log("=".repeat(100));
  console.log("SIG:", c.signature);
  console.log("ACTION:", c.action);
  console.log("after:", c.after);
}
if (!apply) console.log("\nRe-run with --apply to write changes (backup is created automatically).");
