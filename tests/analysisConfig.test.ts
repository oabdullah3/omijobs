import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadAnalysisSettings,
  saveAnalysisSettings,
  providerApiKeyStatus,
  writeProviderApiKey,
  toPublicSettings,
  validateContract,
  validateField,
  AnalysisProviderConfig,
  AnalysisSettings,
  AnalysisSettingsPublic,
  AnalysisRunStatus,
} from "../src/analysisConfig.js";
import * as fs from "node:fs";
import * as path from "node:path";

const pkgDir = path.resolve(".");
const stateDir = path.join(pkgDir, ".analysis-state-test");

beforeEach(() => {
  // Clean up state dir before each test
  const statePath = path.join(pkgDir, ".analysis-state-test");
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { recursive: true, force: true });
  }
});

afterEach(() => {
  // Clean up after each test
  const statePath = path.join(pkgDir, ".analysis-state-test");
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { recursive: true, force: true });
  }
  // Restore .env if it was modified
  const envPath = path.join(pkgDir, ".env");
  if (fs.existsSync(envPath)) {
    // Keep original .env content, just in case
  }
});

describe("AnalysisConfig - loadAnalysisSettings", () => {
  it("seeds settings from the bundled example and hides provider keys", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    expect(settings.providers[0].apiKeyEnv).toBe("OPENROUTER_API_KEY");
    const publicSettings = toPublicSettings(settings);
    expect(["set", "unset"]).toContain(publicSettings.providers[0].apiKeyStatus);
  });

  it("loads existing state settings when present", () => {
    // First, seed settings
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    saveAnalysisSettings(stateDir, settings);

    // Now load again - should return the same settings
    const loaded = loadAnalysisSettings(pkgDir, stateDir);
    expect(loaded.systemPrompt).toBe(settings.systemPrompt);
    expect(loaded.providers.length).toBe(settings.providers.length);
  });

  it("creates default settings when no example or state exists", () => {
    // Use a non-existent state dir to force default creation
    const defaultDir = path.join(pkgDir, ".analysis-state-nonexistent");
    const defaultSettings = loadAnalysisSettings(pkgDir, defaultDir);
    expect(defaultSettings.systemPrompt).toBeDefined();
    expect(defaultSettings.providers).toBeInstanceOf(Array);
    expect(defaultSettings.schemaVersion).toBe(1);
  });

  it("migrates legacy v0 settings (no schemaVersion/fields) preserving providers", () => {
    const legacyDir = path.join(pkgDir, ".analysis-state-legacy");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "analysis.json"),
      JSON.stringify({
        systemPrompt: "You are a helpful assistant.",
        recommendedThreshold: 6,
        descriptionMaxChars: 4000,
        enabledProvider: "openrouter",
        providers: [
          {
            id: "openrouter",
            name: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openrouter/auto",
            apiKeyEnv: "OPENROUTER_API_KEY",
            temperature: 0.2,
            maxTokens: 400,
            timeoutMs: 60000,
            retries: 3,
            retryBackoffMs: 2000,
          },
        ],
      }),
    );
    const settings = loadAnalysisSettings(pkgDir, legacyDir);
    expect(settings.schemaVersion).toBe(1);
    expect(settings.enabledProvider).toBe("openrouter");
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0].id).toBe("openrouter");
    expect(settings.systemPrompt).toBe("You are a helpful assistant.");
    expect(settings.fields.length).toBeGreaterThan(0);
    // The migrated file is re-saved in the new shape.
    const saved = JSON.parse(fs.readFileSync(path.join(legacyDir, "analysis.json"), "utf8"));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.fields.length).toBeGreaterThan(0);
    expect(saved.recommendedThreshold).toBeUndefined();
  });

  it("replaces the legacy score-based system prompt during migration", () => {
    const legacyDir = path.join(pkgDir, ".analysis-state-legacy-prompt");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "analysis.json"),
      JSON.stringify({
        systemPrompt: 'You are a job-matching evaluator. The user\'s instructions describe exactly what they want in a job. Score each posting 0-10 and return {"score": 0, "reason": "..."}.',
        descriptionMaxChars: 4000,
        enabledProvider: "openrouter",
        providers: [
          {
            id: "openrouter",
            name: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openrouter/auto",
            apiKeyEnv: "OPENROUTER_API_KEY",
            temperature: 0.2,
            maxTokens: 400,
            timeoutMs: 60000,
            retries: 3,
            retryBackoffMs: 2000,
          },
        ],
      }),
    );
    const settings = loadAnalysisSettings(pkgDir, legacyDir);
    expect(settings.systemPrompt).toContain("job-description extractor");
    expect(settings.systemPrompt).not.toContain("job-matching evaluator");
    expect(settings.enabledProvider).toBe("openrouter");
    expect(settings.fields.length).toBeGreaterThan(0);
    const saved = JSON.parse(fs.readFileSync(path.join(legacyDir, "analysis.json"), "utf8"));
    expect(saved.systemPrompt).toContain("job-description extractor");
  });

  it("repairs a v1 file that still carries the legacy score-based prompt", () => {
    const dir = path.join(pkgDir, ".analysis-state-stale-prompt");
    fs.mkdirSync(dir, { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(pkgDir, "analysis.config.base.json"), "utf8"));
    fs.writeFileSync(
      path.join(dir, "analysis.json"),
      JSON.stringify({
        schemaVersion: 1,
        systemPrompt: "You are a job-matching evaluator. Score each posting 0-10 and return a score and reason.",
        descriptionMaxChars: 4000,
        enabledProvider: null,
        providers: [],
        fields: base.fields,
      }),
    );
    const settings = loadAnalysisSettings(pkgDir, dir);
    expect(settings.systemPrompt).toContain("job-description extractor");
    expect(settings.systemPrompt).not.toContain("job-matching evaluator");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "analysis.json"), "utf8"));
    expect(saved.systemPrompt).toContain("job-description extractor");
  });
});

