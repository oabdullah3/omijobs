import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalysis } from "../src/analysis.js";
import type { AnalysisProviderConfig } from "../src/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const provider: AnalysisProviderConfig = { id: "test", name: "Test", baseUrl: "https://example.test", model: "model", apiKeyEnv: "KEY", temperature: 0.2, maxTokens: 10, timeoutMs: 1000, retries: 0, retryBackoffMs: 1 };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-loop-")); const file = join(dir, "jobs.db"); const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const add = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("new", "2026-08-20", JSON.stringify({ title: "New", description: "long description" }), "unapplied", null, "c", "u");
  add.run("old", "2020-01-01", JSON.stringify({ title: "Old" }), "unapplied", null, "c", "u");
  add.run("skip", "2026-08-19", JSON.stringify({ title: "Skip" }), "unapplied", JSON.stringify({ score: 9, reason: "already" }), "c", "u");
  add.run("bad", "2026-08-18", JSON.stringify({ title: "Bad" }), "unapplied", null, "c", "u");
  db.close(); return { dir, file };
}
const base = (file: string, callProvider: (messages: any[]) => Promise<string>, aborted?: () => boolean) => ({ file, instructions: "remote internship", systemPrompt: "evaluate", descriptionMaxChars: 5, retentionDays: 30, threshold: 5, provider, callProvider, now: () => new Date("2026-08-21"), aborted });

describe("runAnalysis", () => {
  it("analyzes, skips, deletes expired, fails malformed, and reports progress", async () => {
    const { dir, file } = await fixture(); const lines: string[] = [];
    try {
      const summary = await runAnalysis({ ...base(file, async (messages) => { expect(messages[1].content).toContain("remote internship"); expect(messages[1].content).toContain("long "); return JSON.stringify({ score: 8, reason: "good" }); }), progress: { line: (line) => lines.push(line), result: (line) => lines.push(`result:${line}`) } });
      expect(summary).toMatchObject({ outcome: "completed", analyzed: 1, skipped: 1, deleted: 1, failed: 1, recommended: 1 });
      expect(lines.at(-1)).toContain("analyzed 1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("stops between rows and aborts on auth/config errors", async () => {
    const first = await fixture();
    try {
      let calls = 0;
      const summary = await runAnalysis(base(first.file, async () => { calls++; return JSON.stringify({ score: 1, reason: "x" }); }, () => calls > 0));
      expect(summary.outcome).toBe("stopped");
    } finally { await rm(first.dir, { recursive: true, force: true }); }
  });
});
