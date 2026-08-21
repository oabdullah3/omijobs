import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisProviderConfig, AnalysisSettings, AnalysisSettingsPublic } from "./types.js";
export { AnalysisRunStatus } from "./types.js";

export type { AnalysisProviderConfig, AnalysisSettings, AnalysisSettingsPublic } from "./types.js";

const SETTINGS_FILE = "analysis.json";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  if (!isFiniteNumber(settings.recommendedThreshold) || settings.recommendedThreshold < 0 || settings.recommendedThreshold > 10) throw new Error("recommendedThreshold must be between 0 and 10");
  if (!isFiniteNumber(settings.descriptionMaxChars) || !Number.isInteger(settings.descriptionMaxChars) || settings.descriptionMaxChars < 1 || settings.descriptionMaxChars > 100_000) throw new Error("descriptionMaxChars must be a positive integer");
  if (settings.enabledProvider !== null && settings.enabledProvider !== undefined && typeof settings.enabledProvider !== "string") throw new Error("enabledProvider must be a provider id or null");
  if (!Array.isArray(settings.providers)) throw new Error("providers must be an array");
  const providers = settings.providers.map(validateProvider);
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error("provider ids must be unique");
  const enabledProvider = settings.enabledProvider === undefined ? null : settings.enabledProvider as string | null;
  if (enabledProvider !== null && !providers.some((provider) => provider.id === enabledProvider)) throw new Error(`enabled provider "${enabledProvider}" does not exist`);
  return { systemPrompt: settings.systemPrompt, recommendedThreshold: settings.recommendedThreshold, descriptionMaxChars: settings.descriptionMaxChars, enabledProvider, providers };
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

export function resolveProviderApiKey(provider: AnalysisProviderConfig, packageDir: string): string | undefined {
  return process.env[provider.apiKeyEnv] || parseDotEnv(join(packageDir, ".env"))[provider.apiKeyEnv];
}

export function providerApiKeyStatus(provider: AnalysisProviderConfig, packageDir: string): "set" | "unset" {
  return resolveProviderApiKey(provider, packageDir) ? "set" : "unset";
}

export function loadAnalysisSettings(packageDir: string, stateDir: string): AnalysisSettings {
  const statePath = join(stateDir, SETTINGS_FILE);
  if (existsSync(statePath)) return validateSettings(JSON.parse(readFileSync(statePath, "utf8")));
  const basePath = join(packageDir, "analysis.config.base.json");
  const settings = existsSync(basePath) ? validateSettings(JSON.parse(readFileSync(basePath, "utf8"))) : validateSettings({ systemPrompt: "You are a job-matching evaluator.", recommendedThreshold: 5, descriptionMaxChars: 4000, enabledProvider: null, providers: [] });
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

export function toPublicSettings(settings: AnalysisSettings, packageDir = ""): AnalysisSettingsPublic {
  return {
    systemPrompt: settings.systemPrompt,
    recommendedThreshold: settings.recommendedThreshold,
    descriptionMaxChars: settings.descriptionMaxChars,
    enabledProvider: settings.enabledProvider,
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
      apiKeyStatus: providerApiKeyStatus(provider, packageDir),
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

export function writeProviderApiKey(provider: AnalysisProviderConfig, value: string, packageDir: string): void {
  if (!value.trim()) throw new Error("API key cannot be empty");
  const file = join(packageDir, ".env");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const prefix = `${provider.apiKeyEnv}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = `${prefix}${value}`;
  else lines.push(`${prefix}${value}`);
  writeFileSync(file, `${lines.filter((line) => line !== "").join("\n")}\n`, "utf8");
}