describe("AnalysisConfig - saveAnalysisSettings", () => {
  it("atomically saves settings and can reload them", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    saveAnalysisSettings(stateDir, settings);

    // Verify file exists
    const settingsPath = path.join(stateDir, "analysis.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    // Reload and verify
    const reloaded = loadAnalysisSettings(pkgDir, stateDir);
    expect(reloaded.systemPrompt).toBe(settings.systemPrompt);
  });

  it("creates state directory if it doesn't exist", () => {
    const tempDir = path.join(pkgDir, ".analysis-state-new-dir");
    const settings = {
      systemPrompt: "Test prompt",
      schemaVersion: 1,
      fields: [],
      descriptionMaxChars: 3000,
      enabledProvider: "openrouter",
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "anthropic/claude-3.5-sonnet",
          apiKeyEnv: "OPENROUTER_API_KEY",
          temperature: 0.3,
          maxTokens: 4000,
          timeoutMs: 30000,
          retries: 3,
          retryBackoffMs: 2000,
        },
      ],
    };

    saveAnalysisSettings(tempDir, settings);
    const settingsPath = path.join(tempDir, "analysis.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    const reloaded = loadAnalysisSettings(pkgDir, tempDir);
    expect(reloaded.systemPrompt).toBe("Test prompt");
  });
});

describe("AnalysisConfig - providerApiKeyStatus", () => {
  it("returns 'set' when env var is present", () => {
    // Set a test env var
    process.env.TEST_API_KEY = "sk-test-123";
    const provider: AnalysisProviderConfig = {
      id: "test",
      name: "Test",
      baseUrl: "https://api.test.com",
      model: "gpt-4",
      apiKeyEnv: "TEST_API_KEY",
      temperature: 0.5,
      maxTokens: 1000,
      timeoutMs: 5000,
      retries: 2,
      retryBackoffMs: 2000,
    };

    const status = providerApiKeyStatus(provider, stateDir);
    expect(status).toBe("set");

    delete process.env.TEST_API_KEY;
  });

  it("returns 'unset' when env var is not present", () => {
    const provider: AnalysisProviderConfig = {
      id: "test",
      name: "Test",
      baseUrl: "https://api.test.com",
      model: "gpt-4",
      apiKeyEnv: "NONEXISTENT_KEY",
      temperature: 0.5,
      maxTokens: 1000,
      timeoutMs: 5000,
      retries: 2,
      retryBackoffMs: [1000, 2000],
    };

    const status = providerApiKeyStatus(provider, stateDir);
    expect(status).toBe("unset");
  });
});

describe("AnalysisConfig - writeProviderApiKey", () => {
  beforeEach(() => {
    // Ensure the state-dir .env exists with no OPENROUTER_API_KEY
    const envPath = path.join(stateDir, ".env");
    if (fs.existsSync(envPath)) {
      fs.rmSync(envPath);
    }
  });

  it("writes a new API key line to .env", () => {
    const provider: AnalysisProviderConfig = {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      apiKeyEnv: "OPENROUTER_API_KEY",
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 30000,
      retries: 3,
      retryBackoffMs: 2000,
    };

    writeProviderApiKey(provider, "sk-or-test-key-123", stateDir);

    const envPath = path.join(stateDir, ".env");
    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("OPENROUTER_API_KEY=sk-or-test-key-123");
  });

  it("replaces existing API key line in .env", () => {
    // First write a key
    const provider: AnalysisProviderConfig = {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      apiKeyEnv: "OPENROUTER_API_KEY",
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 30000,
      retries: 3,
      retryBackoffMs: 2000,
    };

    writeProviderApiKey(provider, "first-key", stateDir);
    writeProviderApiKey(provider, "second-key", stateDir);

    const envPath = path.join(stateDir, ".env");
    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("OPENROUTER_API_KEY=second-key");
    // Should only have one line with the key
    const lines = envContent.split("\n").filter((l) => l.trim());
    const keyLines = lines.filter((l) => l.startsWith("OPENROUTER_API_KEY="));
    expect(keyLines.length).toBe(1);
  });
});

