# config.guide — omi-job-fetch configuration reference

How to configure `config.json` and what actually changes behavior. Every option below is
real — pulled from the adapters' manifests and code. Contract-input flags (`--query`,
`--location`, …) are the same keys in `contract.inputs` / the CLI.

## The config file

```jsonc
{
  "contract": {
    "inputs": {               // input field definitions; "required: true" makes the CLI demand it
      "query": { "required": true, "default": null },
      "location": { "required": false, "default": null },
      "posted_within_days": { "required": false, "default": null },
      "employment_type": { "required": false, "default": null },
      "sort": { "required": false, "default": null },
      "page": { "required": false, "default": 1 },
      "seniority": { "required": false, "default": null }
    },
    "outputs": {}             // output definitions; leave as-is
  },
  "portals": {
    "enabled": ["ctgoodjobs", "gradconnection", "jobsdb", "linkedin"],  // which adapters run
    "config": {
      "gradconnection": { "country": "hk" },   // per-adapter options (see tables below)
      "linkedin": {},
      "jobsdb": {},
      "ctgoodjobs": {}
    }
  },
  "ats": { "enabled": [], "config": {} },      // employer ATS adapters — none built yet (research paused)
  "dedup": { "fields": ["title", "company", "location"] }  // content-signature dedup fields
}
```

- **`portals.enabled`** is the on/off switch. Any registered adapter not listed is skipped.
  Registered ids today: `ctgoodjobs`, `gradconnection`, `jobsdb`, `linkedin`.
- **`portals.config.<id>`** holds per-adapter knobs (pacing, caps, scope). Omitted keys fall
  back to defaults.
- **`dedup.fields`** sets the signature for cross-adapter duplicate removal. Jobs with the
  same signature (case/whitespace-insensitive) collapse into one; first-seen wins and its
  `source` accumulates. Changing these fields changes what counts as a duplicate.
- **`ats`** is reserved for per-employer backend adapters. Research is paused: the tool is
  query-driven and aggregators (the portals above) are the search layer, so none are built.

### CLI vs config

- Inputs (`query`, `location`, …) are the **contract inputs** — pass them on the CLI
  (`node dist/cli.js --query "..." --location "Hong Kong"`) or they default per
  `contract.inputs`.
- Everything under `portals.config` / `dedup` lives only in the config file; there is no CLI
  flag for them. Use `--config <path>` to point at a different config file.

### Environment variables

| Var | Used by | Effect |
|---|---|---|
| `JD_UA` | jobsdb, ctgoodjobs | Browser User-Agent sent to the portal. Default: bundled Chrome UA. |
| `LI_UA` | linkedin | Browser User-Agent sent to LinkedIn's guest endpoints. Default: bundled Chrome UA. |

---

## CTgoodjobs — `ctgoodjobs`

HK job board (jobs.ctgoodjobs.hk). REST POST search, one jobId-dedup'd sweep driven by
`data.meta.jobsTotal`; visitor-id bootstrapped per run; full JD from each job's detail page.
Inherently HK-scoped — **location is ignored; every result is a Hong Kong job** (an
HK-aligned location like "Hong Kong"/"HK" is accepted silently; anything else logs a
warning; the search stays whole-HK).

### Config options (`portals.config.ctgoodjobs`)

| Option | Default | Effect |
|---|---|---|
| `ua` (env `JD_UA`) | bundled Chrome UA | User-Agent for all requests. |
| `delayMs` | 1000 | Pacing between sweep requests. |
| `maxPages` | **200** | Hard cap on pages swept (33 jobs each → 6,600-job ceiling). Higher than the others because a 100-page cap truncates large pools ("finance" ≈ 4,435 jobs). |
| `retryBackoffMs` | [4000, 8000, 16000] | Backoff schedule for retries. |
| `detailConcurrency` | 4 | Concurrent JD-enrichment fetches. |
| `detailDelayMs` | 0 | Pacing between JD-enrichment requests. |

### Input parameters that make an impact

