# config.guide — omijobs configuration reference

`config.json` is the single point of control. The CLI takes **one flag**: `--config <path>`
(defaults to `dashboard.configs/realtime/config.json`). Everything else —
which queries to run, which adapters, each adapter's search params and pacing — lives in
the config file. Every option below is real, pulled from the adapters' manifests and code.

## The config file

```jsonc
{
  "global": {
    // Search params every adapter fully supports: the query list.
    "queries": ["finance intern"],
    // Shared pacing knobs — merged into every adapter, overridable per adapter.
    "delayMs": 1000,
    "retryBackoffMs": [4000, 8000, 16000],
    "maxPages": 100,
    "detailConcurrency": 4,
    "detailDelayMs": 0
  },
  "portals": {
    "enabled": ["linkedin", "jobsdb", "gradconnection", "efinancialcareers", "ctgoodjobs"],
    "config": {
      "linkedin": { /* search params it honors + overrides — see below */ },
      "jobsdb": {},
      "gradconnection": {},
      "efinancialcareers": {},
      "ctgoodjobs": {}
    }
  },
  "ats": { "enabled": [], "config": {} },
  "outputs": { "required": ["apply_url", "title", "company", "location", "source"] },
  "dedup": { "fields": ["title", "company", "location"] },
  "outputDir": "output",
  "db": { "enabled": false, "file": "jobs.db", "retentionDays": 30 }
}
```

### Global vs per-adapter — the split

Two categories, one precedence rule:

- **`global`** holds what every adapter shares: the **`queries`** list (each query runs
  against every enabled adapter; results dedup across all queries × adapters) and the
  **pacing knobs** (`delayMs`, `retryBackoffMs`, `maxPages`, `detailConcurrency`,
  `detailDelayMs`) as shared defaults.
- **`portals.config.<id>`** holds per-adapter things: the **search params that adapter
  actually supports** (pre-populated as `null` when unset), its **geography** (`siteKey` /
  `country` / `countryCode2`), knobs only that adapter has (`maxRounds`, `maxOffset`), and
  **overrides** of the global pacing knobs where it differs.
- **Precedence:** if an attribute appears in both `global` and a per-adapter block, the
  per-adapter value wins for that adapter. In the shipped default state, no search param is
  in both (only `queries` is global, and no adapter block sets one) — the overlap is
  limited to pacing knobs where an adapter genuinely differs (e.g. `linkedin.delayMs`).

`global.queries` accepts a JSON array of strings. A comma-separated string is also accepted
and split for you. An empty/absent list is an error — the run aborts with a message.

### Effective adapter config

