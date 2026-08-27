// Spot-check previously-failing rows that were rescued by the backfill.
// Read-only. Run from omi-job-fetch/: node scripts/spot-check-rescued.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(join(homedir(), ".omijobs", "dashboard.configs", "cron", "output", "tech-internship.db"), { readOnly: true });
const rows = db.prepare("SELECT signature, analysis FROM jobs").all();
db.close();

const probes = [
  "jane street",
  "bybit",
  "ezsvs",
  "schreurs",
  "millennium",
  "eclincloud",
  "transamerica",
  "balyasny",
  "jpmorganchase",
  "tüv",
  "jardine",
  "intern-3d printing",
];
for (const probe of probes) {
  const row = rows.find((r) => r.signature.toLowerCase().includes(probe));
  if (!row) { console.log(`[${probe}] NOT FOUND`); continue; }
  const a = JSON.parse(row.analysis ?? "null");
  console.log(`\n[${probe}]`);
  if (!a) { console.log("  analysis = NULL"); continue; }
  const keys = Object.keys(a);
  console.log(`  fields(${keys.length}): ${keys.join(", ")}`);
  if (a.domain) console.log(`  domain: ${JSON.stringify(a.domain)}`);
  if (a.employment_type) console.log(`  employment_type: ${JSON.stringify(a.employment_type)}`);
}
