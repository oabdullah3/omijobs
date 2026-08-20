# omijobs Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `omijobs dashboard` — a zero-build, in-process HTTP dashboard for the omijobs CLI: purely-DB jobs view, cron management + live visualization, friendly config editing, and dashboard-only docs, styled after the `the-stt-test-harness.html` design language.

**Architecture:** A Node `http` server started by `startDashboard()` and dispatched from `cli.ts` as `omijobs dashboard [--port N]` (foreground, Ctrl+C stops). The server reads state from files in-process (configs, cron.json, SQLite DBs, run.json) and performs *all mutations* by spawning `node <packageDir>/dist/cli.js cron <cmd>` (reusing the tested gateway/launch/wscript logic) — except config edits, which are written in-process with atomic temp+rename. Reactivity is a 2s stat-poll of cron.json + DB mtimes pushing SSE events, plus a 5s jobs-view polling fallback. The frontend is a modular zero-build SPA: `dashboard/index.html`, `dashboard/styles.css` (design tokens from the reference HTML), `dashboard/app.js` (router), `dashboard/api.js` (fetch + SSE), and `dashboard/views/{jobs,cron,config,docs,settings}.js`.

**Tech Stack:** Node >= 24 (uses `node:sqlite`), TypeScript compiled by `tsc` to `dist/`, vitest (`npm test` = `vitest run`, tests are `.test.ts` in `omi-job-fetch/tests/`), zero runtime dependencies (no framework, no bundler, no build step for the frontend). ESM (`"type": "module"`).

## Global Constraints

Copy these verbatim into any task that needs them. Every task's requirements implicitly include this section.

- **Zero runtime dependencies.** No npm packages added. Node built-ins only. `node:sqlite` is loaded via `createRequire(import.meta.url)` (the vitest vite-node workaround) — replicate the pattern from `src/db.ts` in every module that opens a DB.
- **DB mode is enabled by default for every config** (`config.db?.enabled !== false`). The dashboard depends on it. Disabling a config's DB shows a warning in the UI.
- **Every config produces a DB entry** (a row in the source list) unless `config.db.enabled` is explicitly `false`.
- **The jobs view is purely DB-based.** No jobs.json.
- **Cron job names must be unique.** The dashboard rejects a duplicate name with 409 — it never auto-suffixes. cron id == typed slug, so `<name>.db` naming stays predictable.
- **Mutations spawn the CLI, never reimplement the backend.** `cron start/stop/restart/pause/resume/enable/disable/remove/run/add` all go through `node <cliPath> cron <cmd>`. `launchGateway()` is private to `cronCli.ts` and must not be imported. Runs spawn `node <cliPath> run --config <path>` with `OMI_JOB_FETCH_TRIGGER=dashboard`.
- **Reads are in-process**: config JSON, cron.json, SQLite (open/close per request with `PRAGMA busy_timeout = 5000`, never held across requests; status writes are single-row UPDATEs; `SQLITE_BUSY` → HTTP 409 + retry callout).
- **Config edits are atomic** (write temp file in same dir, then rename).
- **Reactivity:** server stat-polls cron.json + discovered DB paths + cron.log every 2s → SSE broadcast; jobs view re-fetches every 5s as fallback.
- **Testing is hermetic.** Tests use `mkdtemp(join(tmpdir(), ...))` temp dirs and a stub CLI. Never touch the real package dir, real `cron.json`, or `~/.omijobs`.
- **No git commits.** The user stages changes and writes commit messages themselves (global CLAUDE.md rule). Every task ends with "Run the tests and report the pass" — never `git commit`. Do not auto-commit, do not propose a commit.
- **Design language** (from `the-stt-test-harness.html`): CSS variables; light palette `#F4F5F7` bg / `#1B2230` ink / `#5B6574` muted / `#929CAB` faint / `#E2E6EC` line / `#C01E33` accent / `#1F7A4C` good / `#A05A00` warn / `#FFFFFF` surface; dark palette `#14171D` bg / `#E9ECF1` ink / `#A6AFBD` muted / `#6B7484` faint / `#2A313D` line / `#FF5A66` accent / `#34C77B` good / `#E0A020` warn / `#1A1F28` surface. Georgia serif headings, sans body 17px/1.62, ui-monospace labels. Components: pulsing rec dot / eyebrow, ticker stat cards, callouts, status chips, sticky-header tables, gloss cards, mono pre panels.
- **Node flags/paths used throughout:** `PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")`; `STATE_DIR = join(homedir(), ".omijobs")`; `CRON_FILE = resolve(PACKAGE_DIR, "cron.json")`; output base = `resolve(config.outputDir ?? "output")` (cwd-relative, exactly like runtime.ts).

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/runtime.ts:195` | DB-enabled default | Modify |
| `src/types.ts` | `db` comment says default false | Modify |
| `config.json` | flip `db.enabled` to true | Modify |
| `tests/runtime.test.ts` | fix disabled-path test + add default test | Modify |
| `src/cron.ts:300-303` | "running" sentinel at spawn | Modify |
| `tests/cron.test.ts` | sentinel test | Modify |
| `src/dashboardConfig.ts` | config discovery, atomic read/write, friendly updates, slugify | Create |
| `src/dashboardDb.ts` | SQLite open/close, list/get/update jobs, DB discovery | Create |
| `src/dashboardCron.ts` | cron.json → view model, gateway liveness, mutations via CLI | Create |
| `src/dashboardRuns.ts` | spawn a run, list run.json metadata | Create |
| `src/dashboardServer.ts` | HTTP server, routes, SSE hub, 2s watcher, static | Create |
| `src/cli.ts` | `dashboard` command dispatch + help + flag parse | Modify |
| `tests/dashboard-{config,db,cron,runs,server,cli}.test.ts` | module tests | Create |
| `dashboard/index.html` | SPA shell | Create |
| `dashboard/styles.css` | design tokens + components | Create |
| `dashboard/api.js` | fetch + SSE client | Create |
| `dashboard/app.js` | router, nav, theme, toast, modal helpers | Create |
| `dashboard/views/jobs.js` | jobs view (main page) | Create |
| `dashboard/views/cron.js` | cron view | Create |
| `dashboard/views/config.js` | config view | Create |
| `dashboard/views/docs.js` | dashboard-only docs | Create |
| `dashboard/views/settings.js` | theme + info | Create |

---

## Task 1: DB enabled by default

**Files:**
- Modify: `src/runtime.ts:195` (`if (config.db?.enabled)` → `if (config.db?.enabled !== false)`)
- Modify: `src/types.ts` (`db` block comment)
- Modify: `config.json` (`"db": { "enabled": false, ... }` → `"enabled": true`)
- Test: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `runPipeline(config, adapters, options)` from `src/runtime.js`; the existing test helpers `makeAdapter(id, family, jobs, manifest?)` and `config(enabled, queries)`.
- Produces: the DB-sync default flips to enabled for every config without an explicit `db.enabled: false`. Later tasks depend on every config having a DB.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime.test.ts` after the `"omits db stats when db is disabled"` test:

```ts
it("syncs the aggregate DB by default when db.enabled is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
  try {
    const cfg = config(["gc"]); // no db block at all — default must be ON
    const adapter = makeAdapter("gc", "portal", [
      { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a", posted_at: "2026-08-18T00:00:00.000Z" },
    ]);
    const result = await runPipeline(cfg, [adapter], { outputDir: dir, now: new Date("2026-08-19T00:00:00.000Z") });
    expect(result.summary.db).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
    expect(existsSync(join(dir, "jobs.db"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the new test FAILS — `result.summary.db` is `undefined` because `config.db?.enabled` is falsy when the `db` block is absent.

**Also, the existing disabled-path test now needs an explicit disable.** `"omits db stats when db is disabled"` currently calls `runPipeline(config(["gc"]), ...)` with no `db` block — under the new default it would start syncing. Change it so the *disabled* path is still exercised:

```ts
it("omits db stats when db is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
  try {
    const cfg = config(["gc"]);
    cfg.db = { enabled: false }; // explicit opt-out
    const adapter = makeAdapter("gc", "portal", [
      { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a" },
    ]);
    const result = await runPipeline(cfg, [adapter], { outputDir: dir });
    expect(result.summary.db).toBeUndefined();
    expect(result.summary.dbError).toBeUndefined();
    const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
    expect("db" in runMeta).toBe(false);
    expect("dbError" in runMeta).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Implement the default**

`src/runtime.ts:195` — change the DB gate from opt-in to opt-out:

```ts
  if (config.db?.enabled !== false) {
```

`src/types.ts` — update the `db` field comment (find the `db?: { enabled?: boolean; file?: string; retentionDays?: number }` declaration):

```ts
   * db — optional aggregate database. Enabled by DEFAULT for every config
   * (`enabled !== false`); the dashboard relies on it. Set `enabled: false`
   * to opt out of DB writes for a config.
```

`config.json` (repo root of the package, `omi-job-fetch/config.json`) — flip the default config to enabled:

```json
  "db": { "enabled": true, "file": "jobs.db", "retentionDays": 30 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including the new default-sync test and the corrected disabled-path test.

- [ ] **Step 5: No commit** — per Global Constraints, do not stage or commit. Report test results.

---

## Task 2: cron "running" sentinel

**Files:**
- Modify: `src/cron.ts:300-303` (gateway spawn block)
- Test: `tests/cron.test.ts`

**Interfaces:**
- Consumes: `runGateway(options)`, `saveCron`, `loadCron` from `src/cron.js`; the test helper `makeDir()` (returns `{dir, cronFile, stateDir}`) and `job(over?)` from `tests/cron.test.ts`.
- Produces: gateway writes `lastStatus: "running"` at spawn (so a mid-run job reads as running, and an interrupted run isn't mistaken for "ok"). Later tasks (`dashboardCron.getCronState`) key the live "running" indicator off `lastStatus === "running"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cron.test.ts` inside the `describe("runGateway", ...)` block:

```ts
it("marks a job as running at spawn, then resolves to ok at completion", async () => {
  const { dir, cronFile, stateDir } = await makeDir();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    saveCron(cronFile, { paused: false, jobs: [job({ id: "a", lastRun: "2026-08-19T11:00:00.000Z" })] });
    const done = runGateway({
      cronFile,
      cliPath: "cli",
      stateDir,
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      tickMs: 10,
      log: () => {},
      spawnJob: async () => {
        // The run is in flight here — the store must already say "running".
        await sleep(20);
        expect(loadCron(cronFile).jobs[0].lastStatus).toBe("running");
        release();
        return { ok: true, code: 0 };
      },
    });
    await gate;
    writeFileSync(join(stateDir, "stop"), "");
    await done;
    expect(loadCron(cronFile).jobs[0].lastStatus).toBe("ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron.test.ts -t "running at spawn"`
Expected: FAIL — `lastStatus` is still `null` (or the previous value) while the run is in flight.

- [ ] **Step 3: Implement the sentinel**

`src/cron.ts`, inside the gateway's spawn block (currently only writes `lastRun`):

```ts
          await writeCron((c) => {
            const target = c.jobs.find((j) => j.id === job.id);
            if (target) target.lastRun = now.toISOString();
            if (target) target.lastStatus = "running";
          });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cron.test.ts`
Expected: all PASS. The existing completion test ("records lastRun/lastStatus") still passes because the sentinel is overwritten at completion.

- [ ] **Step 5: No commit** — per Global Constraints.

---

## Task 3: `dashboardConfig.ts` — config discovery & friendly edits

**Files:**
- Create: `src/dashboardConfig.ts`
- Test: `tests/dashboard-config.test.ts`

**Interfaces:**
- Consumes: `RunConfig` from `./types.js`; `dbFile(config, outputDir)` from `./db.js`; `normalizeQueries` from `./runtime.js`; `adapters` from `./registry.js`; `loadCron` from `./cron.js`; Node `fs`/`path`/`url`.
- Produces (exact signatures later tasks rely on):

```ts
export interface ConfigDb { enabled: boolean; file: string; path: string; exists: boolean; }
export interface ConfigMeta {
  id: string;                 // "base" | cron job id
  kind: "base" | "cron";
  path: string;               // absolute path to the config file
  rel: string;                // path relative to packageDir
  queries: string[];
  enabledPortals: string[];
  outputDir: string;
  db: ConfigDb;
}
export interface ConfigListInput { packageDir: string; cronFile?: string; }
export interface FriendlyPatch {
  queries?: string[];
  enabledPortals?: string[];
  storage?: "shared" | "separate" | "custom";
  dbEnabled?: boolean;
  baseConfig?: RunConfig;
  id?: string;                // cron slug — names the <id>.db for "separate" storage
}
export function slugify(value: string): string;
export function resolveDbPath(config: RunConfig): string;
export function readConfig(path: string): RunConfig;                       // throws on missing / bad JSON
export function validateConfig(raw: unknown): { ok: true; config: RunConfig } | { ok: false; error: string };
export function writeConfig(path: string, config: RunConfig): void;        // atomic temp+rename
export function discoverConfigs(input: ConfigListInput): ConfigMeta[];
export function configMeta(id: string, kind: "base" | "cron", path: string, rel: string, config: RunConfig): ConfigMeta;
export function applyFriendlyUpdate(config: RunConfig, patch: FriendlyPatch): RunConfig;
```

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyFriendlyUpdate,
  configMeta,
  discoverConfigs,
  readConfig,
  resolveDbPath,
  slugify,
  validateConfig,
  writeConfig,
} from "../src/dashboardConfig.js";
import type { RunConfig } from "../src/types.js";

const BASE: RunConfig = {
  global: { queries: ["finance intern"] },
  portals: { enabled: ["gradconnection"], config: {} },
  ats: { enabled: [], config: {} },
  outputDir: "output",
};

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-config-"));
  await writeFile(join(dir, "config.json"), JSON.stringify(BASE));
  return dir;
}

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slugify("Finance Intern 2026")).toBe("finance-intern-2026");
    expect(slugify(" a!!b ")).toBe("a-b");
    expect(slugify("???")).toBe("job");
  });
});

describe("resolveDbPath", () => {
  it("defaults to <outputDir>/jobs.db", () => {
    expect(resolveDbPath(BASE)).toBe(resolve("output", "jobs.db"));
  });
  it("honors db.file", () => {
    expect(resolveDbPath({ ...BASE, db: { file: "mine.db" } })).toBe(resolve("output", "mine.db"));
  });
});

