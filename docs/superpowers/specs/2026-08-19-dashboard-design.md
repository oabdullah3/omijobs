# omijobs dashboard — Design Spec

**Date:** 2026-08-19
**Status:** Approved by user (design reviewed section-by-section)
**Next step:** writing-plans (implementation plan)

## 1. Purpose

`omijobs dashboard` launches a local web dashboard that ties the tool together: view and control the aggregate job DBs, the cron scheduler, and the config files — all from a browser. It is a **control surface over the existing CLI**, not a second implementation. Reads come from the same files the CLI reads; every mutation invokes the same CLI command a terminal user would type.

The package currently has **zero runtime dependencies and no build step**. The dashboard keeps that: a static HTML/CSS/JS app served by a small `node:http` server started by `omijobs dashboard`. Nothing new to install, nothing to compile, works offline against `127.0.0.1`.

**Hard constraints (from user):**
- Zero new runtime dependencies; no build step.
- The dashboard must **react automatically** to changes (DB rows written by cron, cron state changes) — no manual refresh.
- It must **control cron dynamically** — the full stop/start/pause/resume/enable/disable/add/remove/run-now surface.
- DB access must **never clash with the cron gateway's writes**.
- Foreground server: `omijobs dashboard` runs in the terminal, auto-opens the browser, Ctrl+C stops.
- The jobs view is **purely DB-based** (never the `output/runs` JSON), and the user always knows **where each config stores its DB**.
- **DB mode is enabled by default everywhere** (omitted `db.enabled` ⇒ on) — the dashboard depends on it; disabling shows a warning (§7, §9).
- Visual language adapted from the user's reference HTML (`the-stt-test-harness.html`).

## 2. Design language

Adapted wholesale from `the-stt-test-harness.html` (editorial, magazine-style). Its CSS variable system, palette, typography trio, and component vocabulary are reused directly:

- **Palette (light):** bg `#F4F5F7`, surface `#FFFFFF`, ink `#1B2230`, muted `#5B6574`, faint `#929CAB`, line `#E2E6EC`, accent `#C01E33` (crimson), accent-soft `#FAE9EB`, good `#1F7A4C` / good-soft `#E8F3EC`, warn `#A05A00` / warn-soft `#FAF0DF`, shadow `0 1px 2px rgba(20,26,40,.04)`.
- **Dark theme:** carried over verbatim (bg `#14171D`, surface `#1A1F28`, accent `#FF5A66`, …) via `prefers-color-scheme` plus a manual `data-theme` toggle.
- **Type:** serif (Georgia/Iowan/Palatino) for headings; system sans for body at 17px/1.62; ui-monospace for labels, numbers, codes. Mono uppercase eyebrows at 12.5px with `.14em` letter-spacing.
- **Reused components:** pulsing `rec` dot; **ticker** stat cards (mono number + label); **callouts** (accent-soft, 3px left accent border, mono tag); **chips** with dots (`.fixed`/`.skip`/`.blocked` → applied/unapplied/uninterested); **tables** with sticky mono uppercase headers and accent first column; **flow nodes** (`node` / `node.hl`) for run progress; mono **pre panels** for logs; **gloss/lat cards** for docs and per-adapter blocks; hairlines and soft shadows throughout.
- **Adaptations for an app shell:** a slim top nav bar (mono uppercase links, active item underlined in accent; gear icon far right → Settings; light/dark toggle), compact per-page headers (serif h1 + eyebrow + lede + page actions), and a one-line app bar instead of the reference's 72px hero. The `rec` dot marks a live server / running gateway.

## 3. Architecture

