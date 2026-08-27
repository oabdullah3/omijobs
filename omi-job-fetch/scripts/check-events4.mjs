// Failure details + run summary from events log (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/logs/events.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const fails = db.prepare("SELECT ts, runId, message, data FROM events WHERE event = 'analysis.job.failed' ORDER BY id DESC LIMIT 30").all();
console.log(`== analysis.job.failed: ${fails.length} ==`);
for (const r of fails) {
  console.log(`[${r.ts}] run=${r.runId} ${(r.message ?? "").slice(0, 100)}`);
  if (r.data) console.log(`  data: ${String(r.data).slice(0, 260)}`);
}

const runs = db.prepare("SELECT DISTINCT runId FROM events WHERE event = 'analysis.job.failed'").all().map((r) => r.runId);
console.log("\nruns with failures:", runs.join(", "));

const started = db.prepare("SELECT ts, runId FROM events WHERE event = 'analysis.started' ORDER BY id").all();
console.log("\n== analysis.started runs ==");
for (const r of started) console.log(`[${r.ts}] ${r.runId}`);

const finished = db.prepare("SELECT ts, runId, message FROM events WHERE event = 'analysis.finished' ORDER BY id DESC LIMIT 5").all();
console.log("\n== analysis.finished ==");
for (const r of finished) console.log(`[${r.ts}] ${r.runId} ${(r.message ?? "").slice(0, 120)}`);
