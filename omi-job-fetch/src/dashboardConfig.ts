import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dbFile } from "./db.js";
import { loadCron } from "./cron.js";
import { normalizeQueries } from "./runtime.js";
import { adapters } from "./registry.js";
import type { RunConfig } from "./types.js";

export interface ConfigDb { enabled: boolean; file: string; path: string; exists: boolean; }
export interface ConfigMeta {
  id: string;                 // "base" | cron job id
  kind: "base" | "cron";
  path: string;               // absolute path to the config file
  rel: string;                // path relative to packageDir
  queries: string[];
  enabledPortals: string[];
  outputDir: string;
  db: ConfigDb;
}
export interface ConfigListInput { packageDir: string; cronFile?: string; }
export interface FriendlyPatch {
  queries?: string[];
  enabledPortals?: string[];
  storage?: "shared" | "separate" | "custom";
  dbEnabled?: boolean;
  baseConfig?: RunConfig;
  id?: string;                // cron slug — names the <id>.db for "separate" storage
}

/**
 * Fixed config layout: the base/realtime config and cron configs each live in a
 * deterministic folder under dashboard.configs/, so the dashboard can show
 * config *names* instead of full paths.
 */
export const BASE_CONFIG_REL = "dashboard.configs/realtime/config.json";
export const CRON_CONFIG_DIR = "dashboard.configs/cron";

/** Lowercase slug for cron ids and separate-storage DB filenames. */
export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "job";
}

/** Resolve a config's aggregate-DB file (cwd-relative outputDir, like runtime). */
export function resolveDbPath(config: RunConfig): string {
  return dbFile(config, resolve(config.outputDir ?? "output"));
}

/** Read + JSON-parse a config. Throws with context on missing/bad JSON. */
export function readConfig(path: string): RunConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`config at ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const v = validateConfig(raw);
  if (!v.ok) throw new Error(`config at ${path}: ${v.error}`);
  return v.config;
}

/** Minimal shape check — an object carrying the portal/ats structure. */
export function validateConfig(raw: unknown): { ok: true; config: RunConfig } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const cfg = raw as Partial<RunConfig>;
  if (typeof cfg.portals !== "object" || cfg.portals === null) return { ok: false, error: 'missing "portals" block' };
  if (typeof cfg.ats !== "object" || cfg.ats === null) return { ok: false, error: 'missing "ats" block' };
  return { ok: true, config: cfg as RunConfig };
}

/** Atomic write: temp file in the same dir, then rename over the target. */
export function writeConfig(path: string, config: RunConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

const atsIds = new Set(adapters.filter((a) => a.manifest.family === "ats").map((a) => a.manifest.id));
function splitEnabled(ids: string[]): { portals: string[]; ats: string[] } {
  const portals: string[] = [];
  const ats: string[] = [];
  for (const id of ids) (atsIds.has(id) ? ats : portals).push(id);
  return { portals, ats };
}

/** Build a ConfigMeta from a loaded config. */
export function configMeta(id: string, kind: "base" | "cron", path: string, rel: string, config: RunConfig): ConfigMeta {
  const dbPath = resolveDbPath(config);
  return {
    id,
    kind,
    path,
    rel,
    queries: normalizeQueries(config.global?.queries),
    enabledPortals: [...(config.portals?.enabled ?? []), ...(config.ats?.enabled ?? [])],
    outputDir: config.outputDir ?? "output",
    db: {
      enabled: config.db?.enabled !== false,
      file: config.db?.file ?? "jobs.db",
      path: dbPath,
      exists: existsSync(dbPath),
    },
  };
}

/**
 * Discover configs: the base config.json plus one meta per cron job (config
 * paths resolve relative to the cron.json folder, matching the CLI).
 */
export function discoverConfigs(input: ConfigListInput): ConfigMeta[] {
  const basePath = resolve(input.packageDir, BASE_CONFIG_REL);
  const metas: ConfigMeta[] = [];
  if (existsSync(basePath)) {
    metas.push(configMeta("base", "base", basePath, BASE_CONFIG_REL, readConfig(basePath)));
  }
  if (input.cronFile && existsSync(input.cronFile)) {
    for (const job of loadCron(input.cronFile).jobs) {
      const path = resolve(dirname(input.cronFile), job.config);
      if (!existsSync(path)) continue;
      try {
        metas.push(configMeta(job.id, "cron", path, job.config, readConfig(path)));
      } catch {
        // A cron whose config file is broken is still listed (with db.exists
        // false / empty defaults are impossible here) — but only if readable.
        // Skip unreadable ones; the cron page surfaces the error itself.
      }
    }
  }
  return metas;
}

/**
 * Apply a simplified-controls patch to a config. Storage mapping:
 *   shared   → same outputDir as the base config, db.file = base's jobs.db, enabled
 *   separate → same outputDir, db.file = <slug>.db, enabled
 *   custom   → leave outputDir/db untouched (advanced editor owns it)
 */
export function applyFriendlyUpdate(config: RunConfig, patch: FriendlyPatch): RunConfig {
  let out: RunConfig = config;
  if (patch.queries) out = { ...out, global: { ...out.global, queries: patch.queries } };
  if (patch.enabledPortals) {
    const split = splitEnabled(patch.enabledPortals);
    out = { ...out, portals: { ...out.portals, enabled: split.portals }, ats: { ...out.ats, enabled: split.ats } };
  }
  if (patch.storage === "shared" || patch.storage === "separate") {
    const outputDir = patch.baseConfig?.outputDir ?? out.outputDir;
    if (patch.storage === "shared") {
      out = {
        ...out,
        outputDir,
        db: { ...out.db, enabled: true, file: patch.baseConfig?.db?.file ?? "jobs.db" },
      };
    } else {
      out = { ...out, outputDir, db: { ...out.db, enabled: true, file: `${slugify(patch.id ?? "job")}.db` } };
    }
  }
  if (patch.dbEnabled !== undefined) out = { ...out, db: { ...out.db, enabled: patch.dbEnabled } };
  return out;
}
