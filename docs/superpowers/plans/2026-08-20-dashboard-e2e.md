# Manual E2E — Dashboard, npm installation, AI analysis & edge cases

**Click-driven, browser-first.** Every browser scenario names the page, control, action, and exact thing to verify. The installation section intentionally includes terminal commands because this plan is also a clean-machine package-install test. The edge cases — missing prerequisites, provider failures, closing the dashboard mid-run, killing processes, shared DB paths, and stopping the gateway while work runs — are first-class test cases, not optional cleanup.

**Pages you'll use** (top-bar tabs): **Jobs** · **Analysis** · **Cron** · **Config** · **Docs**, plus the **⚙ Settings** link. Landing page is Jobs. A green dot in the top-left blinks when the dashboard's live socket is connected.

## Scenario map

| # | Scenario | Pages / buttons | Verifies |
|---|---|---|---|
| 0 | Clean-machine global npm installation | npm registry → global CLI → dashboard | Node prerequisite, global install, CLI, dashboard, clean user state |
| 1 | First run | Config → **Run now** | Base run works, card shows live progress |
| 2 | Stop + guard rails | Config → **Run now** again / **Stop** | 409 on double-start, Stop aborts & saves partials |
| 3 | Jobs page after a run | Jobs | DB rows, ticker, score column, dedup |
| 4 | AI onboarding and provider test | Analysis → provider form → **Test** | Seeded config, key redaction, provider setup, success/failure states |
| 5 | AI analysis happy path | Analysis → **Run analysis** | Prompt, score/reason storage, progress, summary, recommended count |
| 6 | AI analysis failure/recovery paths | Analysis → Stop / invalid provider / fake failures | 400/409 guards, retries, row failures, auth abort, restart recovery |
| 7 | Close the dashboard mid-run | Config/Analysis + closing/killing the dashboard | Reattach on restart, no stale "running" |
| 8 | Kill a run process | Config/Analysis + `taskkill` the run's pid | Stale marker recovered, Run now re-enables |
| 9 | Add a job cron | Cron → form → **Add cron job** | Job card, countdown, auto-fire after Resume |
| 10 | Add an analysis cron | Cron → Analysis crons → form | DB target, separate section, scheduled analysis spawn |
| 11 | **Stop the gateway while work runs** | Cron → **Stop** (gateway) | Run orphans, card flips to done — never stuck running |
| 12 | Restart the gateway while work runs | Cron → **Restart** | Stale pidfile cleared, work survives |
| 13 | Cron controls and unhappy paths | Cron cards | Run now, Stop, Pause, Disable, Remove, invalid config |
| 14 | Two dashboards and shared state | Config/Analysis, two terminals | Shared state, cross-dashboard 409 + Stop |
| 15 | Jobs deep dive | Jobs | Search, filters, score sort, detail verdict, status actions |
| 16 | Settings / Docs / theme / teardown | Gear, Docs, sun/moon | Environment truth, docs render, theme persists, clean shutdown |

---

## 0. Clean-machine global npm installation (~5 minutes)

Run this section on a machine with no previous `omijobs` install and no previous `~/.omijobs` state. This is the only installation workflow in this plan. Record the OS, Node version, npm version, package version, and command results. Do not put API keys in shell history or paste them into this document.

### 0A — Verify prerequisites and install globally

1. Open PowerShell or a terminal and run:

   ```powershell
   node --version
   npm --version
   npm view omijobs version
   npm install --global omijobs
   Get-Command omijobs
   omijobs --help
   ```

   - **Pass:** Node reports `v24` or newer, npm runs, the registry returns the expected package version, global install exits 0, and `omijobs --help` lists `run`, `cron`, `analyze`, and `dashboard`.
   - **Unhappy path:** On a machine with Node below 24, stop and record that installation is blocked by the package engine requirement. Do not work around it with an older Node version. Install Node 24+, reopen the terminal, and repeat the checks.
   - **Unhappy path:** If npm emits an engine warning or install fails, capture the exact warning/error and check `Get-Command node,npm`.
   - **Unhappy path:** If `omijobs` cannot be found, check `npm root --global`, `npm prefix --global`, and `Get-Command omijobs -All`; repair PATH before continuing.

