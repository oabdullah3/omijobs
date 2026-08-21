import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis, type AnalysisSummary } from "./analysis.js";
import { callProvider } from "./analysisProvider.js";
import { addProvider, enableProvider, loadAnalysisSettings, providerApiKeyStatus, removeProvider, resolveProviderApiKey, saveAnalysisSettings, toPublicSettings, updateProvider, writeProviderApiKey } from "./analysisConfig.js";
import { discoverConfigs, resolveBaseRetention } from "./dashboardConfig.js";
import { loadCron } from "./cron.js";
import type { AnalysisProviderConfig } from "./types.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ANALYSIS_STATE_DIR = join(homedir(), ".omijobs");
export const ANALYSIS_DIR = join(ANALYSIS_STATE_DIR, "analysis");
export const ACTIVE_FILE = join(ANALYSIS_DIR, "active");

function dbPathForKey(packageDir: string, dbKey: string): string {
  const cronFile = resolve(packageDir, "cron.json");
  const meta = discoverConfigs({ packageDir, cronFile }).find((item) => item.id === dbKey);
  if (!meta) throw new Error(`No DB config "${dbKey}"`);
  return meta.db.path;
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
export function readActiveMarker(file = ACTIVE_FILE): { dbPath: string; pid: number; startedAt: string } | null {
  if (!existsSync(file)) return null;
  try {
    const marker = JSON.parse(readFileSync(file, "utf8")) as { dbPath: string; pid: number; startedAt: string };
    if (typeof marker.dbPath === "string" && Number.isInteger(marker.pid) && pidAlive(marker.pid)) return marker;
  } catch { /* stale marker */ }
  rmSync(file, { force: true });
  return null;
}
export function acquireAnalysisLock(file: string, dbPath: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ dbPath, pid: process.pid, startedAt: new Date().toISOString() }));
  try { return JSON.parse(readFileSync(file, "utf8")).pid === process.pid; } catch { return false; }
}
export function resolveAnalysisState(stateDir = ANALYSIS_STATE_DIR) {
  const dir = join(stateDir, "analysis");
  return { dir, active: join(dir, "active"), status: (db: string) => join(dir, `${db}.status.json`), log: (db: string) => join(dir, `${db}.log`), stop: (db: string) => join(dir, `${db}.stop`) };
}
function stateFromEnvironment(fallback: ReturnType<typeof resolveAnalysisState>): ReturnType<typeof resolveAnalysisState> {
  const marker = process.env.OMI_JOB_FETCH_RUN_MARKER;
  if (!marker) return fallback;
  const dir = dirname(marker);
  return { dir, active: marker, status: (db: string) => join(dir, `${db}.status.json`), log: (db: string) => process.env.OMI_JOB_FETCH_PROGRESS_FILE ?? join(dir, `${db}.log`), stop: (db: string) => process.env.OMI_JOB_FETCH_STOP_FILE ?? join(dir, `${db}.stop`) };
}
function summaryFile(file: string, summary: AnalysisSummary): void { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`); }

export interface AnalysisCliOptions { packageDir?: string; stateDir?: string; instructions?: string; }
export async function runAnalysisCommand(dbKey: string, options: AnalysisCliOptions = {}): Promise<number> {
  const packageDir = resolve(options.packageDir ?? PACKAGE_DIR); const state = stateFromEnvironment(resolveAnalysisState(options.stateDir)); const dbPath = dbPathForKey(packageDir, dbKey);
  if (!existsSync(dbPath)) throw new Error(`DB does not exist: ${dbPath}`);
  const settings = loadAnalysisSettings(packageDir, options.stateDir ?? ANALYSIS_STATE_DIR);
  const provider = settings.providers.find((item) => item.id === settings.enabledProvider);
  if (!provider) throw new Error("no enabled analysis provider");
  const apiKey = resolveProviderApiKey(provider, packageDir);
  if (!apiKey) throw new Error(`missing API key for ${provider.id}`);
  const active = readActiveMarker(state.active);
  if (active) return 2;
  rmSync(state.stop(dbKey), { force: true });
  if (!acquireAnalysisLock(state.active, dbPath)) return 2;
  const progressLines: string[] = [];
  try {
    const summary = await runAnalysis({
      file: dbPath, instructions: options.instructions ?? "", systemPrompt: settings.systemPrompt, descriptionMaxChars: settings.descriptionMaxChars,
      retentionDays: resolveBaseRetention(packageDir) ?? 30, threshold: settings.recommendedThreshold, provider,
      callProvider: (messages) => callProvider(provider, apiKey, messages),
      aborted: () => existsSync(state.stop(dbKey)),
      progress: { line: (line) => { progressLines.push(line); writeFileSync(state.log(dbKey), `${progressLines.join("\n")}\n`); }, result: (line) => { progressLines.push(`result: ${line}`); writeFileSync(state.log(dbKey), `${progressLines.join("\n")}\n`); } },
    });
    summaryFile(state.status(dbKey), summary);
    return summary.outcome === "stopped" ? 130 : summary.outcome === "error" ? 1 : 0;
  } finally { rmSync(state.active, { force: true }); }
}

export function analysisStatus(packageDir = PACKAGE_DIR, stateDir = ANALYSIS_STATE_DIR): unknown {
  const state = resolveAnalysisState(stateDir); const active = readActiveMarker(state.active); const settings = loadAnalysisSettings(packageDir, stateDir);
  return { settings: toPublicSettings(settings, packageDir), active };
}
export function stopAnalysis(dbKey: string, stateDir = ANALYSIS_STATE_DIR): boolean { const state = resolveAnalysisState(stateDir); const active = readActiveMarker(state.active); if (!active) return false; mkdirSync(state.dir, { recursive: true }); writeFileSync(state.stop(dbKey), new Date().toISOString()); return true; }

function parseProvider(argv: string[]): AnalysisProviderConfig {
  const values: Record<string, string> = {}; for (let i = 0; i < argv.length; i++) { const key = argv[i].replace(/^--/, ""); values[key] = argv[++i] ?? ""; }
  return { id: values.id, name: values.name, baseUrl: values["base-url"], model: values.model, apiKeyEnv: values["api-key-env"], temperature: Number(values.temperature ?? 0.2), maxTokens: Number(values["max-tokens"] ?? 400), timeoutMs: Number(values["timeout-ms"] ?? 60000), retries: Number(values.retries ?? 3), retryBackoffMs: Number(values["retry-backoff-ms"] ?? 2000) };
}
export async function runAnalyzeCommand(argv: string[], options: AnalysisCliOptions = {}): Promise<number> {
  const [command, target, ...rest] = argv; const packageDir = resolve(options.packageDir ?? PACKAGE_DIR); const stateDir = options.stateDir ?? ANALYSIS_STATE_DIR;
  if (!command || command === "run") return runAnalysisCommand(command === "run" ? target : command, options);
  if (command === "status") { console.log(JSON.stringify(analysisStatus(packageDir, stateDir), null, 2)); return 0; }
  if (command === "stop") return stopAnalysis(target, stateDir) ? 0 : 2;
  if (command === "providers") {
    const settings = loadAnalysisSettings(packageDir, stateDir); const action = target;
    if (action === "list") { console.log(JSON.stringify(toPublicSettings(settings, packageDir), null, 2)); return 0; }
    if (action === "add") { saveAnalysisSettings(stateDir, addProvider(settings, parseProvider(rest))); return 0; }
    if (action === "remove") { saveAnalysisSettings(stateDir, removeProvider(settings, rest[0])); return 0; }
    if (action === "enable") { saveAnalysisSettings(stateDir, enableProvider(settings, rest[0])); return 0; }
    if (action === "test") { const provider = settings.providers.find((item) => item.id === rest[0]); if (!provider) throw new Error(`provider "${rest[0]}" does not exist`); const key = resolveProviderApiKey(provider, packageDir); if (!key) throw new Error("provider key is unset"); console.log(await callProvider(provider, key, [{ role: "system", content: "Reply with the single word OK" }, { role: "user", content: "ping" }])); return 0; }
  }
  throw new Error(`unknown analyze command: ${command}`);
}
