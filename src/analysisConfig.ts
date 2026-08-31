import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisProviderConfig, AnalysisSettings, AnalysisSettingsPublic, ContractField, ContractFieldKind, ContractNormalize, ExtractionContract } from "./types.js";
export { AnalysisRunStatus } from "./types.js";

export type { AnalysisProviderConfig, AnalysisSettings, AnalysisSettingsPublic, ContractField, ContractFieldKind, ContractNormalize, ExtractionContract } from "./types.js";

const SETTINGS_FILE = "analysis.json";
const FIELD_KINDS: ContractFieldKind[] = ["enum", "list", "range", "number", "date"];
const NORMALIZERS: ContractNormalize[] = ["lower", "canonical-language", "canonical-license"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateField(raw: unknown): ContractField {
  if (typeof raw !== "object" || raw === null) throw new Error("field must be an object");
  const f = raw as Record<string, unknown>;
  if (typeof f.key !== "string" || !/^[a-z][a-z0-9_]*$/.test(f.key)) throw new Error(`field.key must be a snake_case string`);
  if (typeof f.kind !== "string" || !(FIELD_KINDS as string[]).includes(f.kind)) throw new Error(`field "${f.key}" has invalid kind`);
  const kind = f.kind as ContractFieldKind;
  if (f.multi !== undefined && typeof f.multi !== "boolean") throw new Error(`field "${f.key}" multi must be a boolean`);
  if (f.normalize !== undefined && (typeof f.normalize !== "string" || !(NORMALIZERS as string[]).includes(f.normalize))) throw new Error(`field "${f.key}" normalize is invalid`);
  const out: ContractField = { key: f.key as string, kind, multi: f.multi === true };
  if (f.normalize !== undefined) out.normalize = f.normalize as ContractNormalize;
  if (kind === "enum") {
    if (!Array.isArray(f.values) || f.values.length === 0 || !f.values.every((v) => typeof v === "string" && v.trim() !== "")) throw new Error(`field "${f.key}" enum requires a non-empty values[] array`);
    out.values = (f.values as string[]).map((v) => v.trim());
  } else if (f.values !== undefined) {
    throw new Error(`field "${f.key}" values is only allowed on enum fields`);
  }
  if (kind === "range") {
    if (f.unit !== undefined) out.unit = String(f.unit);
    if (f.currency !== undefined) out.currency = String(f.currency);
    if (f.period !== undefined) out.period = String(f.period);
  }
  return out;
}

export function validateContract(raw: unknown): ExtractionContract {
  if (typeof raw !== "object" || raw === null) throw new Error("contract must be an object");
  const c = raw as Record<string, unknown>;
  if (!Number.isInteger(c.schemaVersion) || (c.schemaVersion as number) < 1) throw new Error("schemaVersion must be a positive integer");
  if (!Array.isArray(c.fields)) throw new Error("fields must be an array");
  const fields = c.fields.map(validateField);
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new Error("field keys must be unique");
  return { schemaVersion: c.schemaVersion as number, fields };
}

export function validateProvider(raw: unknown): AnalysisProviderConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("provider must be an object");
  const provider = raw as Record<string, unknown>;
  for (const key of ["id", "name", "baseUrl", "model", "apiKeyEnv"] as const) {
    if (typeof provider[key] !== "string" || provider[key].trim() === "") throw new Error(`provider.${key} is required`);
  }
  if (!/^https?:\/\//i.test(provider.baseUrl as string)) throw new Error("provider.baseUrl must be an http(s) URL");
  if (!/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv as string)) throw new Error("provider.apiKeyEnv must be an environment variable name");
  const ranges: Array<[keyof AnalysisProviderConfig, number, number]> = [
    ["temperature", 0, 2], ["maxTokens", 1, 100_000], ["timeoutMs", 1_000, 300_000],
    ["retries", 0, 10], ["retryBackoffMs", 0, 300_000],
  ];
  for (const [key, min, max] of ranges) {
    if (!isFiniteNumber(provider[key]) || (provider[key] as number) < min || (provider[key] as number) > max) throw new Error(`provider.${String(key)} must be between ${min} and ${max}`);
  }
  if (!["maxTokens", "timeoutMs", "retries", "retryBackoffMs"].every((key) => Number.isInteger(provider[key]))) throw new Error("provider integer settings must be whole numbers");
  return {
    id: (provider.id as string).trim(), name: (provider.name as string).trim(), baseUrl: (provider.baseUrl as string).trim().replace(/\/$/, ""),
    model: (provider.model as string).trim(), apiKeyEnv: (provider.apiKeyEnv as string).trim(), temperature: provider.temperature as number,
    maxTokens: provider.maxTokens as number, timeoutMs: provider.timeoutMs as number, retries: provider.retries as number, retryBackoffMs: provider.retryBackoffMs as number,
  };
}