- **CLI command:** `omijobs dashboard [--port N]`. Foreground; prints the URL; auto-opens the browser (`start` on Windows, `open` on macOS, `xdg-open` on Linux); Ctrl+C stops. `cli.ts` dispatches it to `startDashboard()`.
- **Server** (`src/dashboardServer.ts`): a `node:http` server bound to `127.0.0.1` (default port **5211**, `--port` overrides). Serves the static `dashboard/` folder, exposes the JSON API (§5), and hosts one SSE channel. Testable by injection: `startDashboard({ port?, packageDir?, stateDir?, cliPath?, openBrowser?, now? })` defaults to the real package/state paths.
- **Helper modules** (flat `src/*.ts`, matching project convention):
  - `src/dashboardDb.ts` — DB discovery + reads + status updates (§6).
  - `src/dashboardRuns.ts` — spawn a config's sweep as a child and stream its stdout/stderr; list recent runs from `output/runs/*/run.json`.
  - `src/dashboardConfig.ts` — config discovery, friendly-field extraction, validation, atomic writes.
  - `src/dashboardCron.ts` — cron state assembly (loadCron + gateway status + per-job `nextRunAt`/`running`) and mutation dispatch.
- **Frontend** (zero-build static): `dashboard/index.html`, `dashboard/styles.css`, `dashboard/app.js` (hash router + shell), `dashboard/api.js` (fetch + EventSource client), `dashboard/views/jobs.js`, `cron.js`, `config.js`, `docs.js`, `settings.js`.

## 4. Control model — the CLI is the single source of truth

- **Reads:** the server reads state directly from the same files the CLI reads — `config.json`, `cron.json` (via `loadCron`), the SQLite DBs, `~/.omijobs/cron.log` tail, `gateway.pid`, `autostartStatus()`.
- **Mutations:** the server spawns the real CLI (`node <packageDir>/dist/cli.js cron <cmd> …`) as a child and returns its stdout + exit code to the browser. A UI click is literally the terminal command, so every edge case the backend already handles (run-while-running, gateway down, missing config) surfaces identically.
- **Running a sweep:** `POST /api/configs/:id/run` spawns `node <cli> run --config <path>` with `OMI_JOB_FETCH_TRIGGER=dashboard`, streams its stdout/stderr to SSE subscribers, and returns `{ runId }` with the outcome recorded. This is what both the Config page's **Run now** and the Cron page's per-job **Run now** use. The dashboard tracks its own in-flight configs to block duplicate manual runs.
- **Config edits** are the one in-process write (JSON parse → validate → atomic write via temp file + rename) — they do not go through a CLI subcommand because no such command exists. Cron config *creation* happens in-process (write the new config file), then `cron add` is spawned to register the job.

## 5. Server API

| Route | Method | Purpose |
|---|---|---|
| `/api/bootstrap` | GET | package dir, state dir, port, config/cron paths, adapters registry (id + human name for the forms). |
| `/api/configs` | GET | base + cron configs: `{ id, kind: base\|cron, path, queries, enabledPortals, outputDir, db:{ enabled, path, exists, jobCount }, lastRun? }`. |
| `/api/configs/:id` | PUT | partial update `{ queries?, enabledPortals?, raw? }` → validate, merge, atomic write; returns saved config + errors. |
| `/api/configs/:id/run` | POST | spawn that config's sweep; streams over SSE; returns `{ runId }`. |
| `/api/cron` | GET | `{ file, paused, gateway:{ running, pid, autostart }, jobs:[…] }` — each job: `id, config, configPath, schedule, parsed, enabled, lastRun, lastStatus, nextRunAt, running`. |
| `/api/cron/:action` | POST | `start`, `stop`, `restart`, `enable`, `disable`, `pause`, `resume`, `remove`, `run` — spawn the CLI; returns `{ ok, code, output }`. |
| `/api/cron/add` | POST | `{ name, schedule, storage: shared\|separate, config: { new, fromTemplate?, queries?, enabledPortals? } \| { existing, path } }` — name must be **unique** (409 on duplicate, never auto-suffixed); write the config file if new (applying `storage`, §7), then spawn `cron add`; returns CLI output. |
| `/api/dbs` | GET | `[{ key, label, path, exists, jobCount, byStatus:{ unapplied, applied, uninterested } }]` — one per enabled config's resolved DB. |
| `/api/dbs/:key/jobs` | GET | `?status=&q=&sort=&dir=&limit=&offset=` → `{ total, rows }`. Default sort `posted_at` desc. `rows` carry `signature, status, postedAt, job:{ title, company, location, source, apply_url, … }`. |
| `/api/jobs/:dbKey/:signature` | GET | full row: `job` JSON + `status`, `analysis`, `created_at`, `updated_at`. |
| `/api/jobs` | PATCH | `{ dbKey, signature, status }`, status ∈ `unapplied\|applied\|uninterested` → single-row `UPDATE`; returns `{ ok }`. |
| `/api/runs` | GET | recent `output/runs/*/run.json` summaries, newest first. |
| `/api/events` | GET | SSE. Events: `{type:"cron"}` (cron.json/gateway changed), `{type:"db", dbKey}` (DB file changed), `{type:"run", runId, status}`, `{type:"log", runId, line}`. |