2. Confirm the installed runtime assets without opening or printing any `.env` file:

   ```powershell
   npm root --global
   Get-ChildItem "$(npm root --global)\omijobs" -Name
   Test-Path "$(npm root --global)\omijobs\dist\cli.js"
   Test-Path "$(npm root --global)\omijobs\dashboard\index.html"
   ```

   - **Pass:** the global package contains `dist/cli.js`, `dashboard/index.html`, `dashboard.configs/realtime/config.json`, and `analysis.config.example.json`.
   - **Unhappy path:** If the package is missing `dist` or dashboard assets, do not continue to browser testing; the published package is incomplete.

3. Start from a disposable working directory:

   ```powershell
   New-Item -ItemType Directory -Force "$HOME\omijobs-global-e2e" | Out-Null
   Set-Location "$HOME\omijobs-global-e2e"
   omijobs analyze status
   omijobs dashboard --port 5211
   ```

   - **Pass:** `omijobs analyze status` creates only expected user state under `~/.omijobs`; `omijobs dashboard` prints a URL and serves the dashboard. The global installation directory remains read-only application assets, not runtime storage.
   - **Unhappy path:** If the dashboard cannot find its bundled base config, stop and record a packaging/configuration defect. Do not manually edit the global install to hide it.

## 1. Stateful test setup (~30 seconds)

1. Keep the dashboard started by `omijobs dashboard` from section 0 running, or restart it with `omijobs dashboard --port 5211` if needed. Use the URL it prints.
3. Click **Cron**. If the gateway card shows `running (pid …)`, click **Restart** (a gateway started before this feature needs restarting to spawn runs with the marker env). If it shows `not running`, click **Start**. Either way: badge flips to `running (pid <new>)`.
4. Do not clear `~/.omijobs`, remove cron jobs, delete DBs, or reset the browser between scenarios. Later scenarios intentionally reuse the base run, DB rows, provider settings, cron jobs, and dashboard state created earlier.
5. Only reset a single scenario's resource when the scenario explicitly says “fresh run”, “fresh DB”, or “fresh state”. Record that reset before performing it.
6. For AI scenarios, use a disposable provider key or local fake OpenAI-compatible endpoint. Never display or paste a real key into this plan.

**The one rule that makes the edge cases work — "close" vs "kill":**

| You do this | What actually happens to the in-flight run |
|---|---|
| Close the browser tab | Nothing — the dashboard server keeps running, the run keeps going. Reopen = reattach, trivially. |
| Ctrl+C in the dashboard terminal | The run **aborts gracefully** (SIGINT goes to the shared console). This is Stop-equivalent, NOT a crash. |
| **Kill the dashboard process** (Task Manager → End task on node, or `taskkill /F /PID <dashboard-pid>`) | Only the dashboard dies. The run **orphans and keeps fetching**. This is the true crash test. |

> This plan is cumulative: start at section 0 and continue in order. Resources created in earlier sections are inputs to later sections. Only the explicitly marked fresh-run scenarios reset anything.

---

## 2. First run — Config page

1. Click **Config**.
   - See: "Configuration" heading, a **Realtime** section, and the `base` card showing hint `realtime config`, a db badge (`jobs.db · not created yet` on a fresh install, or `jobs.db · N jobs` after the first run), `queries: finance intern`, `adapters: <the 5 enabled portals>`, and three buttons: **Edit**, **Run now** (bright/primary), **Stop** (greyed out).
   - No **Cron** section here yet — that only appears once a cron job exists.
2. Click **Run now** on the `base` card.
   - See: toast `Started a run for "base" (<runId>)`. Within ~5 s the card grows a run line that updates as each portal finishes — e.g. `run: ✓ gradconnection — 3 raw, 0 dropped, 7s · just now` — then the next portal's boundary line. **Run now** greys out; **Stop** becomes active.
3. Let it finish.
   - See: run line becomes the summary `run: 123 jobs, 12 dropped, 3 deduped` (no `· just now` suffix), **Stop** greys out, **Run now** re-enables, and the db badge flips to `jobs.db · 123 jobs`.

**That's the happy path.** Everything below is what happens when things *don't* go to plan.

---

## 3. Stop & guard rails (one shared running window)

Start a run (§2 step 2). While it's running:

1. **Try to start another.** Click **Run now** again — by the next refresh it's already disabled, but if you catch it: toast `A run for "base" is already in progress` and nothing starts. **No second process.** This is the fix for "spawned twice onto the same jobs.db → database is locked".
2. **Stop it.** Click **Stop**.
   - See: toast `Stopping "base" — saving results so far…`. Within ~250 ms the run aborts; the card shows a result ending `· stopped`; **Stop** greys out; **Run now** re-enables. The jobs fetched so far are already in the DB (check **Jobs**).

