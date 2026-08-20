# Analysis Tab — AI Job Recommendations — Design

**Goal:** Let the user run an AI analysis over any aggregate DB from the dashboard or CLI. Each job row is given to an LLM provider (OpenAI-format chat completions) together with user instructions; the model returns a structured `{ score, reason }` verdict stored in the DB's `analysis` column. The dashboard surfaces scores (sortable, filterable by "recommended"), and can bulk-mark low-scoring jobs as uninterested.

**Date:** 2026-08-20 · **Status:** Design (approved 2026-08-20)

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **DB** | An aggregate SQLite `jobs` table at a config's resolved `db.file` path. Every DB is owned by a config (`base` or a cron job); multiple configs may share one path ("shared" storage). |
| **DB key** | The identity used in the UI/CLI: a config id (`base` or a cron slug). Internally, the lock and status are keyed by the resolved **DB file path**, not the config id, so shared files can't be analyzed twice. |
| **Analysis run** | One process that iterates a DB's rows and calls the provider per row. Only one run exists at a time (global lock). |
| **Analysis** | The stored verdict for one row: `{"score": <0–10>, "reason": "<text>"}`. |
| **Threshold** | `recommendedThreshold` (default **5**). A job with `score >= threshold` is "recommended". The threshold is a dashboard-side cut — the model is never told it. |

---

## 2. Architecture

### 2.1 Process model

One analysis run = one spawned, detached process mirroring the run machinery:

- Spawn: `node <dist>/cli.js analyze run <dbKey>`, `stdio: "ignore"`, `windowsHide: true` — survives the dashboard dying.
- Env channels (reuse the existing generic helpers `createProgressFile` / `createStopWatch` / the marker pattern — they already read `OMI_JOB_FETCH_*`):
  - `OMI_JOB_FETCH_PROGRESS_FILE` → `<stateDir>/analysis/<dbKey>.log`
  - `OMI_JOB_FETCH_STOP_FILE` → `<stateDir>/analysis/<dbKey>.stop`
  - `OMI_JOB_FETCH_RUN_MARKER` → `<stateDir>/analysis/active` (the **global lock**)
- The **lock**: the CLI writes `{ dbPath, pid, startedAt }` to `active` at start and deletes it in a `finally` on every exit. (The generic `createRunMarker` only writes `{pid, startedAt}` — the analyze command writes its own marker with this richer payload, same env var, same lifecycle.) "Is something being analyzed" = read `active`, PID-verify (`process.kill(pid, 0)`, EPERM counts alive), clean up dead markers. Starting any DB while `active` is live → 409.
- **Stop**: the dashboard writes `<stateDir>/analysis/<dbKey>.stop`; the loop checks it between rows, finalizes a summary, clears the marker, exits 130.
- **Close dashboard mid-run**: the process orphans and keeps going; a reopened dashboard reads `active` + tails `<dbKey>.log` → shows "still being analyzed" with live progress.

### 2.2 One DB at a time

Because the lock is keyed by resolved DB **path**, two config ids sharing `jobs.db` are one DB: starting a second analysis (from either id) while `active` is live returns 409. The dashboard's DB selector lists distinct paths (deduped), labelled with the owning config id(s).

**Lock acquisition is write-then-verify** (inside the analyze command, so it works uniformly for dashboard, manual-CLI, and cron-fired runs): write `{dbPath, pid, startedAt}` to `active`, re-read it; if it is still this process's pid the lock is owned, otherwise the run lost the race. A run that loses exits non-zero; a **cron-fired** run reports `skipped — analysis already in progress`, and its next schedule picks up the leftover rows (nothing is lost — unanalyzed rows persist).

### 2.3 Retention standardization

**One owner:** the base config `dashboard.configs/realtime/config.json` → `db.retentionDays`. All consumers use it; cron configs stop carrying retention.

