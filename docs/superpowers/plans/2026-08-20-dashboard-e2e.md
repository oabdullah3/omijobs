# Manual E2E — Dashboard walkthrough & edge cases

**Click-driven, browser-only.** Every scenario names the page, the button, and the exact thing you should see. The only terminal commands in the whole plan are the two that launch the thing (build + start the dashboard). The edge cases — closing the dashboard mid-run, killing the run process, stopping the gateway while a job runs — are the point of this document.

**Pages you'll use** (top-bar tabs, left→right): **Jobs** · **Cron** · **Config** · **Docs**, plus the **⚙ Settings** link. Landing page is Jobs. A green dot in the top-left blinks when the dashboard's live socket is connected.

## Scenario map

| # | Scenario | Pages / buttons | Verifies |
|---|---|---|---|
| 1 | First run | Config → **Run now** | Base run works, card shows live progress |
| 2 | Stop + guard rails | Config → **Run now** again / **Stop** | 409 on double-start, Stop aborts & saves partials |
| 3 | Jobs page after a run | Jobs | DB rows, ticker, dedup |
| 4 | Close the dashboard mid-run | Config + closing/killing the dashboard | Reattach on restart, no stale "running" |
| 5 | Kill the run process | Config + `taskkill` the run's pid | Stale marker recovered, Run now re-enables |
| 6 | Add a cron job | Cron → form → **Add cron job** | Job card, countdown, auto-fire after Resume |
| 7 | **Stop the gateway while a job runs** | Cron → **Stop** (gateway) | Run orphans, job flips to done — never stuck running |
| 8 | Restart the gateway while a job runs | Cron → **Restart** | Stale pidfile cleared, run survives |
| 9 | Cron job Run now / Stop / Pause / Disable | Cron job card | Guards + pause/resume semantics |
| 10 | Two dashboards | Config, two terminals | Shared state, cross-dashboard 409 + Stop |
| 11 | Jobs deep dive | Jobs | Search, filter, sort, detail modal, Apply/Not-interested |
| 12 | Settings / Docs / theme | Gear, Docs, sun/moon | Environment truth, docs render, theme persists |

---

## 0. One-time setup (~30 seconds)