describe("readConfig / writeConfig / validateConfig", () => {
  it("readConfig throws on a missing file", async () => {
    const dir = await makeDir();
    try {
      expect(() => readConfig(join(dir, "nope.json"))).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writeConfig is atomic (no temp file left behind) and readable", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "out.json");
      writeConfig(path, { ...BASE, global: { queries: ["q2"] } });
      expect(readConfig(path).global?.queries).toEqual(["q2"]);
      // No leftover temp files.
      const leftovers = (await import("node:fs/promises")).readdir(dir);
      expect((await leftovers).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("validateConfig rejects non-config shapes and accepts a well-formed config", () => {
    expect(validateConfig({}).ok).toBe(false);
    expect(validateConfig({ portals: {}, ats: {} }).ok).toBe(true);
  });
});

describe("discoverConfigs", () => {
  it("returns the base meta plus one meta per cron job, with the db path resolved", async () => {
    const dir = await makeDir();
    try {
      await writeFile(join(dir, "cron.json"), JSON.stringify({
        paused: false,
        jobs: [{ id: "finance", config: "test.configs/finance.config.json", schedule: "every 6 hours" }],
      }));
      await writeFile(
        join(dir, "test.configs", "finance.config.json"),
        JSON.stringify({ ...BASE, global: { queries: ["grad"] } }),
      );
      const metas = discoverConfigs({ packageDir: dir, cronFile: join(dir, "cron.json") });
      expect(metas.map((m) => m.id)).toEqual(["base", "finance"]);
      const base = metas[0];
      expect(base.kind).toBe("base");
      expect(base.db.enabled).toBe(true);
      expect(base.db.file).toBe("jobs.db");
      expect(base.db.exists).toBe(false);
      expect(base.queries).toEqual(["finance intern"]);
      const fin = metas[1];
      expect(fin.kind).toBe("cron");
      expect(fin.queries).toEqual(["grad"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports db.enabled false for a config that opted out", async () => {
    const dir = await makeDir();
    try {
      const meta = configMeta("base", "base", join(dir, "config.json"), "config.json", {
        ...BASE,
        db: { enabled: false },
      });
      expect(meta.db.enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applyFriendlyUpdate", () => {
  const cron: RunConfig = { ...BASE, global: { queries: ["old"] } };

  it("replaces queries", () => {
    expect(applyFriendlyUpdate(cron, { queries: ["a", "b"] }).global?.queries).toEqual(["a", "b"]);
  });

  it("splits enabledPortals into portals vs ats by registry family", () => {
    const out = applyFriendlyUpdate(cron, { enabledPortals: ["gradconnection", "taleo"] });
    expect(out.portals.enabled).toEqual(["gradconnection"]);
    expect(out.ats.enabled).toEqual(["taleo"]);
  });

  it("storage 'shared' points db.file at the base config's file and enables it", () => {
    const out = applyFriendlyUpdate(cron, { storage: "shared", baseConfig: BASE, id: "finance" });
    expect(out.db).toEqual({ enabled: true, file: "jobs.db" });
  });

  it("storage 'separate' names the db <slug>.db", () => {
    const out = applyFriendlyUpdate(cron, { storage: "separate", baseConfig: BASE, id: "Finance Intern" });
    expect(out.db).toEqual({ enabled: true, file: "finance-intern.db" });
  });

  it("storage 'custom' leaves db untouched", () => {
    const withDb = { ...cron, db: { enabled: false, file: "x.db" } };
    expect(applyFriendlyUpdate(withDb, { storage: "custom" })).toEqual(withDb);
  });

  it("dbEnabled false opts out and warns downstream", () => {
    expect(applyFriendlyUpdate(cron, { dbEnabled: false }).db?.enabled).toBe(false);
  });
});
```

Note: the ats split test assumes `taleo` is registered with family `ats` in `src/registry.ts`. If it isn't, use the first adapter whose manifest family is `"ats"` from the registry in the test (e.g. `adapters.find((a) => a.manifest.family === "ats")?.manifest.id`). Check `src/registry.ts` and adjust that one literal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-config.test.ts`
Expected: FAIL — module not found (`Cannot find module '../src/dashboardConfig.js'`).

- [ ] **Step 3: Write the implementation**

Create `src/dashboardConfig.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dbFile } from "./db.js";
import { loadCron } from "./cron.js";
import { normalizeQueries } from "./runtime.js";
import { adapters } from "./registry.js";
import type { RunConfig } from "./types.js";

/** Lowercase slug for cron ids and separate-storage DB filenames. */
export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "job";
}

/** Resolve a config's aggregate-DB file (cwd-relative outputDir, like runtime). */
export function resolveDbPath(config: RunConfig): string {
  return dbFile(config, resolve(config.outputDir ?? "output"));
}

/** Read + JSON-parse a config. Throws with context on missing/bad JSON. */
export function readConfig(path: string): RunConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`config at ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const v = validateConfig(raw);
  if (!v.ok) throw new Error(`config at ${path}: ${v.error}`);
  return v.config;
}

/** Minimal shape check — an object carrying the portal/ats structure. */
export function validateConfig(raw: unknown): { ok: true; config: RunConfig } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const cfg = raw as Partial<RunConfig>;
  if (typeof cfg.portals !== "object" || cfg.portals === null) return { ok: false, error: 'missing "portals" block' };
  if (typeof cfg.ats !== "object" || cfg.ats === null) return { ok: false, error: 'missing "ats" block' };
  return { ok: true, config: cfg as RunConfig };
}

/** Atomic write: temp file in the same dir, then rename over the target. */
export function writeConfig(path: string, config: RunConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}

const atsIds = new Set(adapters.filter((a) => a.manifest.family === "ats").map((a) => a.manifest.id));
function splitEnabled(ids: string[]): { portals: string[]; ats: string[] } {
  const portals: string[] = [];
  const ats: string[] = [];
  for (const id of ids) (atsIds.has(id) ? ats : portals).push(id);
  return { portals, ats };
}

/** Build a ConfigMeta from a loaded config. */
export function configMeta(id: string, kind: "base" | "cron", path: string, rel: string, config: RunConfig): ConfigMeta {
  const dbPath = resolveDbPath(config);
  return {
    id,
    kind,
    path,
    rel,
    queries: normalizeQueries(config.global?.queries),
    enabledPortals: [...(config.portals?.enabled ?? []), ...(config.ats?.enabled ?? [])],
    outputDir: config.outputDir ?? "output",
    db: {
      enabled: config.db?.enabled !== false,
      file: config.db?.file ?? "jobs.db",
      path: dbPath,
      exists: existsSync(dbPath),
    },
  };
}

/**
 * Discover configs: the base config.json plus one meta per cron job (config
 * paths resolve relative to the cron.json folder, matching the CLI).
 */
export function discoverConfigs(input: ConfigListInput): ConfigMeta[] {
  const basePath = resolve(input.packageDir, "config.json");
  const metas: ConfigMeta[] = [];
  if (existsSync(basePath)) {
    metas.push(configMeta("base", "base", basePath, "config.json", readConfig(basePath)));
  }
  if (input.cronFile && existsSync(input.cronFile)) {
    for (const job of loadCron(input.cronFile).jobs) {
      const path = resolve(dirname(input.cronFile), job.config);
      if (!existsSync(path)) continue;
      try {
        metas.push(configMeta(job.id, "cron", path, job.config, readConfig(path)));
      } catch {
        // A cron whose config file is broken is still listed (with db.exists
        // false / empty defaults are impossible here) — but only if readable.
        // Skip unreadable ones; the cron page surfaces the error itself.
      }
    }
  }
  return metas;
}

/**
 * Apply a simplified-controls patch to a config. Storage mapping:
 *   shared   → same outputDir as the base config, db.file = base's jobs.db, enabled
 *   separate → same outputDir, db.file = <slug>.db, enabled
 *   custom   → leave outputDir/db untouched (advanced editor owns it)
 */
export function applyFriendlyUpdate(config: RunConfig, patch: FriendlyPatch): RunConfig {
  let out: RunConfig = config;
  if (patch.queries) out = { ...out, global: { ...out.global, queries: patch.queries } };
  if (patch.enabledPortals) {
    const split = splitEnabled(patch.enabledPortals);
    out = { ...out, portals: { ...out.portals, enabled: split.portals }, ats: { ...out.ats, enabled: split.ats } };
  }
  if (patch.storage === "shared" || patch.storage === "separate") {
    const outputDir = patch.baseConfig?.outputDir ?? out.outputDir;
    if (patch.storage === "shared") {
      out = {
        ...out,
        outputDir,
        db: { ...out.db, enabled: true, file: patch.baseConfig?.db?.file ?? "jobs.db" },
      };
    } else {
      out = { ...out, outputDir, db: { ...out.db, enabled: true, file: `${slugify(patch.id ?? "job")}.db` } };
    }
  }
  if (patch.dbEnabled !== undefined) out = { ...out, db: { ...out.db, enabled: patch.dbEnabled } };
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard-config.test.ts`
Expected: all PASS (adjust the ats literal in the split test if needed).

- [ ] **Step 5: No commit.**

---

## Task 4: `dashboardDb.ts` — SQLite access layer

**Files:**
- Create: `src/dashboardDb.ts`
- Test: `tests/dashboard-db.test.ts`

**Interfaces:**
- Consumes: `ConfigMeta` from `./dashboardConfig.js`; the `createRequire` + `DatabaseSync` pattern from `./db.js`.
- Produces (exact signatures):

```ts
export const JOB_STATUSES = ["unapplied", "applied", "uninterested"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export interface DbInfo { key: string; label: string; path: string; exists: boolean; total: number; byStatus: Record<string, number>; error: string | null; }
export interface JobListQuery {
  status?: string;
  q?: string;
  sort?: string;   // "posted_at" | "title" | "company" | "location" | "status" — any other value falls back to "posted_at"
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
export interface JobListRow { signature: string; status: string; postedAt: string | null; job: Record<string, unknown>; }
export interface JobListResult { total: number; rows: JobListRow[]; }
export interface JobDetail { signature: string; status: string; postedAt: string | null; createdAt: string | null; updatedAt: string | null; analysis: unknown; job: Record<string, unknown>; }
export function discoverDbs(metas: ConfigMeta[]): DbInfo[];
export function listJobs(file: string, query?: JobListQuery): JobListResult;
export function getJob(file: string, signature: string): JobDetail | null;
export function setJobStatus(file: string, signature: string, status: string): { ok: boolean; error?: string };
export function isBusyError(error: unknown): boolean;
```

Behavior contract:
- Every call opens the SQLite file, runs `PRAGMA busy_timeout = 5000`, does its work, and closes. Never holds a connection across calls (avoids clashing with the cron gateway's writers).
- `discoverDbs`: missing file → `exists: false, total: 0, error: null`. Corrupt/locked file → `exists: true, total: 0, error: <message>`.
- `listJobs`: status filter in SQL; `q` (text) filter in JS across the job's `title`/`company`/`location` (case-insensitive substring); sort + paginate in JS; `total` = post-filter count; default `sort: "posted_at", dir: "desc"`, nulls last. Any `sort` value not in `SORTERS` falls back to `"posted_at"`; `dir` other than `"asc"`/`"desc"` falls back to `"desc"`.
- `setJobStatus`: validates `status ∈ JOB_STATUSES` (throws otherwise); single-row `UPDATE jobs SET status = ?, updated_at = ? WHERE signature = ?`; returns `{ok: true}` when a row changed, `{ok: false, error: "not found"}` when nothing matched, `{ok: false, error: <msg>}` on a busy/corrupt failure.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  discoverDbs,
  getJob,
  isBusyError,
  listJobs,
  setJobStatus,
} from "../src/dashboardDb.js";
import type { ConfigMeta } from "../src/dashboardConfig.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const NOW = "2026-08-19T00:00:00.000Z";

function seed(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE jobs (
      signature  TEXT PRIMARY KEY,
      posted_at  TEXT,
      job        TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'unapplied',
      analysis   TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const ins = db.prepare(
    "INSERT INTO jobs (signature, posted_at, job, status, analysis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  ins.run("a", "2026-08-18T00:00:00.000Z", JSON.stringify({ title: "Grad Program", company: "HSBC", location: "Hong Kong" }), "unapplied", null, NOW, NOW);
  ins.run("b", "2026-08-19T00:00:00.000Z", JSON.stringify({ title: "Analyst", company: "JPM", location: "Singapore" }), "applied", JSON.stringify({ fit: 0.8 }), NOW, NOW);
  ins.run("c", "2026-08-17T00:00:00.000Z", JSON.stringify({ title: "Internship", company: "GS", location: "Hong Kong" }), "uninterested", null, NOW, NOW);
  db.close();
}

function meta(file: string): ConfigMeta {
  return {
    id: "base",
    kind: "base",
    path: "config.json",
    rel: "config.json",
    queries: ["q"],
    enabledPortals: [],
    outputDir: "output",
    db: { enabled: true, file: "jobs.db", path: file, exists: existsSync(file) },
  };
}

describe("discoverDbs", () => {
  it("reports a missing db as absent with zero counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const info = discoverDbs([meta(join(dir, "jobs.db"))])[0];
      expect(info.exists).toBe(false);
      expect(info.total).toBe(0);
      expect(info.byStatus).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts totals and by-status for an existing db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const info = discoverDbs([meta(file)])[0];
      expect(info.exists).toBe(true);
      expect(info.total).toBe(3);
      expect(info.byStatus).toEqual({ unapplied: 1, applied: 1, uninterested: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("listJobs", () => {
  async function withDb(): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    const file = join(dir, "jobs.db");
    seed(file);
    return { dir, file };
  }

  it("defaults to posted_at desc, most recent first", async () => {
    const { dir, file } = await withDb();
    try {
      const { rows, total } = listJobs(file);
      expect(total).toBe(3);
      expect(rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters by status and by text across title/company/location", async () => {
    const { dir, file } = await withDb();
    try {
      expect(listJobs(file, { status: "applied" }).rows.map((r) => r.signature)).toEqual(["b"]);
      // Case-insensitive substring on company.
      expect(listJobs(file, { q: "hsbc" }).rows.map((r) => r.signature)).toEqual(["a"]);
      // Matches location, not just title.
      expect(listJobs(file, { q: "singapore" }).rows.map((r) => r.signature)).toEqual(["b"]);
      // Sort by title asc.
      expect(listJobs(file, { sort: "title", dir: "asc" }).rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
      // Unknown sort keys fall back to the posted_at default instead of crashing.
      expect(listJobs(file, { sort: "banana" }).rows.map((r) => r.signature)).toEqual(["b", "a", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("paginates", async () => {
    const { dir, file } = await withDb();
    try {
      const page = listJobs(file, { limit: 1, offset: 1 });
      expect(page.rows.map((r) => r.signature)).toEqual(["a"]);
      expect(page.total).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getJob", () => {
  it("returns the full row including analysis, null for unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const detail = getJob(file, "b");
      expect(detail?.status).toBe("applied");
      expect(detail?.analysis).toEqual({ fit: 0.8 });
      expect((detail?.job as Record<string, unknown>).title).toBe("Analyst");
      expect(getJob(file, "zzz")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("setJobStatus", () => {
  it("updates a row's status and returns ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const r = setJobStatus(file, "a", "applied");
      expect(r.ok).toBe(true);
      expect(getJob(file, "a")?.status).toBe("applied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports not-found for an unknown signature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      const r = setJobStatus(file, "zzz", "applied");
      expect(r.ok).toBe(false);
      expect(r.error).toBe("not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-db-"));
    try {
      const file = join(dir, "jobs.db");
      seed(file);
      expect(() => setJobStatus(file, "a", "nonsense")).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isBusyError", () => {
  it("recognizes busy messages", () => {
    expect(isBusyError("database is locked")).toBe(true);
    expect(isBusyError(new Error("SQLITE_BUSY: cannot commit"))).toBe(true);
    expect(isBusyError("disk I/O error")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/dashboardDb.ts`:

```ts
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ConfigMeta } from "./dashboardConfig.js";

// node:sqlite via createRequire — see the note in src/db.ts for why.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const JOB_STATUSES = ["unapplied", "applied", "uninterested"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface DbInfo {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  total: number;
  byStatus: Record<string, number>;
  error: string | null;
}
export interface JobListQuery {
  status?: string;
  q?: string;
  sort?: string;   // "posted_at" | "title" | "company" | "location" | "status" — any other value falls back to "posted_at"
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
export interface JobListRow { signature: string; status: string; postedAt: string | null; job: Record<string, unknown>; }
export interface JobListResult { total: number; rows: JobListRow[]; }
export interface JobDetail {
  signature: string;
  status: string;
  postedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  analysis: unknown;
  job: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function open(file: string): { db: InstanceType<typeof DatabaseSync>; close: () => void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, close: () => db.close() };
}

function parseJob(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function nullOrString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function discoverDbs(metas: ConfigMeta[]): DbInfo[] {
  return metas.map((m) => {
    if (!m.db.exists) return { key: m.id, label: m.rel, path: m.db.path, exists: false, total: 0, byStatus: {}, error: null };
    try {
      const { db, close } = open(m.db.path);
      try {
        const total = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0);
        const byStatus: Record<string, number> = {};
        for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as Row[]) {
          byStatus[String(row.status)] = Number(row.n);
        }
        return { key: m.id, label: m.rel, path: m.db.path, exists: true, total, byStatus, error: null };
      } finally {
        close();
      }
    } catch (error) {
      return {
        key: m.id,
        label: m.rel,
        path: m.db.path,
        exists: true,
        total: 0,
        byStatus: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

const TEXT_FIELDS = ["title", "company", "location"] as const;
const SORTERS: Record<string, (r: JobListRow) => string | null> = {
  posted_at: (r) => r.postedAt,
  title: (r) => String(r.job.title ?? ""),
  company: (r) => String(r.job.company ?? ""),
  location: (r) => String(r.job.location ?? ""),
  status: (r) => r.status,
};

export function listJobs(file: string, query: JobListQuery = {}): JobListResult {
  const { db, close } = open(file);
  try {
    let sql = "SELECT signature, status, posted_at, job FROM jobs";
    const params: unknown[] = [];
    if (query.status) {
      sql += " WHERE status = ?";
      params.push(query.status);
    }
    sql += " ORDER BY posted_at DESC";
    const rows = (db.prepare(sql).all(...params) as Row[]).map(
      (r): JobListRow => ({
        signature: String(r.signature),
        status: String(r.status),
        postedAt: nullOrString(r.posted_at),
        job: parseJob(r.job),
      }),
    );

    // Text filter in JS so it matches title/company/location precisely.
    let filtered = rows;
    if (query.q) {
      const needle = query.q.toLowerCase();
      filtered = rows.filter((r) => {
        const hay = TEXT_FIELDS.map((f) => String(r.job[f] ?? "")).join(" ").toLowerCase();
        return hay.includes(needle);
      });
    }

    const sort = query.sort && query.sort in SORTERS ? query.sort : "posted_at";
    const dir = query.dir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const va = SORTERS[sort](a);
      const vb = SORTERS[sort](b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // nulls last
      if (vb === null) return -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * dir;
    });

    const total = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    return { total, rows: filtered.slice(offset, offset + limit) };
  } finally {
    close();
  }
}

export function getJob(file: string, signature: string): JobDetail | null {
  const { db, close } = open(file);
  try {
    const row = db
      .prepare("SELECT signature, status, posted_at, created_at, updated_at, analysis, job FROM jobs WHERE signature = ?")
      .get(signature) as Row | undefined;
    if (!row) return null;
    return {
      signature: String(row.signature),
      status: String(row.status),
      postedAt: nullOrString(row.posted_at),
      createdAt: nullOrString(row.created_at),
      updatedAt: nullOrString(row.updated_at),
      analysis: row.analysis === null || row.analysis === undefined ? null : JSON.parse(String(row.analysis)),
      job: parseJob(row.job),
    };
  } finally {
    close();
  }
}

export function setJobStatus(file: string, signature: string, status: string): { ok: boolean; error?: string } {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of ${JOB_STATUSES.join(", ")}`);
  }
  const { db, close } = open(file);
  try {
    const changed = Number(
      db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE signature = ?").run(status, new Date().toISOString(), signature).changes,
    );
    if (changed > 0) return { ok: true };
    return { ok: false, error: "not found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    close();
  }
}

export function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.toLowerCase().includes("busy") || msg.includes("SQLITE_BUSY");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard-db.test.ts`
Expected: all PASS.

- [ ] **Step 5: No commit.**

---

## Task 5: `dashboardCron.ts` — cron view model + CLI mutations

**Files:**
- Create: `src/dashboardCron.ts`
- Test: `tests/dashboard-cron.test.ts`

**Interfaces:**
- Consumes: `loadCron`, `nextDueAt` from `./cron.js`; `autostartStatus` from `./platform.js`; `CronSchedule`, `CronJob` from `./types.js`.
- Produces (exact signatures):

```ts
export interface CronJobState {
  id: string;
  config: string;
  configPath: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: string | null;
  nextRunAt: string;       // ISO — the UI shows a live countdown to this
  running: boolean;
}
export interface CronGatewayState {
  file: string;
  paused: boolean;
  error?: string;           // set when cron.json is unreadable
  gateway: { running: boolean; pid: number | null; stale: boolean; autostart: string };
  jobs: CronJobState[];
}
export interface MutationResult { ok: boolean; code: number; output: string; }
export interface CronStateInput { cronFile: string; stateDir: string; now?: Date; }
export function getCronState(input: CronStateInput): CronGatewayState;
export function nextRunAt(schedule: CronSchedule, lastRun: string | null, now: Date): string;
export function runCronMutation(input: { cliPath: string; args: string[] }): Promise<MutationResult>;
export function tailLog(stateDir: string, lines?: number): string[];
export function gatewayAlive(stateDir: string): { running: boolean; pid: number | null; stale: boolean };
```

Behavior contract:
- `running` = `lastStatus === "running"`. A `running` job whose gateway is down is labeled "stale" by the UI (the server state already carries `gateway.running`).
- `nextRunAt`: interval + never-run → `now` (due immediately); interval + ran → `nextDueAt(parsed, lastRun)` clamped to `now` when overdue; clock → `nextDueAt(parsed, now)` (never-run) or `nextDueAt(parsed, lastRun)` clamped.
- `runCronMutation`: `spawn(process.execPath, [cliPath, "cron", ...args], { windowsHide: true })`, capture stdout+stderr, resolve `{ok: code === 0, code, output}` on close.
- `gatewayAlive`: pidfile at `join(stateDir, "gateway.pid")`; `process.kill(pid, 0)` for liveness; `stale` = pidfile present but not alive.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-cron.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayAlive, getCronState, nextRunAt, runCronMutation, tailLog } from "../src/dashboardCron.js";
import type { CronSchedule } from "../src/types.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

async function makeDir(): Promise<{ dir: string; cronFile: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
  return { dir, cronFile: join(dir, "cron.json"), stateDir: join(dir, "state") };
}

describe("nextRunAt", () => {
  const interval: CronSchedule = { type: "interval", minutes: 30 };
  const clock: CronSchedule = { type: "clock", hour: 9, minute: 0, days: null };

  it("interval never-run fires immediately", () => {
    expect(nextRunAt(interval, null, NOW)).toBe(NOW.toISOString());
  });
  it("interval since lastRun fires after the window (or now when overdue)", () => {
    expect(nextRunAt(interval, "2026-08-19T11:00:00.000Z", NOW)).toBe("2026-08-19T11:30:00.000Z");
    expect(nextRunAt(interval, "2026-08-19T11:45:00.000Z", NOW)).toBe(NOW.toISOString());
  });
  it("clock computes the next occurrence", () => {
    expect(nextRunAt(clock, null, NOW)).toBe("2026-08-20T09:00:00.000Z");
    expect(nextRunAt(clock, "2026-08-18T09:00:00.000Z", NOW)).toBe("2026-08-20T09:00:00.000Z");
  });
});

describe("gatewayAlive", () => {
  it("reports not running without a pidfile, stale with a dead pid, running with a live one", async () => {
    const { dir, stateDir } = await makeDir();
    try {
      expect(gatewayAlive(stateDir).running).toBe(false);
      await writeFile(join(stateDir, "gateway.pid"), "99999999");
      const stale = gatewayAlive(stateDir);
      expect(stale.running).toBe(false);
      expect(stale.stale).toBe(true);
      await writeFile(join(stateDir, "gateway.pid"), String(process.pid));
      expect(gatewayAlive(stateDir).running).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getCronState", () => {
  it("maps cron.json into job states with running flag and countdowns", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      await writeFile(
        cronFile,
        JSON.stringify({
          paused: false,
          jobs: [
            { id: "a", config: "config.json", schedule: "every 30m", enabled: true, lastRun: "2026-08-19T11:00:00.000Z", lastStatus: "running" },
            { id: "b", config: "other.json", schedule: "daily at 09:00", enabled: false, lastRun: "2026-08-19T09:00:00.000Z", lastStatus: "ok" },
          ],
        }),
      );
      const state = getCronState({ cronFile, stateDir, now: NOW });
      expect(state.paused).toBe(false);
      expect(state.gateway.running).toBe(false);
      expect(state.jobs[0]).toMatchObject({ id: "a", running: true, nextRunAt: "2026-08-19T11:30:00.000Z" });
      expect(state.jobs[1]).toMatchObject({ id: "b", running: false, enabled: false, nextRunAt: "2026-08-20T09:00:00.000Z" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces an unreadable cron.json as an error", async () => {
    const { dir, cronFile, stateDir } = await makeDir();
    try {
      await writeFile(cronFile, "{nope");
      const state = getCronState({ cronFile, stateDir, now: NOW });
      expect(state.error).toBeDefined();
      expect(state.jobs).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runCronMutation", () => {
  it("spawns `node <cli> cron <args>` and returns the captured output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const cli = join(dir, "stub.cjs");
      await writeFile(cli, "console.log('saw: ' + process.argv.slice(2).join(' ')); process.exit(0);\n");
      const r = await runCronMutation({ cliPath: cli, args: ["pause"] });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("saw: pause");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tailLog", () => {
  it("returns the last N lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-cron-"));
    try {
      const stateDir = join(dir, "state");
      await writeFile(join(stateDir, "cron.log"), Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
      expect(tailLog(stateDir, 3)).toEqual(["line 7", "line 8", "line 9"]);
      expect(tailLog(join(dir, "missing"), 3)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-cron.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/dashboardCron.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadCron, nextDueAt } from "./cron.js";
import { autostartStatus } from "./platform.js";
import type { CronSchedule } from "./types.js";

export interface CronJobState {
  id: string;
  config: string;
  configPath: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: string | null;
  nextRunAt: string;
  running: boolean;
}
export interface CronGatewayState {
  file: string;
  paused: boolean;
  error?: string;
  gateway: { running: boolean; pid: number | null; stale: boolean; autostart: string };
  jobs: CronJobState[];
}
export interface MutationResult { ok: boolean; code: number; output: string; }
export interface CronStateInput { cronFile: string; stateDir: string; now?: Date; }

/** Next firing time as an ISO string, clamped to `now` when overdue. */
export function nextRunAt(schedule: CronSchedule, lastRun: string | null, now: Date): string {
  if (lastRun === null) {
    return nextDueAt(schedule, now).toISOString();
  }
  const next = nextDueAt(schedule, new Date(lastRun));
  return next.getTime() <= now.getTime() ? now.toISOString() : next.toISOString();
}

export function gatewayAlive(stateDir: string): { running: boolean; pid: number | null; stale: boolean } {
  const pidFile = join(stateDir, "gateway.pid");
  if (!existsSync(pidFile)) return { running: false, pid: null, stale: false };
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return { running: false, pid: null, stale: true };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null, stale: true };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return { running: alive, pid, stale: !alive };
}

/** Read cron.json into a view model the UI can render directly. */
export function getCronState(input: CronStateInput): CronGatewayState {
  let cron: ReturnType<typeof loadCron>;
  try {
    cron = loadCron(input.cronFile);
  } catch (error) {
    return {
      file: input.cronFile,
      paused: false,
      error: error instanceof Error ? error.message : String(error),
      gateway: { ...gatewayAlive(input.stateDir), autostart: autostartStatus() },
      jobs: [],
    };
  }
  const gw = gatewayAlive(input.stateDir);
  const now = input.now ?? new Date();
  const jobs = cron.jobs.map((job) => ({
    id: job.id,
    config: job.config,
    configPath: resolve(resolve(input.cronFile, ".."), job.config),
    schedule: job.schedule,
    enabled: job.enabled,
    lastRun: job.lastRun,
    lastStatus: job.lastStatus,
    running: job.lastStatus === "running",
    nextRunAt: nextRunAt(job.parsed, job.lastRun, now),
  }));
  return {
    file: input.cronFile,
    paused: cron.paused,
    gateway: { ...gw, autostart: autostartStatus() },
    jobs,
  };
}

/** Spawn `node <cliPath> cron <args>` and capture its output + exit code. */
export function runCronMutation(input: { cliPath: string; args: string[] }): Promise<MutationResult> {
  return new Promise((resolveMutation) => {
    const child = spawn(process.execPath, [input.cliPath, "cron", ...input.args], {
      windowsHide: true,
      env: { ...process.env, OMI_JOB_FETCH_TRIGGER: "dashboard" },
    });
    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.stderr.on("data", (d) => { output += String(d); });
    child.on("error", (error) => resolveMutation({ ok: false, code: 1, output: error.message }));
    child.on("close", (code) => resolveMutation({ ok: code === 0, code: code ?? 1, output }));
  });
}

/** Last N lines of the gateway log (empty array when absent). */
export function tailLog(stateDir: string, lines = 30): string[] {
  const file = resolve(stateDir, "cron.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").slice(-lines);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard-cron.test.ts`
Expected: all PASS.

- [ ] **Step 5: No commit.**

---

## Task 6: `dashboardRuns.ts` — run spawning + run.json listing

**Files:**
- Create: `src/dashboardRuns.ts`
- Test: `tests/dashboard-runs.test.ts`

**Interfaces:**
- Consumes: `timestampId` from `./runtime.js`; Node `child_process`/`fs`/`path`.
- Produces (exact signatures):

```ts
export interface RunSpawnInput {
  cliPath: string;
  configPath: string;
  trigger?: string;
  onLine?: (line: string) => void;
  onExit?: (code: number | null) => void;
}
export interface RunSpawnResult { id: string; }
export function startRun(input: RunSpawnInput): RunSpawnResult;
export interface RunMeta {
  id: string;
  path: string;
  startedAt: string | null;
  durationMs: number | null;
  jobs: number;
  trigger?: string;
  adapters: { adapter: string; status: string; jobCount?: number; durationMs?: number; error?: string }[];
}
export function listRuns(outputDir: string, limit?: number): RunMeta[];
```

Behavior contract:
- `startRun` spawns `node <cliPath> run --config <configPath>` with `OMI_JOB_FETCH_TRIGGER = trigger`, pipes stdout/stderr line-by-line to `onLine`, and calls `onExit(code)` on close. Returns the run id (`timestampId`).
- `listRuns` reads `outputDir/runs/<id>/run.json` for every run directory, newest first (timestamp ids are lexicographically sortable), default limit 20.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-runs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, startRun } from "../src/dashboardRuns.js";

describe("startRun", () => {
  it("spawns the run, forwards lines, sets the trigger env, reports the exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-runs-"));
    try {
      const cli = join(dir, "stub.cjs");
      await writeFile(cli, [
        "console.log('trigger=' + (process.env.OMI_JOB_FETCH_TRIGGER || ''));",
        "console.log('cfg=' + process.argv[process.argv.indexOf('--config') + 1]);",
        "process.exit(0);",
      ].join("\n"));
      const lines: string[] = [];
      const exited = new Promise<number | null>((r) => {
        startRun({
          cliPath: cli,
          configPath: join(dir, "config.json"),
          trigger: "dashboard",
          onLine: (l) => lines.push(l),
          onExit: r,
        });
      });
      const code = await exited;
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("trigger=dashboard");
      expect(lines.join("\n")).toContain(`cfg=${join(dir, "config.json")}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("listRuns", () => {
  it("lists run.json entries newest-first with parsed metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omijobs-runs-"));
    try {
      const runs = join(dir, "runs");
      await writeFile(
        join(runs, "20260818-000000-01", "run.json"),
        JSON.stringify({ id: "20260818-000000-01", startedAt: "2026-08-18T00:00:00.000Z", durationMs: 10, jobs: 1, adapters: [{ adapter: "a", status: "ok" }] }),
      );
      await writeFile(
        join(runs, "20260819-000000-02", "run.json"),
        JSON.stringify({ id: "20260819-000000-02", startedAt: "2026-08-19T00:00:00.000Z", durationMs: 20, jobs: 2, trigger: "dashboard", adapters: [{ adapter: "b", status: "error", error: "boom" }] }),
      );
      const list = listRuns(dir);
      expect(list.map((r) => r.id)).toEqual(["20260819-000000-02", "20260818-000000-01"]);
      expect(list[0].jobs).toBe(2);
      expect(list[0].trigger).toBe("dashboard");
      expect(list[0].adapters[0].status).toBe("error");
      // Missing run.json is skipped.
      expect(list.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-runs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/dashboardRuns.ts`:

```ts
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { timestampId } from "./runtime.js";

export interface RunSpawnInput {
  cliPath: string;
  configPath: string;
  trigger?: string;
  onLine?: (line: string) => void;
  onExit?: (code: number | null) => void;
}
export interface RunSpawnResult { id: string; }

export interface RunMeta {
  id: string;
  path: string;
  startedAt: string | null;
  durationMs: number | null;
  jobs: number;
  trigger?: string;
  adapters: { adapter: string; status: string; jobCount?: number; durationMs?: number; error?: string }[];
}

/** Spawn one run: `node <cli> run --config <path>` with the dashboard trigger env. */
export function startRun(input: RunSpawnInput): RunSpawnResult {
  const id = timestampId(new Date());
  const child = spawn(process.execPath, [input.cliPath, "run", "--config", input.configPath], {
    env: { ...process.env, OMI_JOB_FETCH_TRIGGER: input.trigger ?? "dashboard" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (d: Buffer | string) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line) input.onLine?.(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", () => input.onExit?.(null));
  child.on("close", (code) => input.onExit?.(code));
  return { id };
}

/** List run metadata from outputDir/runs/<id>/run.json, newest first. */
export function listRuns(outputDir: string, limit = 20): RunMeta[] {
  const runsDir = resolve(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  const metas: RunMeta[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(runsDir, entry.name, "run.json");
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      metas.push({
        id: String(raw.id ?? entry.name),
        path: file,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        durationMs: typeof raw.durationMs === "number" ? raw.durationMs : null,
        jobs: typeof raw.jobs === "number" ? raw.jobs : 0,
        trigger: typeof raw.trigger === "string" ? raw.trigger : undefined,
        adapters: Array.isArray(raw.adapters) ? (raw.adapters as RunMeta["adapters"]) : [],
      });
    } catch {
      // Corrupt run.json — skip.
    }
  }
  metas.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return metas.slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard-runs.test.ts`
Expected: all PASS.

- [ ] **Step 5: No commit.**

---

## Task 7: `dashboardServer.ts` — HTTP server, routes, SSE, watcher

**Files:**
- Create: `src/dashboardServer.ts`
- Test: `tests/dashboard-server.test.ts`

**Interfaces:**
- Consumes: `adapters` from `./registry.js`; `discoverConfigs, readConfig, writeConfig, configMeta, applyFriendlyUpdate, slugify` from `./dashboardConfig.js`; `discoverDbs, listJobs, getJob, setJobStatus, JOB_STATUSES, isBusyError` from `./dashboardDb.js`; `getCronState, runCronMutation, tailLog` from `./dashboardCron.js`; `startRun, listRuns` from `./dashboardRuns.js`; `loadCron, parseSchedule` from `./cron.js`; `RunConfig` from `./types.js`.
- Produces (exact signatures):

```ts
export interface DashboardOptions {
  port?: number;        // default 5211
  packageDir?: string;  // default: this package's root
  stateDir?: string;    // default: ~/.omijobs
  cliPath?: string;     // default: <packageDir>/dist/cli.js
  openBrowser?: boolean; // default true
  now?: () => Date;
}
export interface DashboardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}
export async function startDashboard(options?: DashboardOptions): Promise<DashboardServer>;
```

Route table (implement exactly):

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/` (and any static) | serve `dashboard/` files, guarded against traversal |
| GET | `/api/bootstrap` | `{ packageDir, stateDir, configPath, cronPath, cliPath, port, adapters: [{id,name,family}] }` |
| GET | `/api/configs` | `ConfigMeta[]` with each `db.jobCount` filled in |
| GET | `/api/configs/:id` | `{ config }` — the full raw RunConfig (for the advanced JSON editor) |
| PUT | `/api/configs/:id` | body `{queries?, enabledPortals?, storage?, dbEnabled?, raw?}` → friendly update (or `raw` JSON), atomic write; `dbWarning: true` when result has `db.enabled === false` |
| POST | `/api/configs/:id/run` | 409 if that config already has a run in flight; else `startRun` (broadcasts on lines + exit), returns `{ok:true, runId}` |
| GET | `/api/cron` | `getCronState({cronFile, stateDir, now})` |
| POST | `/api/cron/:action` | action ∈ start\|stop\|restart\|pause\|resume\|run (body may carry `id` for enable\|disable\|remove) → `runCronMutation`, broadcast, return `{ok, code, output}` (502 on nonzero exit) |
| POST | `/api/cron/add` | validate schedule; slug name; **409 on duplicate name**; create config (shared/separate storage) if new; `runCronMutation(["add", "--config", rel, "--schedule", s, "--name", id])` |
| GET | `/api/cron/log` | `{ lines: tailLog(stateDir) }` |
| GET | `/api/dbs` | `discoverDbs(discoverConfigs(...))` |
| GET | `/api/dbs/:key/jobs` | query params `status/q/sort/dir/limit/offset` → `listJobs(dbPath, ...)`; 404 for unknown key |
| GET | `/api/jobs/:dbKey/:signature` | `getJob` (decodeURIComponent the signature); 404 when null |
| PATCH | `/api/jobs` | body `{dbKey, signature, status}`; validate status ∈ JOB_STATUSES → 400; not-found → 404; busy → 409 `{error, busy:true}` |
| GET | `/api/runs` | `listRuns(base.outputDir)` |
| GET | `/api/events` | SSE: keep-alive comment every 15s, remove client on close |

Error handling: unknown `/api/*` → 404 JSON. Malformed JSON body → 400. Unknown cron action → 400. `EADDRINUSE` → reject with a clear message.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboardServer.js";

const NOW = "2026-08-19T12:00:00.000Z";

// A stub "cli" the dashboard treats as the real one: it echoes cron mutations
// and, for `run`, writes a run.json into the config's outputDir so /api/runs
// has something to list.
const STUB_CLI = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
console.log("stub " + args.join(" "));
console.log("trigger=" + (process.env.OMI_JOB_FETCH_TRIGGER || ""));
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
process.exit(0);
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
  await writeFile(join(pkg, "config.json"), JSON.stringify({ ...BASE_CONFIG, outputDir: join(dir, "output") }));
  await writeFile(join(pkg, "cron.json"), JSON.stringify({
    paused: false,
    jobs: [{ id: "finance", config: "test.configs/finance.config.json", schedule: "every 6 hours", enabled: true, lastRun: "2026-08-19T06:00:00.000Z", lastStatus: "ok" }],
  }));
  await mkdir(join(pkg, "test.configs"), { recursive: true }); // writeFile does not create parents
  await writeFile(join(pkg, "test.configs", "finance.config.json"), JSON.stringify({ ...BASE_CONFIG, outputDir: join(dir, "output") }));
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
      expect(body.output).toContain("stub pause");
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
      expect((await res.json()).output).toContain("new-intern");
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

  it("GET /api/jobs/:dbKey/:signature returns the detail and 404s on miss", async () => {
    const env = await makeEnv();
    try {
      const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/dashboardServer.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "./registry.js";
import { loadCron, parseSchedule } from "./cron.js";
import { applyFriendlyUpdate, configMeta, discoverConfigs, readConfig, slugify, validateConfig, writeConfig } from "./dashboardConfig.js";
import { discoverDbs, getJob, isBusyError, listJobs, setJobStatus, JOB_STATUSES } from "./dashboardDb.js";
import { getCronState, runCronMutation, tailLog } from "./dashboardCron.js";
import { listRuns, startRun } from "./dashboardRuns.js";
import type { RunConfig } from "./types.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 5211;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

export interface DashboardOptions {
  port?: number;
  packageDir?: string;
  stateDir?: string;
  cliPath?: string;
  openBrowser?: boolean;
  now?: () => Date;
}
export interface DashboardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        rejectBody(new Error("invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardServer> {
  const packageDir = resolve(options.packageDir ?? PKG);
  const stateDir = options.stateDir ?? join(homedir(), ".omijobs");
  const cliPath = options.cliPath ?? resolve(packageDir, "dist", "cli.js");
  const cronFile = resolve(packageDir, "cron.json");
  const staticRoot = resolve(packageDir, "dashboard");
  const clock = options.now ?? (() => new Date());

  const clients = new Set<ServerResponse>();
  const inflight = new Set<string>();
  const broadcast = (type: string, payload: unknown) => {
    // Unnamed message events only: `es.onmessage` does NOT fire for named
    // `event: <type>` SSE events, so the type rides inside the data payload.
    const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
    for (const client of clients) {
      try {
        client.write(msg);
      } catch {
        clients.delete(client);
      }
    }
  };

  // --- 2s stat-poll: broadcast on changes to cron.json, DB files, cron.log ---
  let lastSeen = new Map<string, number>();
  const watch = setInterval(() => {
    const targets = [cronFile, join(stateDir, "cron.log")];
    let metas: ReturnType<typeof discoverConfigs> = [];
    try {
      metas = discoverConfigs({ packageDir, cronFile });
    } catch {
      // unreadable cron.json — still watch the file itself for recovery
    }
    for (const m of metas) targets.push(m.db.path);
    const seen = new Map<string, number>();
    for (const t of targets) {
      try {
        seen.set(t, statSync(t).mtimeMs);
      } catch {
        // missing file
      }
    }
    for (const [path, ms] of seen) {
      if (lastSeen.has(path) && lastSeen.get(path) !== ms) {
        const kind = path === cronFile ? "cron" : path === join(stateDir, "cron.log") ? "state" : "db";
        broadcast(kind, {});
      }
    }
    lastSeen = seen;
  }, 2000);

  // --- route handlers ---
  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = path.split("/").filter(Boolean); // ["api", ...]

    if (path === "/api/bootstrap" && method === "GET") {
      sendJson(res, 200, {
        packageDir,
        stateDir,
        configPath: join(packageDir, "config.json"),
        cronPath: cronFile,
        cliPath,
        port: options.port ?? DEFAULT_PORT,
        adapters: adapters.map((a) => ({ id: a.manifest.id, name: a.manifest.name, family: a.manifest.family })),
      });
      return;
    }

    if (path === "/api/configs" && method === "GET") {
      const metas = discoverConfigs({ packageDir, cronFile });
      const counts = new Map(discoverDbs(metas).map((d) => [d.key, d.total]));
      sendJson(res, 200, metas.map((m) => ({ ...m, db: { ...m.db, jobCount: counts.get(m.id) ?? 0 } })));
      return;
    }

    const configsId = /^\/api\/configs\/([^/]+)$/.exec(path);
    if (configsId && method === "GET") {
      const id = decodeURIComponent(configsId[1]);
      const meta = discoverConfigs({ packageDir, cronFile }).find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      sendJson(res, 200, { config: readConfig(meta.path) });
      return;
    }

    const configsRun = /^\/api\/configs\/([^/]+)\/run$/.exec(path);
    if (configsRun && method === "POST") {
      const id = decodeURIComponent(configsRun[1]);
      if (inflight.has(id)) {
        sendJson(res, 409, { error: `A run for "${id}" is already in progress — wait for it to finish.` });
        return;
      }
      const meta = discoverConfigs({ packageDir, cronFile }).find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      inflight.add(id);
      broadcast("runs", { running: id });
      const { id: runId } = startRun({
        cliPath,
        configPath: meta.path,
        trigger: "dashboard",
        onLine: (line) => broadcast("runs", { line }),
        onExit: (code) => {
          inflight.delete(id);
          broadcast("runs", { done: id, code });
          broadcast("db", {});
        },
      });
      sendJson(res, 200, { ok: true, runId });
      return;
    }

    const configs = /^\/api\/configs\/([^/]+)$/.exec(path);
    if (configs && method === "PUT") {
      const id = decodeURIComponent(configs[1]);
      const metas = discoverConfigs({ packageDir, cronFile });
      const meta = metas.find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      let config: RunConfig;
      if (body.raw !== undefined) {
        const v = validateConfig(body.raw);
        if (!v.ok) {
          sendJson(res, 400, { error: v.error });
          return;
        }
        config = v.config;
      } else {
        const current = readConfig(meta.path);
        const baseMeta = metas.find((m) => m.kind === "base");
        const baseConfig = baseMeta ? readConfig(baseMeta.path) : undefined;
        config = applyFriendlyUpdate(current, {
          queries: Array.isArray(body.queries) ? body.queries.map(String) : undefined,
          enabledPortals: Array.isArray(body.enabledPortals) ? body.enabledPortals.map(String) : undefined,
          storage: body.storage as "shared" | "separate" | "custom" | undefined,
          dbEnabled: typeof body.dbEnabled === "boolean" ? body.dbEnabled : undefined,
          baseConfig,
          id,
        });
      }
      writeConfig(meta.path, config);
      const fresh = configMeta(meta.id, meta.kind, meta.path, meta.rel, config);
      broadcast("db", {});
      sendJson(res, 200, { config: fresh, dbWarning: config.db?.enabled === false });
      return;
    }

    if (path === "/api/cron" && method === "GET") {
      const state = getCronState({ cronFile, stateDir, now: clock() });
      // Dashboard-triggered runs (POST /api/configs/:id/run) block the same
      // config id the gateway uses, so a manual run lights the same indicator.
      for (const job of state.jobs) if (inflight.has(job.id)) job.running = true;
      sendJson(res, 200, state);
      return;
    }

    if (path === "/api/cron/log" && method === "GET") {
      sendJson(res, 200, { lines: tailLog(stateDir, 30) });
      return;
    }

    const cronAction = /^\/api\/cron\/([a-z]+)$/.exec(path);
    if (cronAction && method === "POST") {
      const action = cronAction[1];
      const known = new Set(["start", "stop", "restart", "pause", "resume", "run", "enable", "disable", "remove"]);
      if (!known.has(action)) {
        sendJson(res, 400, { error: `Unknown cron action "${action}"` });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch {
        // no body is fine for start/stop/etc.
      }
      const args = action === "enable" || action === "disable" || action === "remove"
        ? [action, String(body.id ?? "")]
        : [action];
      const result = await runCronMutation({ cliPath, args });
      broadcast("cron", {});
      sendJson(res, result.ok ? 200 : 502, { ...result });
      return;
    }

    if (path === "/api/cron/add" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const name = String(body.name ?? "").trim();
      const schedule = String(body.schedule ?? "").trim();
      if (!name) {
        sendJson(res, 400, { error: "A cron name is required" });
        return;
      }
      let parsed;
      try {
        parsed = parseSchedule(schedule);
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const id = slugify(name);
      const cron = loadCron(cronFile);
      if (cron.jobs.some((j) => j.id === id)) {
        sendJson(res, 409, { error: `A cron job named "${id}" already exists — names must be unique.` });
        return;
      }
      const metas = discoverConfigs({ packageDir, cronFile });
      const baseMeta = metas.find((m) => m.kind === "base");
      if (!baseMeta) {
        sendJson(res, 500, { error: "No base config.json — cannot create a cron config." });
        return;
      }
      const configRel = typeof body.existing === "string" && body.existing
        ? body.existing
        : `test.configs/${id}.config.json`;
      const configPath = resolve(dirname(cronFile), configRel);
      if (!existsSync(configPath)) {
        const baseConfig = readConfig(baseMeta.path);
        writeConfig(
          configPath,
          applyFriendlyUpdate(baseConfig, {
            queries: Array.isArray(body.queries) ? body.queries.map(String) : undefined,
            enabledPortals: Array.isArray(body.enabledPortals) ? body.enabledPortals.map(String) : undefined,
            storage: body.storage === "shared" || body.storage === "separate" || body.storage === "custom" ? body.storage : "shared",
            baseConfig,
            id,
          }),
        );
      }
      const result = await runCronMutation({
        cliPath,
        args: ["add", "--config", configRel, "--schedule", schedule, "--name", id],
      });
      broadcast("cron", {});
      sendJson(res, result.ok ? 200 : 502, { ...result });
      return;
    }

    if (path === "/api/dbs" && method === "GET") {
      const metas = discoverConfigs({ packageDir, cronFile });
      sendJson(res, 200, discoverDbs(metas));
      return;
    }

    const dbJobs = /^\/api\/dbs\/([^/]+)\/jobs$/.exec(path);
    if (dbJobs && method === "GET") {
      const key = decodeURIComponent(dbJobs[1]);
      const meta = discoverConfigs({ packageDir, cronFile }).find((m) => m.id === key);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${key}"` });
        return;
      }
      // A never-created DB (config db disabled or zero runs so far) isn't an
      // error — the jobs table is just empty.
      if (!meta.db.enabled || !existsSync(meta.db.path)) {
        sendJson(res, 200, { total: 0, rows: [] });
        return;
      }
      const q = url.searchParams;
      const result = listJobs(meta.db.path, {
        status: q.get("status") ?? undefined,
        q: q.get("q") ?? undefined,
        sort: q.get("sort") ?? undefined,
        dir: q.get("dir") ?? undefined,
        limit: Number(q.get("limit") ?? 200),
        offset: Number(q.get("offset") ?? 0),
      });
      sendJson(res, 200, result);
      return;
    }

    const jobDetail = /^\/api\/jobs\/([^/]+)\/(.+)$/.exec(path);
    if (jobDetail && method === "GET") {
      const key = decodeURIComponent(jobDetail[1]);
      const signature = decodeURIComponent(jobDetail[2]);
      const meta = discoverConfigs({ packageDir, cronFile }).find((m) => m.id === key);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${key}"` });
        return;
      }
      const detail = getJob(meta.db.path, signature);
      if (!detail) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (path === "/api/jobs" && method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const { dbKey, signature, status } = body;
      if (typeof status !== "string" || !(JOB_STATUSES as readonly string[]).includes(status)) {
        sendJson(res, 400, { error: `status must be one of ${JOB_STATUSES.join(", ")}` });
        return;
      }
      const meta = discoverConfigs({ packageDir, cronFile }).find((m) => m.id === dbKey);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${String(dbKey)}"` });
        return;
      }
      const r = setJobStatus(meta.db.path, String(signature), status);
      if (!r.ok) {
        if (r.error === "not found") {
          sendJson(res, 404, { error: "job not found" });
        } else if (isBusyError(r.error)) {
          sendJson(res, 409, { error: "The DB is busy — another process is writing it. Try again in a moment.", busy: true });
        } else {
          sendJson(res, 500, { error: r.error ?? "unknown error" });
        }
        return;
      }
      broadcast("db", {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/api/runs" && method === "GET") {
      const metas = discoverConfigs({ packageDir, cronFile });
      const baseMeta = metas.find((m) => m.kind === "base");
      sendJson(res, 200, listRuns(baseMeta ? resolve(baseMeta.outputDir) : resolve("output")));
      return;
    }

    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch {
          /* client gone */
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: `No such endpoint: ${method} ${path}` });
  }

  function handleStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const rel = (path === "/" ? "index.html" : path.replace(/^\/+/, "").split("?")[0]);
    const file = resolve(staticRoot, rel);
    if (!file.startsWith(staticRoot + sep) && file !== staticRoot) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, res, url.pathname, url).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: errMsg(error) });
        else res.end();
      });
      return;
    }
    handleStatic(req, res, url.pathname);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(`Port ${options.port ?? DEFAULT_PORT} is already in use. Pass a free port: omijobs dashboard --port 5212`);
    }
    throw error;
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;

  if (options.openBrowser !== false) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", windowsHide: true }).unref();
  }

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        clearInterval(watch);
        for (const client of clients) {
          try {
            client.end();
          } catch {
            /* ignore */
          }
        }
        clients.clear();
        server.close(() => resolveClose());
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard-server.test.ts`
Expected: all PASS. If the SSE test is flaky, increase the deadline to 8000ms.

- [ ] **Step 5: No commit.**

---

## Task 8: CLI `dashboard` command

**Files:**
- Modify: `src/cli.ts` (dispatch in `main()`, new `parseDashboardFlags` + `runDashboardCommand`, help text)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `startDashboard` from `./dashboardServer.js`.
- Produces: `omijobs dashboard [--port <number>]` runs the dashboard in the foreground; `--port` validated 1–65535; `process.exit(code)` is never reached while the server runs (Ctrl+C kills the process, per the spec's lifecycle choice). Export `parseDashboardFlags(argv): { port?: number; error?: string }` for tests.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts`:

```ts
describe("parseDashboardFlags", () => {
  it("parses --port and --port= forms", () => {
    expect(parseDashboardFlags(["--port", "5212"])).toEqual({ port: 5212 });
    expect(parseDashboardFlags(["--port=5213"])).toEqual({ port: 5213 });
    expect(parseDashboardFlags([])).toEqual({});
  });

  it("rejects bad ports and unknown flags", () => {
    expect(parseDashboardFlags(["--port", "abc"]).error).toBeDefined();
    expect(parseDashboardFlags(["--port", "0"]).error).toBeDefined();
    expect(parseDashboardFlags(["--port", "70000"]).error).toBeDefined();
    expect(parseDashboardFlags(["--bogus"]).error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `parseDashboardFlags` is not exported.

- [ ] **Step 3: Write the implementation**

`src/cli.ts` — add the import near the top:

```ts
import { startDashboard } from "./dashboardServer.js";
```

Add the flag parser (exported, near the other exports):

```ts
export function parseDashboardFlags(argv: string[]): { port?: number; error?: string } {
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const raw = argv[++i];
      if (raw === undefined) return { error: "--port requires a number" };
      port = Number(raw);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice(7));
    } else {
      return { error: `Unknown dashboard flag: ${a}` };
    }
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { error: "--port must be an integer in 1–65535" };
  }
  return { port };
}

