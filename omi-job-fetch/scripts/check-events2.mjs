// Look at recent events around the analysis run (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/logs/events.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const total = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
console.log("total events:", total);

const last = db.prepare("SELECT ts, level, source, event, message FROM events ORDER BY id DESC LIMIT 40").all();
for (const r of last) console.log(`[${r.ts}] ${r.level} ${r.source}.${r.event} ${(r.message ?? "").slice(0, 120)}`);