**Reactivity:** the server stat-polls `cron.json` and each discovered DB's mtime every 2s and pushes `cron`/`db` SSE events on change (so gateway-written `lastRun`/`lastStatus` and cron-written DB rows reach the UI live). The jobs view additionally re-fetches every 5s as a fallback if SSE drops.

## 6. Data & DB safety

- **DB discovery:** for each config (base + every cron job's config), resolve `outputBase = resolve(config.outputDir ?? "output")` and `dbPath = resolve(outputBase, config.db?.file ?? "jobs.db")` — identical to `dbFile()`/`runtime.ts`. Every config produces a DB entry unless `db.enabled` is explicitly `false` — the default is enabled (§9). Each entry's **absolute path is shown in the UI** so the user always knows where data is stored.
- **Reads:** open `DatabaseSync(file)` per request, `PRAGMA busy_timeout = 5000`, run the query, close. Never held across requests → cannot hold a lock while the cron gateway's runs write.
- **Status writes (`PATCH /api/jobs`):** single-row `UPDATE jobs SET status = ? WHERE signature = ?`, serialized by SQLite against cron's batch upserts. `syncDb` preserves `status`/`analysis` on re-runs, so UI-set statuses survive subsequent sweeps.
- **Busy handling:** on `SQLITE_BUSY` the endpoint returns a `409` with a clear message; the UI shows a "DB busy — a sweep is writing, retry in a moment" callout with a Retry button. No crash paths.

## 7. Pages & navigation

Top nav: **Jobs · Cron · Config · Docs** + gear (Settings) + theme toggle. Hash routing (`#/jobs`, `#/cron`, …).

### Jobs (`#/jobs`) — main page
- **Source selector:** every discovered DB, labeled by its owning config, with its absolute path shown; empty state when a DB file doesn't exist yet → a "run a sweep to populate it" hint pointing to Config/Cron. (DB mode is enabled by default; disabling it shows a warning, §7 Config.)
- **Ticker:** total / applied / uninterested / unapplied for the selected DB.
- **List:** rows with title, company, location, posted-at, source, status chip. **Default sort: latest posted_at.** Filters: status, text search (title/company/location). Sort: posted_at / company / title, asc/desc.
- **Detail:** click a row → modal with description, apply link, all fields, and an **analysis section shown only when present** (the `analysis` column exists today and is unused — future-ready, no features yet). Status controls: **applied** / **uninterested** / back to **unapplied**, applied immediately via `PATCH`.

### Cron (`#/cron`)
- **Gateway header:** running state (pulsing `rec` dot when alive), autostart state, global **Pause / Resume**, **Start / Stop / Restart**; `cron.log` tail (last ~10 lines) in a mono panel.
- **Per-job card:** id, human schedule, config path, enabled/disabled chip, last run time + status, **"running now" indicator** (pulsing dot + "running"), **live countdown to next run** ("in 12m", "next tick" when overdue, "Mon 09:00 UTC" for clock jobs) ticking client-side; the config's resolved DB path.
- **Per-job actions:** enable/disable, edit (→ Config editor), remove (confirm), **Run now** (disabled with "already running — started \<time\>" when running; allowed even when the gateway is down).
- **Add cron:** modal — name (**must be unique**; a duplicate is rejected with an inline error, never silently suffixed), schedule builder (interval presets, daily/weekdays/weekends at HH:MM, day picker) with live validation via `parseSchedule`, **storage choice**, and config (new from base template with query + enabled portals, or existing file).

  **Storage choice (simplified view, one per cron):** **Shared — the same `jobs.db` as normal runs** (the cron's config upserts into the base config's DB — same `outputDir` + `db.file`) or **Separate — a unique `<name>.db`** in the same output dir, named from the slugified cron name. Either way `db.enabled: true` is set on the cron's config so the dashboard can show its jobs. The **Advanced settings** panel overrides with the exact `outputDir` + `db.file`; when the user changes it there, the simplified control reflects the true state (shared / separate / custom).

### Config (`#/config`)
- Cards for the base config + every cron config: path, query, enabled-portal chips (from the adapters registry), outputDir, **resolved DB path**, last run outcome.
- **Edit:** friendly form (query + enabled-portal checkboxes); for cron configs it also exposes the same **storage** choice (shared `jobs.db` / separate `<name>.db` / custom — derived from the config's current `db.file`, saved back to `db.enabled` + `db.file`). **Disabling the DB triggers a warning** — "the dashboard's Jobs view will stop showing this source" — non-blocking, user can proceed; **Advanced settings** tucked behind a section toggle — a validated JSON editor with a friendly label per top-level block (pacing knobs, per-adapter params, outputs, dedup, outputDir, db). Save validates first; atomic write; inline errors.
- **Run now** per config (streams live into a log panel — visible when requested, not by default).

### Docs (`#/docs`)
Dashboard-only usage: quickstart (install/run, open the dashboard, enable a jobs DB), page-by-page walkthrough, FAQ/glossary. Rendered in the editorial style (callouts, tables, chips). No CLI docs.

### Settings (`#/settings`)
Theme (light/dark/system), port + state-dir info, advanced editors for the base config. Tucked behind the gear.

## 8. Edge cases & error handling

- **Run-now while a cron job is in flight** → disabled + "already running — started \<time\>"; the server also refuses when the same config is already running (dashboard-tracked in-flight, or gateway `lastStatus === "running"`).
- **Duplicate cron name** → rejected by the add-cron form and the `/api/cron/add` API (inline error / 409); ids are never silently suffixed, so the cron id always equals the name the user typed.
- **Gateway down** → stopped state, Start enabled; a job showing `running` with the gateway down is labeled **stale (gateway down)**.
- **Missing config file** for a cron job → error chip; Run-now disabled with the reason (mirrors the gateway's `missing config` handling).
- **Corrupt cron.json / config.json** → the API returns the parse error; the UI shows it in a callout and disables mutations that would overwrite the file.
- **Two writers (CLI + dashboard)** → config writes are atomic (temp + rename); the UI re-reads after save; last-writer-wins, matching existing CLI behavior.
- **DB busy** → `409` + retry callout (§6).
- **SSE dropped** → the 5s jobs polling keeps views current.
- **Run fails (exit 1)** → the log panel shows the CLI output; the config card shows the outcome; surfaced as a warning callout, never a crash.

## 9. Backend changes (approved)

- **`src/cron.ts` gateway loop:** when a job is spawned, write `lastStatus: "running"` (instead of leaving the stale previous value) alongside `lastRun`; the real outcome is written on completion as today. This makes "in progress" observable to the dashboard and to `cron status`/`list`, and fixes the stale-status-after-interrupted-run anomaly. ~2 lines.
- **DB enabled by default:** `db.enabled` defaults to **on**. `src/runtime.ts` runs the aggregate-DB sync when `config.db?.enabled !== false` (previously it required an explicit `true`); `config.json`'s `db.enabled` flips to `true`; the `types.ts` doc comment updates to match. DB failures stay non-fatal warnings — this only changes the default, never the opt-out. Existing tests asserting the old disabled default are updated.

## 10. File layout

```
omi-job-fetch/
  src/
    dashboardServer.ts      # NEW http server: routes, static, SSE hub; startDashboard()
    dashboardDb.ts          # NEW db discovery + reads + status updates
    dashboardRuns.ts        # NEW spawn/stream sweeps + recent-runs listing
    dashboardConfig.ts      # NEW config discovery, validation, atomic writes
    dashboardCron.ts        # NEW cron state assembly + mutation dispatch
    cli.ts                  # MODIFY add `dashboard` command dispatch
    cron.ts                 # MODIFY the "running" sentinel (§9)
  dashboard/
    index.html              # NEW shell
    styles.css              # NEW design tokens + components (reference-adapted)
    app.js                  # NEW hash router + page shell
    api.js                  # NEW fetch + EventSource client
    views/jobs.js           # NEW
    views/cron.js           # NEW
    views/config.js         # NEW
    views/docs.js           # NEW
    views/settings.js       # NEW
  tests/
    dashboard-db.test.js    # NEW
    dashboard-config.test.js# NEW
    dashboard-cron.test.js  # NEW
    dashboard-runs.test.js  # NEW
    dashboard-server.test.js# NEW (routes via injected state + stub CLI)
```

Path resolution mirrors the CLI: package dir for `config.json` / `cron.json` / `dist/cli.js`; cron config paths relative to `cron.json`'s dir; state in `~/.omijobs`. New cron configs created by the dashboard default to `test.configs/<name>.config.json` (matching the existing finance/tech cron configs).

## 11. Testing

- **Unit (vitest), all against injected temp dirs — never the real package or `~/.omijobs`:**
  - `dashboardDb`: discovery (enabled-only, path resolution), list with status/text/sort/paging, get full row, status PATCH (valid + invalid status), busy → 409.
  - `dashboardConfig`: discovery (base + cron), friendly-field extraction, validate (bad JSON, missing `queries`/`portals.enabled` → rejected), atomic write, partial merge.
  - `dashboardCron`: state assembly — running detection (`lastStatus === "running"`), `nextRunAt` rules (interval overdue → next tick; interval future → lastRun + interval; clock → next occurrence), gateway up/down/stale labeling.
  - `dashboardRuns`: spawn a stub script and assert line streaming + exit outcome; recent-runs listing from a fixture `output/runs/` tree.
  - `dashboardServer`: boot on an ephemeral port against temp state + a stub CLI; assert each route's status/shape; assert a cron mutation invokes the stub CLI with the right args.
- **Cron `nextDueAt`/`isDue`** are already covered by existing cron tests; the dashboard reuses them.
- **Frontend** is not unit-tested (zero-dep, no DOM harness) — the API is the tested surface; the UI is verified in the browser.

## 12. Scope

**In scope:** CLI command + server + helpers; the full static dashboard app (Jobs/Cron/Config/Docs/Settings); DB discovery + status controls; cron management + countdowns + run-now + add; config editing (friendly + advanced) with atomic writes; live SSE + polling reactivity; log streaming for dashboard-initiated runs; the `running` sentinel tweak; unit tests; design language adaptation.

**Deferred:** analysis features (column surfaced when present; no behavior yet), anything downstream of the DB/CLI.

**Non-goals:** auth/encryption (localhost only, `127.0.0.1` bind), multi-user, mobile-first layout (desktop-first, responsive), CLI documentation inside the dashboard, detaching the server as a background daemon.

## 13. Resolved decisions

- **Zero-build static SPA** (approach A) — no new runtime deps, no build step.
- **Foreground server**, Ctrl+C to stop, browser auto-opens; default port **5211**, `--port` overrides.
- **Control model:** reads from files, mutations via spawned CLI — single source of truth is the CLI.
- **Reactivity:** SSE push (2s file-watch) + 5s jobs polling fallback.
- **Config writes in-process, atomic** (temp + rename), validated before save.
- **New cron configs → `test.configs/<name>.config.json`** (existing convention).
- **Cron names must be unique** — enforced by the dashboard add-cron form and API; ids are never silently suffixed.
- **Simplified cron storage choice** — shared `jobs.db` (same as normal runs) or a per-cron `<name>.db`; exact `outputDir`/`db.file` editable in Advanced settings, which then overrides the simplified control.
- **Backend tweak:** gateway writes `lastStatus: "running"` at spawn.
- **DB enabled by default everywhere** — omitted `db.enabled` ⇒ on (`runtime.ts` default + `config.json` flip); disabling shows a warning in the dashboard.
- **Theme:** system preference by default, manual light/dark override in Settings.