async function runDashboardCommand(argv: string[]): Promise<number> {
  const { port, error } = parseDashboardFlags(argv);
  if (error) {
    console.error(`Error: ${error}`);
    console.log("Usage: omijobs dashboard [--port <number>]");
    return 2;
  }
  try {
    const { url } = await startDashboard({ port });
    console.log(`omijobs dashboard: ${url}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise(() => {}); // keep running until the user presses Ctrl+C
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
```

`main()` — add the dispatch before the fallback `runCommand`:

```ts
  } else if (argv[0] === "dashboard") {
    code = await runDashboardCommand(argv.slice(1));
  } else {
```

`printHelp()` — add the command line:

```
  dashboard [--port N]       Open the web dashboard (default port 5211)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: all PASS.

- [ ] **Step 5: No commit.**

---

## Task 9: Static shell — `dashboard/styles.css` + `dashboard/index.html`

**Files:**
- Create: `dashboard/index.html`
- Create: `dashboard/styles.css`

**Interfaces:**
- Consumes: nothing (pure static).
- Produces: the SPA shell the router (Task 10) fills. `index.html` loads `/app.js` as `type="module"`; `styles.css` defines the design-token CSS variables and every component class the views use (`.appbar`, `.nav`, `.btn`, `.btn-primary`, `.icon-btn`, `.card`, `.ticker`, `.stat`, `.table`, `.chip`, `.chip.applied/.uninterested`, `.callout`, `.callout.warn`, `.modal`, `.modal-backdrop`, `.eyebrow`, `.rec` (pulsing), `.mono`, `.log`, `.form-grid`, `.select`, `.input`, `.empty`, `.badge`, `.countdown`, `.codeblock`, `.hint`, `.docs`).

Component inventory (from the reference design, adapted):

| Class | Purpose |
|-------|---------|
| `.appbar` / `.appbar-brand` / `.appbar-nav` / `.appbar-actions` | fixed top bar, brand + nav + settings/theme icons |
| `.nav-item` / `.nav-item.active` | tab links with accent underline when active |
| `.rec` | pulsing record dot (accent when live, muted when idle) |
| `.eyebrow` | small mono uppercase label with dot |
| `.ticker` / `.stat` / `.stat b` | stat-card row (total + per-status) |
| `.card` / `.card h3` / `.gloss` | white surface cards |
| `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-danger` / `.icon-btn` | buttons |
| `.chip` / `.chip.applied` / `.chip.uninterested` / `.chip.unapplied` | status chips (good/warn/muted) |
| `.callout` / `.callout.warn` / `.callout.good` | warning / success banners |
| `.table` / `.table th` / `.table td` / `.row-click` | sticky-header data table |
| `.modal-backdrop` / `.modal` | detail/edit dialogs |
| `.mono` / `.log` / `.codeblock` | monospace panels |
| `.select` / `.input` / `.form-grid` / `.field > label` | form controls |
| `.countdown` | live countdown text (tabular figures) |
| `.empty` | empty-state block |
| `.badge` / `.badge.live` / `.badge.off` | running / stale / off badges |
| `.docs h1/h2/p/code/ul` | docs-page typography |

- [ ] **Step 1: Create `dashboard/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omijobs dashboard</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="appbar">
  <span class="appbar-brand"><span class="rec" id="live-dot"></span> omijobs</span>
  <nav class="appbar-nav" id="nav"></nav>
  <span class="appbar-actions">
    <button id="theme-toggle" class="icon-btn" title="Toggle light/dark">◐</button>
    <a href="#/settings" class="icon-btn" title="Settings" id="settings-link">⚙</a>
  </span>
</header>
<main id="view" class="wrap"></main>
<footer class="pagefoot">omijobs dashboard</footer>
<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `dashboard/styles.css`**

```css
:root {
  --bg: #F4F5F7; --ink: #1B2230; --muted: #5B6574; --faint: #929CAB;
  --line: #E2E6EC; --accent: #C01E33; --good: #1F7A4C; --warn: #A05A00;
  --surface: #FFFFFF; --shadow: 0 1px 3px rgba(27,34,48,.08);
  --serif: Georgia, "Times New Roman", serif;
  --sans: -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
}
[data-theme="dark"] {
  --bg: #14171D; --ink: #E9ECF1; --muted: #A6AFBD; --faint: #6B7484;
  --line: #2A313D; --accent: #FF5A66; --good: #34C77B; --warn: #E0A020;
  --surface: #1A1F28; --shadow: 0 1px 3px rgba(0,0,0,.4);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg); color: var(--ink); font: 17px/1.62 var(--sans);
}
a { color: var(--accent); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 88px 24px 80px; }

/* App bar */
.appbar {
  position: fixed; inset: 0 0 auto 0; z-index: 50; height: 56px;
  display: flex; align-items: center; gap: 24px; padding: 0 24px;
  background: var(--surface); border-bottom: 1px solid var(--line);
}
.appbar-brand { font: 600 17px var(--serif); letter-spacing: .2px; display: flex; align-items: center; gap: 10px; }
.appbar-nav { display: flex; gap: 4px; flex: 1; }
.nav-item {
  font: 500 14px var(--sans); color: var(--muted); text-decoration: none;
  padding: 6px 12px; border-radius: 8px; border: 1px solid transparent;
}
.nav-item:hover { color: var(--ink); background: var(--bg); }
.nav-item.active { color: var(--ink); border-color: var(--line); background: var(--bg); box-shadow: inset 0 -2px 0 var(--accent); }
.appbar-actions { display: flex; gap: 8px; }

/* Record dot */
.rec { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--muted); }
.rec.live { background: var(--accent); animation: pulse 1.6s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(192,30,51,.4); } 70% { box-shadow: 0 0 0 8px rgba(192,30,51,0); } 100% { box-shadow: 0 0 0 0 rgba(192,30,51,0); } }

/* Eyebrow */
.eyebrow { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .12em; color: var(--faint); display: flex; align-items: center; gap: 8px; }

/* Buttons */
.btn, .icon-btn {
  font: 500 14px var(--sans); color: var(--ink); cursor: pointer;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 14px; transition: filter .12s, border-color .12s;
}
.btn:hover, .icon-btn:hover { border-color: var(--faint); }
.btn:disabled, .icon-btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-ghost { background: transparent; }
.btn-danger { background: transparent; border-color: var(--accent); color: var(--accent); }
.icon-btn { padding: 6px 9px; font-size: 16px; line-height: 1; }
.btn.small, .icon-btn.small { padding: 3px 8px; font-size: 12px; }

/* Cards */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 18px; }
.card h2, .card h3 { font: 600 20px var(--serif); margin: 0 0 6px; }
.card h3 { font-size: 17px; }

/* Ticker stats */
.ticker { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.stat b { display: block; font: 600 26px var(--serif); }
.stat span { font: 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }

/* Table */
.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.table { width: 100%; border-collapse: collapse; font-size: 15px; }
.table th { position: sticky; top: 0; background: var(--surface); text-align: left; font: 600 12px var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--faint); padding: 10px 14px; border-bottom: 1px solid var(--line); }
.table td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
.table tr:last-child td { border-bottom: 0; }
.row-click { cursor: pointer; }
.row-click:hover td { background: var(--bg); }
.t-title { font-weight: 600; }
.t-meta { color: var(--muted); font-size: 13px; }
.t-time { font: 13px var(--mono); color: var(--faint); white-space: nowrap; }

/* Chips */
.chip { display: inline-block; font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.chip.applied { color: var(--good); border-color: currentColor; }
.chip.uninterested { color: var(--faint); }
.chip.unapplied { color: var(--accent); border-color: currentColor; }

/* Callouts */
.callout { border: 1px solid var(--line); border-left: 4px solid var(--faint); border-radius: 10px; padding: 12px 14px; margin: 12px 0; font-size: 14px; background: var(--surface); }
.callout.warn { border-left-color: var(--warn); color: var(--warn); }
.callout.good { border-left-color: var(--good); color: var(--good); }
.callout p { margin: 0; }

/* Badges (running / stale / off) */
.badge { display: inline-block; font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.badge.live { color: var(--accent); border-color: currentColor; animation: pulse 1.6s ease-out infinite; }
.badge.off { color: var(--faint); }
.badge.stale { color: var(--warn); border-color: currentColor; }

/* Forms */
.form-grid { display: grid; gap: 12px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field > label { display: block; font: 600 12px var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 4px; }
.input, .select { width: 100%; font: 15px var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.input:focus, .select:focus { outline: none; border-color: var(--accent); }
.hint { font-size: 13px; color: var(--faint); margin-top: 2px; }

/* Toast */
.toast { position: fixed; inset: auto 50% 22px auto; transform: translateX(50%); z-index: 200; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; font-size: 14px; box-shadow: var(--shadow); max-width: 70vw; }
.toast.warn { border-left: 4px solid var(--warn); }
.toast.good { border-left: 4px solid var(--good); }

/* Modal */
.modal-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(20,23,29,.45); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 24px 24px; overflow-y: auto; }
.modal { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 24px; max-width: 720px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,.2); }
.modal h3 { font: 600 20px var(--serif); margin: 0 0 12px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }

/* Mono panels */
.mono, .codeblock, .log { font: 13px/1.55 var(--mono); }
.codeblock { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 14px; overflow: auto; white-space: pre; }
.log { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; max-height: 260px; overflow: auto; white-space: pre-wrap; }

/* Countdown */
.countdown { font: 600 13px var(--mono); font-variant-numeric: tabular-nums; color: var(--accent); }

/* Empty state */
.empty { text-align: center; color: var(--faint); padding: 48px 0; font-size: 15px; }

/* Job detail rows */
.dl { display: grid; grid-template-columns: 110px 1fr; gap: 6px 14px; font-size: 15px; }
.dl dt { color: var(--muted); font: 600 12px var(--mono); text-transform: uppercase; letter-spacing: .06em; padding-top: 2px; }
.dl dd { margin: 0; }

/* Toolbar row (selects + search + sort) */
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; }
.toolbar .input { max-width: 280px; }

/* Docs typography */
.docs h1 { font: 700 30px var(--serif); margin: 0 0 4px; }
.docs h2 { font: 600 22px var(--serif); margin: 28px 0 8px; }
.docs h3 { font: 600 17px var(--serif); margin: 20px 0 6px; }
.docs p { color: var(--muted); }
.docs code { font: 13px var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
.docs ul { color: var(--muted); }

.pagefoot { position: fixed; inset: auto 0 0 0; padding: 8px 24px; font: 11px var(--mono); color: var(--faint); background: var(--surface); border-top: 1px solid var(--line); }
```

- [ ] **Step 3: No test cycle** (static files). Verify manually by opening the server's `/` in a browser after Task 10 exists — or just confirm the file parses as CSS. No commit.

---

## Task 10: `dashboard/api.js` + `dashboard/app.js` (router)

**Files:**
- Create: `dashboard/api.js`
- Create: `dashboard/app.js`

**Interfaces:**
- Consumes: the server routes from Task 7.
- Produces:
  - `api.js` exports: `api.get(path)`, `api.post(path, body?)`, `api.patch(path, body?)`, `api.put(path, body?)` (JSON, throw `ApiError(status, message)` on non-2xx), `api.onLive(cb)` (returns an `EventSource`; each broadcast is an unnamed SSE `data:` event whose payload is `{type, payload}` — calls `cb(type, payload)`), and `class ApiError`.
  - `app.js` exports the shared UI helpers the views import: `el(tag, attrs?, ...children)` (DOM builder; `onclick`/`onchange` props and `data-*` attrs supported), `esc(value)` (HTML-escape), `toast(message, kind?)`, `openModal(root)`, `closeModal()`, `fmtTime(iso)`, `fmtRel(iso)`, `fmtCountdown(iso)`. It owns the router: nav rendering, `#/route` hash routing, theme (persisted in `localStorage`), and a `live-dot` that turns on while any SSE connection is open.

Router contract: each view module in `dashboard/views/*.js` exports `render()` returning an `HTMLElement` (async OK), optional `mount(root)`, optional `unmount()`, optional `onLive(event)`. `app.js` calls `unmount()` on the outgoing view before rendering the new one, and forwards SSE events to the current view's `onLive`.

- [ ] **Step 1: Create `dashboard/api.js`**

```js
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function parse(res) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch { /* keep status text */ }
    throw new ApiError(res.status, msg);
  }
  return res.json();
}

export const api = {
  get: (path) => fetch(path).then(parse),
  post: (path, body = {}) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  patch: (path, body = {}) =>
    fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  put: (path, body = {}) =>
    fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(parse),
  onLive: (cb) => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const { type, payload } = JSON.parse(e.data);
        cb(type, payload);
      } catch { /* ignore malformed */ }
    };
    return es;
  },
};
```

- [ ] **Step 2: Create `dashboard/app.js`**

```js
import { api } from "./api.js";
import * as jobs from "./views/jobs.js";
import * as cron from "./views/cron.js";
import * as config from "./views/config.js";
import * as docs from "./views/docs.js";
import * as settings from "./views/settings.js";

const ROUTES = { jobs, cron, config, docs, settings };
const NAV = [["jobs", "Jobs"], ["cron", "Cron"], ["config", "Config"], ["docs", "Docs"]];
const $ = (id) => document.getElementById(id);

// --- DOM helpers (exported for views) ---
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "data") {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
    } else if (key === "html") {
      node.innerHTML = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- time helpers ---
export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
export function fmtRel(iso) {
  if (!iso) return "never";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ${ms >= 0 ? "ago" : "from now"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ${ms >= 0 ? "ago" : "from now"}`;
  return `${Math.round(h / 24)}d ${ms >= 0 ? "ago" : "from now"}`;
}
export function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// --- toast + modal ---
let toastTimer = null;
export function toast(message, kind = "") {
  let node = $("toast");
  if (!node) {
    node = el("div", { id: "toast", class: "toast" });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.display = "none"; }, 4000);
}
export function openModal(root) {
  const backdrop = el("div", { class: "modal-backdrop", onclick: () => backdrop.remove() });
  backdrop.append(root);
  document.body.append(backdrop);
  return backdrop;
}
export function closeModal() {
  document.querySelector(".modal-backdrop")?.remove();
}

// --- theme ---
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("omijobs-theme", theme);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀" : "☾";
}