| Contract input | Maps to | Impact |
|---|---|---|
| `query` | body `keyword` | Keyword search. **Strict phrase/AND match** — multi-word queries return far fewer than JobsDB ("tech intern" → 4 jobs; "intern" alone → 1,592). |
| `location` | — (ignored) | **No-op.** CTgoodjobs is Hong Kong-only; the criteria endpoint that maps free text → district ids is behind an AWS WAF CAPTCHA and all jobs are HK anyway. An HK-aligned location ("Hong Kong", "HK") is accepted silently; any other value logs a warning. The search stays whole-HK either way. |
| `posted_within_days` | `startPostDate` | Jobs published within the last N days. |
| `employment_type` | `employmentTypeIds` | full-time→001, part-time→002, temporary→003, contract→004, freelance→005, permanent→006, internship→007. |
| `seniority` | `gradeIds` | entry/intern→006, junior→004, middle→002, senior→001. |
| `sort` | body `sort` | relevance/best-match→1, date/newest/listed→2 (2 = newest-first by publishTime, the site's default). |

`page` is ignored (the adapter sweeps every page for full coverage).

---

## GradConnection — `gradconnection`

Grad/entry-level campaign board, partitioned per country subdomain
(hk.gradconnection.com). Offset-walk sweep (no total count; empty page = end). Inherently
country-scoped by `country` — **location narrows within that country**.

### Config options (`portals.config.gradconnection`)

| Option | Default | Effect |
|---|---|---|
| `country` | `hk` | Country subdomain (hk / sg / au) — **this is the geographic scope**. |
| `delayMs` | 1000 | Pacing between sweep requests. |
| `maxPages` | 100 | Hard cap on pages swept (20 jobs each → 2,000-job ceiling). |
| `retryBackoffMs` | [4000, 8000, 16000] | Backoff schedule for retries. |

### Input parameters that make an impact

| Contract input | Maps to | Impact |
|---|---|---|
| `query` | `query` | Keyword search. |
| `location` | `location` (resolved vs /api/locations) | **Country-level only.** Free text resolves against GradConnection's locations; a city/region expands to its parent country ("Hong Kong" → hk). Unknown → the adapter run aborts with an error (pass a real location or omit --location). |
| `employment_type` | `job_type` | internship/intern→`internships`, graduate→`graduate-jobs`, entry-level→`entry-level-jobs`, part-time→`part-time-student-jobs`. |

`seniority` is unsupported; `page` is ignored. `posted_within_days`/`sort` have no
GradConnection equivalent.

---

## JobsDB — `jobsdb`

HK job board (hk.jobsdb.com, Seek platform). REST search, page-walk sweep driven by
`totalCount`. Inherently HK-scoped by the site partition — **location narrows, it doesn't
scope**.

### Config options (`portals.config.jobsdb`)

| Option | Default | Effect |
|---|---|---|
| `siteKey` | `HK-Main` | JobsDB site partition (HK-Main, SG-Main, …). Swapping it changes the country searched. |
| `ua` (env `JD_UA`) | bundled Chrome UA | User-Agent for all requests. |
| `delayMs` | 1000 | Pacing between sweep requests. |
| `maxPages` | 100 | Hard cap on pages swept (20 jobs each → 2,000-job ceiling). |
| `retryBackoffMs` | [4000, 8000, 16000] | Backoff schedule for retries. |
| `detailConcurrency` | 4 | Concurrent JD-enrichment fetches. |
| `detailDelayMs` | 0 | Pacing between JD-enrichment requests. |

### Input parameters that make an impact

| Contract input | Maps to | Impact |
|---|---|---|
| `query` | `keywords` | Keyword search — **loose/fuzzy** matching (any term can match), so multi-word queries return far more than CTgoodjobs. |
| `location` | `where` | Free-text location filter. |
| `posted_within_days` | `daterange` | Jobs listed within the last N days. |
| `employment_type` | `worktype` | full-time→242, part-time→243, contract/temp→244, casual/vacation→245. |
| `sort` | `sortmode` | date/newest/listed→ListedDate, relevance/best-match→KeywordRelevance. |

`seniority` is unsupported; `page` is ignored.

---

## LinkedIn — `linkedin`

Global job search via LinkedIn's guest endpoints. **The only portal with no inherent
geography** — `location` is the scope switch, not a narrowing filter. Sweeps every offset
with shell-retry + saturation rounds; `meta.coverage` reports how much of the pool was
captured.

### Config options (`portals.config.linkedin`)

| Option | Default | Effect |
|---|---|---|
| `ua` (env `LI_UA`) | bundled Chrome UA | User-Agent for the guest endpoints. |
| `delayMs` | 1500 | Pacing between sweep requests. |
| `maxRounds` | 5 | Saturation rounds over still-empty offsets (stops once a round adds nothing new, min 2). |
| `maxOffset` | derived from `totalResults`, else 500 | Hard cap on the last offset swept (10 jobs per offset). |
| `retryBackoffMs` | [4000, 8000, 16000] | Backoff schedule for shell/rate-limit retries. |
| `detailConcurrency` | 2 | Concurrent JD-enrichment fetches (detail endpoint rate-limits bursts). |
| `detailDelayMs` | 1200 | Pacing between JD-enrichment requests. |

### Input parameters that make an impact

| Contract input | Maps to | Impact |
|---|---|---|
| `query` | `keywords` | Keyword search. |
| `location` | `location` | **Primary geographic scope.** Omit it and the search is worldwide — pass "Hong Kong" to get an HK search. |

**No-ops (verified, skipped with a note):** `employment_type`, `posted_within_days`, `sort`,
`seniority` — LinkedIn's guest endpoint ignores them. `page` is ignored (full sweep).

---

## Quick matrix

Which input actually does something per portal (✓ = honors, ✗ = no-op/ignored):

| Input | ctgoodjobs | gradconnection | jobsdb | linkedin |
|---|---|---|---|---|
| `query` | ✓ keyword (strict) | ✓ | ✓ keyword (fuzzy) | ✓ |
| `location` | ✗ ignored (HK-only) | ✓ country-level only | ✓ free text | ✓ (scopes, not narrows) |
| `posted_within_days` | ✓ `startPostDate` | ✗ | ✓ `daterange` | ✗ |
| `employment_type` | ✓ 001–007 | ✓ job_type slug | ✓ worktype 242–245 | ✗ |
| `seniority` | ✓ gradeIds | ✗ | ✗ | ✗ |
| `sort` | ✓ 1=rel, 2=date | ✗ | ✓ ListedDate/KeywordRelevance | ✗ |
| `page` | ✗ sweep-all | ✗ sweep-all | ✗ sweep-all | ✗ sweep-all |

Geography at a glance: **ctgoodjobs, gradconnection, jobsdb** are inherently HK-scoped
(ctgoodjobs ignores location; gradconnection/jobsdb narrow by it); **linkedin** is global
unless you pass a location.
