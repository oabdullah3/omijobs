// Check the 33 unanalyzed rows + the [object object] row in full (read-only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2] ?? "C:/Users/Omer Abdullah/.omijobs/dashboard.configs/cron/output/tech-internship.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log("== rows with NULL/empty analysis ==");
const noA = db.prepare("SELECT signature, job, status, created_at FROM jobs WHERE analysis IS NULL OR analysis = '' ORDER BY created_at").all();
console.log(`count=${noA.length}`);
for (const r of noA) { const j = JSON.parse(r.job); console.log(`- [${r.created_at}] ${r.status} | ${j.title ?? "?"} | ${j.company ?? "?"}`); }

console.log("\n== [object object] row raw ==");
const junk = db.prepare("SELECT analysis FROM jobs WHERE analysis LIKE '%[object%'").all();
for (const r of junk) console.log(r.analysis);
