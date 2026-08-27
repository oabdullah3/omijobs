// Deeper flaw hunt on tech-internship DB (read-only).
// Usage: node scripts/flaw-hunt-tech-db.mjs [dbPath]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/dashboard.configs/cron/output/tech-internship.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log("== status distribution ==");
console.log(db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status ORDER BY n DESC").all());

const rows = db.prepare("SELECT signature, job, status, analysis FROM jobs").all();
const parsed = rows.filter((r) => r.analysis && r.analysis.startsWith("{")).map((r) => ({ ...r, a: JSON.parse(r.analysis) }));

console.log(`\n== legacy fields (reason/score) — ${parsed.filter((r) => "reason" in r.a || "score" in r.a).length} rows ==`);
for (const r of parsed.filter((r) => "reason" in r.a || "score" in r.a)) {
  const j = JSON.parse(r.job);
  console.log(`- ${j.title ?? "?"} | ${j.company ?? "?"} | score=${r.a.score} | reason=${String(r.a.reason ?? "").slice(0, 90)}`);
}

console.log(`\n== unmatched values ==`);
for (const r of parsed.filter((r) => r.a.unmatched)) {
  const j = JSON.parse(r.job);
  console.log(`- ${j.title ?? "?"} | ${j.company ?? "?"} | unmatched=${JSON.stringify(r.a.unmatched)}`);
}

console.log(`\n== HTML entities in any value ==`);
let entCount = 0;
for (const r of parsed) {
  for (const [k, v] of Object.entries(r.a)) {
    const s = JSON.stringify(v);
    if (/&[a-z]+;|&#\d+;/.test(s)) { entCount++; console.log(`- ${k}: ${s.slice(0, 120)}  [${JSON.parse(r.job).title ?? "?"}]`); }
  }
}
if (!entCount) console.log("(none)");

console.log(`\n== [object Object] junk ==`);
let junkCount = 0;
for (const r of parsed) {
  for (const [k, v] of Object.entries(r.a)) {
    if (/\[object /.test(JSON.stringify(v))) { junkCount++; console.log(`- ${k}: ${JSON.stringify(v).slice(0, 120)} [${JSON.parse(r.job).title ?? "?"}]`); }
  }
}
if (!junkCount) console.log("(none)");

console.log(`\n== suspicious skills (typos / generic) ==`);
const suspect = /kubenetes|angulare|javascrip|python\s|java\s|c\+\+ ?|htm[l]?$|css$|excel$|word$|powerpoint|office$|microsoft office/i;
for (const r of parsed) {
  const sk = r.a.skills;
  if (!Array.isArray(sk)) continue;
  for (const s of sk) {
    if (suspect.test(s)) console.log(`- "${s}" [${JSON.parse(r.job).title ?? "?"}]`);
  }
}

console.log(`\n== suspicious job_start_date (past or malformed) ==`);
for (const r of parsed) {
  const d = r.a.job_start_date;
  if (typeof d === "string") {
    if (/^20(2[0-4]|1\d)/.test(d)) console.log(`- ${d} [${JSON.parse(r.job).title ?? "?"}]`);
  }
}

console.log(`\n== years_experience weird (min>max, 0-0) ==`);
for (const r of parsed) {
  const y = r.a.years_experience;
  if (y && typeof y === "object") {
    if ((y.min != null && y.max != null && y.min > y.max) || (y.min === 0 && y.max === 0)) console.log(`- ${JSON.stringify(y)} [${JSON.parse(r.job).title ?? "?"}]`);
  }
}

console.log(`\n== salary sanity ==`);
for (const r of parsed) {
  const s = r.a.salary;
  if (s && typeof s === "object") {
    if (s.min != null && s.max != null && s.max - s.min > 40000) console.log(`- ${JSON.stringify(s)} [${JSON.parse(r.job).title ?? "?"}]`);
  }
}