Now, with `base` idle:
3. Click **Stop** anyway.
   - See: toast `No run for "base" is currently in progress`. Nothing breaks. Stop is a no-op when there's nothing to stop.

---

## 4. AI onboarding and provider setup — Analysis page

1. Click **Analysis** using the clean `~/.omijobs` state created in section 0.
   - **Pass:** the page shows `No AI provider configured — analysis is disabled` only when no provider exists; otherwise it shows the configured provider and `set`/`unset` key status. Do not reset the state created by section 0 unless explicitly recording a separate fresh-state run.
   - **Security check:** no API key value appears in the page, browser network response, CLI output, log, or `.json` settings file.
2. Add a provider using the onboarding form with a local fake OpenAI-compatible endpoint or disposable test provider. Use a harmless key entered directly into the key field.
   - **Pass:** the provider appears with the correct name/model/base URL and key status becomes `set`; the key field is not repopulated when the form is reopened.
   - **Unhappy path:** blank key, blank id/name/model/base URL, malformed URL, duplicate id, invalid temperature, negative timeout, or threshold outside `0..10` is rejected with a useful error and leaves the prior settings unchanged.
3. Click **Test** / **Check status**.
   - **Pass:** a minimal request returns `ok` and the model reply; the request uses `Reply with the single word OK` and `ping`, and the key is not shown.
   - **Unhappy path:** fake 401/403/404, malformed JSON, timeout, network failure, and 429/500 responses show an error without claiming the provider is healthy. Confirm transient failures retry and auth/config failures do not retry indefinitely.
4. Enable provider A, add provider B, enable B, remove B, then reload the page.
   - **Pass:** enable/remove state persists; deleting the enabled provider clears the enabled selection; provider keys remain write-only.
5. Edit the system prompt, description limit, and recommendation threshold. Set threshold to `0`, `5`, and `10` in separate checks.
   - **Pass:** values persist after reload; recommendations use `score >= threshold`; the model prompt never contains the threshold.

## 5. AI analysis happy path

Use a local fake provider that records request bodies and returns deterministic verdicts. Seed the selected aggregate DB with at least: one high score, one below-threshold score, one already analyzed row, one malformed/empty row candidate, one old row, and one row with a long description.

1. On **Analysis**, select the DB, enter instructions such as `remote internship in Hong Kong`, and click **Run analysis**.
   - **Pass:** the button disables, a running banner shows the selected DB, progress advances as `N/M jobs analyzed`, and the provider receives system prompt, user instructions, and the expected truncated job JSON.
   - **Pass:** the request is OpenAI-compatible: `/chat/completions`, bearer authorization, `model`, `messages`, `temperature`, `max_tokens`, and `stream: false`.
2. Let the run finish.
   - **Pass:** each valid response is stored exactly as `{ "score": <integer 0–10>, "reason": "<text>" }`; existing analyzed rows are skipped; expired rows are deleted; malformed responses remain unanalyzed; the final line reports analyzed/skipped/failed/deleted/recommended counts.
   - **Pass:** the DB card shows total/analyzed/pending/recommended counts and a final run time. Refreshing the dashboard shows the same summary and no false running state.
3. Open **Jobs**.
   - **Pass:** Score appears as a column; valid scores sort ascending/descending; null scores render as `—` and sort last; **AI recommended** shows only parsed scores at or above the selected threshold.
4. Click a score and open the row detail.
   - **Pass:** the verdict shows readable score plus reason. Legacy or malformed analysis falls back to raw JSON rather than crashing.
5. On Analysis, click **mark all below threshold as uninterested** and confirm.
   - **Pass:** only parsed scores below threshold change status; rows with no analysis or malformed analysis do not change; the response reports the exact count; Jobs ticker/status filters update.

## 6. AI analysis failure, stop, and recovery paths

1. Start analysis with no enabled provider, an unset key, a missing DB, and an invalid DB key.
   - **Expected:** each request is rejected with 400-level feedback; no process starts and no marker is left behind.
2. Start analysis, then click **Run analysis** again from the same or another dashboard.
   - **Expected:** the second request is rejected with 409; the global active marker identifies the resolved DB path; two config ids sharing one DB cannot run concurrently.
