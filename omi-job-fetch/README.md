# omijobs

Deterministic, programmatic job retrieval from job boards and aggregator portals.
Replaces the `run_job_digest.py` scraping layer. No browser automation, no AI in the
retrieval loop — every run is driven by a plain config file and produces reproducible
output you can diff between runs.

Everything you'll type is `omijobs run` (a sweep now) or `omijobs cron ...` (scheduled
sweeps). This guide gets you from zero to your first job list in under a minute; the full
config reference is [config.guide.md](config.guide.md).

## Requirements

- **Node ≥ 24** (uses the built-in `node:sqlite`)
- `npm install` + `npm run build` in the project folder

## Your first run — under a minute

**1. Set your search terms.** Copy the starter config and edit the queries:

```bash
cp config.example.json config.json
# then edit config.json → "global": { "queries": ["finance intern"] }
```

The query list is the whole search: each query runs against every enabled portal, and
results deduplicate across all queries × portals.

**2. Run it:**

```bash
node dist/cli.js run
```

(Install the CLI with `npm link` and the same command is just `omijobs run`.)

**3. Read the results.** Each run writes two files:

- `output/runs/<timestamp>/jobs.json` — the deduped, normalized job list
- `output/runs/<timestamp>/run.json` — the record of the run: queries, per-portal status
  and counts, what got dropped or deduplicated, timings

## What the run does

Every enabled portal is swept for every query, results are normalized to one contract
(title, company, location, apply URL, source, …), cross-portal duplicates collapse on a
content signature (`dedup.fields`), and listings missing a required field are dropped and
reported in the manual-review trail. No credentials are needed to read these sites.

## One-off vs scheduled

**One-off** — `omijobs run [--config <path>]` runs a sweep right now and exits. Bare
`omijobs` does the same. Good for trying a config or a manual check.

**Scheduled** — `omijobs cron` runs the same sweeps on a timer, from the same CLI:

```bash
omijobs cron add --config config.json --schedule "every 6 hours"
omijobs cron start        # background gateway + auto-start at login — survives reboots
omijobs cron status       # gateway state, autostart state, last log lines, jobs
omijobs cron list         # jobs + last run status
omijobs cron stop         # stop the gateway and remove auto-start
```

Schedules are human-friendly: `every 30m`, `every 6 hours`, `daily at 09:00`,
`weekdays at 18:30`, `monday at 09:00`. Jobs live in `cron.json` next to `package.json`;
`omijobs cron enable/disable <id>` and `pause/resume` turn jobs on/off individually or
globally. A cron-spawned run marks itself in its `run.json` (`"trigger": "cron"`), so
scheduled results are distinguishable from manual ones.

## Optional: an aggregate database

Set `"db": { "enabled": true }` in config.json and every run also upserts its deduped jobs
into one SQLite file (`jobs.db`) keyed by the same dedup signature — so the DB grows
across runs instead of resetting each time. Rows past `retentionDays` are expired
automatically. Turned off by default.

## Config at a glance

Everything about a run lives in `config.json` — there are no per-run query flags:

- `global.queries` — the search terms (required)
- `portals.enabled` / `ats.enabled` — which adapters run (ATS backends are a future
  named-employer mode; v1 ships portals only)
- `portals.config.<id>` — per-portal search params and pacing
- `outputs.required` / `dedup.fields` / `outputDir` — drop policy, dedup signature, output
  location
- `db` — the optional aggregate store above

### Geography gotchas

Portals are geographically scoped — `location` *narrows* within a portal's scope, it never
changes the scope:

- **ctgoodjobs** — Hong Kong only; `location` is ignored
- **gradconnection** / **jobsdb** — HK by default (gradconnection's `country`, jobsdb's
  `siteKey`)
- **efinancialcareers** — country-scoped by `countryCode2` (sent as the search `location` when unset)
- **linkedin** — the only global portal; set `location` to scope it

### Environment variables

No secrets in config.json. Adapters read env vars for anything sensitive:

| Var | Portal | Effect |
|---|---|---|
| `JD_UA` / `LI_UA` / `EF_UA` | jobsdb+ctgoodjobs / linkedin / efinancialcareers | Custom browser User-Agent (defaults to a bundled Chrome UA) |

### Exit codes

`0` = at least one portal found jobs; `1` = nothing found (or a run failed). A run that
returns nothing on purpose (e.g. an empty `portals.enabled`) exits `1` — treat it as
"nothing new".

## Commands

```
omijobs run [--config <path>]   Run a job sweep now (default when no command given)
omijobs cron <command>          Manage scheduled runs and the gateway

  cron add --config <path> --schedule "<str>" [--name <id>]
  cron list | enable <id> | disable <id> | remove <id>
  cron pause | resume
  cron start | stop | restart | status
  cron run                      Run every enabled job now, ignoring schedules

Any command accepts --help.
```
