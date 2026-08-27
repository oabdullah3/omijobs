// Replay the raw content from analysis.job.failed events through the NEW
// extractContract to prove the hardened parser rescues the 33 unanalyzed rows.
// Read-only. Run from repo root:
//   node "omi-job-fetch/scripts/replay-failed-extractions.mjs"
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { extractContract } = await import("../dist/analysisProvider.js");
// The extraction contract must match analysis.config.base.json
const contract = (await import("../analysis.config.base.json", { with: { type: "json" } })).default;

const eventsDb = join(homedir(), ".omijobs", "logs", "events.db");
const db = new DatabaseSync(eventsDb, { readOnly: true });
const rows = db.prepare("SELECT data, ts FROM events WHERE event = 'analysis.job.failed' ORDER BY ts").all();
db.close();

let parsed = 0, stillFailed = 0;
const rescued = [], failed = [];
for (const row of rows) {
  const data = JSON.parse(row.data);
  const sig = data.signature ?? "?";
  const content = typeof data.content === "string" ? data.content : "(no content)";
  const result = extractContract(content, contract);
  if (result) { parsed++; rescued.push(sig); }
  else { stillFailed++; failed.push(sig); }
}
console.log(`events with content: ${rows.length}`);
console.log(`RESCUED by new parser: ${parsed}`);
console.log(`still failing: ${stillFailed}`);
if (rescued.length) console.log("\n-- rescued --\n" + rescued.map((s) => `  ${s}`).join("\n"));
if (failed.length) console.log("\n-- still failing --\n" + failed.map((s) => `  ${s}`).join("\n"));
