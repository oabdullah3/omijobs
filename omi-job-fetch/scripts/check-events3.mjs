// Find analysis events in the events log (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/logs/events.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db.prepare("SELECT ts, level, source, event, runId, message FROM events WHERE source LIKE '%analysis%' OR event LIKE 'analysis%' ORDER BY id DESC LIMIT 60").all();
console.log(`analysis events: ${rows.length}`);
for (const r of rows) console.log(`[${r.ts}] ${r.level} ${r.source}.${r.event} run=${r.runId ?? ""} ${(r.message ?? "").slice(0, 140)}`);
