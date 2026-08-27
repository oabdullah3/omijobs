// Check recent analysis events for the live backfill run. Read-only.
// Run from omi-job-fetch/: node scripts/check-live-run.mjs
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(join(homedir(), ".omijobs", "logs", "events.db"), { readOnly: true });
const rows = db.prepare("SELECT ts, event, message, data FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 10").all(new Date(Date.now() - 10 * 60 * 1000).toISOString());
db.close();
for (const r of rows) {
  console.log(`${r.ts}  ${r.event}  ${r.message}${r.data ? "  " + String(r.data).slice(0, 120) : ""}`);
}
