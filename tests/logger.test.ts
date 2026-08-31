import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, errorData, queryLogs, logMeta } from "../src/logger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omijobs-log-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createLogger", () => {
  it("appends one JSON line to the daily file with the right fields", () => {
    const log = createLogger({ source: "gateway" }, dir);
    log.info("gateway.started", "gateway started", { count: 3 });
    const file = join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
    expect(line.source).toBe("gateway");
    expect(line.event).toBe("gateway.started");
    expect(line.level).toBe("info");
    expect(line.message).toBe("gateway started");
    expect(line.data).toEqual({ count: 3 });
    expect(line.pid).toBe(process.pid);
    expect(line.runId).toBeNull();
    expect(typeof line.ts).toBe("string");
  });

  it("carries runId/jobId from context and child()", () => {
    const log = createLogger({ source: "run", runId: "r1" }, dir);
    log.child({ jobId: "finance" }).warn("run.stopped", "stopped");
    const { events } = queryLogs({}, dir);
    expect(events[0].runId).toBe("r1");
    expect(events[0].jobId).toBe("finance");
    expect(events[0].level).toBe("warn");
  });

  it("never throws on an unwritable directory", () => {
    const log = createLogger({ source: "dashboard" }, "\0invalid\0");
    expect(() => log.error("dashboard.error", "boom", errorData(new Error("x")))).not.toThrow();
  });

  it("errorData captures the error message and stack", () => {
    const data = errorData(new Error("kaput"));
    expect(data.error).toBe("kaput");
    expect(typeof data.stack).toBe("string");
  });
});

describe("queryLogs and logMeta", () => {
  it("filters by source, level, and free text", () => {
    const log = createLogger({ source: "gateway" }, dir);
    const run = createLogger({ source: "run", runId: "r1", jobId: "finance" }, dir);
    log.info("gateway.started", "booted");
    run.warn("run.stopped", "stopped early");
    run.error("run.error", "boom", errorData(new Error("db down")));

    expect(queryLogs({ source: "run" }, dir).total).toBe(2);
    expect(queryLogs({ level: "warn" }, dir).total).toBe(1);
    expect(queryLogs({ q: "db down" }, dir).total).toBe(1);
    expect(queryLogs({ runId: "r1" }, dir).total).toBe(2);
    expect(queryLogs({ source: ["gateway", "run"] }, dir).total).toBe(3);
  });

  it("honors from/to and returns newest-first", () => {
    const log = createLogger({ source: "gateway" }, dir);
    log.info("a", "one");
    log.info("b", "two");
    const { events, total } = queryLogs({ limit: 1 }, dir);
    expect(total).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("b");
  });

  it("logMeta reports sources, levels, counts, and recent ids", () => {
    const run = createLogger({ source: "run", runId: "r1", jobId: "finance" }, dir);
    run.info("run.started", "go");
    run.error("run.error", "bad");
    const meta = logMeta(dir);
    expect(meta.sources).toEqual(["run"]);
    expect(meta.levels.sort()).toEqual(["error", "info"]);
    expect(meta.counts.run.info).toBe(1);
    expect(meta.counts.run.error).toBe(1);
    expect(meta.recentRunIds).toEqual(["r1"]);
    expect(meta.recentJobIds).toEqual(["finance"]);
  });
});
