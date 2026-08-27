// Final targeted checks: legacy row contents, unknown keys, per-row completeness (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/dashboard.configs/cron/output/tech-internship.db";
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare("SELECT signature, job, analysis FROM jobs WHERE analysis IS NOT NULL AND analysis != ''").all();
const parsed = rows.filter((r) => r.analysis.startsWith("{")).map((r) => ({ ...r, a: JSON.parse(r.analysis) }));

// 1. Union of all keys in analyses
const keys = new Set();
for (const r of parsed) for (const k of Object.keys(r.a)) keys.add(k);
console.log("ALL KEYS ACROSS ANALYSES:", [...keys].sort().join(", "));

// 2. Full dump of the 7 legacy rows (old prompt era)
console.log("\n== LEGACY ROWS (score/reason) FULL ANALYSIS ==");
for (const r of parsed.filter((r) => "reason" in r.a || "score" in r.a)) {
  const j = JSON.parse(r.job);
  console.log(`\n[${j.title}] ${j.company}`);
  console.log(JSON.stringify(r.a, null, 1));
}

// 3. preferred_languages still containing programming languages?
console.log("\n== preferred_languages non-spoken junk ==");
const progLang = /python|java|c\+\+|c#|\.net|javascript|typescript|golang|rust|swift|ruby|php|sql|html|css|kotlin|scala|r\b/i;
for (const r of parsed) {
  const pl = r.a.preferred_languages;
  if (Array.isArray(pl)) for (const v of pl) if (progLang.test(v)) console.log(`- "${v}" [${JSON.parse(r.job).title}]`);
}

// 4. Rows missing analysis entirely
console.log("\n== rows with empty/missing analysis (33 expected) ==");
const empty = rows.filter((r) => !r.analysis || r.analysis === "" || !r.analysis.startsWith("{"));
console.log(`count=${empty.length}`);
for (const r of empty.slice(0, 10)) { const j = JSON.parse(r.job); console.log(`- ${j.title ?? "?"} | ${j.company ?? "?"}`); }

// 5. Analysis "completeness": how many fields typically populated
console.log("\n== fields per row (top 15 rows by count) ==");
const counts = parsed.map((r) => ({ n: Object.keys(r.a).length, t: JSON.parse(r.job).title })).sort((a, b) => b.n - a.n);
for (const c of counts.slice(0, 15)) console.log(`${c.n} fields | ${c.t}`);

// 6. seniority officer / odd values detail
console.log("\n== seniority != intern/graduate ==");
for (const r of parsed) { const s = r.a.seniority; if (s && !["intern", "graduate"].includes(s)) console.log(`- ${s} [${JSON.parse(r.job).title}]`); }

// 7. jobs with neither languages nor skills nor domain (minimal extraction)
console.log("\n== near-empty analyses (<=2 fields) ==");
for (const r of parsed) { if (Object.keys(r.a).length <= 2) console.log(`- ${Object.keys(r.a).length} fields [${JSON.parse(r.job).title}]`); }
