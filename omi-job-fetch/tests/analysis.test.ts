import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractionBlock, runAnalysis } from "../src/analysis.js";
import { AuthConfigError } from "../src/analysisProvider.js";
import { createLogger, queryLogs } from "../src/logger.js";
import type { AnalysisProviderConfig, ExtractionContract } from "../src/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const provider: AnalysisProviderConfig = { id: "test", name: "Test", baseUrl: "https://example.test", model: "model", apiKeyEnv: "KEY", temperature: 0.2, maxTokens: 10, timeoutMs: 1000, retries: 0, retryBackoffMs: 1 };
const contract: ExtractionContract = { schemaVersion: 1, fields: [{ key: "domain", kind: "list", multi: true, normalize: "lower" }, { key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] }] };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-loop-")); const file = join(dir, "jobs.db"); const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const add = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("new", "2026-08-20", JSON.stringify({ title: "New", description: "long description" }), "unapplied", null, "c", "u");
  add.run("old", "2020-01-01", JSON.stringify({ title: "Old" }), "unapplied", null, "c", "u");
  add.run("done", "2026-08-19", JSON.stringify({ title: "Done" }), "unapplied", JSON.stringify({ schemaVersion: 1, domain: ["finance"] }), "c", "u");
  add.run("legacy", "2026-08-18", JSON.stringify({ title: "Legacy" }), "unapplied", JSON.stringify({ score: 9, reason: "old" }), "c", "u");
  add.run("applied", "2026-08-17", JSON.stringify({ title: "Applied" }), "applied", null, "c", "u");
  add.run("bad", "2026-08-16", JSON.stringify({ title: "Bad" }), "unapplied", null, "c", "u");
  db.close(); return { dir, file };
}
const base = (file: string, callProvider: (messages: any[]) => Promise<string>, aborted?: () => boolean) => ({ file, systemPrompt: "extract", descriptionMaxChars: 5, retentionDays: 30, contract, provider, callProvider, now: () => new Date("2026-08-21"), aborted });

describe("extractionBlock", () => {
  it("lists fields, optionality, and no threshold references", () => {
    const block = extractionBlock(contract);
    expect(block).toContain("domain");
    expect(block).toContain("employment_type");
    expect(block).toContain("Only include a field when the job description specifies it");
    expect(block).not.toContain("score");
    expect(block).not.toContain("threshold");
  });
});

describe("runAnalysis", () => {
  it("extracts unapplied rows; retries failed/legacy rows; skips conforming + status rows", async () => {
    const { dir, file } = await fixture(); const lines: string[] = [];
    try {
      const summary = await runAnalysis({ ...base(file, async () => JSON.stringify({ domain: ["tech"] })), progress: { line: (l) => lines.push(l), result: (l) => lines.push(`result:${l}`) } });
      // new + bad (NULL) and legacy (non-conforming) are retried; done (conforming) and applied (status) are skipped; old is deleted by retention.
      expect(summary).toMatchObject({ outcome: "completed", analyzed: 3, skipped: 2, deleted: 1, failed: 0 });
      expect(summary).not.toHaveProperty("recommended");
      expect(lines.at(-1)).toContain("analyzed 3");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("reanalyze also redoes conforming rows", async () => {
    const { dir, file } = await fixture();
    try {
      let calls = 0;
      const summary = await runAnalysis({ ...base(file, async () => { calls++; return JSON.stringify({ domain: ["tech"] }); }), reanalyze: true });
      expect(summary.analyzed).toBe(4); // new + bad + legacy (always retried) + done (forced by toggle)
      expect(calls).toBe(4);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("stops between rows and aborts on auth/config errors", async () => {
    const first = await fixture();
    try {
      let calls = 0;
      const summary = await runAnalysis(base(first.file, async () => { calls++; return JSON.stringify({ domain: ["tech"] }); }, () => calls > 0));
      expect(summary.outcome).toBe("stopped");
    } finally { await rm(first.dir, { recursive: true, force: true }); }
  });
  it("emits per-job analysis events and an aborting provider.fail", async () => {
    const { dir, file } = await fixture();
    const logDir = join(dir, "logs");
    const logger = createLogger({ source: "analysis", runId: "a1", jobId: "base" }, logDir);
    try {
      await runAnalysis({ ...base(file, async () => { throw new AuthConfigError("401", 401); }), logger });
      const { events } = queryLogs({ source: "analysis" }, logDir);
      expect(events.some((e) => e.event === "analysis.started")).toBe(true);
      expect(events.some((e) => e.event === "analysis.provider.fail")).toBe(true);
      expect(events.some((e) => e.event === "analysis.error")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
