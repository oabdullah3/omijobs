import { describe, expect, it, vi } from "vitest";
import { AuthConfigError, TransientProviderError, callProvider, extractContract } from "../src/analysisProvider.js";
import type { AnalysisProviderConfig, ExtractionContract } from "../src/types.js";

const provider: AnalysisProviderConfig = {
  id: "test", name: "Test", baseUrl: "https://example.test/v1", model: "test-model", apiKeyEnv: "TEST_KEY",
  temperature: 0.2, maxTokens: 400, timeoutMs: 1000, retries: 2, retryBackoffMs: 1,
};
const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const contract: ExtractionContract = {
  schemaVersion: 1,
  fields: [
    { key: "employment_type", kind: "enum", multi: false, values: ["full-time", "part-time", "contract"] },
    { key: "skills", kind: "list", multi: true, normalize: "lower" },
    { key: "salary", kind: "range", currency: "HKD", period: "monthly" },
    { key: "years_experience", kind: "range", unit: "years" },
    { key: "job_start_date", kind: "date" },
  ],
};

describe("extractContract", () => {
  it("coerces enum, list, range, and date; omits absent fields", () => {
    const result = extractContract('```json\n{"employment_type":"Full-Time","skills":"SQL, Excel and Python","salary":{"min":"38000","max":45000},"job_start_date":"2026-09-01"}\n```', contract);
    expect(result).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql", "excel", "python"], salary: { min: 38000, max: 45000 }, job_start_date: "2026-09-01" });
  });
  it("buckets unknown enum values to other and records unmatched", () => {
    const result = extractContract('{"employment_type":"freelance"}', contract);
    expect(result).toEqual({ schemaVersion: 1, employment_type: "other", unmatched: { employment_type: ["freelance"] } });
  });
  it("returns schemaVersion-only for zero recognized fields (done, not failed)", () => {
    expect(extractContract('{"nothing":"here"}', contract)).toEqual({ schemaVersion: 1 });
    expect(extractContract('{}', contract)).toEqual({ schemaVersion: 1 });
  });
  it("returns null for malformed output", () => {
    expect(extractContract("no json", contract)).toBeNull();
    expect(extractContract(123 as unknown, contract)).toBeNull();
  });
  it("drops invalid range values and non-ISO dates", () => {
    expect(extractContract('{"salary":{"min":-5,"max":10},"job_start_date":"not-a-date"}', contract)).toEqual({ schemaVersion: 1, salary: { max: 10 } });
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
