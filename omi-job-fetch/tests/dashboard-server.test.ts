import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboardServer.js";
import { createLogger } from "../src/logger.js";

const NOW = "2026-08-19T12:00:00.000Z";

// A stub "cli" the dashboard treats as the real one: it echoes cron mutations,
// and for `run` mimics the real CLI lifecycle — writes a run.json into the
// config's outputDir (so /api/runs has something to list), writes the running
// marker + a progress line at start, holds the marker ~2s so a restarted
// dashboard can observe the run in flight, then writes a result line and clears
// the marker (like the CLI's finally block) before exiting.
const STUB_CLI = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
console.log("stub " + args.join(" "));
console.log("trigger=" + (process.env.OMI_JOB_FETCH_TRIGGER || ""));
const marker = process.env.OMI_JOB_FETCH_RUN_MARKER;
const progress = process.env.OMI_JOB_FETCH_PROGRESS_FILE;
if (marker) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}
if (progress) {
  fs.mkdirSync(path.dirname(progress), { recursive: true });
  fs.writeFileSync(progress, "  stub · working\\n");
}
if (args[0] === "run") {
  const cfgPath = args[args.indexOf("--config") + 1];
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const out = path.resolve(cfg.outputDir ?? "output");
  const runs = path.join(out, "runs", "20260819-000000-test");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, "run.json"), JSON.stringify({
    id: "20260819-000000-test",
    startedAt: ${JSON.stringify(NOW)},
    durationMs: 5,
    jobs: 1,
    trigger: process.env.OMI_JOB_FETCH_TRIGGER,
    adapters: [{ adapter: "stub", status: "ok", jobCount: 1, durationMs: 5 }],
  }));
}
if (!marker) process.exit(0); // cron mutations: exit fast
// Hold the marker so a restarted dashboard observes the run in flight, then
// finalize like the real CLI's finally block.
setTimeout(() => {
  if (progress) fs.appendFileSync(progress, "result: 1 jobs, 0 dropped, 0 deduped\\n");
  if (marker) fs.rmSync(marker, { force: true });
  process.exit(0);
}, 2000);
`;

const BASE_CONFIG = {
  global: { queries: ["finance intern"] },
  portals: { enabled: ["gradconnection"], config: {} },
  ats: { enabled: [], config: {} },
  outputDir: "output", // replaced with an absolute temp path per test
  db: { enabled: true, file: "jobs.db", retentionDays: 30 },
};

async function makeEnv(): Promise<{ dir: string; pkg: string; cronFile: string; stateDir: string; cliPath: string; server: Awaited<ReturnType<typeof startDashboard>> }> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-server-"));
  const pkg = join(dir, "pkg");
  await mkdir(pkg, { recursive: true });
  await mkdir(join(pkg, "dashboard"), { recursive: true });
  await mkdir(join(pkg, "dashboard.configs", "realtime"), { recursive: true }); // writeFile does not create parents
  await writeFile(join(pkg, "dashboard.configs", "realtime", "config.json"), JSON.stringify({ ...BASE_CONFIG, outputDir: join(dir, "output") }));
  await writeFile(join(pkg, "cron.json"), JSON.stringify({
    paused: false,
    jobs: [{ id: "finance", config: "dashboard.configs/cron/finance.config.json", schedule: "every 6 hours", enabled: true, lastRun: "2026-08-19T06:00:00.000Z", lastStatus: "ok" }],
  }));
  await mkdir(join(pkg, "dashboard.configs", "cron"), { recursive: true });
  await writeFile(join(pkg, "dashboard.configs", "cron", "finance.config.json"), JSON.stringify({ ...BASE_CONFIG, outputDir: join(dir, "output") }));
  await writeFile(join(pkg, "dashboard", "index.html"), "<h1>omijobs</h1>");
  const cliPath = join(dir, "cli-stub.cjs");
  await writeFile(cliPath, STUB_CLI);
  const stateDir = join(dir, "state");
  const server = await startDashboard({ port: 0, packageDir: pkg, stateDir, cliPath, openBrowser: false, now: () => new Date(NOW) });
  return { dir, pkg, cronFile: join(pkg, "cron.json"), stateDir, cliPath, server };
}

describe("dashboard server", () => {
  it("serves the static shell at /", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("omijobs");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/bootstrap returns the environment and adapter registry", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/bootstrap");
      const body = await res.json();
      expect(body.packageDir).toContain("pkg");
      expect(body.port).toBe(env.server.port);
      expect(Array.isArray(body.adapters)).toBe(true);
      expect(body.adapters[0]).toHaveProperty("id");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/configs lists base + cron configs with db info", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/configs");
      const body = await res.json();
      expect(body.map((c: { id: string }) => c.id)).toEqual(["base", "finance"]);
      expect(body[0].db.enabled).toBe(true);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("PUT /api/configs/base applies a friendly update and flags a disabled DB", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/configs/base", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: ["grad"], dbEnabled: false }),
      });
      const body = await res.json();
      expect(body.dbWarning).toBe(true);
      expect(body.config.queries).toEqual(["grad"]);
      expect(body.config.db.enabled).toBe(false);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("PUT /api/configs/base merges friendly fields on top of raw JSON", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/configs/base", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          raw: {
            global: { queries: ["intern"] },
            portals: { enabled: ["greenhouse"], config: {} },
            ats: { enabled: [], config: {} },
            outputDir: "output",
            db: { enabled: true, file: "jobs.db", retentionDays: 30 },
          },
          queries: ["grad", "intern"],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The changed form field (queries) overrides the raw JSON…
      expect(body.config.queries).toEqual(["grad", "intern"]);
      // …but everything the form didn't touch comes from the raw JSON verbatim.
      const written = await (await fetch(env.server.url + "/api/configs/base")).json();
      expect(written.config.portals.enabled).toEqual(["greenhouse"]);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/configs/base returns the full raw config for the advanced editor", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/configs/base");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toBeDefined();
      expect(body.config.global.queries).toEqual(["finance intern"]);
      expect(body.config.db.enabled).toBe(true);
      const miss = await fetch(env.server.url + "/api/configs/nope");
      expect(miss.status).toBe(404);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/configs/base/run spawns the CLI and surfaces the run in /api/runs", async () => {
    const env = await makeEnv();
    try {
      const runRes = await fetch(env.server.url + "/api/configs/base/run", { method: "POST" });
      const runBody = await runRes.json();
      expect(runBody.ok).toBe(true);
      expect(runBody.runId).toBeTruthy();
      // The stub writes run.json synchronously; poll briefly.
      let runs: { id: string }[] = [];
      for (let i = 0; i < 20; i++) {
        runs = (await (await fetch(env.server.url + "/api/runs")).json()) as { id: string }[];
        if (runs.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(runs.map((r) => r.id)).toContain("20260819-000000-test");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/configs/:id/stop writes the stop marker for a running job and 409s otherwise", async () => {
    const env = await makeEnv();
    try {
      // Prove the job is "running" via a live-PID run marker (the test process
      // is alive) — the same way the server reattaches to an in-flight run.
      const runs = join(env.stateDir, "runs");
      await mkdir(runs, { recursive: true });
      await writeFile(join(runs, "finance.running"), JSON.stringify({ pid: process.pid, startedAt: NOW }));
      const res = await fetch(env.server.url + "/api/configs/finance/stop", { method: "POST" });
      expect(res.status).toBe(200);
      expect(existsSync(join(env.stateDir, "runs", "finance.stop"))).toBe(true);
      // A config with no run in progress is rejected with 409.
      const nope = await fetch(env.server.url + "/api/configs/base/stop", { method: "POST" });
      expect(nope.status).toBe(409);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("reattaches to an orphaned run across a dashboard restart via the running marker", async () => {
    const env = await makeEnv();
    try {
      const runRes = await fetch(env.server.url + "/api/configs/base/run", { method: "POST" });
      expect(runRes.status).toBe(200);
      // A fresh dashboard on the same stateDir is a faithful restart — its
      // in-memory inflight set is empty, so only the PID-verified marker can
      // show the run as still running.
      const restarted = await startDashboard({ port: 0, packageDir: env.pkg, stateDir: env.stateDir, cliPath: env.cliPath, openBrowser: false, now: () => new Date(NOW) });
      try {
        let body: Record<string, { running: boolean; result: string | null }> = {};
        for (let i = 0; i < 40; i++) {
          body = (await (await fetch(restarted.url + "/api/run/status")).json()) as typeof body;
          if (body["base"]?.running) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(body["base"].running).toBe(true);
        // Once the orphan finishes, its finally clears the marker and writes the
        // result line — the restarted dashboard flips to done.
        for (let i = 0; i < 80; i++) {
          body = (await (await fetch(restarted.url + "/api/run/status")).json()) as typeof body;
          if (!body["base"]?.running) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(body["base"].running).toBe(false);
        expect(body["base"].result).toContain("1 jobs");
      } finally {
        await restarted.close();
      }
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/run/status reads progress files into live/result entries keyed by config id", async () => {
    const env = await makeEnv();
    try {
      const runs = join(env.stateDir, "runs");
      await mkdir(runs, { recursive: true });
      await writeFile(join(runs, "finance.log"), "  gc · page 1/2 · 3 found\nresult: 3 jobs, 1 dropped, 0 deduped\n");
      const body = (await (await fetch(env.server.url + "/api/run/status")).json()) as Record<
        string,
        { running: boolean; lastLines: string[]; result: string | null }
      >;
      expect(body["finance"].running).toBe(false);
      expect(body["finance"].lastLines).toEqual(["  gc · page 1/2 · 3 found"]);
      expect(body["finance"].result).toBe("3 jobs, 1 dropped, 0 deduped");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/cron returns job states with running flags and countdowns", async () => {
    const env = await makeEnv();
    try {
      const body = await (await fetch(env.server.url + "/api/cron")).json();
      expect(body.jobs[0]).toMatchObject({ id: "finance", running: false });
      expect(body.jobs[0].nextRunAt).toBe("2026-08-19T12:00:00.000Z"); // overdue → now
      expect(body.gateway.running).toBe(false);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/cron/pause spawns the CLI and returns its output", async () => {
    const env = await makeEnv();
    try {
      const body = await (await fetch(env.server.url + "/api/cron/pause", { method: "POST" })).json();
      expect(body.ok).toBe(true);
      expect(body.output).toContain("stub cron pause");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/cron/add rejects a duplicate name with 409", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/cron/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "finance", schedule: "every 6 hours", storage: "separate" }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("finance");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/cron/add creates a config + job for a new unique name", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/cron/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New Intern", schedule: "every 6 hours", storage: "separate", queries: ["grad"] }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).output).toContain("dashboard.configs/cron/new-intern.config.json");
      // The config file lands in the fixed cron folder with the separate DB name.
      const cfgPath = join(env.pkg, "dashboard.configs", "cron", "new-intern.config.json");
      expect(existsSync(cfgPath)).toBe(true);
      expect(JSON.parse(readFileSync(cfgPath, "utf8")).db.file).toBe("new-intern.db");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("POST /api/cron/add rejects a name that would collide with the realtime config", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/cron/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Base", schedule: "every 6 hours", storage: "separate" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('"base"');
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("PATCH /api/jobs updates status; 400 for a bad status", async () => {
    const env = await makeEnv();
    try {
      const db = join(env.dir, "output", "jobs.db"); // the base config's outputDir
      // Seed the db with the same table shape as syncDb.
      const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      await mkdir(join(env.dir, "output"), { recursive: true });
      const sql = new DatabaseSync(db);
      sql.exec(`CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      sql.prepare("INSERT INTO jobs (signature, posted_at, job, status, analysis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("sig1", NOW, JSON.stringify({ title: "T", company: "C", location: "HK" }), "unapplied", null, NOW, NOW);
      sql.close();
      const res = await fetch(env.server.url + "/api/jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbKey: "base", signature: "sig1", status: "applied" }),
      });
      expect(res.status).toBe(200);
      const bad = await fetch(env.server.url + "/api/jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dbKey: "base", signature: "sig1", status: "nonsense" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("DELETE /api/dbs/:key requires typed confirmation and removes the file", async () => {
    const env = await makeEnv();
    try {
      const db = join(env.dir, "output", "jobs.db"); // the base config's outputDir
      const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      await mkdir(join(env.dir, "output"), { recursive: true });
      const sql = new DatabaseSync(db);
      sql.exec(`CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      sql.close();
      expect(existsSync(db)).toBe(true);

      const wrong = await fetch(env.server.url + "/api/dbs/base", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "nope" }),
      });
      expect(wrong.status).toBe(400);
      expect(existsSync(db)).toBe(true);

      const miss = await fetch(env.server.url + "/api/dbs/nope", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "nope" }),
      });
      expect(miss.status).toBe(404);

      const ok = await fetch(env.server.url + "/api/dbs/base", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "base" }),
      });
      expect(ok.status).toBe(200);
      expect(existsSync(db)).toBe(false);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/jobs/:dbKey/:signature returns the detail and 404s on miss", async () => {
    const env = await makeEnv();
    try {
      const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      await mkdir(join(env.dir, "output"), { recursive: true });
      const sql = new DatabaseSync(join(env.dir, "output", "jobs.db")); // the base config's outputDir
      sql.exec(`CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      sql.prepare("INSERT INTO jobs (signature, posted_at, job, status, analysis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("sig1", NOW, JSON.stringify({ title: "T" }), "unapplied", JSON.stringify({ fit: 0.5 }), NOW, NOW);
      sql.close();
      const hit = await fetch(env.server.url + "/api/jobs/base/sig1");
      expect(hit.status).toBe(200);
      expect((await hit.json()).analysis).toEqual({ fit: 0.5 });
      const miss = await fetch(env.server.url + "/api/jobs/base/nope");
      expect(miss.status).toBe(404);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("SSE /api/events pushes an event after a cron mutation", async () => {
    const env = await makeEnv();
    try {
      const ac = new AbortController();
      const res = await fetch(env.server.url + "/api/events", { signal: ac.signal });
      const reader = res.body!.getReader();
      await fetch(env.server.url + "/api/cron/pause", { method: "POST" });
      let buf = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        if (buf.includes('"type":"cron"')) break;
      }
      ac.abort();
      expect(buf).toContain('"type":"cron"');
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown API routes with 404", async () => {
    const env = await makeEnv();
    try {
      const res = await fetch(env.server.url + "/api/nope");
      expect(res.status).toBe(404);
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/logs returns filtered events and /api/logs/meta returns facets", async () => {
    const env = await makeEnv();
    try {
      const logger = createLogger({ source: "dashboard" }, join(env.stateDir, "logs"));
      logger.info("dashboard.run", "run base", { id: "base" });
      const logs = await (await fetch(`${env.server.url}/api/logs?source=dashboard`)).json();
      expect(logs.total).toBeGreaterThanOrEqual(1);
      expect(logs.events[0].source).toBe("dashboard");
      const meta = await (await fetch(`${env.server.url}/api/logs/meta`)).json();
      expect(meta.sources).toContain("dashboard");
    } finally {
      await env.server.close();
      await rm(env.dir, { recursive: true, force: true });
    }
  });
});