export function validateSettings(raw: unknown): AnalysisSettings {
  if (typeof raw !== "object" || raw === null) throw new Error("analysis settings must be an object");
  const settings = raw as Record<string, unknown>;
  if (typeof settings.systemPrompt !== "string" || settings.systemPrompt.trim() === "") throw new Error("systemPrompt is required");
  if (!isFiniteNumber(settings.descriptionMaxChars) || !Number.isInteger(settings.descriptionMaxChars) || settings.descriptionMaxChars < 1 || settings.descriptionMaxChars > 100_000) throw new Error("descriptionMaxChars must be a positive integer");
  if (settings.enabledProvider !== null && settings.enabledProvider !== undefined && typeof settings.enabledProvider !== "string") throw new Error("enabledProvider must be a provider id or null");
  if (!Array.isArray(settings.providers)) throw new Error("providers must be an array");
  const providers = settings.providers.map(validateProvider);
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error("provider ids must be unique");
  const enabledProvider = settings.enabledProvider === undefined ? null : settings.enabledProvider as string | null;
  if (enabledProvider !== null && !providers.some((provider) => provider.id === enabledProvider)) throw new Error(`enabled provider "${enabledProvider}" does not exist`);
  const contract = validateContract({ schemaVersion: settings.schemaVersion, fields: settings.fields });
  return { schemaVersion: contract.schemaVersion, systemPrompt: settings.systemPrompt, descriptionMaxChars: settings.descriptionMaxChars, enabledProvider, providers, fields: contract.fields };
}

function parseDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

export function resolveProviderApiKey(provider: AnalysisProviderConfig, stateDir: string): string | undefined {
  return process.env[provider.apiKeyEnv] || parseDotEnv(join(stateDir, ".env"))[provider.apiKeyEnv];
}

export function providerApiKeyStatus(provider: AnalysisProviderConfig, stateDir: string): "set" | "unset" {
  return resolveProviderApiKey(provider, stateDir) ? "set" : "unset";
}

/** The extraction contract bundled with the package (or an empty v1 contract when absent). */
function loadBaseContract(packageDir: string): { schemaVersion: number; fields: ContractField[] } {
  const basePath = join(packageDir, "analysis.config.base.json");
  if (!existsSync(basePath)) return { schemaVersion: 1, fields: [] };
  return validateContract(JSON.parse(readFileSync(basePath, "utf8")));
}

const DEFAULT_SYSTEM_PROMPT = "You are a job-description extractor. Read the job posting and output ONLY the fields that are explicitly stated, as a single JSON object. Never invent or assume a value; when a field is not specified in the posting, omit it entirely. mandatory_languages and preferred_languages may contain ONLY human spoken languages (e.g. English, Cantonese, Mandarin, Japanese) — never programming languages, frameworks, or any other skills. Use plain text without HTML entities (write r&d, not r&amp;d). Check the spelling of technical terms and brand names (e.g., Kubernetes, Angular, JavaScript).";
/** Signature of the pre-extraction v0 default prompt, which asked for a 0-10 score/reason verdict. */
const LEGACY_SYSTEM_PROMPT_SIGNATURE = "job-matching evaluator";

