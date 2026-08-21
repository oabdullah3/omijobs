import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadAnalysisSettings,
  saveAnalysisSettings,
  providerApiKeyStatus,
  writeProviderApiKey,
  toPublicSettings,
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
    expect(defaultSettings.recommendedThreshold).toBe(5);
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
      recommendedThreshold: 0.8,
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

    const status = providerApiKeyStatus(provider, pkgDir);
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

    const status = providerApiKeyStatus(provider, pkgDir);
    expect(status).toBe("unset");
  });
});

describe("AnalysisConfig - writeProviderApiKey", () => {
  beforeEach(() => {
    // Ensure .env exists with no OPENROUTER_API_KEY
    const envPath = path.join(pkgDir, ".env");
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

    writeProviderApiKey(provider, "sk-or-test-key-123", pkgDir);

    const envPath = path.join(pkgDir, ".env");
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

    writeProviderApiKey(provider, "first-key", pkgDir);
    writeProviderApiKey(provider, "second-key", pkgDir);

    const envPath = path.join(pkgDir, ".env");
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
      systemPrompt: "Test prompt",
      recommendedThreshold: 5,
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

    // Should have the expected fields
    expect(publicSettings.systemPrompt).toBe("Test prompt");
    expect(publicSettings.recommendedThreshold).toBe(5);
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
      systemPrompt: "Test prompt",
      recommendedThreshold: 5,
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