Each adapter run gets `ctx.config` = global knobs merged with the adapter block's non-input
keys (per-adapter wins), and `ctx.input` = `query` plus the adapter block's search params.
Search params are identified by the adapter's manifest input keys — the config block never
lists a param the adapter ignores (no-op params like linkedin's `sort` are simply absent).

`portals.enabled` is the on/off switch. Registered ids: `ctgoodjobs`, `efinancialcareers`,
`gradconnection`, `jobsdb`, `linkedin`.

### Drop policy, dedup, output

- **`outputs.required`** — a job missing one of these fields is dropped (counted, listed in
  the manual-review trail). Default (when the key is absent): `apply_url`, `title`,
  `company`, `location`, `source`. Set it to `[]` to require nothing.
- **`dedup.fields`** — the content signature for cross-adapter duplicate removal. Jobs with
  the same signature collapse into one; first-seen wins and its `source` accumulates.
- **`outputDir`** — where run output lands (`<outputDir>/runs/<timestamp>/jobs.json` +
  `run.json`). Default `output`.
- **`ats`** — reserved for per-employer backend adapters. Research is paused: the tool is
  query-driven and aggregators (the portals above) are the search layer, so none are built.

### Aggregate DB (`db`)

An opt-in SQLite store that **grows across runs**: every run also upserts its deduped jobs
(one row per job) into a single table, keyed by the same `dedup.fields` signature, then
expires rows older than a retention window. The normal `outputDir` run storage happens
exactly as before — DB mode is an extra step on top.

| Option | Default | Effect |
|---|---|---|
| `enabled` | `false` | Turn DB mode on (`true`). Off by default; nothing is written when off. |
| `file` | `<outputDir>/jobs.db` | Where the SQLite file lives, resolved relative to `outputDir` (an absolute path is respected). |
| `retentionDays` | `30` | Rows whose job `posted_at` is older than this many days are deleted after each run. Set `0` to keep everything. |

Rows (table `jobs`):

| Column | Meaning |
|---|---|
| `signature` | Content signature of `dedup.fields` (e.g. `title|company|location`, case/whitespace-insensitive) — the primary key, so the DB aggregates across runs. |
| `posted_at` | The job's post date as ISO-8601, or NULL when the portal didn't provide it (NULL rows are never expired). |
| `job` | The full normalized job JSON — the same shape written to `jobs.json`. |
| `status` | Tracking field, default `'unapplied'` for every new row. **Preserved across overwrites** — a later run updating the same signature keeps whatever status/analysis you've set. |
| `analysis` | Reserved for job analysis, always NULL for now. Preserved across overwrites. |
| `created_at` / `updated_at` | First-inserted / last-written timestamps. `created_at` survives overwrites. |

Semantics: a later run with the same title+company+location **overwrites** the earlier row
(new `job`, `posted_at`, `updated_at`; keeps `status`, `analysis`, `created_at`); brand-new
signatures are appended. After the upsert, the table is scanned and rows with a
`posted_at` older than `retentionDays` are removed (jobs with no parseable date are kept).
Each run's `run.json` gains a `db` block — `{ "added", "updated", "removed", "total" }` —
and a DB failure is a warning, never a run failure.

Backed by Node's built-in `node:sqlite` (zero install, works on any platform) — this is why
the package requires **Node ≥ 24**.

### Scheduled runs (`cron`)

Scheduled runs are managed separately from the realtime config — a small `cron.json` (default:
the folder containing `package.json`) lists jobs, each pointing at its own config under
`dashboard.configs/cron/` plus a human-friendly schedule, and a self-managed background
**gateway** spawns them on time.

The gateway is a detached process with OS auto-start at login (Windows HKCU Run key,
macOS LaunchAgent, Linux systemd user unit), so `omijobs cron start` once is enough — it
survives logout and reboot. All state lives in `~/.omijobs` (pidfile, stop marker, `cron.log`).

`cron.json`:

```jsonc
{
  "paused": false,             // top-level switch: true stops ALL jobs until "cron resume"
  "jobs": [
    {
      "id": "daily-finance",        // unique, slugged from --name or the config filename
      "config": "dashboard.configs/cron/daily-finance.config.json",  // resolved relative to the cron.json folder
      "schedule": "daily at 09:00", // human-friendly grammar, see below
      "enabled": true,              // per-job on/off
      "lastRun": null,              // written by the gateway (ISO-8601) — don't edit
      "lastStatus": null            // "ok" / "exit N" / "error: …" — don't edit
    }
  ]
}
```

**Schedule grammar** (case-insensitive, UTC clock times):

| Form | Example |
|---|---|
| `every <n> min|hour|day|week` | `every 30m`, `every 6 hours`, `every 2 days` |
| `daily at <HH:MM>` | `daily at 09:00` |
| `weekdays at <HH:MM>` | `weekdays at 09:00` (Mon–Fri) |
| `weekends at <HH:MM>` | `weekends at 10:00` (Sat–Sun) |
| `<day> at <HH:MM>` | `monday at 09:00` (full or 3-letter) |
| aliases | `hourly`, `daily` (= `daily at 00:00`), `weekly` |

Intervals are due the moment the interval has elapsed since `lastRun` (a job added while the
gateway is down runs immediately on the next tick — catch-up). Clock jobs wait for their
slot; a never-run clock job does **not** fire immediately.

The CLI (`omijobs cron`):

| Command | Effect |
|---|---|
| `add --config <path> --schedule "<str>" [--name <id>]` | Add a job (validates the schedule + config path). |
| `list` · `enable <id>` · `disable <id>` · `remove <id>` | Inspect / toggle / delete jobs. |
| `pause` · `resume` | Pause or resume ALL jobs. |
| `start` · `stop` · `restart` · `status` | Manage the gateway (start registers OS auto-start, stop removes it). |
| `run` | Run every enabled job now, ignoring schedules (spawns `node dist/cli.js run`). |
| `gateway` | Internal: run the gateway loop in the foreground. |

A cron-spawned run marks itself in its `run.json`: the summary gains `"trigger": "cron"`.
Manual `omijobs run` writes no trigger field.

### Environment variables

| Var | Used by | Effect |
|---|---|---|
| `JD_UA` | jobsdb, ctgoodjobs | Browser User-Agent sent to the portal. Default: bundled Chrome UA. |
| `LI_UA` | linkedin | Browser User-Agent sent to LinkedIn's guest endpoints. Default: bundled Chrome UA. |
| `EF_UA` | efinancialcareers | Browser User-Agent sent to eFinancialCareers' endpoints. Default: bundled Chrome UA. |

These stay environment-only — they are not config keys.

---

## CTgoodjobs — `ctgoodjobs`

HK job board (jobs.ctgoodjobs.hk). REST POST search, one jobId-dedup'd sweep driven by
`data.meta.jobsTotal`; visitor-id bootstrapped per run; full JD from each job's detail page.
Inherently HK-scoped — **location is ignored; every result is a Hong Kong job**.

### Config options (`portals.config.ctgoodjobs`)

| Option | Default | Effect |
|---|---|---|
| `delayMs` | 1000 (global) | Pacing between sweep requests. |
| `maxPages` | **200** (overrides global 100) | Hard cap on pages swept (33 jobs each → 6,600-job ceiling). Higher than the others because a 100-page cap truncates large pools ("finance" ≈ 4,435 jobs). |
| `retryBackoffMs` | [4000, 8000, 16000] (global) | Backoff schedule for retries. |
| `detailConcurrency` | 4 (global) | Concurrent JD-enrichment fetches. |
| `detailDelayMs` | 0 (global) | Pacing between JD-enrichment requests. |

### Search params this adapter honors

| Config key | Maps to | Impact |
|---|---|---|
| `query` (global) | body `keyword` | Keyword search. **Strict phrase/AND match** — multi-word queries return far fewer than JobsDB ("tech intern" → 4 jobs; "intern" alone → 1,592). |
| `posted_within_days` | `startPostDate` | Jobs published within the last N days. |
| `employment_type` | `employmentTypeIds` | full-time→001, part-time→002, temporary→003, contract→004, freelance→005, permanent→006, internship→007. |
| `seniority` | `gradeIds` | entry/intern→006, junior→004, middle→002, senior→001. |
| `sort` | body `sort` | relevance/best-match→1, date/newest/listed→2 (2 = newest-first by publishTime, the site's default). |

`location` and `page` are not supported (HK-only; the adapter sweeps every page).

---

## GradConnection — `gradconnection`

Grad/entry-level campaign board, partitioned per country subdomain
(hk.gradconnection.com). Offset-walk sweep (no total count; empty page = end). Inherently
country-scoped by `country` — **location narrows within that country**.

### Config options (`portals.config.gradconnection`)

| Option | Default | Effect |
|---|---|---|
| `country` | `hk` | Country subdomain (hk / sg / au) — **this is the geographic scope**. |
| `delayMs` | 1000 (global) | Pacing between sweep requests. |
| `maxPages` | 100 (global) | Hard cap on pages swept (20 jobs each → 2,000-job ceiling). |
| `retryBackoffMs` | [4000, 8000, 16000] (global) | Backoff schedule for retries. |

`detailConcurrency` / `detailDelayMs` are global defaults this adapter doesn't read.

### Search params this adapter honors

| Config key | Maps to | Impact |
|---|---|---|
| `query` (global) | `query` | Keyword search. |
| `location` | `location` (resolved vs /api/locations) | **Country-level only.** Free text resolves against GradConnection's locations; a city/region expands to its parent country ("Hong Kong" → hk). Unknown → the adapter run aborts with an error. |
| `employment_type` | `job_type` | internship/intern→`internships`, graduate→`graduate-jobs`, entry-level→`entry-level-jobs`, part-time→`part-time-student-jobs`. |

`posted_within_days` / `sort` / `seniority` / `page` have no GradConnection equivalent.

---

## JobsDB — `jobsdb`

HK job board (hk.jobsdb.com, Seek platform). REST search, page-walk sweep driven by
`totalCount`. Inherently HK-scoped by the site partition — **location narrows, it doesn't
scope**.

### Config options (`portals.config.jobsdb`)

| Option | Default | Effect |
|---|---|---|
| `siteKey` | `HK-Main` | JobsDB site partition (HK-Main, SG-Main, …). Swapping it changes the country searched. |
| `delayMs` | 1000 (global) | Pacing between sweep requests. |
| `maxPages` | 100 (global) | Hard cap on pages swept (20 jobs each → 2,000-job ceiling). |
| `retryBackoffMs` | [4000, 8000, 16000] (global) | Backoff schedule for retries. |
| `detailConcurrency` | 4 (global) | Concurrent JD-enrichment fetches. |
| `detailDelayMs` | 0 (global) | Pacing between JD-enrichment requests. |

### Search params this adapter honors

| Config key | Maps to | Impact |
|---|---|---|
| `query` (global) | `keywords` | Keyword search — **loose/fuzzy** matching (any term can match), so multi-word queries return far more than CTgoodjobs. |
| `location` | `where` | Free-text location filter. |
| `posted_within_days` | `daterange` | Jobs listed within the last N days. |
| `employment_type` | `worktype` | full-time→242, part-time→243, contract/temp→244, casual/vacation→245. |
| `sort` | `sortmode` | date/newest/listed→ListedDate, relevance/best-match→KeywordRelevance. |

`seniority` is unsupported; `page` is ignored.

---

## eFinancialCareers — `efinancialcareers`

Finance-sector job board (global site, `countryCode2` scopes the search). Deterministic GET
search (200/page driven by `meta.totalResults`), **full JD inline in the list** (no detail
request), and the apply URL resolved per-job: the apply-information API for external
applications (~73% of HK), the detail page otherwise. Country-scoped by `countryCode2` —
when no `location` is given, the adapter sends the country name derived from the code
(HK → "Hong Kong") as the `location` term, which is the only thing the API actually
filters by. **`countryCode2` alone is ignored by the API — an explicit `location`
narrows within (and overrides) that scope.**

### Config options (`portals.config.efinancialcareers`)

| Option | Default | Effect |
|---|---|---|
| `countryCode2` | `HK` | Country scope (HK, SG, …). Sent as the search `location` when `location` is unset (HK → "Hong Kong"). |
| `delayMs` | 1000 (global) | Pacing between sweep requests. |
| `maxPages` | 100 (global) | Hard cap on pages swept (200 jobs each → 20,000-job ceiling). |
| `retryBackoffMs` | [4000, 8000, 16000] (global) | Backoff schedule for retries. |
| `detailConcurrency` | 4 (global) | Concurrent apply-URL fetches (external jobs only). |
| `detailDelayMs` | 0 (global) | Pacing between apply-URL requests. |

### Search params this adapter honors

| Config key | Maps to | Impact |
|---|---|---|
| `query` (global) | `q` | Keyword search. |
| `location` | `location` | Free text, georesolved server-side ("Hong Kong" → Country precision, radius 40). When unset, the adapter derives it from `countryCode2` (HK → "Hong Kong") — this is the only thing that scopes the search. |
| `posted_within_days` | `filters.postedDate` | ONE/THREE/SEVEN — **capped at 7 days**; larger requests are skipped with a note (post-filter client-side), not silently narrowed. |
| `employment_type` | `filters.employmentType` + `filters.positionType` | full-time→FULL_TIME, part-time→PART_TIME; permanent→PERMANENT, contract→CONTRACT, temporary→TEMPORARY, internship/intern→INTERNSHIPS_AND_GRADUATE_TRAINEE (the last four are positionType). |
| `seniority` | `filters.seniority` | entry/intern→INTERN_GRADUATE, junior→ANALYST, middle→ASSOCIATE_MID_LEVEL, senior→AVP_SENIOR. |

`sort` is unsupported (eFC `sortBy` is a server-side no-op — verified identical orderings);
`page` is ignored (full sweep).

---

## LinkedIn — `linkedin`

Global job search via LinkedIn's guest endpoints. **The only portal with no inherent
geography** — `location` is the scope switch, not a narrowing filter. Sweeps every offset
with shell-retry + saturation rounds; `meta.coverage` reports how much of the pool was
captured.

### Config options (`portals.config.linkedin`)

| Option | Default | Effect |
|---|---|---|
| `delayMs` | **1500** (overrides global 1000) | Pacing between sweep requests. |
| `maxRounds` | 5 | Saturation rounds over still-empty offsets (stops once a round adds nothing new, min 2). |
| `maxOffset` | derived from `totalResults`, else 500 | Hard cap on the last offset swept (10 jobs per offset). |
| `retryBackoffMs` | [4000, 8000, 16000] (global) | Backoff schedule for shell/rate-limit retries. |
| `detailConcurrency` | **2** (overrides global 4) | Concurrent JD-enrichment fetches (detail endpoint rate-limits bursts). |
| `detailDelayMs` | **1200** (overrides global 0) | Pacing between JD-enrichment requests. |

`maxPages` is a global default this adapter doesn't read (it uses `maxRounds`/`maxOffset`).

### Search params this adapter honors

| Config key | Maps to | Impact |
|---|---|---|
| `query` (global) | `keywords` | Keyword search. |
| `location` | `location` | **Primary geographic scope.** Omit it (leave `null`) and the search is worldwide — pass "Hong Kong" to get an HK search. |

Everything else (`employment_type`, `posted_within_days`, `sort`, `seniority`) is a verified
no-op on the guest endpoint, so none of it appears in the config block.

---

## Quick matrix

Which search param actually does something per portal (✓ = honors, ✗ = no-op/ignored):

| Input | ctgoodjobs | gradconnection | jobsdb | efinancialcareers | linkedin |
|---|---|---|---|---|---|
| `query` | ✓ keyword (strict) | ✓ | ✓ keyword (fuzzy) | ✓ | ✓ |
| `location` | ✗ (HK-only) | ✓ country-level only | ✓ free text | ✓ free text (georesolved) | ✓ (scopes, not narrows) |
| `posted_within_days` | ✓ `startPostDate` | ✗ | ✓ `daterange` | ✓ `filters.postedDate` (≤7d) | ✗ |
| `employment_type` | ✓ 001–007 | ✓ job_type slug | ✓ worktype 242–245 | ✓ employmentType/positionType | ✗ |
| `seniority` | ✓ gradeIds | ✗ | ✗ | ✓ `filters.seniority` | ✗ |
| `sort` | ✓ 1=rel, 2=date | ✗ | ✓ ListedDate/KeywordRelevance | ✗ (server-side no-op) | ✗ |
| `page` | ✗ sweep-all | ✗ sweep-all | ✗ sweep-all | ✗ sweep-all | ✗ sweep-all |

Geography at a glance: **ctgoodjobs, gradconnection, jobsdb** are inherently HK-scoped
(ctgoodjobs ignores location; gradconnection/jobsdb narrow by it); **efinancialcareers** is
country-scoped by `countryCode2` — sent as the search `location` when unset (location narrows
within it); **linkedin** is global unless you set a location.
