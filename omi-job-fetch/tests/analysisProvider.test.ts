import { describe, expect, it, vi } from "vitest";
import { AuthConfigError, TransientProviderError, callProvider, extractScoreReason } from "../src/analysisProvider.js";
import type { AnalysisProviderConfig } from "../src/types.js";

const provider: AnalysisProviderConfig = {
  id: "test", name: "Test", baseUrl: "https://example.test/v1", model: "test-model", apiKeyEnv: "TEST_KEY",
  temperature: 0.2, maxTokens: 400, timeoutMs: 1000, retries: 2, retryBackoffMs: 1,
};
const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("extractScoreReason", () => {
  it("extracts fenced, surrounded, numeric-string output and clamps", () => {
    expect(extractScoreReason('before ```json\n{"score":"12.4","reason":" strong "}\n``` after')).toEqual({ score: 10, reason: "strong" });
    expect(extractScoreReason('{"score":-2,"reason":"poor"}')).toEqual({ score: 0, reason: "poor" });
  });
  it("rejects malformed or incomplete verdicts", () => {
    expect(extractScoreReason("no json")).toBeNull();
    expect(extractScoreReason('{"score":"x","reason":"bad"}')).toBeNull();
    expect(extractScoreReason('{"score":4,"reason":""}')).toBeNull();
  });
});

describe("callProvider", () => {
  it("sends the OpenAI-compatible request", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://example.test/v1/chat/completions");
      expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "test-model", temperature: 0.2, max_tokens: 400, stream: false });
      return ok("reply");
    });
    await expect(callProvider(provider, "secret", [{ role: "user", content: "ping" }], fetcher as typeof fetch)).resolves.toBe("reply");
  });
  it("aborts auth and malformed-body errors", async () => {
    await expect(callProvider(provider, "secret", [], vi.fn(async () => new Response("", { status: 401 })) as typeof fetch)).rejects.toBeInstanceOf(AuthConfigError);
    await expect(callProvider(provider, "secret", [], vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch)).rejects.toBeInstanceOf(AuthConfigError);
  });
  it("retries transient responses and then succeeds", async () => {
    let count = 0;
    const fetcher = vi.fn(async () => ++count === 1 ? new Response("busy", { status: 429 }) : ok("done"));
    const sleep = vi.fn(async () => {});
    await expect(callProvider(provider, "secret", [], fetcher as typeof fetch, sleep)).resolves.toBe("done");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });
  it("fails after transient retries", async () => {
    const fetcher = vi.fn(async () => new Response("busy", { status: 503 }));
    await expect(callProvider(provider, "secret", [], fetcher as typeof fetch, async () => {})).rejects.toBeInstanceOf(TransientProviderError);
  });
});
