import type { AnalysisProviderConfig } from "./types.js";
import type { Logger } from "./logger.js";

export interface ScoreReason { score: number; reason: string; }
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

export function extractScoreReason(content: unknown): ScoreReason | null {
  if (typeof content !== "string") return null;
  const withoutFences = content.replace(/```(?:json)?/gi, "");
  const object = balancedObject(withoutFences);
  if (!object) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(object) as Record<string, unknown>; } catch { return null; }
  const rawScore = typeof parsed.score === "number" ? parsed.score : typeof parsed.score === "string" && parsed.score.trim() !== "" ? Number(parsed.score) : NaN;
  if (!Number.isFinite(rawScore) || typeof parsed.reason !== "string" || parsed.reason.trim() === "") return null;
  return { score: Math.max(0, Math.min(10, Math.round(rawScore))), reason: parsed.reason.trim() };
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
