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

/**
 * Lenient recovery for common model quirks: trailing commas, single-quoted
 * strings, and unquoted keys. Returns null when the text is still not JSON.
 */
function parseLenientJson(text: string): Record<string, unknown> | null {
  // 1. Drop trailing commas.
  const noTrailing = text.replace(/,\s*([}\]])/g, "$1");
  // 2. Convert single-quoted strings to double-quoted with a small state
  //    machine (regex stacking breaks on `'a', 'b'` arrays and prose).
  let out = "";
  let inString = false;
  let inSingle = false;
  let escaped = false;
  for (const char of noTrailing) {
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === "'") { inSingle = !inSingle; out += '"'; continue; }
    out += char;
  }
  // 3. Quote unquoted keys (`{foo: 1}` → `{"foo": 1}`).
  const quoted = out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  try { return JSON.parse(quoted) as Record<string, unknown>; } catch { return null; }
}

/** Index of the next non-whitespace char at/after `from`, or -1. */
function nextNonSpace(text: string, from: number): number {
  for (let i = from; i < text.length; i++) if (!/\s/.test(text[i])) return i;
  return -1;
}

/**
 * Read a double-quoted string starting at `start` (which must point at a `"`).
 * Model output frequently drops the closing quote, so an unterminated string is
 * closed at the first line break or at EOF.
 */
function readStringToken(text: string, start: number): { value: string; end: number } | null {
  let out = "";
  let i = start + 1;
  let escaped = false;
  for (; i < text.length; i++) {
    const char = text[i];
    if (escaped) { out += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') return { value: out, end: i + 1 };
    if (char === "\n" || char === "\r") return { value: out, end: i };
    out += char;
  }
  return { value: out, end: i };
}

function readNumberToken(text: string, start: number): { value: number; end: number } | null {
  const match = /-?\d+(?:\.\d+)?/.exec(text.slice(start));
  if (!match) return null;
  return { value: Number(match[0]), end: start + match[0].length };
}

/**
 * Tolerantly read an array value. Collects quoted strings and numbers, flattens
 * nested arrays, skips object regions, and ignores stray tokens plus duplicated
 * open/close brackets (`]: [` and `": [`), which small models emit frequently.
 */
function readArrayValue(text: string, start: number): { value: unknown[]; end: number } | null {
  const values: unknown[] = [];
  let i = start + 1;
  let depth = 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      if (text[i + 1] === ":") {
        // Duplicated `": [` junk token — skip the quote, colon, and the bracket
        // WITHOUT treating the bracket as nesting.
        const after = nextNonSpace(text, i + 2);
        i = after >= 0 && text[after] === "[" ? after + 1 : i + 2;
        continue;
      }
      const token = readStringToken(text, i);
      if (token) {
        const value = token.value.trim();
        if (value !== "") values.push(value);
        i = token.end;
        continue;
      }
    }
    if (char === "[") { depth++; i++; continue; }
    if (char === "{") {
      // Skip a balanced object region without harvesting its string contents.
      let inner = 1; i++;
      while (i < text.length && inner > 0) {
        if (text[i] === '"') { const token = readStringToken(text, i); if (token) { i = token.end; continue; } }
        if (text[i] === "{") inner++;
        else if (text[i] === "}") inner--;
        i++;
      }
      continue;
    }
    if (char === "]") {
      depth--;
      if (depth === 0) {
        // A stray close followed by `[` or `": [` means the model duplicated the
        // opening token — ignore the close and keep collecting.
        const next = nextNonSpace(text, i + 1);
        if (next >= 0 && text[next] === "[") { depth++; i = next + 1; continue; }
        if (next >= 0 && text[next] === '"' && text[next + 1] === ":") {
          const after = nextNonSpace(text, next + 2);
          if (after >= 0 && text[after] === "[") { depth++; i = after + 1; continue; }
        }
        return { value: values, end: i + 1 };
      }
      i++;
      continue;
    }
    if (char === "," || char === ":" || char === "}") { i++; continue; }
    if (/[0-9-]/.test(char)) {
      const number = readNumberToken(text, i);
      if (number) { values.push(number.value); i = number.end; continue; }
    }
    i++;
  }
  return { value: values, end: i };
}

