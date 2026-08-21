import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { DEFAULT_RETENTION_DAYS } from "./db.js";
import { discoverConfigs, resolveBaseRetention, type ConfigMeta } from "./dashboardConfig.js";
import { countAnalysis } from "./analysisDb.js";
import { analysisStatus, resolveAnalysisState } from "./analysisCli.js";
import { loadAnalysisSettings, toPublicSettings } from "./analysisConfig.js";

function readJson(file: string): any | null { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function uniqueDbs(metas: ConfigMeta[]): Array<{ path: string; owners: ConfigMeta[] }> {
  const map = new Map<string, ConfigMeta[]>();
  for (const meta of metas) map.set(meta.db.path, [...(map.get(meta.db.path) ?? []), meta]);
  return [...map.entries()].map(([path, owners]) => ({ path, owners }));
}
export interface DashboardAnalysisOptions { packageDir: string; cronFile: string; stateDir: string; now?: () => Date; }
export function getAnalysisDashboardState(options: DashboardAnalysisOptions): any {
  const settings = loadAnalysisSettings(options.packageDir, options.stateDir);
  const metas = discoverConfigs({ packageDir: options.packageDir, cronFile: options.cronFile });
  const state = resolveAnalysisState(options.stateDir);
  const active = analysisStatus(options.packageDir, options.stateDir) as any;
  const runningDb = active.active?.dbPath ?? null;
  const retentionDays = resolveBaseRetention(options.packageDir) ?? DEFAULT_RETENTION_DAYS;
  const dbs = uniqueDbs(metas).map(({ path, owners }) => {
    const key = owners[0].id;
    const exists = existsSync(path);
    const counts = exists ? countAnalysis(path, settings.recommendedThreshold) : { total: 0, analyzed: 0, pending: 0, recommended: 0 };
    const status = readJson(state.status(key));
    const log = existsSync(state.log(key)) ? readFileSync(state.log(key), "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? null : null;
    return { key, label: owners.map((owner) => owner.id).join(", "), path, exists, ...counts, retentionDays, status: status?.outcome ?? null, lastRun: status?.finishedAt ?? null, summary: status ?? log, running: path === runningDb };
  });
  return { settings: toPublicSettings(settings, options.packageDir), dbs, runningDb };
}
