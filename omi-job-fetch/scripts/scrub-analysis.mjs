#!/usr/bin/env node
// Scrub specific values out of an extraction field across every job in an
// omijobs analysis DB, rewriting the stored analysis JSON in place.
//
// Usage:
//   node scripts/scrub-analysis.mjs <dbPath> --field preferred_languages --drop python,java,c++,c#
//   node scripts/scrub-analysis.mjs <dbPath> --field skills --drop "[object object]" --dry-run
//
// Flags:
//   --field <key>   extraction field to edit (default: preferred_languages)
//   --drop a,b,c    comma-separated values to remove (case-insensitive, exact match)
//   --dry-run       print what would change without writing anything
//   --no-backup     skip copying <dbPath>.bak before writing
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith("--"));
const field = flag("--field") ?? "preferred_languages";
const drop = (flag("--drop") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const dryRun = args.includes("--dry-run");
const noBackup = args.includes("--no-backup");

if (!dbPath || !existsSync(dbPath)) {
  console.error("Usage: node scripts/scrub-analysis.mjs <dbPath> --field <key> --drop a,b,c [--dry-run] [--no-backup]");
  process.exit(1);
}
if (drop.length === 0) {
  console.error("Nothing to drop: pass --drop v1,v2");
  process.exit(1);
}

function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const db = new DatabaseSync(dbPath, dryRun ? { readOnly: true } : {});
const rows = db.prepare("SELECT signature, analysis FROM jobs WHERE analysis IS NOT NULL").all();
const updates = [];
for (const row of rows) {
  let obj;
  try { obj = JSON.parse(String(row.analysis)); } catch { continue; }
  if (!obj || typeof obj !== "object" || typeof obj.schemaVersion !== "number") continue;
  const value = obj[field];
  if (!Array.isArray(value)) continue;
  const next = value.filter((v) => {
    if (typeof v !== "string") return true; // keep numbers, drop nothing else
    return !drop.includes(v.trim().toLowerCase());
  });
  if (next.length === value.length) continue;
  obj[field] = next;
  updates.push({ signature: String(row.signature), analysis: JSON.stringify(obj) });
}

console.log(`${dryRun ? "[dry-run] would update" : "Updating"} ${updates.length} job(s), removing [${drop.join(", ")}] from ${field}:`);
for (const u of updates) console.log(`  - ${u.signature}`);

if (!dryRun && updates.length > 0) {
  if (!noBackup) copyFileSync(dbPath, `${dbPath}.bak`);
  const tx = db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?");
  for (const u of updates) tx.run(u.analysis, new Date().toISOString(), u.signature);
}
db.close();
console.log(dryRun ? "No changes written." : `Done. Backup: ${dbPath}.bak`);
