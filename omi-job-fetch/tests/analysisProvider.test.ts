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
  it("recovers single-quoted keys and values", () => {
    expect(extractContract("{'employment_type':'full-time','skills':['SQL', 'Excel']}", contract)).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql", "excel"] });
  });
  it("recovers trailing commas and unquoted keys", () => {
    expect(extractContract("{employment_type: \"full-time\", skills: [\"SQL\",],}", contract)).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql"] });
  });
  it("recovers prose-wrapped sloppy JSON", () => {
    expect(extractContract("Sure! Here's the result: {'salary': {'min': 38000, 'max': 45000,},}", contract)).toEqual({ schemaVersion: 1, salary: { min: 38000, max: 45000 } });
  });
  it("still returns null when the recovery fails", () => {
    expect(extractContract("no json at all here", contract)).toBeNull();
    expect(extractContract("{'unterminated': ", contract)).toBeNull();
  });
  it("drops object values from list fields instead of stringifying them", () => {
    expect(extractContract('{"skills": [{"name": "python"}, "SQL"]}', contract)).toEqual({ schemaVersion: 1, skills: ["sql"] });
  });
  it("drops object values from enum fields", () => {
    expect(extractContract('{"employment_type": {"kind": "full-time"}}', contract)).toEqual({ schemaVersion: 1 });
  });
  it("decodes html entities in extracted values", () => {
    expect(extractContract('{"skills": ["r&amp;d", "women&#39;s health"]}', contract)).toEqual({ schemaVersion: 1, skills: ["r&d", "women's health"] });
  });
  it("folds spaced and punctuated enum variants onto hyphenated values", () => {
    expect(extractContract('{"employment_type": "Full Time"}', contract)).toEqual({ schemaVersion: 1, employment_type: "full-time" });
    expect(extractContract('{"employment_type": "part-time."}', contract)).toEqual({ schemaVersion: 1, employment_type: "part-time" });
    expect(extractContract('{"employment_type": "freelance"}', contract).unmatched).toEqual({ employment_type: ["freelance"] });
  });
  it("recovers duplicate closing brackets (orphan `],`)", () => {
    expect(extractContract('{"employment_type": ["full-time"], ], "skills": ["SQL", "Python"],}', contract)).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql", "python"] });
  });
  it("recovers unclosed strings", () => {
    expect(extractContract('{"skills": [\n    "SQL\n  ],\n  "employment_type": "full-time"\n}', contract)).toEqual({ schemaVersion: 1, skills: ["sql"], employment_type: "full-time" });
  });
  it("recovers duplicated `\": [` tokens", () => {
    expect(extractContract('{"skills": [": [\n    "SQL",\n    "Python"\n  ],\n  "employment_type": "full-time"\n}', contract)).toEqual({ schemaVersion: 1, skills: ["sql", "python"], employment_type: "full-time" });
  });
  it("recovers missing colons in keys", () => {
    expect(extractContract('{"skills: [\n    "SQL"\n  ]\n}', contract)).toEqual({ schemaVersion: 1, skills: ["sql"] });
  });
  it("recovers stray tokens inside arrays", () => {
    expect(extractContract('{"skills": [f&b]": [\n    "SQL"\n  ]\n}', contract)).toEqual({ schemaVersion: 1, skills: ["sql"] });
  });
  it("flattens nested arrays in list fields", () => {
    expect(extractContract('{"skills": [[ "SQL", "Python" ], "Java"]}', contract)).toEqual({ schemaVersion: 1, skills: ["sql", "python", "java"] });
  });
  it("recovers broken JSON embedded after thinking prose", () => {
    expect(extractContract("Here's a thinking process: 1. Analyze the Request. 2. Output JSON. {\"employment_type\": \"Full Time\", \"skills\": [\"SQL\",]}, done", contract)).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql"] });
  });
  it("salvages range objects from unparseable output", () => {
    expect(extractContract('garbage {"salary": {min: 38000, max: 45000}', contract)).toEqual({ schemaVersion: 1, salary: { min: 38000, max: 45000 } });
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
