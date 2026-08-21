# Analysis Tab — AI Job Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-backed AI analysis for aggregate job databases, expose progress and recommendations in the CLI and dashboard, and support scheduled analysis crons without allowing concurrent analysis of the same resolved database.

**Architecture:** Keep provider I/O, response extraction, configuration, SQLite mutations, and the analysis loop in focused TypeScript modules. The CLI owns detached process lifecycle and the global path-keyed lock; the dashboard reads state files and starts/stops the CLI, while existing run and cron machinery remains the process orchestration boundary. The browser adds an Analysis view and additive score/filter/detail behavior to Jobs, with the server as the only route/config authority.

**Tech Stack:** Node.js >=24, TypeScript, built-in `fetch`/`AbortController`, `node:sqlite`, Vitest, the existing hand-written HTTP dashboard server, and vanilla browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-20-analysis-design.md`

## Global Constraints

- Node runtime is `>=24`; use built-in `fetch`, `AbortController`, and `node:sqlite`.
- The stored verdict is exactly `{ "score": <integer 0–10>, "reason": "<text>" }`; malformed or untrusted model output is never stored.
- The model is never told `recommendedThreshold`; recommendation is a dashboard-side `score >= threshold` cut.
- At most one analysis run exists globally, keyed by resolved DB file path, not config id.
- Lock acquisition is write-then-read-verify and the marker payload is `{ dbPath, pid, startedAt }`.
- Runtime key resolution is `process.env` first, then `<packageDir>/.env`; key values are never returned, logged, or rendered.
- Existing analyzed rows are skipped; failed rows remain empty for a later run; retention deletion uses the same base retention value as normal runs.
- Analysis processes are detached with `stdio: "ignore"` and `windowsHide: true`; dashboard shutdown must not stop them.
- Use the existing `busy_timeout = 5000`, progress-file, stop-file, and marker conventions.
- Cron jobs remain backward compatible: absent `kind` means `"run"`; analysis jobs require `dbKey` and do not require `config`.
- Do not change lock files or create commits as part of implementation; run the focused validation commands after each task.

## File Structure

### New files

- `omi-job-fetch/src/analysisProvider.ts` — provider and response contracts, `extractScoreReason`, OpenAI-compatible request, error classes, retries, timeout, and `Retry-After` handling.
- `omi-job-fetch/src/analysisConfig.ts` — analysis settings validation, example seeding, atomic settings writes, provider CRUD, and append-or-replace `.env` key status/write operations.
- `omi-job-fetch/src/analysisDb.ts` — analysis-row reads, verdict writes, retention deletion, counts, and threshold bulk status updates.
- `omi-job-fetch/src/analysis.ts` — pure/testable row loop with injected provider call, stop probe, progress sink, clock, and retention policy.
- `omi-job-fetch/src/dashboardAnalysis.ts` — path-deduped DB discovery and analysis state assembly from markers, logs, status files, settings, and SQLite counts.
- `omi-job-fetch/src/analysisCli.ts` — `analyze` command parsing, provider subcommands, marker lifecycle, detached/foreground run behavior, status/stop operations, and exit codes.
- `omi-job-fetch/dashboard/views/analysis.js` — Analysis tab UI for DB selection, progress, provider onboarding/configuration, settings, test calls, run/stop, and bulk uninterested marking.
- `omi-job-fetch/analysis.config.example.json` — seeded default system prompt, threshold, limits, and OpenRouter provider entry.
- `omi-job-fetch/tests/analysisProvider.test.ts` — extraction and HTTP provider behavior.
- `omi-job-fetch/tests/analysisConfig.test.ts` — settings/provider/`.env` behavior.
- `omi-job-fetch/tests/analysis.test.ts` — loop semantics and outcomes.
- `omi-job-fetch/tests/analysisDb.test.ts` — SQLite analysis mutations and counters.
- `omi-job-fetch/tests/analysisCli.test.ts` — CLI parsing, spawning, locking, stop, status, and detach behavior.

### Modified files

- `omi-job-fetch/src/types.ts` — `CronJob.kind` and `dbKey`, plus shared analysis result/status types.
- `omi-job-fetch/src/cli.ts` — dispatch `analyze`; export/reuse progress and stop helpers; pass base retention into normal runs.
- `omi-job-fetch/src/runtime.ts` — add `RunOptions.retentionDays` and use it for `syncDb`.
- `omi-job-fetch/src/dashboardConfig.ts` — add `resolveBaseRetention` and strip cron retention edits.
- `omi-job-fetch/src/dashboardDb.ts` — select/parse analysis, score sort, and `minScore` filtering.
- `omi-job-fetch/src/dashboardServer.ts` — analysis routes, detached spawn, status watch, score filter injection, and analysis broadcast.
- `omi-job-fetch/src/cron.ts` — validate/save analysis cron records and spawn analysis runs.
- `omi-job-fetch/src/cronCli.ts` — `cron add-analysis` and kind-aware list/run behavior.
- `omi-job-fetch/dashboard/app.js` — Analysis route and navigation entry.
- `omi-job-fetch/dashboard/views/jobs.js` — score column, recommended filter, readable verdict detail, and score interaction.
- `omi-job-fetch/dashboard/views/cron.js` — separate analysis-cron section and analysis controls/summaries.
- `omi-job-fetch/dashboard/views/config.js` — base-only retention editor and inherited cron retention display.
- `omi-job-fetch/tests/cli.test.ts`, `runtime.test.ts`, `dashboard-config.test.ts`, `dashboard-db.test.ts`, `dashboard-server.test.ts`, `cron.test.ts` — regression and integration coverage.
- `omi-job-fetch/.gitignore` — `.env` and analysis state exclusions.
- `omi-job-fetch/config.guide.md`, `omi-job-fetch/README.md` — retention ownership and analysis CLI/dashboard documentation.

## Implementation Tasks

### Task 1: Establish Analysis Contracts and Configuration

**Files:**
- Create: `omi-job-fetch/analysis.config.example.json`
- Create: `omi-job-fetch/src/analysisConfig.ts`
- Modify: `omi-job-fetch/src/types.ts`
- Test: `omi-job-fetch/tests/analysisConfig.test.ts`

**Interfaces:**
- Produces `AnalysisProviderConfig`, `AnalysisSettings`, `AnalysisSettingsPublic`, `AnalysisRunStatus`, `loadAnalysisSettings(packageDir, stateDir)`, `saveAnalysisSettings(stateDir, settings)`, `providerApiKeyStatus(provider, packageDir)`, `writeProviderApiKey(provider, value, packageDir)`, and provider CRUD functions used by the CLI and server.
- `AnalysisSettings` contains `systemPrompt: string`, `recommendedThreshold: number`, `descriptionMaxChars: number`, `enabledProvider: string | null`, and `providers: AnalysisProviderConfig[]`.
- `AnalysisProviderConfig` contains `id`, `name`, `baseUrl`, `model`, `apiKeyEnv`, `temperature`, `maxTokens`, `timeoutMs`, `retries`, and `retryBackoffMs`.

- [ ] **Step 1: Write failing configuration tests**

Test the example seed on first load, atomic save/reload, threshold/provider validation, duplicate provider ids, provider add/edit/remove/enable, and `.env` status/write behavior. Assert that public settings contain only `apiKeyStatus: "set" | "unset"`, never the key value.

```ts
it("seeds settings from the bundled example and hides provider keys", () => {
  const settings = loadAnalysisSettings(pkgDir, stateDir);
  expect(settings.providers[0].apiKeyEnv).toBe("OPENROUTER_API_KEY");
  expect(toPublicSettings(settings, pkgDir).providers[0].apiKeyStatus).toBe("unset");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/analysisConfig.test.ts`

Expected: FAIL because the analysis configuration module and public projection do not exist.

- [ ] **Step 3: Implement validation, seed, atomic save, provider CRUD, and `.env` handling**

Read `analysis.config.example.json` from `packageDir` only when the state-dir settings file is absent. Validate threshold `0..10`, positive bounded numeric knobs, unique ids, required URL/model/env fields, and safe provider ids. Use temp-file-plus-rename for settings and update `.env` by replacing only the matching `KEY=...` line or appending it. Resolve keys from `process.env` before `.env`, but expose only set/unset.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --run tests/analysisConfig.test.ts`

Expected: PASS, with no key contents present in returned objects or captured output.

### Task 2: Implement Provider Extraction and OpenAI-Compatible Calls

**Files:**
- Create: `omi-job-fetch/src/analysisProvider.ts`
- Test: `omi-job-fetch/tests/analysisProvider.test.ts`

**Interfaces:**
- Consumes `AnalysisProviderConfig` and resolved API keys from Task 1.
- Produces `extractScoreReason(content: unknown): { score: number; reason: string } | null`, `callProvider(provider, apiKey, messages, fetchImpl?): Promise<string>`, and `AuthConfigError`/`TransientProviderError` classes with status metadata.

- [ ] **Step 1: Write failing extraction and HTTP tests**

Cover fenced JSON, prose around JSON, numeric-string scores, rounding/clamping, missing/wrong fields, empty reasons, malformed provider bodies, 401/403/404 abort errors, 429-then-200 retry, 5xx retry, timeout/network retry, and `Retry-After` delay selection. Verify requests contain `/chat/completions`, bearer auth, model, messages, temperature, `max_tokens`, and `stream: false`.

```ts
expect(extractScoreReason('```json\n{"score":"12.4","reason":"strong"}\n```')).toEqual({ score: 10, reason: "strong" });
expect(extractScoreReason('{"score": "x", "reason": "no"}')).toBeNull();
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/analysisProvider.test.ts`

Expected: FAIL because extraction and provider functions are absent.

- [ ] **Step 3: Implement balanced JSON extraction and provider error classes**

Strip code fences, locate the first object, scan balanced braces while respecting quoted strings/escapes, parse JSON, coerce/round/clamp score, and require a non-empty string reason. Treat 401/403/404, missing key, and malformed response body as auth/config errors; treat 429, 5xx, timeout, and network failures as transient.

- [ ] **Step 4: Implement the fetch client and retry policy**

Normalize `baseUrl` without duplicating `/chat/completions`, use `AbortController` for `timeoutMs`, retry transient failures `retries` times with `retryBackoffMs`, `Retry-After`, and bounded jitter, and return `choices[0].message.content` only when it is a string.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npm test -- --run tests/analysisProvider.test.ts`

Expected: PASS for extraction, request shape, auth/config aborts, transient retries, timeout, and malformed body handling.

### Task 3: Add SQLite Analysis Operations

**Files:**
- Create: `omi-job-fetch/src/analysisDb.ts`
- Create: `omi-job-fetch/tests/analysisDb.test.ts`
- Modify: `omi-job-fetch/src/dashboardDb.ts`

**Interfaces:**
- Consumes the existing `jobs` schema and `extractScoreReason` from Task 2.
- Produces `listAnalysisRows(file): AnalysisRow[]`, `setJobAnalysis(file, signature, verdict): void`, `deleteJobRow(file, signature): boolean`, `countAnalysis(file, threshold): AnalysisCounts`, and `bulkMarkBelowThreshold(file, threshold): number`.
- `AnalysisCounts` is `{ total, analyzed, pending, recommended }` and additionally exposes `skipped`, `failed`, and `deleted` only in run summaries, not as DB-derived row states.

- [ ] **Step 1: Write failing DB tests**

Seed rows with valid, invalid, null, old, and already-analyzed values. Assert analysis writes preserve `status`, `created_at`, and job content; row listing is ordered `posted_at DESC`; deletion removes only the requested row; counts parse valid scores; bulk marking touches only parsed scores below threshold and never null/invalid analysis.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/analysisDb.test.ts tests/dashboard-db.test.ts`

Expected: FAIL for missing analysis DB exports and the new dashboard score query behavior.

- [ ] **Step 3: Implement the SQLite helpers with existing busy-timeout behavior**

Reuse the local `open()` pattern, store `JSON.stringify({ score, reason })`, update only `analysis` and `updated_at`, use `DELETE ... WHERE signature = ?`, and update statuses with a parsed score predicate in JavaScript or a deterministic SQL selection so malformed JSON cannot be marked.

- [ ] **Step 4: Extend `dashboardDb.ts` for score-aware job lists**

Add `analysis` and `score: number | null` to `JobListRow`, allow `sort: "score"`, parse scores only through `extractScoreReason`, and accept `minScore?: number` in `JobListQuery`. Preserve null-score-last behavior for both sort directions and existing text/status/pagination behavior.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `npm test -- --run tests/analysisDb.test.ts tests/dashboard-db.test.ts`

Expected: PASS, including the existing dashboard DB tests.

### Task 4: Build the Pure Analysis Run Loop

**Files:**
- Create: `omi-job-fetch/src/analysis.ts`
- Create: `omi-job-fetch/tests/analysis.test.ts`

**Interfaces:**
- Consumes `listAnalysisRows`, `setJobAnalysis`, `deleteJobRow`, `extractScoreReason`, and an injected provider function.
- Produces `runAnalysis(options): Promise<AnalysisSummary>`, where options include `file`, `instructions`, `systemPrompt`, `descriptionMaxChars`, `retentionDays`, `threshold`, `now`, `aborted`, `callProvider`, and `progress` with `line`/`result` methods.
- `AnalysisSummary` contains `startedAt`, `finishedAt`, `outcome`, `error`, `total`, `analyzed`, `skipped`, `failed`, `deleted`, `recommended`, `instructions`, `provider`, and `model`.

- [ ] **Step 1: Write failing loop tests**

Use a fake provider and a temporary SQLite DB to cover success storage, skipped analyzed rows, expired deletion, malformed response as failed, auth/config abort, transient failure after provider retries as failed, stop between rows with `outcome: "stopped"`, progress text `N/M jobs analyzed`, and threshold-independent provider prompts.

```ts
expect(summary).toMatchObject({ outcome: "completed", analyzed: 1, skipped: 1, deleted: 1, failed: 1 });
expect(JSON.parse(getJob(file, "good")!.analysis as string)).toEqual({ score: 8, reason: "strong match" });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/analysis.test.ts`

Expected: FAIL because the loop module does not exist.

- [ ] **Step 3: Implement row ordering, retention, prompt construction, and buckets**

For each row, skip non-null analysis first; delete rows whose `posted_at` is older than the retention cutoff when retention is positive; otherwise call the provider with the system prompt, user instructions, and truncated job JSON. Parse through `extractScoreReason`; write valid verdicts and count recommended scores, leave failed rows empty, and continue after row-level failures.

- [ ] **Step 4: Implement abort and auth/config finalization**

Check `aborted()` between rows. On stop, finalize `stopped`; on auth/config error, finalize `error` without burning remaining rows; always write a final result line through the injected progress sink. Do not use the threshold in the model prompt.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npm test -- --run tests/analysis.test.ts`

Expected: PASS for all row buckets, prompt constraints, stop behavior, and summary counts.

### Task 5: Standardize Base Retention for Normal Runs

**Files:**
- Modify: `omi-job-fetch/src/dashboardConfig.ts`
- Modify: `omi-job-fetch/src/runtime.ts`
- Modify: `omi-job-fetch/src/cli.ts`
- Modify: `omi-job-fetch/tests/dashboard-config.test.ts`
- Modify: `omi-job-fetch/tests/runtime.test.ts`
- Modify: `omi-job-fetch/tests/cli.test.ts`

**Interfaces:**
- Produces `resolveBaseRetention(packageDir): number | undefined` and `FriendlyPatch.stripRetention?: boolean`.
- `RunOptions.retentionDays?: number` takes precedence over `config.db.retentionDays`, then `DEFAULT_RETENTION_DAYS`.

- [ ] **Step 1: Add failing retention tests**

Cover base config present/absent, base value winning over a cron config value, fallback to the cron value when no base exists, default 30, and cron friendly updates stripping `db.retentionDays` while base updates retain it.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run tests/dashboard-config.test.ts tests/runtime.test.ts tests/cli.test.ts`

Expected: FAIL because base retention resolution and the new option are absent.

- [ ] **Step 3: Implement the retention flow**

Read only the base config at `BASE_CONFIG_REL`; make `runCommand` pass `resolveBaseRetention(PACKAGE_DIR)` to `runPipeline`; update `syncDb` selection to `options.retentionDays ?? config.db?.retentionDays ?? DEFAULT_RETENTION_DAYS`; pass `stripRetention: true` only for cron config friendly updates.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm test -- --run tests/dashboard-config.test.ts tests/runtime.test.ts tests/cli.test.ts`

Expected: PASS with existing normal-run behavior preserved.

### Task 6: Add CLI Analysis Lifecycle and Global Lock

**Files:**
- Create: `omi-job-fetch/src/analysisCli.ts`
- Create: `omi-job-fetch/tests/analysisCli.test.ts`
- Modify: `omi-job-fetch/src/cli.ts`

**Interfaces:**
- Consumes Tasks 1–5 and `discoverConfigs`; resolves a DB key to a config and then a DB path.
- Produces `runAnalysisCommand(dbKey, options?): Promise<number>`, `runAnalyzeCommand(argv): Promise<number>`, `getAnalysisStatus(...)`, `stopAnalysis(...)`, and `acquireAnalysisLock(markerFile, dbPath)`/`releaseAnalysisLock(markerFile)`.

- [ ] **Step 1: Write failing CLI tests**

Test `analyze <db>` compatibility, `analyze run <db>`, status listing, stop marker creation, provider subcommand parsing, path-keyed lock collision, dead-marker cleanup, write-then-read verification, `.status.json` finalization, cron trigger propagation, and detached Ctrl+C behavior where the first signal detaches and a second signal retains the normal kill behavior.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/analysisCli.test.ts tests/cli.test.ts`

Expected: FAIL because the analyze command and dispatch are absent.

- [ ] **Step 3: Implement command dispatch and provider subcommands**

Route `analyze` before normal run parsing. Implement `status`, `stop`, `providers list/add/remove/enable/test`, and `run`; validate DB keys through `discoverConfigs`, reject missing DB/provider key, and return stable non-zero codes for user/config errors.

- [ ] **Step 4: Implement detached lifecycle, markers, status, and progress files**

Use `OMI_JOB_FETCH_PROGRESS_FILE`, `OMI_JOB_FETCH_STOP_FILE`, and `OMI_JOB_FETCH_RUN_MARKER`; write the richer active marker `{ dbPath, pid, startedAt }`; acquire by write/read verification; PID-check active markers and clean stale ones; write one status JSON in `finally`; clear the marker on every exit. Foreground runs detach console signal handling after the first Ctrl+C while continuing file progress.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `npm test -- --run tests/analysisCli.test.ts tests/cli.test.ts`

Expected: PASS for command routing, lock safety, stop/status state, and signal behavior.

### Task 7: Add Dashboard Analysis State Assembly and API Routes

**Files:**
- Create: `omi-job-fetch/src/dashboardAnalysis.ts`
- Modify: `omi-job-fetch/src/dashboardServer.ts`
- Modify: `omi-job-fetch/tests/dashboard-server.test.ts`

**Interfaces:**
- Produces `getAnalysisDashboardState({ packageDir, cronFile, stateDir, now })` returning `{ settings, dbs, runningDb }`, with DB entries `{ key, label, path, exists, total, analyzed, pending, recommended, retentionDays, status, lastRun, summary, running }`.
- Routes consume this state and expose `GET /api/analysis`, `POST /api/analysis/run`, `POST /api/analysis/stop`, provider/settings CRUD/test endpoints, and `POST /api/analysis/:db/mark-unrecommended`.

- [ ] **Step 1: Extend the server test environment with a real analysis DB and stub CLI**

Add a provider config/key fixture without exposing key text, seed shared and separate DB paths, and make the stub recognize `analyze run <dbKey>`, marker/progress/status files, and trigger env values.

- [ ] **Step 2: Write failing route tests**

Cover DB path deduplication and owner labels, settings key redaction, onboarding run block (400), missing DB (400), active run collision (409), stop matching/non-matching DB (200/409), provider CRUD/enable/test, threshold settings update, bulk mark count, state-file summaries, and orphaned analysis reattachment after server restart.

- [ ] **Step 3: Implement `dashboardAnalysis.ts` state assembly**

Deduplicate discovered config metas by resolved DB path while retaining all owner ids for labels. Read active marker with PID verification, parse status JSON only after completion, tail the analysis log, calculate DB counts, and use `resolveBaseRetention(packageDir) ?? DEFAULT_RETENTION_DAYS`.

- [ ] **Step 4: Implement detached server routes and broadcasts**

Spawn `node <dist>/cli.js analyze run <dbKey>` with `stdio: "ignore"`, `windowsHide: true`, analysis progress/stop/active paths, and dashboard trigger env. Guard enabled provider/key, active lock, and DB existence. Add provider/settings route validation and broadcast `analysis` on state-file changes.

- [ ] **Step 5: Extend the 2-second watcher and run score filtering**

Watch `<stateDir>/analysis/*`, classify those changes as `analysis`, and inject the configured threshold into `listJobs` as `minScore` when the Jobs route asks for recommended rows.

- [ ] **Step 6: Run focused server tests and verify they pass**

Run: `npm test -- --run tests/dashboard-server.test.ts`

Expected: PASS for route guards, provider redaction, detached lifecycle, state assembly, broadcasts, and restart reattachment.

### Task 8: Add Score-Aware Jobs Dashboard Behavior

**Files:**
- Modify: `omi-job-fetch/dashboard/views/jobs.js`
- Modify: `omi-job-fetch/src/dashboardServer.ts`
- Modify: `omi-job-fetch/tests/dashboard-db.test.ts`
- Modify: `omi-job-fetch/tests/dashboard-server.test.ts`

**Interfaces:**
- Consumes `JobListRow.score`, `minScore`, and `JobDetail.analysis` from Tasks 3 and 7.
- Produces a Jobs UI with sortable Score, an AI recommended filter, readable score/reason detail, and a score click target that does not accidentally trigger the row action twice.

- [ ] **Step 1: Add failing API/data tests**

Assert parsed scores appear in list rows, score sorting places nulls last, `minScore` excludes below-threshold and malformed rows, and detail responses preserve valid verdict objects while UI fallback remains available for arbitrary legacy JSON.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run tests/dashboard-db.test.ts tests/dashboard-server.test.ts`

Expected: FAIL for score fields, filter behavior, and route threshold injection.

- [ ] **Step 3: Implement route/query support**

Accept `recommended=1` in the jobs endpoint, resolve the current threshold from analysis settings, pass `minScore`, and return `score` alongside the existing job/status fields.

- [ ] **Step 4: Implement Jobs UI additions**

Add score sort state, recommended selector, score column with `—` for null, score/reason rendering in the detail modal, and a score click affordance that opens the verdict without breaking normal row detail behavior.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `npm test -- --run tests/dashboard-db.test.ts tests/dashboard-server.test.ts`

Expected: PASS for data and route behavior; browser behavior is verified in the final build/test pass because this repo has no dedicated browser unit harness.

### Task 9: Build the Analysis Dashboard View and Navigation

**Files:**
- Create: `omi-job-fetch/dashboard/views/analysis.js`
- Modify: `omi-job-fetch/dashboard/app.js`
- Modify: `omi-job-fetch/dashboard/styles.css`

**Interfaces:**
- Consumes all `/api/analysis` and analysis action routes from Task 7 plus shared `api`, `el`, `esc`, `fmtTime`, `fmtRel`, `toast`, and modal helpers.
- Produces a route named `analysis` and a view with running state, DB cards/selector, instructions, provider onboarding/editor/list/test controls, threshold/system-prompt editors, stop/run controls, and confirmed bulk marking.

- [ ] **Step 1: Write a view checklist against the route contract**

Verify the view handles no providers, provider-without-key, enabled provider, running/orphaned state, completed/error/stopped summaries, missing DBs, threshold changes, empty DB lists, and failed API calls without rendering key values.

- [ ] **Step 2: Implement the route and navigation entry**

Import the view, add it to `ROUTES`, add `Analysis` to `NAV`, refresh on `analysis` live events, and use the existing DOM helper/style vocabulary.

- [ ] **Step 3: Implement DB/run sections**

Render deduped DB labels, live `N/M jobs analyzed`, Stop, disabled Run analysis guards, per-DB counts and last-run summaries, and a confirm-before-submit bulk mark action.

- [ ] **Step 4: Implement provider onboarding and settings forms**

Prefill the OpenRouter example, render key inputs only as write-only fields with set/unset status, support add/edit/remove/enable/test, and persist system prompt/threshold/description limit through the settings API.

- [ ] **Step 5: Run build and the full test suite**

Run: `npm run typecheck; npm test`

Expected: PASS with browser modules copied/served by the existing dashboard static path and no TypeScript regressions.

### Task 10: Add Analysis Cron Model, Gateway, and CLI Mutation

**Files:**
- Modify: `omi-job-fetch/src/types.ts`
- Modify: `omi-job-fetch/src/cron.ts`
- Modify: `omi-job-fetch/src/cronCli.ts`
- Modify: `omi-job-fetch/src/dashboardServer.ts`
- Modify: `omi-job-fetch/tests/cron.test.ts`
- Modify: `omi-job-fetch/tests/dashboard-server.test.ts`

**Interfaces:**
- `CronJob.kind: "run" | "analysis"` defaults to `"run"`; analysis jobs have `dbKey: string` and `config` is optional only for that kind.
- `defaultSpawnJob` dispatches run jobs to `run --config <path>` and analysis jobs to `analyze run <dbKey>`, using analysis state paths and `OMI_JOB_FETCH_TRIGGER=cron`.
- `cron add-analysis --name <name> --schedule <schedule> --db <dbKey>` validates the target against discovered config ids and writes a compatible cron record.

- [ ] **Step 1: Write failing cron compatibility tests**

Load legacy run jobs without `kind`, load/save analysis jobs without requiring `config`, reject missing/invalid `dbKey`, assert due analysis spawn arguments and env, and assert a lock-losing child produces `skipped — analysis already in progress` without gateway-level special casing.

- [ ] **Step 2: Run focused cron tests and verify they fail**

Run: `npm test -- --run tests/cron.test.ts tests/dashboard-server.test.ts`

Expected: FAIL for kind parsing, analysis spawn routing, and the add-analysis command.

- [ ] **Step 3: Implement type-aware cron load/save and spawn**

Keep old `config` run behavior unchanged. Persist `kind` and `dbKey` only when applicable, pass analysis progress/stop/active paths based on the target DB key, and let the spawned CLI self-gate the global lock.

- [ ] **Step 4: Implement `cron add-analysis` and dashboard add route support**

Parse name/schedule/db, reject `base` collisions and unknown DB keys, create the analysis cron record without creating a run config, and retain shared enable/disable/pause/resume/remove/run-now semantics.

- [ ] **Step 5: Run focused cron tests and verify they pass**

Run: `npm test -- --run tests/cron.test.ts tests/dashboard-server.test.ts`

Expected: PASS for legacy parsing, analysis scheduling, spawn env, and lock-loss behavior.

### Task 11: Add Analysis Cron Dashboard UI

**Files:**
- Modify: `omi-job-fetch/dashboard/views/cron.js`
- Modify: `omi-job-fetch/dashboard/app.js` only if shared refresh/event wiring needs a small adjustment

**Interfaces:**
- Consumes kind-aware `/api/cron`, `/api/analysis`, `/api/configs`, and existing cron mutation endpoints.
- Produces a visually separate Analysis crons section with DB dropdown, analysis badge, analysis summary, and Run now/Stop/Enable/Disable/Remove actions.

- [ ] **Step 1: Add failing manual interaction checklist**

Exercise adding an analysis cron, rendering it separately from run crons, selecting distinct DB paths, starting/stopping it, disabling/removing it, and seeing the same analysis summary as the Analysis tab.

- [ ] **Step 2: Implement analysis cron data refresh and section rendering**

Fetch `/api/analysis` alongside cron/config state, partition by `job.kind`, render analysis summaries from state files, and avoid treating `dbKey` as a config path.

- [ ] **Step 3: Implement add form and controls**

Add Name + Schedule + DB dropdown, route submit to the analysis-cron mutation, map Run now/Stop to analysis endpoints, and retain the standard cron controls for enable/disable/remove.

- [ ] **Step 4: Run build and full tests**

Run: `npm run build; npm test`

Expected: PASS, with the static view loading through the existing dashboard shell.

### Task 12: Config UI, Documentation, Ignore Rules, and Example Fixtures

**Files:**
- Modify: `omi-job-fetch/dashboard/views/config.js`
- Modify: `omi-job-fetch/.gitignore`
- Modify: `omi-job-fetch/config.guide.md`
- Modify: `omi-job-fetch/README.md`
- Modify: `omi-job-fetch/cron.example.json`

**Interfaces:**
- Documents the public CLI/dashboard contract without exposing or asking users to commit secrets.
- Base config owns retention; cron configs display inheritance and ignore stale cron retention fields.

- [ ] **Step 1: Add failing documentation/config fixture checks**

Search the docs and example cron JSON for the old per-cron retention guidance and assert the example includes the back-compatible `kind` shape and analysis command examples.

- [ ] **Step 2: Update the Config view**

Render a retention-days field only for the base config, send `0` as keep-everything, and show cron cards as read-only `inherits base (30d)` or the resolved base value.

- [ ] **Step 3: Update ignore rules and examples**

Ignore `.env`, `analysis/`, and analysis settings state under the user state directory as appropriate for this repo; keep `analysis.config.example.json` tracked and include `kind: "run"`/analysis examples in `cron.example.json`.

- [ ] **Step 4: Update README and config guide**

Document provider setup, write-only API key behavior, `analyze` commands, dashboard flow, score/recommended semantics, analysis cron syntax, retention single ownership, stop/detach behavior, and exit/status meanings. Do not include real key values.

- [ ] **Step 5: Run documentation/config validation**

Run: `npm run typecheck; npm test`

Expected: PASS, with examples matching the implemented parsers and no tracked secret/state files.

### Task 13: Full Regression and Spec-Coverage Verification

**Files:**
- Modify only files needed to resolve failures discovered by the checks above.

- [ ] **Step 1: Build the package**

Run: `npm run build`

Expected: TypeScript emits `dist` successfully under Node 24.

- [ ] **Step 2: Run all unit/integration tests**

Run: `npm test`

Expected: all existing and new Vitest suites pass, including provider fake-server, SQLite, server lifecycle, CLI, retention, and cron tests.

- [ ] **Step 3: Run the typecheck separately**

Run: `npm run typecheck`

Expected: no new TypeScript diagnostics.

- [ ] **Step 4: Perform a manual CLI smoke check**

From `omi-job-fetch`, run `node dist/cli.js analyze status`, `node dist/cli.js analyze providers list`, and `node dist/cli.js cron list` against a temporary state/config fixture. Confirm output contains provider ids/statuses but never API key values.

- [ ] **Step 5: Perform a dashboard smoke check**

Run `node dist/cli.js dashboard --port 5211`, open the printed URL, visit Analysis, Jobs, Cron, and Config, and verify the page loads, the Analysis tab is navigable, no key value is rendered, score/filter controls appear, and an analysis cron is visibly separate from run crons.

- [ ] **Step 6: Complete the spec audit**

Check each design section: detached process/lock, retention ownership, row loop buckets, stop/detach, config/provider/error policy, dashboard routes/UI, Jobs score behavior, analysis cron behavior, CLI commands, and every listed test category. Record any intentionally deferred behavior only when it is explicitly in the design's YAGNI section.

## Plan Self-Review

- **Spec coverage:** Tasks 1–4 cover data/config/provider/loop behavior; Task 5 covers retention; Task 6 covers CLI lifecycle; Task 7 covers server/state; Task 8 covers Jobs; Task 9 covers the Analysis tab; Tasks 10–11 cover analysis crons; Task 12 covers UI/docs/ignore/example changes; Task 13 covers verification.
- **Placeholder scan:** No incomplete or vague implementation steps are used; each task identifies concrete files, interfaces, tests, and commands.
- **Type consistency:** `AnalysisSettings`, `AnalysisProviderConfig`, `AnalysisSummary`, `AnalysisCounts`, `CronJob.kind`, `CronJob.dbKey`, `JobListRow.score`, and `JobListQuery.minScore` are introduced before their consumers.
- **Scope check:** The design contains several independent subsystems, but each is represented as an independently testable task in one ordered plan because the user supplied one approved cross-cutting design and the interfaces intentionally connect the subsystems.