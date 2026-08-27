// Check events DB for analysis failures around the unanalyzed rows (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/logs/events.db";
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  console.log("tables:", tables.join(", "));
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    console.log(`${t}: ${cols.join(", ")}`);
  }
  // find the analysis-related log rows
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (cols.some((c) => /event|msg|message|name/i.test(c))) {
      const rows = db.prepare(`SELECT * FROM ${t} WHERE CAST(${cols[0]} AS TEXT) LIKE '%analysis%' OR CAST(${cols[1] ?? cols[0]} AS TEXT) LIKE '%failed%' ORDER BY rowid DESC LIMIT 30`).all();
      console.log(`\n== ${t} analysis/failed rows (${rows.length}) ==`);
      for (const r of rows) console.log(JSON.stringify(r).slice(0, 300));
    }
  }
} catch (e) {
  console.log("events db error:", e.message);
}
