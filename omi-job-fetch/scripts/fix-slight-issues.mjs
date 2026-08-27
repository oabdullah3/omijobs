// Manually fix "already analyzed but slightly broken" rows in the tech DB.
// Safe: copies the DB to a timestamped backup before any write.
//   dry-run (default): node scripts/fix-slight-issues.mjs
//   apply:             node scripts/fix-slight-issues.mjs --apply
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const apply = process.argv.includes("--apply");
const dbPath = join(homedir(), ".omijobs", "dashboard.configs", "cron", "output", "tech-internship.db");
if (!existsSync(dbPath)) { console.error("DB not found:", dbPath); process.exit(1); }

if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.bak-${stamp}`;
  copyFileSync(dbPath, backup);
  console.log("backup written:", backup);
}

const db = new DatabaseSync(dbPath);
const rows = db.prepare("SELECT signature, analysis, updated_at FROM jobs").all();

const changes = [];
for (const row of rows) {
  const analysis = JSON.parse(row.analysis ?? "null");
  if (!analysis || analysis.schemaVersion !== 1) continue;
  const before = JSON.stringify(analysis);

  // 1. Junk `[object object]` values from list fields
  for (const key of ["domain", "industry", "skills", "licenses", "mandatory_languages", "preferred_languages"]) {
    if (Array.isArray(analysis[key])) {
      const cleaned = analysis[key].filter((v) => String(v).trim().toLowerCase() !== "[object object]");
      if (cleaned.length !== analysis[key].length) analysis[key] = cleaned;
    }
  }

  // 2. Fold spaced/unmatched employment_type variants and drop from unmatched
  const fold = { "full time": "full-time", "part time": "part-time" };
  if (analysis.unmatched && Array.isArray(analysis.unmatched.employment_type)) {
    const kept = [];
    for (const tag of analysis.unmatched.employment_type) {
      const folded = fold[String(tag).trim().toLowerCase()];
      if (folded) { if (!analysis.employment_type || analysis.employment_type === "other") analysis.employment_type = folded; }
      else kept.push(tag);
    }
    if (kept.length) analysis.unmatched.employment_type = kept;
    else delete analysis.unmatched.employment_type;
    if (Object.keys(analysis.unmatched).length === 0) delete analysis.unmatched;
  }

  // 3. Typo fixes in skills
  if (Array.isArray(analysis.skills)) {
    analysis.skills = analysis.skills.map((s) => {
      const v = String(s).trim().toLowerCase();
      if (v === "kubenetes") return "kubernetes";
      if (v === "angulare") return "angular";
      return s;
    });
  }

  // 4. Fabricated past start date (description never mentions it)
  if (analysis.job_start_date === "2025-07") delete analysis.job_start_date;

  const after = JSON.stringify(analysis);
  if (after !== before) {
    changes.push({ signature: row.signature, before, after });
    if (apply) {
      db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?").run(after, new Date().toISOString(), row.signature);
    }
  }
}
db.close();

console.log(`\n${apply ? "APPLIED" : "DRY-RUN"} — ${changes.length} row(s) would change:\n`);
for (const c of changes) {
  console.log("=".repeat(100));
  console.log("SIG:", c.signature);
  console.log("  before:", c.before);
  console.log("  after :", c.after);
}
if (!apply) console.log("\nRe-run with --apply to write changes (backup is created automatically).");