1. In `omi-job-fetch/`: `npm run build` — the dashboard spawns `dist/cli.js`, so it must be current.
2. Start the dashboard: `node dist/cli.js dashboard` — browser opens to `http://127.0.0.1:5211`. (You'll be in `omi-job-fetch/`, so output lands where the dashboard expects.)
3. Click **Cron**. If the gateway card shows `running (pid …)`, click **Restart** (a gateway started before this feature needs restarting to spawn runs with the marker env). If it shows `not running`, click **Start**. Either way: badge flips to `running (pid <new>)`.
4. Clean slate (only if you've experimented before): on the Cron page, **Remove** any leftover jobs; and if `~/.omijobs/runs/` has stale files from old sessions, clear that folder. Neither is needed for a fresh checkout.

**The one rule that makes the edge cases work — "close" vs "kill":**

| You do this | What actually happens to the in-flight run |
|---|---|
| Close the browser tab | Nothing — the dashboard server keeps running, the run keeps going. Reopen = reattach, trivially. |
| Ctrl+C in the dashboard terminal | The run **aborts gracefully** (SIGINT goes to the shared console). This is Stop-equivalent, NOT a crash. |
| **Kill the dashboard process** (Task Manager → End task on node, or `taskkill /F /PID <dashboard-pid>`) | Only the dashboard dies. The run **orphans and keeps fetching**. This is the true crash test. |

> Runs take 1–5 min, so chain the in-flight scenarios: start one run, then work through §2's double-start/Stop and §4 before it ends. Sections that need a *fresh* run will say so.

---

## 1. First run — Config page

1. Click **Config**.
   - See: "Configuration" heading, a **Realtime** section, and the `base` card showing hint `realtime config`, a db badge (`jobs.db · not created yet` on a fresh install, or `jobs.db · N jobs` after the first run), `queries: finance intern`, `adapters: <the 5 enabled portals>`, and three buttons: **Edit**, **Run now** (bright/primary), **Stop** (greyed out).
   - No **Cron** section here yet — that only appears once a cron job exists.
2. Click **Run now** on the `base` card.
   - See: toast `Started a run for "base" (<runId>)`. Within ~5 s the card grows a run line that updates as each portal finishes — e.g. `run: ✓ gradconnection — 3 raw, 0 dropped, 7s · just now` — then the next portal's boundary line. **Run now** greys out; **Stop** becomes active.
3. Let it finish.
   - See: run line becomes the summary `run: 123 jobs, 12 dropped, 3 deduped` (no `· just now` suffix), **Stop** greys out, **Run now** re-enables, and the db badge flips to `jobs.db · 123 jobs`.

**That's the happy path.** Everything below is what happens when things *don't* go to plan.

---

## 2. Stop & guard rails (one shared running window)

Start a run (§1 step 2). While it's running:

1. **Try to start another.** Click **Run now** again — by the next refresh it's already disabled, but if you catch it: toast `A run for "base" is already in progress` and nothing starts. **No second process.** This is the fix for "spawned twice onto the same jobs.db → database is locked".
2. **Stop it.** Click **Stop**.
   - See: toast `Stopping "base" — saving results so far…`. Within ~250 ms the run aborts; the card shows a result ending `· stopped`; **Stop** greys out; **Run now** re-enables. The jobs fetched so far are already in the DB (check **Jobs**).

Now, with `base` idle:
3. Click **Stop** anyway.
   - See: toast `No run for "base" is currently in progress`. Nothing breaks. Stop is a no-op when there's nothing to stop.

---

## 3. Jobs page after a run

1. Click **Jobs**.
   - See: a **Source** dropdown (default `default (jobs.db)`), a status filter (`any status`), a search box, and a ticker with **total / unapplied / applied / uninterested** counts. The table lists every job: `posted_ago`, `title`, `company`, `location`, and a status chip.
2. Confirm dedup: the same job seen on two portals (e.g. gradconnection and jobsdb) appears **once** — dedup by title+company+location. Rows come from every run, never duplicated.

---

## 4. Close the dashboard mid-run — the big one

Do these four variants in order of severity. Each needs a fresh run.

**Variant A — close the browser tab.** Start a run, close the tab, reopen `http://127.0.0.1:5211`. *Expected:* the `base` card is still running with the progress it accumulated. Trivially true (the server never died) — sanity check that nothing is session-scoped to the tab.

**Variant B — Ctrl+C in the dashboard terminal.** Start a run, Ctrl+C the terminal. Reopen the dashboard. *Expected:* the card shows a partial result ending `· stopped` — the run aborted *gracefully* (SIGINT reached the run's console group). This is Stop-equivalent, not a crash.

**Variant C — kill the dashboard process (the crash test).** Start a run, wait ~10 s, then Task Manager → End task on `node`, or `taskkill /F /PID <dashboard-pid>`. Only the dashboard dies — the run keeps fetching in the background. Restart the dashboard (`node dist/cli.js dashboard`). *Expected:* the `base` card shows **running again** with the accumulated live progress and **keeps updating** — the new dashboard reattached to the orphan via its PID-verified marker. **Run now is disabled** and **Stop works** (click it: run aborts, partials saved, card shows `· stopped`).

**Variant D — kill the dashboard, let the run finish, then reopen.** Start a run, kill the dashboard (as C), wait for the run to actually complete (a minute or two), reopen the dashboard. *Expected:* the card shows the **final result summary, not "running"** — **Run now** is re-enabled. This is the direct fix for the old "close dashboard mid-run → reopen → stuck/unknown state" bug: the CLI deletes its marker on exit, so a restarted dashboard can't mistake it for running.

---

## 5. Kill the run process — stale marker recovery

1. Start a run. Read its pid from `~/.omijobs/runs/base.running` (a small file containing `{"pid": <pid>, "startedAt": …}`).
2. Kill that pid: `taskkill /F /PID <pid>`. The run dies *without* clearing its marker — exactly the stale-state case.
3. Watch the **Config** page. *Expected:* within ~5 s the card flips to **not running**, settling on the last progress line it had. The dashboard detected the dead PID, discarded the marker, and removed the run from its in-flight set — no "running" forever, and **Stop** greys out.
4. Click **Run now**. *Expected:* a fresh run starts normally — the stale marker did **not** block a restart, and it did **not** leave the card stuck.

---

## 6. Cron page — add a job

1. Click **Cron**.
   - See: the **Cron gateway** card (badge `running (pid X)` from setup, buttons **Start / Stop / Restart**, and **Resume** — it reads *Resume* because cron starts paused; it reads *Pause* when active), plus a **New scheduled run** form at the bottom.
2. Fill the form: Name `finance` · Schedule `every 6 hours` · Queries blank (inherits base queries) · Adapters leave as-is · Storage **shared jobs.db**. Click **Add cron job**.
   - See: a `finance` card appears with badge `never run`, countdown `next: 6h 0m`, `schedule: every 6 hours`, a callout (`queries: finance intern · db: jobs.db · not created yet`), `last run: never`, and buttons **Run now / Stop / Disable / Remove**.
3. Click **Resume** on the gateway (button flips to **Pause**). *Expected:* within ~5 s (next gateway tick) the never-run job is *due*, so it fires on its own: badge flips to **running now**, the `last run` line shows live progress, **Run now** disables, **Stop** enables.

---

## 7. Stop the gateway while a job runs — the stale-"running" fix

Continue from §6 step 3 with `finance` mid-run:

1. Click **Stop** on the gateway card.
   - *Expected:* gateway badge flips to `not running`; **Start** enables, **Stop / Restart** disable. The `finance` job card badge flips to **`running (stale — gateway down)`** — the run is an orphan now, still genuinely fetching.
2. Let the orphan finish. *Expected:* the job card flips to **not running** and shows the run's result line (`last run: … · N jobs, … dropped`). It never stays on "running".

That last sentence is the whole point: the old code kept `lastStatus: "running"` in the cron state forever after a gateway kill, so the job showed "running" indefinitely. Now the run's own marker (PID-verified, deleted by the CLI on exit) decides, so it always flips back.
*Afterwards:* click **Restart** on the gateway (it's stopped now) — it comes back as `running (pid <new>)`. The hard kill skipped the gateway's cleanup, and restart clears the stale pidfile.

---

## 8. Restart the gateway while a job runs

1. With the gateway stopped, click **Run now** on the `finance` job card — this spawns the run *directly* from the dashboard, so it works even with the gateway down. Wait until the card shows `running now`.
2. Click **Restart** on the gateway (it's stopped, so this starts it). *Expected:* badge comes back as `running (pid <new>)`; the job card stays `running now` (the orphaned run kept going); it completes normally with its result line.

---

## 9. Cron job — Run now / Stop / Pause / Disable

With the gateway stopped (so nothing fires on its own):

1. **Run now** on the `finance` card → badge `running now`, live progress, **Stop** active. Click **Run now** again while it runs → disabled on refresh (same 409 guard as the Config page — a run can't overlap itself).
2. **Stop** → aborts; partial results saved; card shows the partial result; **Run now** re-enables.
3. **Disable** → the card stays but the gateway skips it; the button flips to **Enable**. Click **Enable** to restore.
4. Gateway **Pause** → button flips to **Resume**, and a due job will **not** fire until you resume. **Resume** → a due job fires on the next tick. Pausing never interrupts a run already in flight — only stops new ones from starting.

---

## 10. Two dashboards, one state

1. Terminal A: `node dist/cli.js dashboard` (5211). Terminal B: `node dist/cli.js dashboard --port 5212`.
2. Start a run on A (Config → **Run now**). On B, Config page: *Expected:* the `base` card shows **running** too — both dashboards read the same markers.
3. **Run now** on B → rejected (409 toast). **Stop** on B → works; both dashboards flip to `· stopped` / done.

---

## 11. Jobs deep dive

After a run that produced several jobs (see §3 for the base state):

1. **Sort:** click a column header — `posted_at`, `title`, `company`, `location`, `status`. Click again to toggle ↑/↓ (the active column shows an arrow).
2. **Search:** type in the search box — the list narrows as you type (title/company/location, ~300 ms debounce). Clear it to restore.
3. **Filter:** status dropdown → `unapplied` / `applied` / `uninterested`.
4. **Detail modal:** click any row → modal with title, company, location, posted time, source, apply URL (opens in a new tab), analysis (if the adapter recorded any), and description.
5. **Status:** click **Apply** → toast `Marked applied`, the chip flips to `applied`, and the ticker's `applied` count increments. Open another row → **Not interested** → chip flips, `uninterested` increments. The status filter now shows/hides these accordingly.
6. **Source dropdown:** if a cron job uses *separate* storage, a second source (named after the job) appears here — its own DB, its own counts.

---

## 12. Settings / Docs / theme

1. Click the **⚙** gear (top-right) → **Settings**: an *Appearance* card (theme toggle) and an *Environment* card showing **Port, Package dir, State dir, Base config, Cron file, CLI, Adapters**. Spot-check they match reality — that's the dashboard's self-report.
2. Click **Docs** → the rendered overview (Jobs / Cron / Config / Settings). It's a faithful summary of what you just clicked through.
3. Click the **sun/moon** toggle → theme flips. Reload the page → still applied (remembered in localStorage).

---

## 13. Teardown

1. Cron page: gateway **Stop** (or leave it running), then **Remove** on `finance` (confirm dialog).
2. Dashboard terminal: Ctrl+C to stop the server.

---

## 14. Edge-case cheat sheet

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