describe("AnalysisConfig - AnalysisSettingsPublic projection", () => {
  it("exposes only apiKeyStatus and never the actual key value", () => {
    const settings: AnalysisSettings = {
      schemaVersion: 1,
      systemPrompt: "Test prompt",
      fields: [],
      descriptionMaxChars: 5000,
      enabledProvider: "openrouter",
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "anthropic/claude-3.5-sonnet",
          apiKeyEnv: "OPENROUTER_API_KEY",
          temperature: 0.3,
          maxTokens: 4000,
          timeoutMs: 30000,
          retries: 3,
          retryBackoffMs: 2000,
        },
      ],
    };

    const publicSettings = toPublicSettings(settings);

    expect(publicSettings.schemaVersion).toBe(1);
    expect(publicSettings.systemPrompt).toBe("Test prompt");
    expect(publicSettings.fields).toEqual([]);
    expect(publicSettings.descriptionMaxChars).toBe(5000);
    expect(publicSettings.enabledProvider).toBe("openrouter");
    expect(publicSettings.providers.length).toBe(1);

    // apiKeyStatus should be "set" or "unset" (depends on process.env)
    expect(["set", "unset"]).toContain(publicSettings.providers[0].apiKeyStatus);
    // Should NOT contain the actual apiKeyEnv value
    expect(publicSettings.providers[0].apiKeyStatus).not.toBe("OPENROUTER_API_KEY");
  });

  it("handles null enabledProvider", () => {
    const settings: AnalysisSettings = {
      schemaVersion: 1,
      systemPrompt: "Test prompt",
      fields: [],
      descriptionMaxChars: 5000,
      enabledProvider: null,
      providers: [],
    };

    const publicSettings = toPublicSettings(settings);
    expect(publicSettings.enabledProvider).toBeNull();
    expect(publicSettings.providers).toHaveLength(0);
  });
});

describe("AnalysisConfig - AnalysisRunStatus enum", () => {
  it("has all expected status values", () => {
    expect(AnalysisRunStatus.Pending).toBe("pending");
    expect(AnalysisRunStatus.Running).toBe("running");
    expect(AnalysisRunStatus.Completed).toBe("completed");
    expect(AnalysisRunStatus.Failed).toBe("failed");
  });
});

describe("validateField", () => {
  it("accepts a valid enum and list field", () => {
    expect(validateField({ key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] })).toEqual({ key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] });
    expect(validateField({ key: "skills", kind: "list", multi: true, normalize: "lower" })).toEqual({ key: "skills", kind: "list", multi: true, normalize: "lower" });
  });
  it("rejects bad keys, kinds, and enum-without-values", () => {
    expect(() => validateField({ key: "Bad Key", kind: "list" })).toThrow(/snake_case/);
    expect(() => validateField({ key: "x", kind: "nope" })).toThrow(/invalid kind/);
    expect(() => validateField({ key: "x", kind: "enum" })).toThrow(/values/);
    expect(() => validateField({ key: "x", kind: "list", values: ["a"] })).toThrow(/only allowed on enum/);
  });
});

describe("validateContract", () => {
  it("rejects duplicate field keys and non-positive schemaVersion", () => {
    expect(() => validateContract({ schemaVersion: 0, fields: [] })).toThrow(/positive integer/);
    expect(() => validateContract({ schemaVersion: 1, fields: [{ key: "a", kind: "list" }, { key: "a", kind: "list" }] })).toThrow(/unique/);
  });
  it("round-trips a valid contract", () => {
    const contract = validateContract({ schemaVersion: 2, fields: [{ key: "salary", kind: "range", currency: "HKD", period: "monthly" }] });
    expect(contract.schemaVersion).toBe(2);
    expect(contract.fields[0].currency).toBe("HKD");
  });
});

describe("AnalysisConfig - extraction contract settings", () => {
  it("seeds schemaVersion and fields from the bundled base config", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    expect(settings.schemaVersion).toBe(1);
    expect(settings.fields.length).toBeGreaterThan(0);
    expect(settings.fields.some((f) => f.key === "employment_type")).toBe(true);
    expect(settings).not.toHaveProperty("recommendedThreshold");
  });
  it("exposes schemaVersion and fields publicly", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    const pub = toPublicSettings(settings);
    expect(pub.schemaVersion).toBe(1);
    expect(pub.fields.length).toBe(settings.fields.length);
    expect(pub).not.toHaveProperty("recommendedThreshold");
  });
});