function baseSystemPrompt(packageDir: string): string {
  const basePath = join(packageDir, "analysis.config.base.json");
  if (existsSync(basePath)) {
    const raw = JSON.parse(readFileSync(basePath, "utf8")) as Record<string, unknown>;
    if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim() !== "") return raw.systemPrompt;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/** Keep a user-customized prompt, but never a stale v0 score-based one — the extraction pipeline ignores score/reason. */
function resolveSystemPrompt(packageDir: string, candidate: unknown): string {
  if (typeof candidate === "string" && candidate.trim() !== "" && !candidate.includes(LEGACY_SYSTEM_PROMPT_SIGNATURE)) return candidate;
  return baseSystemPrompt(packageDir);
}

export function loadAnalysisSettings(packageDir: string, stateDir: string): AnalysisSettings {
  const statePath = join(stateDir, SETTINGS_FILE);
  if (existsSync(statePath)) {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    // v0 settings (pre-extraction-contract) lack schemaVersion/fields. Preserve
    // the user's provider configuration and upgrade the shape from the bundled
    // contract so the dashboard keeps working after an upgrade.
    if (raw.schemaVersion === undefined || raw.fields === undefined) {
      const contract = loadBaseContract(packageDir);
      const settings = validateSettings({
        schemaVersion: contract.schemaVersion,
        systemPrompt: resolveSystemPrompt(packageDir, raw.systemPrompt),
        descriptionMaxChars: raw.descriptionMaxChars,
        enabledProvider: raw.enabledProvider,
        providers: raw.providers,
        fields: contract.fields,
      });
      saveAnalysisSettings(stateDir, settings);
      return settings;
    }
    const settings = validateSettings(raw);
    // A file migrated before the prompt repair still carries the v0 score-based
    // prompt, which contradicts the extraction contract. Replace it and re-save.
    if (settings.systemPrompt.includes(LEGACY_SYSTEM_PROMPT_SIGNATURE)) {
      const next = { ...settings, systemPrompt: resolveSystemPrompt(packageDir, settings.systemPrompt) };
      saveAnalysisSettings(stateDir, next);
      return next;
    }
    return settings;
  }
  const basePath = join(packageDir, "analysis.config.base.json");
  const settings = existsSync(basePath) ? validateSettings(JSON.parse(readFileSync(basePath, "utf8"))) : validateSettings({ schemaVersion: 1, systemPrompt: DEFAULT_SYSTEM_PROMPT, descriptionMaxChars: 4000, enabledProvider: null, providers: [], fields: [] });
  saveAnalysisSettings(stateDir, settings);
  return settings;
}

export function saveAnalysisSettings(stateDir: string, settings: AnalysisSettings): void {
  const validated = validateSettings(settings);
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, SETTINGS_FILE);
  const temp = join(stateDir, `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(temp, target);
}

export function toPublicSettings(settings: AnalysisSettings, stateDir = ""): AnalysisSettingsPublic {
  return {
    schemaVersion: settings.schemaVersion,
    systemPrompt: settings.systemPrompt,
    descriptionMaxChars: settings.descriptionMaxChars,
    enabledProvider: settings.enabledProvider,
    fields: settings.fields,
    // apiKeyEnv is the env-var *name* (not the secret value), and the numeric
    // fields are needed to pre-fill the onboarding/edit form. The key value
    // itself never leaves write-only storage.
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKeyEnv: provider.apiKeyEnv,
      temperature: provider.temperature,
      maxTokens: provider.maxTokens,
      timeoutMs: provider.timeoutMs,
      retries: provider.retries,
      retryBackoffMs: provider.retryBackoffMs,
      apiKeyStatus: providerApiKeyStatus(provider, stateDir),
    })),
  };
}

export function addProvider(settings: AnalysisSettings, provider: AnalysisProviderConfig): AnalysisSettings {
  const next = validateProvider(provider);
  if (settings.providers.some((item) => item.id === next.id)) throw new Error(`provider "${next.id}" already exists`);
  return validateSettings({ ...settings, providers: [...settings.providers, next] });
}

export function updateProvider(settings: AnalysisSettings, id: string, provider: AnalysisProviderConfig): AnalysisSettings {
  const next = validateProvider(provider);
  if (!settings.providers.some((item) => item.id === id)) throw new Error(`provider "${id}" does not exist`);
  if (next.id !== id && settings.providers.some((item) => item.id === next.id)) throw new Error(`provider "${next.id}" already exists`);
  return validateSettings({ ...settings, enabledProvider: settings.enabledProvider === id ? next.id : settings.enabledProvider, providers: settings.providers.map((item) => item.id === id ? next : item) });
}

export function removeProvider(settings: AnalysisSettings, id: string): AnalysisSettings {
  if (!settings.providers.some((provider) => provider.id === id)) throw new Error(`provider "${id}" does not exist`);
  return validateSettings({ ...settings, enabledProvider: settings.enabledProvider === id ? null : settings.enabledProvider, providers: settings.providers.filter((provider) => provider.id !== id) });
}

export function enableProvider(settings: AnalysisSettings, id: string): AnalysisSettings {
  if (!settings.providers.some((provider) => provider.id === id)) throw new Error(`provider "${id}" does not exist`);
  return validateSettings({ ...settings, enabledProvider: id });
}

export function writeProviderApiKey(provider: AnalysisProviderConfig, value: string, stateDir: string): void {
  if (!value.trim()) throw new Error("API key cannot be empty");
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, ".env");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const prefix = `${provider.apiKeyEnv}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = `${prefix}${value}`;
  else lines.push(`${prefix}${value}`);
  writeFileSync(file, `${lines.filter((line) => line !== "").join("\n")}\n`, "utf8");
}
