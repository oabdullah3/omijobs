// Inspect TRAINEE: Securities Financing Tech skills + full Binance QA description.
// Read-only. Run from omi-job-fetch/: node scripts/inspect-typos.mjs
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
  const job = JSON.parse(row.job);
  const sig = row.signature.toLowerCase();
  if (sig.includes("securities financing tech")) {
    console.log("=".repeat(100));
    console.log("SIG:", row.signature);
    console.log("skills:", JSON.stringify(analysis.skills));
    const desc = String(job.description ?? "");
    const i = desc.toLowerCase().indexOf("kubernet");
    console.log("description mentions kubernetes? ->", i >= 0 ? "YES (at " + i + ")" : "no");
    if (i >= 0) console.log("context:", desc.slice(Math.max(0, i - 80), i + 80).replace(/\s+/g, " "));
  }
  if (sig.includes("qa tooling developer")) {
    console.log("=".repeat(100));
    console.log("SIG:", row.signature);
    console.log("analysis.job_start_date:", analysis.job_start_date);
    const desc = String(job.description ?? "");
    const d = desc.toLowerCase().indexOf("start date");
    console.log("description mentions start date? ->", d >= 0 ? "YES" : "no");
    if (d >= 0) console.log("context:", desc.slice(Math.max(0, d - 100), d + 200).replace(/\s+/g, " "));
    const j = desc.toLowerCase().indexOf("july");
    console.log("description mentions july? ->", j >= 0 ? "YES" : "no");
    if (j >= 0) console.log("context:", desc.slice(Math.max(0, j - 100), j + 200).replace(/\s+/g, " "));
  }
}
