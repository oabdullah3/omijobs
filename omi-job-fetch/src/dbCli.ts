import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverConfigs } from "./dashboardConfig.js";
import { deleteDbFile, discoverDbs } from "./dashboardDb.js";
import { readActiveMarker, resolveAnalysisState } from "./analysisCli.js";
import { ensureUserFiles } from "./userPaths.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(homedir(), ".omijobs");

function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveLine) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveLine(answer);
    });
  });
}

function printDbHelp(): void {
  console.log(`Usage: omijobs db <command>

  list                List aggregate DBs (name, file, row count)
  delete <name>       Permanently delete a DB — type its name to confirm

Names are the config ids shown on the Jobs page (e.g. "base", or a cron slug).`);
}

async function cmdList(): Promise<number> {
  const user = ensureUserFiles(PACKAGE_DIR, STATE_DIR);
  const metas = discoverConfigs({ packageDir: user.stateDir, cronFile: user.cronFile });
  const dbs = discoverDbs(metas);
  if (dbs.length === 0) {
    console.log("No DBs yet — run a sweep first.");
    return 0;
  }
  for (const d of dbs) {
    console.log(`  ${d.key.padEnd(20)} ${d.path}${d.exists ? `  ${d.total} jobs` : "  (not created)"}`);
  }
  return 0;
}

async function cmdDelete(argv: string[]): Promise<number> {
  const key = argv[0];
  if (!key) {
    console.error("Error: db delete requires a name (see: omijobs db list)");
    return 1;
  }
  const user = ensureUserFiles(PACKAGE_DIR, STATE_DIR);
  const metas = discoverConfigs({ packageDir: user.stateDir, cronFile: user.cronFile });
  const meta = metas.find((m) => m.id === key);
  if (!meta) {
    console.error(`Error: no DB named "${key}" (see: omijobs db list)`);
    return 1;
  }
  if (!meta.db.exists) {
    console.log(`DB "${key}" has not been created yet (${meta.db.path}) — nothing to delete.`);
    return 0;
  }
  // Refuse while an analysis is running against this DB file.
  const active = readActiveMarker(resolveAnalysisState(STATE_DIR).active);
  if (active && active.dbPath === meta.db.path) {
    console.error(`Error: "${key}" is being analyzed right now — stop the analysis first.`);
    return 1;
  }
  const answer = await promptLine(`This permanently deletes ${meta.db.path}. Type "${key}" to confirm: `);
  if (answer.trim() !== key) {
    console.log("Aborted — confirmation did not match.");
    return 1;
  }
  const result = deleteDbFile(meta.db.path);
  if (!result.ok) {
    console.error(`Error deleting "${key}": ${result.error}`);
    return 1;
  }
  console.log(`Deleted "${key}" → ${meta.db.path}`);
  return 0;
}

/** Entry point for `omijobs db ...`. Returns the process exit code. */
export async function runDbCommand(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printDbHelp();
      return 0;
    case "list":
      return cmdList();
    case "delete":
      return cmdDelete(rest);
    default:
      console.error(`Unknown db command: ${cmd}`);
      printDbHelp();
      return 2;
  }
}
