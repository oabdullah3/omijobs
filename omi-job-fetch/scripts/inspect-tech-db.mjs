// Inspect the tech-internship DB schema + analysis stats (read-only).
// Usage: node scripts/inspect-tech-db.mjs [dbPath]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/dashboard.configs/cron/output/tech-internship.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log("TABLES:", tables.join(", "));

for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`\n== ${t} (${count} rows) ==`);
  for (const c of cols) console.log(`  ${c.name} ${c.type}${c.pk ? " PK" : ""}`);
}

// If there's an analysis-ish table, show column distribution
for (const t of tables) {
  if (/analys/i.test(t)) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    console.log(`\n== ${t} sample ==`);
    const sample = db.prepare(`SELECT * FROM ${t} LIMIT 2`).all();
    console.log(JSON.stringify(sample, null, 2).slice(0, 3000));
  }
}