- New `resolveBaseRetention(packageDir): number | undefined` (in `dashboardConfig.ts`): reads the base config's `db.retentionDays`; `undefined` when the base config file is absent.
- **Runs:** `runCommand` passes `retentionDays: resolveBaseRetention(PACKAGE_DIR)` into `runPipeline` via a new `RunOptions.retentionDays`. `runtime.ts` line 218 becomes `options.retentionDays ?? config.db?.retentionDays ?? DEFAULT_RETENTION_DAYS`. So base and cron runs both use the base value; a standalone config (no base file) keeps its own, then the 30-day default.
- **Analysis deletion pass** uses `resolveBaseRetention(PACKAGE_DIR) ?? DEFAULT_RETENTION_DAYS` — the same value runs prune with, so the two can never disagree.
- **Cron configs:** `applyFriendlyUpdate` strips `db.retentionDays` on cron adds/edits (new `stripRetention` patch flag). Existing cron configs keep the stale field harmlessly; it is ignored.
- **UI:** a "retention (days)" field on the **base config only** in the Config page edit modal (`0` = keep everything); cron cards show `retention: inherits base (30d)` read-only.
- Docs (`config.guide.md`, `README.md`) updated to say retention is set once, on the base config.

---

### 2.4 Analysis as a cron job

An analysis can be scheduled exactly like a job run. `cron.json` jobs gain a `kind` field:

- `kind: "run"` (default, back-compatible) — an ordinary scheduled job sweep, with its `config` path.
- `kind: "analysis"` — a scheduled analysis pass. Carries a target `dbKey` (a config id whose DB is analyzed) instead of a `config` path. Everything else is shared with job crons: schedule parsing, `enabled`/disable, global pause/resume, gateway firing, dashboard Run now / Stop / Remove, and `lastRun`/`lastStatus`.

**Gateway firing:** a due analysis cron spawns `node <cli> analyze run <dbKey>` detached, with the same marker/stop/progress env as the Analysis tab (trigger env distinguishes it as cron-fired). No special lock handling in the gateway — the spawned process self-gates (§2.2).

**Concurrency model — overlap, lock-protected (chosen):**

- Job runs and analysis runs may overlap. That is safe because (a) at most one analysis runs at any time (the global lock), (b) SQLite writers wait up to 5 s for each other (`busy_timeout`, already shipped), and (c) analysis only ever writes rows that have no analysis, so a concurrent job run inserting/updating rows neither corrupts anything nor loses work — new rows are simply left for the next analysis fire (exactly the "targets the newer stuff" behavior).
- A due analysis cron that loses the lock exits as `skipped — analysis already in progress`; the next schedule picks up the leftover rows.
- Two job crons keep their current behavior (concurrent, safe via `busy_timeout`).

**Dashboard:** the Cron page gains a visually separate **Analysis crons** section (§6.4). The analysis cron's "last run" line renders the analysis summary from the analysis state files — the same state the Analysis tab shows.

## 3. The analysis run

### 3.1 Loop semantics

Iterate `SELECT signature, posted_at, analysis, job FROM jobs ORDER BY posted_at DESC`. For each row:

| Row state | Action | Bucket |
|---|---|---|
| `analysis` is non-null | Skip — no AI call | `skipped` |
| `posted_at` older than `retention` window | **Delete the row** (the retention protocol) | `deleted` |
| Needs analysis → AI call succeeds | Store `{"score", "reason"}` (JSON envelope) | `analyzed` |
| AI call fails after retries, or response doesn't parse to `{score, reason}` | Leave `analysis` empty, move on | `failed` |
| AI call returns an **auth/config error** (401/403/404, malformed response body, missing key) | **Abort the run** with an error status (every call would fail — don't burn the DB) | — |

### 3.2 Progress and status

- Live line (to console on a TTY and mirrored to the progress file): `11/120 jobs analyzed`.
- At the end, `progress.result("analyzed 11, skipped 3, failed 1, deleted 2 · 6 recommended")` — the persisted card line.
- The CLI writes a summary to `<stateDir>/analysis/<dbKey>.status.json` **once, at finish** (completed, stopped, or error):

```json
{
  "startedAt": "…", "finishedAt": "…",
  "outcome": "completed" | "stopped" | "error",
  "error": null | "…",
  "total": 120, "analyzed": 11, "skipped": 3, "failed": 1, "deleted": 2,
  "recommended": 6,
  "instructions": "…", "provider": "openrouter", "model": "openrouter/auto"
}
```

The dashboard shows: `analyzed yesterday · 11 analyzed, 3 skipped, 1 failed, 2 deleted · 6 recommended`, plus `last run: <time>`.

### 3.3 Stop

`analyze stop <db>` (CLI) or the dashboard Stop button writes the `.stop` file. The loop polls it between rows; on abort it writes the `.status.json` with `outcome: "stopped"`, clears the marker, exits 130. Completed analyses are already in the DB.

### 3.4 Detach on Ctrl+C (CLI)

`omijobs analyze run <db>` in a terminal: SIGINT → set a `detached` flag, remove the SIGINT/SIGTERM handlers (a second Ctrl+C kills), stop writing to the console, keep writing to the progress file, keep processing. The run continues in the background and remains stop-able/status-able.

---

## 4. Data model

### 4.1 Analysis config — `~/.omijobs/analysis.json`

Lives in the state dir (shared across checkouts). **Seeded on first use from the bundled `analysis.config.example.json`** in the package dir (the traveling starting point). Shape:

```json
{
  "systemPrompt": "…see §5.1…",
  "recommendedThreshold": 5,
  "descriptionMaxChars": 4000,
  "enabledProvider": null,
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "openrouter/auto",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "temperature": 0.2,
      "maxTokens": 400,
      "timeoutMs": 60000,
      "retries": 3,
      "retryBackoffMs": 2000
    }
  ]
}
```

Atomic write on save (same temp-file+rename pattern as `writeConfig`). Validation on load: threshold 0–10, providers have unique ids with required `baseUrl`/`model`/`apiKeyEnv`, numeric knobs in sane ranges.

### 4.2 Stored analysis (the DB column)

`analysis` is JSON (`dashboardDb.getJob` already `JSON.parse`s it). The analysis process stores exactly:

```json
{ "score": 8, "reason": "Strong match: …" }
```

The **extractor** is the shared validator/parser for both storing and reading (see §5.2) — filtering, counting, and bulk-mark all parse scores through it.

### 4.3 `.env` (package dir, gitignored)

API keys live in `.env` as `OPENROUTER_API_KEY=…`. Runtime resolution order: `process.env` → `<packageDir>/.env`. The dashboard's provider editor writes/updates the var (append-or-replace), and reports only `set`/`unset` — existing values are never read back or displayed. A small `.env` reader/writer is product code; neither the assistant nor the UI ever displays key values.

---

## 5. Provider system

### 5.1 System prompt (config-set) + user instructions

The **system prompt** ships in the example config and is editable in the dashboard. The user's typed **instructions** become the user prompt, followed by the job:

```
<systemPrompt>

user: <instructions>

--- JOB ---
{ title, company, location, posted_at, apply_url, source, description (truncated to descriptionMaxChars) }
```

Draft system prompt (the model is **never told the threshold** — scoring is a calibrated 0–10, and "recommended" is a pure dashboard-side cut):

> You are a job-matching evaluator. The user's instructions describe exactly what they want in a job. Score each posting against those instructions, 0–10: 0 = irrelevant; 1–3 = poor match, misses core requirements; 4–6 = partial, notable gaps; 7–9 = strong, minor gaps; 10 = perfect. In `reason`, write 1–3 concise sentences: what matched, what missed, and why the score. Respond with ONLY one JSON object — no prose, no code fences: `{"score": <integer 0–10>, "reason": "<string>"}`

### 5.2 Robust extraction

`extractScoreReason(content): { score, reason } | null`:
1. Strip markdown code fences; find the first `{` to the last balanced `}`; `JSON.parse`.
2. Accept `"score"` as number or numeric string; coerce/round to an integer; clamp to 0–10.
3. `reason` must be a non-empty string.
4. Anything else → `null` (row counts as `failed`; nothing stored).

### 5.3 Provider call

`POST {baseUrl}/chat/completions`, OpenAI format: `{ model, messages, temperature, max_tokens: maxTokens, stream: false }`, `Authorization: Bearer <key>`, via global `fetch` (Node ≥ 24) with an `AbortController` timeout (`timeoutMs`). Parse `data.choices[0].message.content`.

**Error classes** (the run loop branches on these):
- **Auth/config** (401/403/404 on the endpoint, malformed response body, missing key) → abort the run.
- **Transient** (429, 5xx, timeout, network) → retry with backoff (`retries` × `retryBackoffMs`, honoring `Retry-After` when present, plus small jitter), then fail the row and move on.

**Extensibility = data, not code:** any OpenAI-format endpoint (`baseUrl` + chat completions) works — adding DeepSeek later is a JSON entry, no code change. All providers go through the same path.

### 5.4 Test / check-status request

One minimal completion (system: "Reply with the single word OK", user: "ping", `max_tokens` 8), **no fallback**. Run on add and on demand via a **check status** button. Returns `ok` (with the model's reply) or the error message — never the key.

---

## 6. Dashboard

### 6.1 Analysis tab (new view `dashboard/views/analysis.js`, NAV + route in `app.js`)

- **Running section:** live `11/120 jobs analyzed`, **Stop** button, and a "this DB is still being analyzed" banner when a run predates this dashboard's open.
- **DB section:** selector (distinct DB paths, labelled with owning config id) + instructions textarea + **Run analysis** (disabled while a run is active, or when no enabled provider has a key). Below, one card per DB: `never analyzed` / `analyzing now (…/…)` / `analyzed <rel> · <bucket counts> · N recommended`, `last run: <time>`.
- **Providers section:** the enabled provider; a list of providers with enable / test (check status) / edit / remove; an add/edit form. On **add**, a live status from the test request. A **key field** per provider that writes `.env` and shows only `set`/`unset`. Threshold and system-prompt editors.
- **Onboarding** (no provider exists): banner "No AI provider configured — analysis is disabled", runs blocked, and a form prefilled with suggested values (OpenRouter, model, base URL, "get a key" hint linking to the keys page). Once a provider is enabled with a key, everything unlocks.
- **Bulk junk-out:** per-DB button "mark all below threshold as uninterested" — sets `status = 'uninterested'` on **only rows with a parsed score < threshold** (never rows with no analysis). Confirms first; reports the count changed.

### 6.2 Jobs page (existing view, additive)

- New **Score** column (sortable `sort=score`, `—` when unparsed).
- **AI recommended** filter (score ≥ threshold; the route injects the threshold from analysis config into `listJobs` as a `minScore`).
- Detail modal renders the verdict as **score + reason** (readable); raw JSON fallback for anything else.
- Clicking a row's score reveals the reason.

### 6.3 Server routes (`dashboardServer.ts`)

- `GET /api/analysis` → `{ settings (no keys — apiKeyStatus only), dbs: [{ key, label, path, exists, total, analyzed, pending, recommended, retentionDays, status, lastRun, summary, running }], runningDb }`
- `POST /api/analysis/run` `{db}` — guards: enabled provider with a set key (else 400), no active run (else 409), DB exists (else 400). Clears stale stop/marker, spawns detached, broadcasts.
- `POST /api/analysis/stop` `{db}` — 200 if the active DB matches; 409 otherwise.
- `GET/POST /api/analysis/providers`, `DELETE /api/analysis/providers/:id`, `POST /api/analysis/providers/:id/enable`, `POST /api/analysis/providers/:id/test`, `PUT /api/analysis/settings`
- `POST /api/analysis/:db/mark-unrecommended` → `{ ok, count }`
- The 2s stat-watch gains `<stateDir>/analysis/*` → broadcast kind `"analysis"`.

### 6.4 Cron page — analysis crons

A visually separate **Analysis crons** section below the scheduled-run jobs: an add form (Name + Schedule + **DB dropdown** of the distinct DBs), cards with an *analysis* badge whose last-run line renders the analysis summary (from `/api/analysis`, the same state the Analysis tab shows), plus the standard Run now / Stop / Enable / Disable / Remove actions. Run now maps to the analysis spawn; Stop writes the analysis stop file.

---

## 7. CLI surface

```
omijobs analyze <db>                      # run (foreground; Ctrl+C detaches)
omijobs analyze status                    # all DBs + which is active
omijobs analyze stop <db>
omijobs analyze providers list
omijobs analyze providers add --id <id> --name <name> --base-url <url> --model <m> --api-key-env <VAR> [--temperature 0.2 --max-tokens 400 --timeout-ms 60000 --retries 3 --retry-backoff-ms 2000]
omijobs analyze providers remove <id>
omijobs analyze providers enable <id>
omijobs analyze providers test <id>
omijobs cron add-analysis --name <name> --schedule <sched> --db <dbKey>   # schedule an analysis pass
```

`<db>` is a config id (`base` or cron slug), resolved to its DB path via `discoverConfigs` (package dir + `cron.json`), same as the dashboard. `cron add-analysis` shares the standard cron schedule/enable/pause semantics; the target `--db` is the config id whose DB gets analyzed.

---

## 8. Files

**New:**
- `src/analysis.ts` — the run loop (pure; takes a provider-call fn, so fully testable)
- `src/analysisProvider.ts` — OpenAI-format client, error classes, retry/backoff, `extractScoreReason`
- `src/analysisConfig.ts` — load/seed/save settings, provider CRUD + validation, `.env` read/write/status
- `src/analysisDb.ts` — `setJobAnalysis`, `deleteJobRow`, `listAnalysisRows`, `countAnalysis`, `bulkMarkBelowThreshold`
- `src/dashboardAnalysis.ts` — status assembly (active marker + `.status.json` + `.log` + per-DB counts)
- `src/analysisCli.ts` — `analyze` subcommands
- `dashboard/views/analysis.js`
- `analysis.config.example.json` (package dir)

**Modified:**
- `src/cli.ts` — dispatch `analyze`; `runCommand` passes `resolveBaseRetention` into `runPipeline`
- `src/runtime.ts` — `RunOptions.retentionDays` honored at the `syncDb` call
- `src/dashboardConfig.ts` — `resolveBaseRetention`, `stripRetention` in `applyFriendlyUpdate`
- `src/dashboardDb.ts` — `listJobs` selects `analysis`, adds `score` + `minScore` filter
- `src/dashboardServer.ts` — analysis routes, watch targets
- `src/cron.ts` — fire analysis-kind crons (`analyze run <dbKey>`, trigger env)
- `src/cronCli.ts` — `cron add-analysis` + `kind`/`dbKey` validation
- `src/types.ts` — `CronJob.kind` (`"run" | "analysis"`) and optional `dbKey`
- `dashboard/app.js` — NAV + route for analysis
- `dashboard/views/cron.js` — analysis section, add form, badges, last-run summary
- `dashboard/views/jobs.js` — score column/sort/filter/detail
- `dashboard/views/config.js` — retention field on base config
- `.gitignore` — ensure `.env` and analysis state are ignored
- `config.guide.md`, `README.md` — retention single-owner + analysis docs
- Tests: `tests/analysisProvider.test.ts`, `tests/analysisConfig.test.ts`, `tests/analysis.test.ts`, `tests/analysisDb.test.ts`, `tests/analysisCli.test.ts`, plus updates to `dashboard-server.test.ts`, `cli.test.ts`, `runtime.test.ts`, `dashboardDb.test.ts`, `cron.test.ts`.

---

## 9. Testing

- **Extraction:** unit tests against messy model output — code fences, prose around JSON, numeric-string scores, out-of-range scores, missing/wrong-typed fields → `null`.
- **The loop (no network):** pure function with a fake provider — a local `http` server the provider's `baseUrl` points at — covering: success stores JSON; already-analyzed skipped; expired deleted; 429-then-200 retried; 401 aborts the run; malformed JSON → failed row; stop mid-run finalizes with `outcome: "stopped"`.
- **Retention:** `resolveBaseRetention` (base present/absent, base value wins over run config, default 30); `RunOptions.retentionDays` flows into `syncDb`.
- **DB layer:** `setJobAnalysis` preserves status/created_at; `bulkMarkBelowThreshold` only touches parsed-below-threshold rows; `countAnalysis` buckets correctly; delete honors retention.
- **Server:** one-DB-at-a-time 409, stop 200/409, provider CRUD + test (local fake provider), seed-from-example, onboarding blocks runs — using a stub analysis CLI mirroring the `STUB_CLI` pattern.
- **CLI:** `analyze` spawn against the local fake provider; detach-on-Ctrl+C covered.
- **Analysis cron:** `cron.json` parses `kind: "analysis"` (requires `dbKey`) and `kind: "run"` (default, requires `config`); the gateway spawns `analyze run <dbKey>` for a due analysis cron with trigger env; a spawned analysis that loses the lock exits `skipped`.

---

## 10. Out of scope / YAGNI

- Bounded-parallel AI calls (loop is isolated; add later if needed).
- Streaming token output (progress is per-row, not per-token).
- Force re-analysis of already-analyzed rows (a future "re-analyze all" flag).
- Per-job custom instructions / per-DB provider selection (one enabled provider, one instructions field).
- UI for editing `.env` beyond the per-provider key field.