3. Start analysis and click **Stop**.
   - **Expected:** Stop writes the stop marker, the loop stops between rows, completed rows remain stored, status becomes `stopped`, exit behavior is 130, and the active marker is removed.
4. Stop while idle, stop with a different DB selected, delete the DB during setup, and close/reopen the browser during analysis.
   - **Expected:** idle/wrong-DB Stop returns 409 without damage; missing DB returns 400; browser reopen reattaches to the same progress and running state.
5. Exercise fake provider responses: fenced JSON, prose around JSON, numeric-string score, score below 0, score above 10, missing score, empty reason, malformed JSON, 429 then 200, repeated 5xx, timeout, and 401.
   - **Expected:** valid responses are normalized/clamped; malformed responses count failed and leave `analysis` empty; transient errors retry then fail only that row; auth/config errors abort the whole run and write an error status.
6. Kill the dashboard process while analysis is running, restart it, then separately kill the analysis process by PID.
   - **Expected:** dashboard kill leaves analysis running and reattachable; completed orphaned analysis shows its final summary; killing the analysis process leaves a stale marker that is PID-verified, cleaned, and does not block a fresh run.
7. Start two dashboards using the same state directory.
   - **Expected:** both show the same active DB/progress; one can stop the run started by the other; a second start receives 409.

## 7. Jobs page after a run

1. Click **Jobs**.
   - See: a **Source** dropdown (default `default (jobs.db)`), a status filter (`any status`), a search box, and a ticker with **total / unapplied / applied / uninterested** counts. The table lists every job: `posted_ago`, `title`, `company`, `location`, and a status chip.
2. Confirm dedup: the same job seen on two portals (e.g. gradconnection and jobsdb) appears **once** — dedup by title+company+location. Rows come from every run, never duplicated.

---

## 8. Close the dashboard mid-run — the big one

Do these four variants in order of severity. Each needs a fresh run.

**Variant A — close the browser tab.** Start a run, close the tab, reopen `http://127.0.0.1:5211`. *Expected:* the `base` card is still running with the progress it accumulated. Trivially true (the server never died) — sanity check that nothing is session-scoped to the tab.

