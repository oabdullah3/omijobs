import type { AnalysisProviderConfig, ContractField, ContractNormalize, ExtractionContract, ExtractionResult } from "./types.js";
import type { Logger } from "./logger.js";

export interface ChatMessage { role: "system" | "user"; content: string; }
export type FetchLike = typeof fetch;
export type SleepLike = (ms: number) => Promise<void>;

export class AuthConfigError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "AuthConfigError"; this.status = status; }
}
export class TransientProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "TransientProviderError"; this.status = status; }
}

function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function extractContract(content: unknown, contract: ExtractionContract): ExtractionResult | null {
  if (typeof content !== "string") return null;
  const object = balancedObject(content.replace(/```(?:json)?/gi, ""));
  if (!object) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(object) as Record<string, unknown>; } catch { return null; }
  const result: ExtractionResult = { schemaVersion: contract.schemaVersion };
  const unmatched: Record<string, string[]> = {};
  for (const field of contract.fields) {
    const raw = parsed[field.key];
    if (raw === undefined) continue;
    const value = coerceField(raw, field, unmatched);
    if (value !== undefined) result[field.key] = value;
  }
  if (Object.keys(unmatched).length > 0) result.unmatched = unmatched;
  return result;
}

function normalizeTag(value: string, normalize?: ContractNormalize): string {
  const trimmed = value.trim();
  if (normalize === "lower" || normalize === "canonical-language" || normalize === "canonical-license") return trimmed.toLowerCase();
  return trimmed;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function coerceEnum(raw: unknown, field: ContractField, unmatched: Record<string, string[]>): unknown {
  const values = field.values ?? [];
  const tags = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const chosen: string[] = [];
  for (const tag of tags) {
    const t = tag.trim().toLowerCase();
    if (!t) continue;
    if (values.includes(t)) chosen.push(t);
    else { chosen.push("other"); unmatched[field.key] = [...(unmatched[field.key] ?? []), t]; }
  }
  if (chosen.length === 0) return undefined;
  return field.multi ? [...new Set(chosen)] : chosen[0];
}

function coerceList(raw: unknown, field: ContractField): unknown {
  if (!field.multi) {
    const single = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw);
    const t = normalizeTag(single, field.normalize);
    return t ? t : undefined;
  }
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[/,;]|\s+and\s+/i);
  const tags: string[] = [];
  for (const part of parts) {
    const t = normalizeTag(String(part), field.normalize);
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags.length ? tags : undefined;
}

function coerceRange(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const min = toNumber(obj.min);
  const max = toNumber(obj.max);
  const out: Record<string, number> = {};
  if (min !== null && min >= 0) out.min = min;
  if (max !== null && max >= 0) out.max = max;
  return Object.keys(out).length ? out : undefined;
}

function coerceNumber(raw: unknown): unknown {
  const n = toNumber(raw);
  return n === null ? undefined : n;
}

function coerceDate(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(t)) return t;
  const d = Date.parse(t);
  return Number.isNaN(d) ? undefined : new Date(d).toISOString().slice(0, 10);
}

function coerceField(raw: unknown, field: ContractField, unmatched: Record<string, string[]>): unknown {
  switch (field.kind) {
    case "enum": return coerceEnum(raw, field, unmatched);
    case "list": return coerceList(raw, field);
    case "range": return coerceRange(raw);
    case "number": return coerceNumber(raw);
    case "date": return coerceDate(raw);
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function transient(error: unknown): boolean {
  return error instanceof TransientProviderError || (error instanceof Error && (error.name === "AbortError" || error.name === "TypeError"));
}

export async function callProvider(
  provider: AnalysisProviderConfig,
  apiKey: string,
  messages: ChatMessage[],
  fetchImpl: FetchLike = fetch,
  sleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger?: Logger,
): Promise<string> {
  if (!apiKey) throw new AuthConfigError("provider API key is missing");
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const attempts = provider.retries + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
    logger?.debug("analysis.provider.call", `provider call (attempt ${attempt + 1}/${attempts})`, { attempt: attempt + 1, model: provider.model });
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: provider.model, messages, temperature: provider.temperature, max_tokens: provider.maxTokens, stream: false }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new AuthConfigError(`provider request failed (${response.status})`, response.status);
      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 >= attempts) throw new TransientProviderError(`provider request failed (${response.status})`, response.status);
        logger?.warn("analysis.provider.retry", `retrying (attempt ${attempt + 1}/${attempts})`, { attempt: attempt + 1, status: response.status });
        await sleep(retryAfterMs(response) ?? provider.retryBackoffMs * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new AuthConfigError(`provider request failed (${response.status})`, response.status);
      let body: unknown;
      try { body = await response.json(); } catch { throw new AuthConfigError("provider returned malformed JSON", response.status); }
      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new AuthConfigError("provider response is missing choices[0].message.content", response.status);
      return content;
    } catch (error) {
      if (error instanceof AuthConfigError) throw error;
      if (!transient(error)) throw new AuthConfigError(error instanceof Error ? error.message : String(error));
      if (attempt + 1 >= attempts) throw new TransientProviderError(error instanceof Error ? error.message : String(error));
      logger?.warn("analysis.provider.retry", `retrying (attempt ${attempt + 1}/${attempts})`, { attempt: attempt + 1 });
      await sleep(provider.retryBackoffMs * (attempt + 1));
    } finally { clearTimeout(timer); }
  }
  throw new TransientProviderError("provider request exhausted retries");
}