// --- router ---
let current = null;
function routeName() {
  const h = location.hash.replace(/^#\//, "");
  return ROUTES[h] ? h : "jobs";
}
function renderNav(active) {
  const nav = $("nav");
  nav.replaceChildren(...NAV.map(([name, label]) =>
    el("a", { href: `#/${name}`, class: `nav-item${active === name ? " active" : ""}` }, label)));
}
async function render() {
  const name = routeName();
  renderNav(name);
  current?.unmount?.();
  const view = ROUTES[name];
  current = view;
  const root = await view.render();
  $("view").replaceChildren(root);
  view.mount?.(root);
}
window.addEventListener("hashchange", render);

// --- live events ---
const liveDot = $("live-dot");
api.onLive((event) => {
  liveDot.classList.add("live");
  current?.onLive?.(event);
});

$("theme-toggle").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
applyTheme(localStorage.getItem("omijobs-theme") || "light");

render();
```

Note: the `el` helper's `onclick` binding means `el("button", { onclick: () => ... })` works. Views must NOT use inline `innerHTML` for user data — always `esc()` it.

- [ ] **Step 3: No test cycle** (static files). No commit.

---

## Task 11: `dashboard/views/jobs.js`

**Files:**
- Create: `dashboard/views/jobs.js`

**Interfaces:**
- Consumes: `api`, `ApiError` from `../api.js`; `el, esc, toast, openModal, fmtTime, fmtRel` from `../app.js`.
- Produces: the Jobs view — purely DB-based, per the spec: a source selector (each option labeled with the **absolute DB path**), a ticker (total + unapplied/applied/uninterested), filters (status, text, sort field + direction), a sticky-header table (posted_at, title, company, location, status chip) sorted by `posted_at desc` by default, a detail modal (description + meta + analysis only when present) on row click, and status controls (apply / uninterested / unapplied) that PATCH the row. Polls every 5s while mounted and refreshes on `db` SSE events. Handles the `unreadable` DB case (`info.error`) with a callout.

- [ ] **Step 1: Write the view**

```js
import { api, ApiError } from "../api.js";
import { el, esc, toast, openModal, fmtTime, fmtRel } from "../app.js";

const STATUSES = ["unapplied", "applied", "uninterested"];
const state = {
  sources: [],
  key: null,
  status: "",
  q: "",
  sort: "posted_at",
  dir: "desc",
  list: null,
  info: null,
  timer: null,
};

async function refreshSources() {
  state.sources = await api.get("/api/dbs");
  if (!state.key && state.sources.length) state.key = state.sources[0].key;
  if (state.key && !state.sources.some((s) => s.key === state.key)) state.key = state.sources[0]?.key ?? null;
}
async function refresh() {
  try {
    await refreshSources();
    state.info = state.sources.find((s) => s.key === state.key) ?? null;
    state.list = state.key
      ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&limit=500`)
      : null;
    const view = document.getElementById("jobs-root");
    if (view) view.replaceChildren(renderBody());
  } catch (error) {
    toast(error.message, "warn");
  }
}

export function onLive(event) {
  if (event === "db" || event === "runs") refresh();
}
export function mount() {
  state.timer = setInterval(refresh, 5000);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
}

function chip(status) {
  return el("span", { class: `chip ${esc(status)}` }, status);
}

async function openDetail(sig) {
  const detail = await api.get(`/api/jobs/${state.key}/${encodeURIComponent(sig)}`);
  const job = detail.job ?? {};
  const rows = [];
  const push = (label, value) => { if (value != null && value !== "") rows.push(el("dt", {}, label), el("dd", {}, value)); };
  push("Title", job.title);
  push("Company", job.company);
  push("Location", job.location);
  push("Posted", fmtTime(detail.postedAt));
  push("Source", job.source);
  push("Apply URL", job.apply_url ? el("a", { href: job.apply_url, target: "_blank", rel: "noopener" }, job.apply_url) : null);
  if (detail.analysis) rows.push(el("dt", {}, "Analysis"), el("dd", {}, el("pre", { class: "codeblock" }, JSON.stringify(detail.analysis, null, 2))));
  if (job.description) rows.push(el("dt", {}, "Description"), el("dd", {}, job.description));
  const modal = el("div", { class: "modal" },
    el("h3", {}, esc(job.title || sig)),
    el("p", { class: "hint" }, esc(job.company || "") + (job.location ? ` · ${esc(job.location)}` : "")),
    el("dl", { class: "dl" }, ...rows),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-primary", onclick: () => setStatus(sig, "applied", modal) }, "Apply"),
      el("button", { class: "btn btn-ghost", onclick: () => setStatus(sig, "uninterested", modal) }, "Not interested"),
      el("button", { class: "btn btn-ghost", onclick: () => close(modal) }, "Close"),
    ),
  );
  openModal(modal);
  function close(node) { node.closest(".modal-backdrop")?.remove(); }
}

async function setStatus(sig, status, modal) {
  try {
    await api.patch("/api/jobs", { dbKey: state.key, signature: sig, status });
    modal.closest(".modal-backdrop")?.remove();
    toast(`Marked ${esc(status)}`, "good");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function renderTicker() {
  const info = state.info;
  const by = info?.byStatus ?? {};
  const cards = [
    ["total", info?.total ?? 0],
    ["unapplied", by.unapplied ?? 0],
    ["applied", by.applied ?? 0],
    ["uninterested", by.uninterested ?? 0],
  ];
  return el("div", { class: "ticker" }, ...cards.map(([label, n]) =>
    el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, label))));
}

function renderTable() {
  const list = state.list;
  if (!list) return el("div", { class: "empty" }, "No source selected.");
  if (list.total === 0) return el("div", { class: "empty" }, "No jobs match the current filter.");
  const head = el("tr", {},
    ...(["posted_at", "title", "company", "location", "status"].map((key) =>
      el("th", { onclick: () => { if (state.sort === key) state.dir = state.dir === "desc" ? "asc" : "desc"; else { state.sort = key; state.dir = "desc"; } refresh(); } },
        `${key}${state.sort === key ? (state.dir === "desc" ? " ↓" : " ↑") : ""}`))),
  );
  const body = list.rows.map((row) =>
    el("tr", { class: "row-click", onclick: () => openDetail(row.signature) },
      el("td", { class: "t-time" }, fmtRel(row.postedAt)),
      el("td", {}, el("span", { class: "t-title" }, esc(row.job.title || row.signature.slice(0, 8)))),
      el("td", {}, esc(row.job.company ?? "")),
      el("td", {}, esc(row.job.location ?? "")),
      el("td", {}, chip(row.status))));
  return el("div", { class: "table-wrap" },
    el("table", { class: "table" },
      el("thead", {}, head),
      el("tbody", {}, ...body)));
}

function renderBody() {
  const info = state.info;
  const srcOpts = state.sources.map((s) => {
    const name = s.key === "base" ? "default (jobs.db)" : s.key;
    return el("option", { value: s.key }, `${name} — ${s.path}`);
  });
  const source = el("div", {},
    el("label", { class: "eyebrow" }, "Source"),
    el("select", {
      class: "select",
      onchange: (e) => { state.key = e.target.value; state.info = state.sources.find((s) => s.key === state.key); refresh(); },
    }, srcOpts));
  const statusFilter = el("select", {
    class: "select",
    onchange: (e) => { state.status = e.target.value; refresh(); },
  },
    el("option", { value: "" }, "any status"),
    ...STATUSES.map((s) => el("option", { value: s }, s)));
  const search = el("input", {
    class: "input",
    placeholder: "search title / company / location…",
    value: state.q,
    oninput: (e) => { state.q = e.target.value.trim(); refresh(); },
  });
  const body = [];
  if (info?.error) {
    body.push(el("div", { class: "callout warn" },
      el("p", {}, `Could not read this DB: ${esc(info.error)}. If the cron gateway is writing to it right now, wait a moment and refresh.`)));
  }
  body.push(el("div", { class: "toolbar" }, source, statusFilter, search));
  body.push(renderTicker());
  body.push(renderTable());
  return el("div", { id: "jobs-root" }, ...body);
}

export async function render() {
  await refreshSources();
  return el("div", {},
    el("p", { class: "eyebrow" }, "Jobs"),
    el("h2", { class: "docs" }, "Saved jobs"),
    renderBody());
}
```

- [ ] **Step 2: No test cycle** (static). No commit.

---

## Task 12: `dashboard/views/cron.js`

**Files:**
- Create: `dashboard/views/cron.js`

**Interfaces:**
- Consumes: `api` from `../api.js`; `el, esc, toast, openModal, fmtCountdown, fmtRel` from `../app.js`.
- Produces: the Cron view — gateway header (live rec dot, paused/resumed chip, start/stop/restart/pause/resume buttons, autostart state, gateway pid + stale label, cron.log tail in a `.log` panel), per-job cards (name, schedule, enabled toggle, **Run now via `POST /api/configs/:id/run`** — works even with the gateway down, `running` badge + live countdown to `nextRunAt`, resolved DB path from the `/api/configs` map, last run time + status, enable/disable/remove), and an Add cron form (unique name, schedule with datalist, storage radio shared/separate, queries, portal checkboxes). Refreshes every 3s and on `cron`/`state` SSE events; countdowns tick every 1s. Config mutations run through `POST /api/cron/:action` and `POST /api/cron/add`, surfacing CLI output in a toast; duplicate-name 409s show the error.

- [ ] **Step 1: Write the view**

```js
import { api } from "../api.js";
import { el, esc, toast, openModal, fmtCountdown, fmtRel } from "../app.js";

const SCHEDULE_EXAMPLES = ["every 30m", "every 6 hours", "every 2 days", "daily at 09:00", "weekdays at 09:00", "weekends at 10:00", "monday at 09:00", "hourly", "daily", "weekly"];
const state = { data: null, bootstrap: null, configDbs: {}, refreshTimer: null, tickTimer: null };

async function refresh() {
  try {
    state.data = await api.get("/api/cron");
    if (!state.bootstrap) state.bootstrap = await api.get("/api/bootstrap");
    // Map each config id → its resolved DB path so job cards can show it.
    const configs = await api.get("/api/configs");
    state.configDbs = Object.fromEntries(configs.map((m) => [m.id, m.db.enabled ? m.db.path : null]));
    const root = document.getElementById("cron-root");
    if (root) root.replaceChildren(renderBody());
    loadLog();
  } catch (error) {
    toast(error.message, "warn");
  }
}

// Tick every second so every countdown span re-reads its data-next timestamp;
// nothing else changes, so this is cheap and avoids rebuilding the DOM.
function tickCountdowns() {
  for (const node of document.querySelectorAll(".countdown[data-next]")) {
    node.textContent = fmtCountdown(node.dataset.next);
  }
}

export function onLive(event) {
  if (event === "cron" || event === "state") refresh();
}
export function mount() {
  state.refreshTimer = setInterval(refresh, 3000);
  state.tickTimer = setInterval(tickCountdowns, 1000);
  refresh();
}
export function unmount() {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
}

async function mutate(action, id) {
  try {
    const body = await api.post(`/api/cron/${action}`, id ? { id } : {});
    if (body.output) toast(body.output.trim().split("\n").pop(), body.ok ? "good" : "warn");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function gatewayHeader() {
  const d = state.data;
  const gw = d.gateway;
  const rec = el("span", { class: `rec${gw.running ? " live" : ""}` });
  const statusText = gw.running ? `running (pid ${gw.pid})` : gw.stale ? "stale (gateway down)" : "not running";
  const badge = gw.running ? el("span", { class: "badge live" }, statusText)
    : gw.stale ? el("span", { class: "badge stale" }, statusText)
    : el("span", { class: "badge off" }, statusText);
  const btns = [
    el("button", { class: "btn btn-primary", disabled: gw.running, onclick: () => mutate("start") }, "Start"),
    el("button", { class: "btn", disabled: !gw.running, onclick: () => mutate("stop") }, "Stop"),
    el("button", { class: "btn", disabled: !gw.running, onclick: () => mutate("restart") }, "Restart"),
    el("button", { class: "btn", onclick: () => mutate(d.paused ? "resume" : "pause") }, d.paused ? "Resume" : "Pause"),
  ];
  return el("div", { class: "card" },
    el("p", { class: "eyebrow" }, "Cron gateway"),
    el("div", { class: "toolbar" }, rec, badge, ...btns),
    el("p", { class: "hint" }, `Auto-start at login: ${esc(gw.autostart)} · state: ${esc(d.file)}`),
    el("div", { class: "log", id: "cron-log" }, "loading log…"));
}

async function loadLog() {
  try {
    const { lines } = await api.get("/api/cron/log");
    const log = document.getElementById("cron-log");
    if (log) log.textContent = lines.length ? lines.join("\n") : "(no log lines yet)";
  } catch { /* ignore */ }
}

function jobCard(job, gwRunning) {
  const running = job.running;
  const statusText = running
    ? (gwRunning ? "running now" : "running (stale — gateway down)")
    : (job.lastStatus ?? "never run");
  const badge = running
    ? el("span", { class: `badge ${gwRunning ? "live" : "stale"}` }, statusText)
    : el("span", { class: "badge off" }, statusText);
  // Always a countdown span (data-next drives the 1s ticker), even when not
  // running — the card just stops updating the text to a static "next: …".
  const countdown = el("span", { class: "countdown", "data": { next: job.nextRunAt } }, `next: ${fmtCountdown(job.nextRunAt)}`);
  const controls = [
    el("button", { class: "btn small", disabled: running, onclick: () => runNow(job) }, "Run now"),
    el("button", { class: "btn small", onclick: () => mutate(job.enabled ? "disable" : "enable", job.id) }, job.enabled ? "Disable" : "Enable"),
    el("button", { class: "btn small btn-danger", onclick: () => removeJob(job) }, "Remove"),
  ];
  const dbPath = state.configDbs[job.id];
  return el("div", { class: "card", "data": { cron: job.id } },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(job.id)),
      badge,
      countdown),
    el("p", { class: "hint" }, `schedule: ${esc(job.schedule)} · config: ${esc(job.config)}`),
    dbPath ? el("p", { class: "hint" }, `db: ${esc(dbPath)}`) : null,
    el("p", { class: "hint" }, `last run: ${fmtRel(job.lastRun)} (${esc(statusText)})`),
    el("div", { class: "toolbar" }, ...controls));
}

// Run now spawns the real CLI (POST /api/configs/:id/run), so it works even
// when the gateway is down; the dashboard's in-flight guard returns 409 for a
// config that is already running, which disables the button via the next refresh.
async function runNow(job) {
  try {
    const body = await api.post(`/api/configs/${job.id}/run`);
    toast(`Started a run for "${job.id}" (${body.runId})`, "good");
    refresh();
  } catch (error) {
    toast(error.message, error.status === 409 ? "warn" : "warn");
  }
}

async function removeJob(job) {
  if (!confirm(`Remove cron job "${job.id}"? This does not delete its config file.`)) return;
  await mutate("remove", job.id);
}

function renderBody() {
  const d = state.data;
  if (d.error) {
    return el("div", { id: "cron-root" },
      el("div", { class: "callout warn" }, el("p", {}, esc(d.error))),
      gatewayHeader());
  }
  return el("div", { id: "cron-root" },
    gatewayHeader(),
    el("p", { class: "eyebrow" }, "Jobs"),
    ...d.jobs.map((j) => jobCard(j, d.gateway.running)),
    addCronCard());
}

function addCronCard() {
  const name = el("input", { class: "input", placeholder: "e.g. Finance Intern" });
  const schedule = el("input", { class: "input", list: "sched-examples", placeholder: "e.g. every 6 hours" });
  const queries = el("input", { class: "input", placeholder: "comma-separated queries (blank = base queries)" });
  const portalChecks = (state.bootstrap?.adapters ?? []).map((a) =>
    el("label", {}, el("input", { type: "checkbox", value: a.id }), ` ${esc(a.name)}`));
  const shared = el("input", { type: "radio", name: "storage", value: "shared", checked: true });
  const separate = el("input", { type: "radio", name: "storage", value: "separate" });
  const form = el("form", { class: "form-grid" },
    el("div", { class: "form-row" },
      el("div", { class: "field" }, el("label", {}, "Name (unique)"), name, el("div", { class: "hint" }, "Becomes the cron id and, for separate storage, the DB filename.")),
      el("div", { class: "field" }, el("label", {}, "Schedule"), schedule,
        el("datalist", { id: "sched-examples" }, ...SCHEDULE_EXAMPLES.map((s) => el("option", { value: s })))),
    ),
    el("div", { class: "field" }, el("label", {}, "Queries"), queries),
    el("div", { class: "field" }, el("label", {}, "Adapters"),
      el("div", { class: "toolbar" }, ...portalChecks)),
    el("div", { class: "field" },
      el("label", {}, "Where do results go?"),
      el("div", {},
        el("label", {}, shared, " shared jobs.db (same as normal runs) "),
        el("label", {}, separate, " separate <name>.db"),
      )),
    el("button", { class: "btn btn-primary", type: "submit" }, "Add cron job"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const portals = [...form.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    try {
      const body = await api.post("/api/cron/add", {
        name: name.value.trim(),
        schedule: schedule.value.trim(),
        queries: queries.value.split(",").map((s) => s.trim()).filter(Boolean),
        enabledPortals: portals,
        storage: form.querySelector("input[name=storage]:checked").value,
      });
      toast(body.output?.trim().split("\n")[0] ?? "Added", "good");
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  });
  return el("div", { class: "card" },
    el("p", { class: "eyebrow" }, "Add cron"),
    el("h3", {}, "New scheduled run"),
    form);
}

export async function render() {
  if (!state.data) await refresh();
  loadLog();
  const root = document.createElement("div");
  if (state.data) root.append(gatewayHeader(), ...state.data.jobs.map((j) => jobCard(j, state.data.gateway.running)), addCronCard());
  else root.append(el("div", { class: "empty" }, "Loading…"));
  root.id = "cron-root";
  return root;
}
```

- [ ] **Step 2: No test cycle** (static). No commit.

---

## Task 13: `dashboard/views/config.js`

**Files:**
- Create: `dashboard/views/config.js`

**Interfaces:**
- Consumes: `api` from `../api.js`; `el, esc, toast, openModal, fmtRel` from `../app.js`.
- Produces: the Config view — a card per config (`base` + every cron config), each showing name, kind, relative path, **the absolute DB path** (+ exists badge / job count — `GET /api/configs` fills `db.jobCount`, so `meta.db.jobCount` is always present here even though `ConfigMeta` itself doesn't declare it), queries, enabled adapters; buttons Edit, Run now (409 on in-flight → explain), and (for cron configs) a note that its jobs live on the Cron page. The Edit modal has a friendly form (queries, adapter checkboxes, storage radio shared/separate/custom for cron configs, a DB-enabled toggle) plus an Advanced textarea loaded with the **full raw config via `GET /api/configs/:id`**. Two save actions: **Save** sends the friendly payload through `api.put`; **Apply JSON** parses the textarea and sends `api.put` with `{raw: parsed}` (toasts on invalid JSON). Saving with `db.enabled: false` shows a warning callout first ("The dashboard Jobs page won't show results from this config."); a `dbWarning` response renders the warning after save.

- [ ] **Step 1: Write the view**

```js
import { api } from "../api.js";
import { el, esc, toast, openModal, fmtRel } from "../app.js";

const state = { configs: [], bootstrap: null, timer: null };

async function refresh() {
  try {
    state.configs = await api.get("/api/configs");
    if (!state.bootstrap) state.bootstrap = await api.get("/api/bootstrap");
    const root = document.getElementById("config-root");
    if (root) root.replaceChildren(renderBody());
  } catch (error) {
    toast(error.message, "warn");
  }
}

export function onLive(event) {
  if (event === "db" || event === "runs") refresh();
}
export function mount() {
  state.timer = setInterval(refresh, 5000);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
}

async function runNow(meta) {
  try {
    const body = await api.post(`/api/configs/${meta.id}/run`);
    toast(`Started a run for "${meta.id}" (${body.runId})`, "good");
  } catch (error) {
    toast(error.message, error.status === 409 ? "warn" : "warn");
  }
}

function configCard(meta) {
  const dbPath = meta.db.path;
  const dbBadge = meta.db.enabled
    ? el("span", { class: `badge ${meta.db.exists ? "live" : "off"}` }, meta.db.exists ? `db: ${meta.db.jobCount} jobs` : "db: not created yet")
    : el("span", { class: "badge stale" }, "db disabled");
  return el("div", { class: "card" },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(meta.id)),
      el("span", { class: "hint" }, meta.kind === "base" ? "base config" : "cron config"),
      dbBadge),
    el("p", { class: "hint" }, `queries: ${esc(meta.queries.join(", ") || "(none)")}`),
    el("p", { class: "hint" }, `adapters: ${esc(meta.enabledPortals.join(", ") || "(none)")}`),
    el("p", { class: "mono" }, `config: ${esc(meta.rel)}`),
    el("p", { class: "mono" }, `db: ${esc(dbPath)}`),
    el("div", { class: "toolbar" },
      el("button", { class: "btn", onclick: () => editModal(meta) }, "Edit"),
      el("button", { class: "btn btn-primary", onclick: () => runNow(meta) }, "Run now")));
}

function editModal(meta) {
  const queries = el("input", { class: "input", value: meta.queries.join(", ") });
  const adapterChecks = (state.bootstrap?.adapters ?? []).map((a) => {
    const on = meta.enabledPortals.includes(a.id);
    return el("label", {}, el("input", { type: "checkbox", value: a.id, checked: on }), ` ${esc(a.name)}`);
  });
  const shared = el("input", { type: "radio", name: "storage", value: "shared", checked: meta.db.file === "jobs.db" && meta.db.enabled });
  const separate = el("input", { type: "radio", name: "storage", value: "separate", checked: meta.db.file.endsWith(".db") && meta.db.file !== "jobs.db" && meta.db.enabled });
  const custom = el("input", { type: "radio", name: "storage", value: "custom", checked: !shared.checked && !separate.checked });
  const dbEnabled = el("input", { type: "checkbox", checked: meta.db.enabled });
  const raw = el("textarea", { class: "input codeblock", rows: 10, spellcheck: "false" });
  raw.value = "loading…";
  const modal = el("div", { class: "modal" },
    el("h3", {}, `Edit ${esc(meta.id)}`),
    el("div", { class: "callout warn", id: "db-warning", style: "display:none" },
      el("p", {}, "This config has DB writes disabled — the dashboard Jobs page will not show its results.")),
    el("div", { class: "form-grid" },
      el("div", { class: "field" }, el("label", {}, "Queries"), queries),
      el("div", { class: "field" }, el("label", {}, "Adapters"), el("div", { class: "toolbar" }, ...adapterChecks)),
      meta.kind === "cron" ? el("div", { class: "field" },
        el("label", {}, "Storage"),
        el("div", {},
          el("label", {}, shared, " shared jobs.db "),
          el("label", {}, separate, " separate <name>.db "),
          el("label", {}, custom, " custom (advanced)"))) : null,
      el("div", { class: "field" }, el("label", {}, "Aggregate DB"), el("label", {}, dbEnabled, " enabled (dashboard depends on it)")),
      el("div", { class: "field" }, el("label", {}, "Advanced (raw JSON)"), raw,
        el("div", { class: "hint" }, "The full config file — edited here and applied verbatim via Apply JSON.")),
    ),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-primary", onclick: () => save() }, "Save"),
      el("button", { class: "btn", onclick: () => applyJson() }, "Apply JSON"),
      el("button", { class: "btn btn-ghost", onclick: () => backdrop.remove() }, "Cancel")));
  const backdrop = openModal(modal);

  // Load the FULL raw RunConfig into the advanced editor on open.
  api.get(`/api/configs/${meta.id}`).then(({ config }) => {
    raw.value = JSON.stringify(config, null, 2);
  }).catch(() => { raw.value = ""; });

  function showWarning() {
    document.getElementById("db-warning").style.display = "block";
  }

  async function save() {
    const warning = document.getElementById("db-warning");
    warning.style.display = "none";
    const willDisable = !dbEnabled.checked;
    if (willDisable && !confirm("Disabling the aggregate DB means the dashboard Jobs page will not show results from this config. Continue?")) return;
    const payload = { queries: queries.value.split(",").map((s) => s.trim()).filter(Boolean), dbEnabled: dbEnabled.checked };
    if (meta.kind === "cron") {
      payload.storage = document.querySelector(`input[name=storage]:checked`)?.value;
    }
    payload.enabledPortals = [...adapterChecks].filter((c) => c.firstChild.checked).map((c) => c.firstChild.value);
    try {
      const body = await api.put(`/api/configs/${meta.id}`, payload);
      if (body.dbWarning) showWarning();
      toast(`Saved ${esc(meta.id)}`, "good");
      backdrop.remove();
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  }

  async function applyJson() {
    let parsed;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      toast("Invalid JSON — nothing was applied", "warn");
      return;
    }
    try {
      const body = await api.put(`/api/configs/${meta.id}`, { raw: parsed });
      if (body.dbWarning) showWarning();
      toast(`Applied JSON to ${esc(meta.id)}`, "good");
      backdrop.remove();
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  }
}

function renderBody() {
  return el("div", { id: "config-root" },
    el("p", { class: "eyebrow" }, "Config"),
    el("h2", { class: "docs" }, "Configuration"),
    el("p", { class: "hint" }, "The base config drives normal runs; each cron job has its own config file."),
    ...state.configs.map(configCard));
}

export async function render() {
  if (!state.configs.length) await refresh();
  return renderBody();
}
```

- [ ] **Step 2: No test cycle** (static). No commit.

---

## Task 14: `dashboard/views/docs.js` + `dashboard/views/settings.js`

**Files:**
- Create: `dashboard/views/docs.js`
- Create: `dashboard/views/settings.js`

**Interfaces:**
- Consumes: `el, esc` from `../app.js`; `api` from `../api.js` (settings).
- Produces: the Docs view (dashboard-only: how to use each page + a quickstart — NOT the CLI docs) and the Settings view (theme toggle, server info: package dir, state dir, config path, cron path, cli path, port, autostart state).

- [ ] **Step 1: Create `dashboard/views/docs.js`**

```js
import { el } from "../app.js";

function h1(text) { return el("h1", {}, text); }
function h2(text) { return el("h2", {}, text); }
function h3(text) { return el("h3", {}, text); }
function p(children) { return el("p", {}, children); }
function code(text) { return el("code", {}, text); }
function li(text) { return el("li", {}, text); }

export async function render() {
  return el("div", { class: "docs" },
    h1("omijobs dashboard"),
    p([`A visual layer over the `, code("omijobs"), ` CLI. Nothing here replaces the CLI — the dashboard reads the same configs, cron file, and SQLite databases, and every control it has runs the real CLI under the hood.`]),

    h2("Quickstart"),
    p([`Run `, code("omijobs dashboard"), ` from the project folder. Your browser opens to `, code("http://127.0.0.1:5211"), `. Press Ctrl+C in the terminal to stop it. Pass `, code("--port 5212"), ` if the default port is taken.`]),

    h2("Jobs"),
    p([`Everything here is read from the aggregate SQLite databases (`, code("jobs.db"), ` per config unless a cron uses separate storage). Pick a source in the dropdown — the label shows the exact file path. Click any row to see the full posting and to mark it `, code("applied"), ` or `, code("uninterested"), ` (or back to `, code("unapplied"), `). Filter by status, search title/company/location, and sort by column.`]),
    p([`Rows come from every run, deduped by title+company+location, so the same job seen across portals appears once.`]),

    h2("Cron"),
    p([`The gateway is the process that wakes up on a schedule and runs jobs. The top card shows whether it is up, lets you `, code("start"), `/`, code("stop"), `/`, code("restart"), `/`, code("pause"), ` it, and tails its log. A pulsing dot means it is running.`]),
    p([`Each scheduled job is its own card: its schedule, whether it is enabled, the countdown to the next run, and its last status. While a run is in flight the card shows `, code("running now"), ` and the Run now button is disabled — a run cannot overlap itself.`]),
    p([`Create a job with the form at the bottom. Names must be unique. Pick shared storage (results land in the normal `, code("jobs.db"), `) or separate storage (a dedicated `, code("<name>.db"), `).`]),

    h2("Config"),
    p([`The base config drives normal runs. Each cron job has its own config file. Edit queries and enabled adapters here; the advanced box shows the raw JSON. If you disable the aggregate DB for a config, the dashboard warns you because the Jobs page reads those databases.`]),

    h2("Settings"),
    p([`Theme toggle and the environment paths the dashboard is wired to.`]),
  );
}
```

- [ ] **Step 2: Create `dashboard/views/settings.js`**

```js
import { api } from "../api.js";
import { el, esc } from "../app.js";

const state = { info: null };

async function refresh() {
  try {
    state.info = await api.get("/api/bootstrap");
  } catch { /* keep last */ }
}

export function mount() { refresh(); }
export async function render() {
  await refresh();
  const info = state.info;
  if (!info) return el("div", { class: "empty" }, "Loading…");
  const rows = [
    ["Port", String(info.port)],
    ["Package dir", info.packageDir],
    ["State dir", info.stateDir],
    ["Base config", info.configPath],
    ["Cron file", info.cronPath],
    ["CLI", info.cliPath],
    ["Adapters", info.adapters.map((a) => `${a.id} (${a.family})`).join(", ")],
  ];
  return el("div", {},
    el("p", { class: "eyebrow" }, "Settings"),
    el("h2", { class: "docs" }, "Dashboard"),
    el("div", { class: "card" },
      el("h3", {}, "Appearance"),
      el("p", {}, "Toggle the theme from the sun/moon button in the top bar. Your choice is remembered.")),
    el("div", { class: "card" },
      el("h3", {}, "Environment"),
      el("dl", { class: "dl" }, ...rows.map(([k, v]) => [el("dt", {}, esc(k)), el("dd", { class: "mono" }, esc(v))]).flat())),
  );
}
```

- [ ] **Step 3: No test cycle** (static). No commit.

---

## Task 15: End-to-end smoke test

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–14.

- [ ] **Step 1: Build and run the full suite**

Run: `npm test`
Expected: all tests pass, including the five new dashboard test files.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no type errors. (If `tsc --noEmit` isn't a configured script, run `npx tsc -p . --noEmit` from `omi-job-fetch/`.)

- [ ] **Step 3: Manual smoke**

Run: `npm run build` then `node dist/cli.js dashboard --port 5211` from `omi-job-fetch/`.
Expected:
- Prints `omijobs dashboard: http://127.0.0.1:5211` and `Press Ctrl+C to stop.`; the browser opens; Ctrl+C stops it.
- Jobs page shows the base source `default (jobs.db)` with a path ending in `jobs.db`, the ticker, and rows after a run has been done.
- Cron page shows the gateway card (Start enabled when stopped), the `finance` job if present in cron.json, and can add a job with unique naming + separate storage producing a `<name>.db` in `output/`.
- Config page edits queries and shows the DB-disabled warning.
- Docs page renders; Settings page shows paths; the theme toggle flips and persists.

- [ ] **Step 4: No commit.**

---

## Plan Self-Review

Reviewed against the spec (`docs/superpowers/specs/2026-08-19-dashboard-design.md`) before handing off.

### 1. Spec coverage

| Spec requirement | Plan task |
| --- | --- |
| DB enabled by default; every config produces a DB entry; Jobs view purely DB-based | Task 1 (`config.db?.enabled !== false` default + tests), Tasks 3–4, Task 11 |
| Dashboard relies on the DB; warn when the user disables it | Task 1, Task 13 (`dbEnabled` toggle + disable confirm + `dbWarning` callout) |
| Zero runtime deps; node >= 24; `node:sqlite` via `createRequire` | Global Constraints; Task 4 (replicated `createRequire` pattern) |
| Mutations spawn the real CLI, never reimplement the backend ("a UI click is literally the terminal command") | Tasks 5, 7, 12 (`runCronMutation`, `POST /api/cron/:action`, `POST /api/cron/add`), Task 13 (`PUT /api/configs/:id` is the one in-process write) |
| Cron per-job **Run now** → `POST /api/configs/:id/run` (spawns `node <cli> run --config <path>` with `OMI_JOB_FETCH_TRIGGER=dashboard`), 409 on in-flight | Task 7 route + Task 12 `runNow(job)`; dashboard-inflight blocked via `inflight` set, and `GET /api/cron` lights the same `running` badge |
| Config edits: the one in-process write, atomic temp+rename; cron config *creation* in-process then `cron add` spawned | Task 3 (`writeConfig` atomic), Task 7 (`POST /api/cron/add`) |
| `PUT /api/configs/:id` accepts `{queries?, enabledPortals?, raw?}` | Task 3 `applyFriendlyUpdate` / `FriendlyPatch`, Task 7 route, Task 13 friendly + Apply JSON actions |
| Gateway header: rec dot, autostart, Pause/Resume, Start/Stop/Restart, cron.log tail | Task 12 `gatewayHeader()` + `/api/cron/log` |
| Per-job card: schedule, enabled chip, last run + status, "running now" pulsing, live countdown ticking client-side, resolved DB path, Run now (disabled while running, allowed with gateway down) | Task 12 `jobCard()` + 1s `tickCountdowns` + `configDbs` map |
| Add cron modal: unique name, schedule builder, storage choice, new-from-base or existing config | Task 7 `POST /api/cron/add` (409 on duplicate), Task 12 `addCronCard()` |
| Settings = theme, port/state-dir info, advanced base config editors | Task 14 |
| In scope: `running` sentinel + log streaming for dashboard-initiated runs | Task 2 (cron.ts sentinel), Task 6/7 (`startRun` streams lines to SSE `runs` events) |

### 2. Placeholder scan

No "TBD"/"TODO"/"implement later". Every task's steps contain complete code and exact expected output. The self-review found and fixed the plan's own placeholders: the `runId: "spawned"` stub in `POST /api/configs/:id/run` (now the real `startRun` id), the Task 13 raw editor that "loaded a lossy reconstruction and never sent" (now a full `GET /api/configs/:id` load + two save actions), and the `api.put ? api.patch(...) : null` fallback (now a real `put` helper).

### 3. Type consistency

- `ConfigMeta`, `ConfigDb`, `DbInfo`, `JobListRow`, `JobListResult`, `CronGatewayState`, `CronJobState`, `RunMeta` — each defined once and referenced by the same names across Tasks 3–15.
- `JobListQuery.sort` is `string` (invalid values fall back to `"posted_at"`), matching `SORTERS: Record<string, …>` and the server's unvalidated `q.get("sort")`.
- `cb(type, payload)` SSE contract is consistent end-to-end: server broadcasts unnamed `data:` events with `{type, payload}` (Task 7), `api.onLive(cb)` parses and forwards `(type, payload)` (Task 10), views' `onLive(event)` compare the type string (Tasks 11–13).
- `api.put` exists in Task 10 and is used by Task 13; no leftover `api.patch` for the PUT endpoint.
- Cron page's per-job Run now and Config page's Run now both hit `POST /api/configs/:id/run`; the config id equals the cron job id for cron configs, and `inflight` (keyed by that same id) backs both the 409 and the `running` badge.
- `GET /api/configs` fills `db.jobCount` on the response even though `ConfigMeta` doesn't declare it — documented in Task 13's Interfaces.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-19-dashboard.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