**Variant B — Ctrl+C in the dashboard terminal.** Start a run, Ctrl+C the terminal. Reopen the dashboard. *Expected:* the card shows a partial result ending `· stopped` — the run aborted *gracefully* (SIGINT reached the run's console group). This is Stop-equivalent, not a crash.

**Variant C — kill the dashboard process (the crash test).** Start a run, wait ~10 s, then Task Manager → End task on `node`, or `taskkill /F /PID <dashboard-pid>`. Only the dashboard dies — the run keeps fetching in the background. Restart the dashboard (`node dist/cli.js dashboard`). *Expected:* the `base` card shows **running again** with the accumulated live progress and **keeps updating** — the new dashboard reattached to the orphan via its PID-verified marker. **Run now is disabled** and **Stop works** (click it: run aborts, partials saved, card shows `· stopped`).

**Variant D — kill the dashboard, let the run finish, then reopen.** Start a run, kill the dashboard (as C), wait for the run to actually complete (a minute or two), reopen the dashboard. *Expected:* the card shows the **final result summary, not "running"** — **Run now** is re-enabled. This is the direct fix for the old "close dashboard mid-run → reopen → stuck/unknown state" bug: the CLI deletes its marker on exit, so a restarted dashboard can't mistake it for running.

---

## 9. Kill a run process — stale marker recovery

1. Start a run. Read its pid from `~/.omijobs/runs/base.running` (a small file containing `{"pid": <pid>, "startedAt": …}`).
2. Kill that pid: `taskkill /F /PID <pid>`. The run dies *without* clearing its marker — exactly the stale-state case.
3. Watch the **Config** page. *Expected:* within ~5 s the card flips to **not running**, settling on the last progress line it had. The dashboard detected the dead PID, discarded the marker, and removed the run from its in-flight set — no "running" forever, and **Stop** greys out.
4. Click **Run now**. *Expected:* a fresh run starts normally — the stale marker did **not** block a restart, and it did **not** leave the card stuck.

---

## 10. Cron page — add a job

1. Click **Cron**.
   - See: the **Cron gateway** card (badge `running (pid X)` from setup, buttons **Start / Stop / Restart**, and **Resume** — it reads *Resume* because cron starts paused; it reads *Pause* when active), plus a **New scheduled run** form at the bottom.
2. Fill the form: Name `finance` · Schedule `every 6 hours` · Queries blank (inherits base queries) · Adapters leave as-is · Storage **shared jobs.db**. Click **Add cron job**.
   - See: a `finance` card appears with badge `never run`, countdown `next: 6h 0m`, `schedule: every 6 hours`, a callout (`queries: finance intern · db: jobs.db · not created yet`), `last run: never`, and buttons **Run now / Stop / Disable / Remove**.
3. Click **Resume** on the gateway (button flips to **Pause**). *Expected:* within ~5 s (next gateway tick) the never-run job is *due*, so it fires on its own: badge flips to **running now**, the `last run` line shows live progress, **Run now** disables, **Stop** enables.

---

## 11. Cron page — add an analysis job

1. In **Cron**, locate the separate **Analysis crons** section.
   - **Pass:** it is visually distinct from scheduled run jobs and has Name, Schedule, and DB controls. The DB choices represent distinct resolved database paths and show their owning config ids.
2. Add an analysis cron for `base` with `daily at 10:00`.
   - **Pass:** an analysis badge appears with the selected DB key, schedule, enabled state, countdown, and the standard Run now / Stop / Enable / Disable / Remove controls.
   - **Unhappy path:** blank name, invalid schedule, duplicate name, unknown DB key, or missing base config is rejected and does not write a partial cron entry.
3. Click **Run now** on the analysis cron.
   - **Pass:** it spawns `analyze run <dbKey>` with the cron trigger and analysis state channels; the Analysis tab shows the same run and summary; the global analysis lock prevents another analysis cron from starting.
4. Disable, enable, pause, resume, stop, and remove the analysis cron.
   - **Pass:** each action has the same semantics as a run cron; pause prevents new analysis fires but does not interrupt an active analysis; remove requires confirmation and does not delete the target DB.

## 12. Stop the gateway while a job runs — the stale-"running" fix

Continue from §10 step 3 with `finance` mid-run:

1. Click **Stop** on the gateway card.
   - *Expected:* gateway badge flips to `not running`; **Start** enables, **Stop / Restart** disable. The `finance` job card badge flips to **`running (stale — gateway down)`** — the run is an orphan now, still genuinely fetching.
2. Let the orphan finish. *Expected:* the job card flips to **not running** and shows the run's result line (`last run: … · N jobs, … dropped`). It never stays on "running".

That last sentence is the whole point: the old code kept `lastStatus: "running"` in the cron state forever after a gateway kill, so the job showed "running" indefinitely. Now the run's own marker (PID-verified, deleted by the CLI on exit) decides, so it always flips back.
*Afterwards:* click **Restart** on the gateway (it's stopped now) — it comes back as `running (pid <new>)`. The hard kill skipped the gateway's cleanup, and restart clears the stale pidfile.

---

## 13. Restart the gateway while a job runs

1. With the gateway stopped, click **Run now** on the `finance` job card — this spawns the run *directly* from the dashboard, so it works even with the gateway down. Wait until the card shows `running now`.
2. Click **Restart** on the gateway (it's stopped, so this starts it). *Expected:* badge comes back as `running (pid <new>)`; the job card stays `running now` (the orphaned run kept going); it completes normally with its result line.

---

## 14. Cron job — Run now / Stop / Pause / Disable

With the gateway stopped (so nothing fires on its own):

1. **Run now** on the `finance` card → badge `running now`, live progress, **Stop** active. Click **Run now** again while it runs → disabled on refresh (same 409 guard as the Config page — a run can't overlap itself).
2. **Stop** → aborts; partial results saved; card shows the partial result; **Run now** re-enables.
3. **Disable** → the card stays but the gateway skips it; the button flips to **Enable**. Click **Enable** to restore.
4. Gateway **Pause** → button flips to **Resume**, and a due job will **not** fire until you resume. **Resume** → a due job fires on the next tick. Pausing never interrupts a run already in flight — only stops new ones from starting.

---

## 15. Two dashboards, one state

1. Terminal A: `node dist/cli.js dashboard` (5211). Terminal B: `node dist/cli.js dashboard --port 5212`.
2. Start a run on A (Config → **Run now**). On B, Config page: *Expected:* the `base` card shows **running** too — both dashboards read the same markers.
3. **Run now** on B → rejected (409 toast). **Stop** on B → works; both dashboards flip to `· stopped` / done.

---

## 16. Jobs deep dive

After a run that produced several jobs (see §7 for the base state):

1. **Sort:** click a column header — `posted_at`, `title`, `company`, `location`, `score`, `status`. Click again to toggle ↑/↓ (the active column shows an arrow; null scores remain last).
2. **Search:** type in the search box — the list narrows as you type (title/company/location, ~300 ms debounce). Clear it to restore.
3. **Filter:** status dropdown → `unapplied` / `applied` / `uninterested`.
   - Toggle **AI recommended** and verify only parsed scores at or above the configured threshold remain. Set the threshold to `0` and `10` on Analysis and confirm the result set changes accordingly.
4. **Detail modal:** click any row → modal with title, company, location, posted time, source, apply URL (opens in a new tab), analysis (if the adapter recorded any), and description.
5. **Status:** click **Apply** → toast `Marked applied`, the chip flips to `applied`, and the ticker's `applied` count increments. Open another row → **Not interested** → chip flips, `uninterested` increments. The status filter now shows/hides these accordingly.
6. **Source dropdown:** if a cron job uses *separate* storage, a second source (named after the job) appears here — its own DB, its own counts.

---

## 17. Settings / Docs / theme

1. Click the **⚙** gear (top-right) → **Settings**: an *Appearance* card (theme toggle) and an *Environment* card showing **Port, Package dir, State dir, Base config, Cron file, CLI, Adapters**. Spot-check they match reality — that's the dashboard's self-report.
2. Click **Docs** → the rendered overview (Jobs / Cron / Config / Settings). It's a faithful summary of what you just clicked through.
3. Click the **sun/moon** toggle → theme flips. Reload the page → still applied (remembered in localStorage).

---

## 18. Teardown

1. Cron page: gateway **Stop** (or leave it running), then **Remove** on `finance` (confirm dialog).
2. Dashboard terminal: Ctrl+C to stop the server.

---

## 19. Edge-case cheat sheet

| Action | Should see |
|---|---|
| Run now while a config is running | 409 toast, no second process, Run now disabled |
| Stop while nothing is running | 409 toast, no-op |
| Stop while running | Run aborts in ~250 ms, result ends `· stopped`, partials saved |
| Close browser tab mid-run | Reopen → still running, progress intact |
| Ctrl+C dashboard terminal mid-run | Run aborts gracefully (Stop-equivalent), not orphaned |
| Kill dashboard process mid-run | Run orphans; reopen → still running, Stop works, Run now blocked |
| Kill dashboard, run finishes, reopen | Result summary, NOT "running"; Run now re-enabled |
| Kill the *run* process | Card flips to not-running in ~5 s; fresh Run now works |
| Stop gateway while a job runs | Gateway down; job shows `running (stale — gateway down)` then flips to done — never stuck "running" |
| Restart gateway while a job runs | Gateway back up with new pid; job run survives |
| Pause gateway | Due jobs stop firing; running job unaffected; Resume restores |
| Disable a job | Gateway skips it; button flips to Enable |
| Run now on a cron job with gateway down | Works (dashboard spawns directly) |
| Two dashboards, same state | Both show the same run; 409 across both; Stop from either |
| Analysis with no provider/key | Disabled or 400; no child process or active marker |
| Provider test 401/403/404 | Clear error; no endless retry; key never shown |
| Provider test 429/5xx/timeout | Retries, then reports failure without marking provider healthy |
| Valid fenced/prose/numeric-string AI JSON | Stored as normalized integer score + non-empty reason |
| Invalid AI JSON / empty reason | Row remains pending and increments failed count |
| AI score below/above range | Stored score is clamped to 0/10; recommendation uses threshold only |
| Analysis Stop | Partial rows persist; status is stopped; active marker clears |
| Analysis process killed | Stale marker is cleaned after PID check; a new analysis can start |
| Two config ids share one DB | One analysis lock; second start returns 409 |
| Analysis cron while another analysis runs | Spawned child self-skips; next schedule can retry pending rows |
| Bulk mark below threshold | Only parsed below-threshold rows become uninterested |
| npm install on Node <24 | Install is rejected/blocked by engine requirement; upgrade Node |
| npm install from registry | Bin works via `npx omijobs`; package has no source/tests/secrets |