/** Read an object value (e.g. a range field) and salvage min/max numbers. */
function readObjectValue(text: string, start: number): { value: Record<string, unknown>; end: number } | null {
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { const token = readStringToken(text, i); if (token) { i = token.end - 1; continue; } }
    if (char === "{") depth++;
    else if (char === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) end = text.length;
  const region = text.slice(start, end);
  const value: Record<string, unknown> = {};
  const min = /["']?\s*min\s*["']?\s*:\s*(-?\d+(?:\.\d+)?)/.exec(region);
  const max = /["']?\s*max\s*["']?\s*:\s*(-?\d+(?:\.\d+)?)/.exec(region);
  if (min) value.min = Number(min[1]);
  if (max) value.max = Number(max[1]);
  return { value, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the first `"key":`-style occurrence in the raw text and read its value tolerantly. */
function extractFieldValue(text: string, key: string): unknown {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])["']?${escapeRegExp(key)}["']?\\s*:`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const after = nextNonSpace(text, match.index + match[0].length);
    if (after < 0) break;
    const char = text[after];
    if (char === "[") {
      const array = readArrayValue(text, after);
      if (array) return array.value;
    } else if (char === "{") {
      const object = readObjectValue(text, after);
      if (object) return object.value;
    } else if (char === '"') {
      if (text[after + 1] === ":") continue; // duplicated `": [` junk
      const str = readStringToken(text, after);
      if (str) return str.value;
    } else if (/[0-9-]/.test(char)) {
      const number = readNumberToken(text, after);
      if (number) return number.value;
    }
  }
  return undefined;
}

/** Last-resort extraction: pull each contract field out of raw model output directly. */
function extractFieldsLenient(text: string, contract: ExtractionContract): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let found = false;
  for (const field of contract.fields) {
    const value = extractFieldValue(text, field.key);
    if (value === undefined) continue;
    found = true;
    out[field.key] = value;
  }
  return found ? out : null;
}

export function extractContract(content: unknown, contract: ExtractionContract): ExtractionResult | null {
  if (typeof content !== "string") return null;
  const text = content.replace(/```(?:json)?/gi, "");
  const object = balancedObject(text);
  let parsed: Record<string, unknown> | null = null;
  if (object) {
    try { parsed = JSON.parse(object) as Record<string, unknown>; } catch { parsed = parseLenientJson(object); }
  }
  if (!parsed) parsed = extractFieldsLenient(text, contract);
  if (!parsed) return null;
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
  // Models sometimes emit HTML-escaped text (e.g. "r&amp;d", "women&#39;s health").
  const decoded = value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/g, "'");
  const trimmed = decoded.trim();
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
  const tags = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string | number => typeof v === "string" || typeof v === "number").map(String);
  const chosen: string[] = [];
  for (const tag of tags) {
    const t = tag.trim().toLowerCase();
    if (!t) continue;
    // Fold model variants onto hyphenated enum values: "Full Time" → "full-time",
    // "fixed term" → "fixed-term", plus trailing punctuation like "full-time.".
    const folded = t.replace(/[.,;:!?()]+$/g, "").replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    if (values.includes(folded)) chosen.push(folded);
    else { chosen.push("other"); unmatched[field.key] = [...(unmatched[field.key] ?? []), t]; }
  }
  if (chosen.length === 0) return undefined;
  return field.multi ? [...new Set(chosen)] : chosen[0];
}

function coerceList(raw: unknown, field: ContractField): unknown {
  if (!field.multi) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first !== "string" && typeof first !== "number") return undefined;
    const t = normalizeTag(String(first), field.normalize);
    return t ? t : undefined;
  }
  // Flatten nested arrays (`[["a"], "b"]`) — small models nest list values.
  const parts = Array.isArray(raw) ? raw.flat(Infinity) : String(raw).split(/[/,;]|\s+and\s+/i);
  const tags: string[] = [];
  for (const part of parts) {
    // Never stringify objects ("[object Object]") — drop them instead.
    if (typeof part !== "string" && typeof part !== "number") continue;
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
