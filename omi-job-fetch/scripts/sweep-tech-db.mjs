// Deep-dive the tech-internship DB analysis column (read-only).
// Usage: node scripts/sweep-tech-db.mjs [dbPath]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/dashboard.configs/cron/output/tech-internship.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const total = db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
const withAnalysis = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE analysis IS NOT NULL AND analysis != ''").get().n;
const parsed = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE analysis IS NOT NULL AND analysis LIKE '{%'").get().n;
console.log(`total=${total} with_analysis=${withAnalysis} json_parsed=${parsed}`);

// Parse every analysis blob, collect per-field stats
const rows = db.prepare("SELECT signature, job, analysis FROM jobs WHERE analysis IS NOT NULL AND analysis != ''").all();
const fields = new Map(); // key -> Map(value -> count)
let parseFail = 0;
let notObject = 0;
const samples = [];

for (const r of rows) {
  let a;
  try { a = JSON.parse(r.analysis); } catch { parseFail++; continue; }
  if (a === null || typeof a !== "object" || Array.isArray(a)) { notObject++; continue; }
  for (const [k, v] of Object.entries(a)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const val of vals) {
      const key = `${k}`;
      if (!fields.has(key)) fields.set(key, new Map());
      const m = fields.get(key);
      const str = typeof val === "object" && val !== null ? JSON.stringify(val) : String(val);
      m.set(str, (m.get(str) ?? 0) + 1);
    }
  }
}

console.log(`\n== field stats (parseFail=${parseFail}, notObject=${notObject}) ==`);
for (const [k, m] of [...fields.entries()].sort()) {
  const distinct = m.size;
  const totalVals = [...m.values()].reduce((s, n) => s + n, 0);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `${n}×${v.length > 40 ? v.slice(0, 40) + "…" : v}`);
  console.log(`\n${k}: ${distinct} distinct / ${totalVals} values`);
  console.log(`  ${top.join(" | ")}`);
}
