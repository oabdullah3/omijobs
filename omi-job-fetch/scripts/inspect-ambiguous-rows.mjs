// Inspect rows with ambiguous analysis values (salary outlier, past start date,
// years 0-0) against their raw job descriptions. Read-only.
// Run from omi-job-fetch/: node scripts/inspect-ambiguous-rows.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = join(homedir(), ".omijobs", "dashboard.configs", "cron", "output", "tech-internship.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare("SELECT signature, analysis, job FROM jobs").all();
db.close();

for (const row of rows) {
  const analysis = JSON.parse(row.analysis ?? "null");
  if (!analysis) continue;
  const flags = [];
  if (analysis.salary && analysis.salary.min === 8000 && analysis.salary.max === 50000) flags.push("salary 8k-50k");
  if (analysis.job_start_date === "2025-07") flags.push("start 2025-07");
  if (analysis.years_experience && analysis.years_experience.min === 0 && analysis.years_experience.max === 0) flags.push("years 0-0");
  if (flags.length === 0) continue;
  const job = JSON.parse(row.job);
  console.log("=".repeat(100));
  console.log("FLAGS:", flags.join(", "));
  console.log("SIG  :", row.signature);
  console.log("TITLE:", job.title);
  console.log("--- description (first 1500 chars) ---");
  console.log(String(job.description ?? "(none)").slice(0, 1500));
}
