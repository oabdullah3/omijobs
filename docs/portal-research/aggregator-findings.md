# Portal Findings — Work in Progress

> This doc accumulates what we actually learn, portal by portal. Each section follows the template in [plan.md §6](plan.md). The contract this is measured against lives in [plan.md §3](plan.md) (draft v0.1, subject to change).
>
> **Legend:** ✅ available · ⚠️ partial · ❌ not available · 🔑 needs auth · ❓ unverified

**Portals researched so far:** LinkedIn (2026-08-16), JobsDB (2026-08-16), CTgoodjobs (2026-08-16), Moovup (2026-08-16), eFinancialCareers (2026-08-16), GradConnection (2026-08-16), JIJIS (2026-08-16).

---

<!--
Sections below get filled as we run research sessions. Copy the §6 template from plan.md for each portal. Do not hand-edit this header.
-->

## LinkedIn

**URL(s):** linkedin.com, hk.linkedin.com
**Last tested:** 2026-08-16

### Auth

- Creds needed? **No.** Guest endpoints work with a browser `User-Agent` only (no cookies, no OAuth), verified from a home IP.
- Session vars used: `$LI_UA` (browser UA), `$LI_KEYWORDS`, `$LI_LOCATION`.

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=&f_TPR=&f_JT=` | HTML fragment | **List** — 10 jobs/request, server-side rendered HTML cards. The core discovery endpoint. |
| GET | `/jobs-guest/jobs/api/jobPosting/<id>` | HTML fragment | **Detail** — full description + 4 structured criteria (seniority, employment type, job function, industry). |
| GET | `/jobs/search?keywords=&location=` (main page) | Full HTML | **Count + bulk URNs** — carries `totalResults` (289 for "Finance Intern HK") and ~60 job URNs; no pagination links. Useful for a first-pass sweep. |

(All relative to `https://www.linkedin.com`.)

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | `keywords=` verified. |
| `location` | ✅ | `location=` free text; **all 40+ probed jobs were Hong Kong** (incl. districts Wan Chai, Causeway Bay) — filtering works. |
| `posted_within_days` | ⚠️ | `f_TPR=r604800/r2592000` accepted, but **changes result composition rather than cleanly subsetting** (30-day page 0 lacked a job posted 2 days prior). Treat as opaque. |
| `employment_type` | ❌ | `f_JT=I` returned **identical 10/10 results** to no filter, on two separate queries. Appears to be a **no-op on the guest endpoint**. |
| `sort` | ❓ | Unverified. |
| `page` / `cursor` | ✅ | `start=` — stride is **10** (start=10 returned 10 all-new jobs); works at least to `start=280` (no early cap at the 289 total). |
| `seniority` | ❓ | Unverified. |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ⚠️ | LinkedIn job-view URL (`/jobs/view/<id>`) is the guest-accessible application entry point. **External ATS URL is NOT exposed to guests** for offsite jobs (e.g. Morgan Stanley) — true direct-apply URLs require the ATS-backend track. |
| `job_page_url` | ✅ | Same job-view URL. |
| `external_id` | ✅ | `urn:li:jobPosting:<id>` / numeric ID. Dedup key. |
| `title` | ✅ | |
| `company` | ✅ | |
| `location` | ✅ | |
| `description` | ✅ | Full rich HTML in `div.description__text` on the detail page (verified — complete Morgan Stanley posting). |
| `posted_at` | ✅ | Absolute `time[datetime]` on list cards; relative ("2 days ago") on detail. Prefer the list value. |
| `expires_at` | ❌ | No structured deadline; deadlines only inside description prose. |
| `is_open` | ⚠️ | "Actively hiring" / "Be an early applicant" badge on list cards; no structured open/closed field. |
| `employment_type` | ✅ | Structured criteria on detail (seniority level, employment type, job function, industries). |
| `source` | ✅ | |

### Deprecation / ToS risk

- **Embedded/unofficial guest endpoints** (`/jobs-guest/...`) — not a documented public API; can change without notice. Already observed: **JSON-LD `JobPosting` is gone from the modern job view** (a prior adapter design assumed it). Last-tested date above is the staleness guard.
- Guest endpoints are widely used by scrapers; LinkedIn may tighten access or shape-block at scale. No explicit deprecation notice exists (it's unofficial).

### Reliability notes

- **⚠️ Non-deterministic result set.** Identical request (`start=0`, same keywords/location) run minutes apart returned **only 2/10 overlapping job IDs**. The list endpoint shuffles/rotates results per request.
- **Consequence:** a single paginated sweep (start=0..280) is *not* sufficient to capture all ~289 jobs. Completeness requires **repeated sweeps + dedup by ID** (the daily digest already re-runs daily, which self-heals drift).
- No rate-limiting observed at 10 requests, but a 29-request full sweep should throttle (~1–2 s between calls).
- List gives absolute `posted_at`; detail gives richer data (description, criteria) at 1 extra request per job — batch-fetch details only for shortlisted/interesting jobs.

### Raw captures

- `research-scratch/linkedin/search_p0.html` — baseline list (start=0)
- `research-scratch/linkedin/search_p0_b.html` — determinism probe (start=0 repeat) → 2/10 overlap with p0
- `research-scratch/linkedin/search_p0_10.html` — start=10 (all-new jobs → stride 10 confirmed)
- `research-scratch/linkedin/search_p0_25.html` — start=25
- `research-scratch/linkedin/search_p0_30d.html` — f_TPR=r2592000 probe
- `research-scratch/linkedin/search_p0_intern.html` — f_JT=I probe (identical to baseline)
- `research-scratch/linkedin/search_finance_nofilter.html` / `search_finance_intern.html` — f_JT discriminator (identical 10/10)
- `research-scratch/linkedin/search_p28_280.html` — start=280 boundary
- `research-scratch/linkedin/search_page.html` — main search page (totalResults=289)
- `research-scratch/linkedin/job_posting_4452903095.html` — guest detail API
- `research-scratch/linkedin/job_view_4452903095.html` — full job page (no JSON-LD)

### Open questions / next steps

- **Saturation test:** how many sweeps until unique-ID growth flattens? (e.g. 3× full sweeps, measure cumulative unique count vs 289.)
- Does `f_TPR` ever drop freshly-posted jobs from its own page 0 (observed), or was that ordering noise from the same rotation?
- Verify whether the main `/jobs/search` page's 60 URNs are a stable superset — if yes, one request gives more coverage than 6 API calls.
- For `apply_url`: pursue ATS backends (Workday, Greenhouse, etc.) for direct application URLs on offsite posts.

---

## JobsDB

**URL(s):** hk.jobsdb.com
**Last tested:** 2026-08-16

### Auth

- Creds needed? **No.** The REST search API and job pages work with a browser `User-Agent` only (no cookies, no OAuth), verified from a home IP.
- Session vars used: `$JD_UA` (browser UA).
- Note: the SPA is Vite/React (client-rendered), so raw HTML of the search page is mostly empty shell — always use the REST API below, not the HTML.

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `/api/jobsearch/v5/search?siteKey=HK-Main&keywords=<kw>&page=<n>` | JSON | **List/discovery** — 20 jobs/request, `totalCount` (800 for "Finance Intern" HK). Core deterministic retrieval surface. |
| GET | `/job/<id>` | HTML | **Detail** — server-rendered full description + structured `data-automation` blocks (title, company, location, work type, classification). |

(All relative to `https://hk.jobsdb.com`. A GraphQL endpoint exists at `/graphql` but is complex and unnecessary; the cloud host `jobsearch-api.cloud.seek.com.au` requires auth.)

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | `keywords=` verified. |
| `location` | ✅ | `where=` free text; e.g. "Central & Western District" → 119 results. |
| `posted_within_days` | ✅ | `daterange=<n>` works (7 → 188 results). ❌ No-ops: `datePosted`, `listedAt`. |
| `employment_type` | ⚠️ | `worktype=<numeric Seek ID>` works (242=Full time→617, 243=Part time→135, 244=Contract/Temp→51, 245=Casual/Vacation→4). ❌ Text form (`worktype=Full time`) is a no-op. |
| `sort` | ✅ | `sortmode=ListedDate` → newest first. |
| `page` / `cursor` | ✅ | `page=<n>`; 20/page, `totalCount` drives pagination. Depth cap unverified. |
| `seniority` | ❓ | Unverified. |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ✅ | `<a href="/job/<id>/apply" data-automation="job-detail-apply">` — JobsDB-hosted apply flow (confirmed for job 93946363). |
| `job_page_url` | ✅ | `/job/<id>`. |
| `external_id` | ✅ | Numeric `id` (e.g. 93946363). Dedup key. |
| `title` | ✅ | `title` in API; `job-detail-title` on page. |
| `company` | ✅ | `companyName` in API; full name in `advertiser-name` on page. |
| `location` | ✅ | `locations[].label` in API; specific district on page (e.g. "Admiralty, Central and Western District"). |
| `description` | ✅ | Full server-rendered in `div[data-automation="jobAdDetails"]` (~55K chars). Search API only gives `teaser` (partial). |
| `posted_at` | ✅ | `listingDate` ISO UTC in API (e.g. 2026-08-13T02:23:12Z) + `listingDateDisplay` ("2d ago"). Page shows human-relative only. |
| `expires_at` | ❌ | No structured deadline anywhere. |
| `is_open` | ❌ | No structured open/closed field; `jdv-badges-section` was empty in capture. |
| `employment_type` | ✅ | `workTypes[]` in API (e.g. `["Part time"]`); `job-detail-work-type` on page. |
| `source` | ✅ | |

### Deprecation / ToS risk

- **Embedded/unofficial endpoint** — `api/jobsearch/v5/search` is the SPA's own widget API, not a documented public API; can change without notice. The `v5` prefix suggests versioning but is not a public contract. Last-tested date above is the staleness guard.
- A documented-official **GraphQL** endpoint exists at `/graphql` (introspection disabled, but useful 400 errors leak the schema) — fallback surface if the REST path breaks.
- Cloud API host (`jobsearch-api.cloud.seek.com.au`) requires service auth (401) — not usable as-is.

### Reliability notes

- **Deterministic result set observed** — the no-op filter probes (`datePosted`, `listedAt`, text worktype) returned **identical job-ID sets** to baseline across separate requests, unlike LinkedIn's rotation. Explicit same-request-twice probe not yet run.
- Pagination: `totalCount`/20 = 40 requests for a full "Finance Intern" HK sweep; page-depth cap unverified.
- Full description + apply URL require 1 job-page request per job (server-rendered HTML ~170KB). Search results alone give title/company/location/date/worktype but **not** description or apply URL.
- No rate-limiting observed at ~15 requests in a session; throttle ~1 s between calls.

### Raw captures

- `research-scratch/jobsdb/search_p0.html` — SPA shell + server-rendered card preview (meta: "800 Finance Intern jobs found in Hong Kong")
- `research-scratch/jobsdb/api_v5_p1.json` / `api_v5_p2.json` — REST search pages 1–2 (20 jobs each, totalCount 800)
- `research-scratch/jobsdb/api_daterange7.json` — `daterange=7` (188 results)
- `research-scratch/jobsdb/api_listedat7.json` / `api_date7.json` — no-op probes (identical IDs to baseline)
- `research-scratch/jobsdb/api_where.json` — `where=Central & Western District` (119 results)
- `research-scratch/jobsdb/api_worktype.json` — text worktype no-op; `api_worktype_242.json` (617) / `_243.json` (135) / `_244.json` (51) / `_245.json` (4) — numeric IDs
- `research-scratch/jobsdb/api_sort_date.json` — `sortmode=ListedDate`
- `research-scratch/jobsdb/job_page_93946363.html` — job detail page (full description in `jobAdDetails`, apply link, work type/location/classification blocks)
- `research-scratch/jobsdb/graphql_probe.json`, `graphql_introspect.json`, `cloud_job_detail.json` (401), `graphql_jobsearch_v7.graphql` — GraphQL/cloud-API exploration
- `research-scratch/jobsdb/js/*.js` — SPA bundle fragments (search-param keys, config)

### Open questions / next steps

- **Determinism probe:** run the identical `page=1` request twice and diff IDs — currently inferred from the no-op tests, not directly confirmed.
- **Pagination depth:** does `page=<n>` walk all 800 (40 requests) or cap early (e.g. 10,000-job guard)?
- **Expired jobs:** what does `/job/<id>` return for a dead listing (404? expired page?) — pick a stale ID from an old capture and probe.
- **Link-out jobs:** the apply flow is JobsDB-hosted (`/job/<id>/apply`) for this capture; verify whether offsite postings redirect to an external ATS from the apply page.
- `salaryLabel` coverage: is it usually empty, or populated for jobs that advertise salary?
- `seniority` filter: JobsDB's taxonomy is classification-based — decide whether the contract's `seniority` maps to it or stays a post-filter.

---

## CTgoodjobs

**URL(s):** jobs.ctgoodjobs.hk (Next.js SSR app), www.ctgoodjobs.hk (legacy ASP portal), api01.ctgoodjobs.hk (JSON API)
**Last tested:** 2026-08-16

### Auth

- Creds needed? **No.** The JSON search API works with a browser `User-Agent` + a **visitor-id** obtained from a public (login-free) bootstrap endpoint. `sid` can be `0`.
- Session vars used: `$CT_UA` (browser UA), `$CT_VID` (fresh visitor id).

```powershell
# One-time per session: fetch a visitor id (body is CSV; first field is the id)
$CT_VID = (curl.exe -s -A $CT_UA "https://www.ctgoodjobs.hk/vid/vid-jobs.asp?visitor_id=&sid=&logincookie=").Split(",")[0]
```

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `/vid/vid-jobs.asp?visitor_id=&sid=&logincookie=` | text (CSV) | **Session bootstrap** — returns `visitor_id,CTID,...`; the visitor_id is the search API's auth token. On `www.ctgoodjobs.hk`. |
| POST | `/job/api/jobs/search` | JSON | **List/discovery — the core surface.** Clean JSON; `data.meta.jobsTotal` (total count) + `data.jobs[]` (rich per-job objects). All filters + pagination + sort via body. On `api01.ctgoodjobs.hk`. |
| GET | `/job/api/jobs/search/criteria` | JSON | **Filter options** — locations (6 regions → districts), employment types, career levels, industries, educations, work models, experience ranges, salaries. |
| GET | `/job/<id>/<slug>` | HTML | **Detail** — SSR page with full JSON-LD `JobPosting` (datePosted, validThrough, employmentType, baseSalary, hiringOrganization, jobLocation, description). On `jobs.ctgoodjobs.hk`. |
| GET | `/ctjob/apply/jobApply.asp?m_jobid=<id>` | HTML | **Apply page** — direct application entry point, derivable from `jobId` alone (verified in captured detail HTML). On `www.ctgoodjobs.hk`. |

```powershell
# Search example (all body-driven filters; see matrices below for enum IDs)
$CT_BODY = '{"pagingInputs":{"page":"1","pageSize":"33","pageOneSize":"33"},"sort":2,"keyword":"Finance Intern","channelIds":[],"employmentTypeIds":["007"],"gradeIds":[],"locationIds":[]}'
curl.exe -s -X POST "https://api01.ctgoodjobs.hk/job/api/jobs/search" `
  -H "Content-type: application/json" -H "channel-id: 001" `
  -H "visitor-id: $CT_VID" -H "sid: 0" -H "lang: en-US" -H "user-id: " -H "login: false" `
  -A $CT_UA -d $CT_BODY
```

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | Body `keyword` (max 100 chars). Verified: "finance" → 4435 jobs. |
| `location` | ✅ | Body `locationIds` = district IDs from `/search/criteria` (e.g. `["005"]` Central → 521). Region IDs available (`"1_r"` = Hong Kong). |
| `posted_within_days` | ✅ | Body `startPostDate` = number of days (`"7"` → 1009). |
| `employment_type` | ✅ | Body `employmentTypeIds` (001 Full-time … 007 Internship → 80). Enum from `/search/criteria`. |
| `sort` | ✅ | Body `sort`: `1` = relevance (also the default when omitted), `2` = site's keyword-search default. Verified discriminating; URL `sort=` is a no-op. |
| `page` / `cursor` | ✅ | `pagingInputs.page` + `pageSize` (site uses 33). Page walk verified (page 2 → new IDs). Depth cap unverified. |
| `seniority` | ✅ | Body `gradeIds` (006 Entry level → 575); plus `workExpFrom`/`workExpTo` (years). Career-level enum from `/search/criteria`. |
| `Other` | ✅ | `industryIds`, `salaryType`/`salaryFrom`/`salaryTo`, `workModelId`, `benefitIds`, `channelIds`, `serviceTypeIds`, and toggles (`isCvOptional`, `isGreatBenefit`, `isImApply`, `isCtMessage`). |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ✅ | `https://www.ctgoodjobs.hk/ctjob/apply/jobApply.asp?m_jobid=<id>` — derivable from `jobId`, no extra request. |
| `job_page_url` | ✅ | `url` in API list (e.g. `/job/10222384/wealth-management-internship-program-welcome-fresh-graduates`). |
| `external_id` | ✅ | `jobId` (numeric string). **Dedup key — mandatory** (see Reliability: pinned jobs duplicate). |
| `title` | ✅ | `jobTitle`. Contains `<strong>` highlight tags on keyword matches — strip before use. |
| `company` | ✅ | `companyName` + `companyId` + `companyUrl`. |
| `location` | ✅ | `locations` (human strings, e.g. `["Wan Chai","Wan Chai District","Hong Kong > Others"]`) **and** structured `jobLocations` with lat/long + eng/chi names. |
| `description` | ⚠️ | Not in the API list. Full HTML only in the detail page's JSON-LD (`description`, ~3K chars) — 1 extra request per job. |
| `posted_at` | ✅ | `publishTime {display,unit,value,date,timestamp}` — structured, ISO timestamp in list. |
| `expires_at` | ✅ | `validThrough {display,unit,value,date,timestamp}` in list — **first portal with a structured expiry**. |
| `is_open` | ⚠️ | No explicit open/closed field; infer from `validThrough.timestamp > now` (list jobs carry validThrough). |
| `employment_type` | ✅ | `empTypes [{id,name}]` in list (may list several, e.g. Full-time + Internship). |
| `source` | ✅ | |

### Deprecation / ToS risk

- **Embedded/unofficial API** — `api01/job/api/jobs/search` is the Next.js app's own widget endpoint, not a documented public API; can change without notice. Last-tested date above is the staleness guard.
- **robots.txt explicitly blocks aggregator crawlers** (JoobleBot, trovitBot, YisouSpider, Jobrapido, JobBot, Bytespider) but `Allow`s `/llms.txt`. Programmatic retrieval at volume may run contrary to their stated crawl policy.
- **AWS WAF in front** (`x-aws-waf-token` header exists in the app; not currently required for search — works without it). Could be enforced later.
- App code includes an **IP-location blocking check** (`blockedLocation`) — foreign/other-region IPs may be gated.
- The `vid-jobs.asp` bootstrap endpoint is equally unofficial.

### Reliability notes

- **Deterministic.** Clean JSON, stable ordering per sort value; filter probes cleanly subset `jobsTotal` (4435 → 80/575/521/1009). The strongest retrieval surface of the portals researched so far.
- **⚠️ Pinned/boosted jobs are prepended to every page AND can duplicate within a single page.** Observed: pageSize 33 → 37 items returned, 36 unique; internship probe contained `jobId` 10222384 twice. The adapter **must dedup by `jobId` across pages**, or pinned jobs (4/page) are collected as noise on every page and double-reported.
- Pagination: `jobsTotal` / pageSize requests for a full sweep (33/page → ~135 for "finance"); depth cap unverified.
- `visitor_id` cookie expires ~1 year out — reuse across sessions is likely fine, but re-fetching the vid endpoint is cheap (one request, no login).
- **Short expiry windows observed:** the Central probe returned jobs expiring 8 days out (2026-08-23). Some listings close fast — `validThrough` is the guard, don't assume a listed job stays open.
- No rate-limiting observed at ~15 requests in a session; throttle ~1 s between calls.
- Description: apply URL and all list fields need zero extra requests; full description only for shortlisted jobs (1 detail request each).

### Raw captures

- `research-scratch/ctgoodjobs/vid_headers.txt` + `vid_response.txt` — visitor-id bootstrap (Set-Cookie + CSV body)
- `research-scratch/ctgoodjobs/api_baseline.json` (4435) · `api_emptype_internship.json` (80) · `api_grade_entry.json` (575) · `api_loc_central.json` (521) · `api_postdate7.json` (1009)
- `research-scratch/ctgoodjobs/api_page2.json` · `api_sort1.json` · `api_nosort.json` · `api_psize33.json` (37 returned / 36 unique — intra-page duplicate proof)
- `research-scratch/ctgoodjobs/api_criteria.json` — full filter-option dump (locations, emptypes, career levels, industries, work models, experiences, salaries)
- `research-scratch/ctgoodjobs/jobs_q_finance.html` — SSR list (q=finance); `job_10226717.html` — detail page (JSON-LD JobPosting + apply URL)
- `research-scratch/ctgoodjobs/js/6434-*.js` — API config (base URLs, param maps, filter-state defaults, body builder)

### Open questions / next steps

- **Pagination depth cap:** does `pagingInputs.page` walk all `jobsTotal` (e.g. 135 pages for "finance") or cap early?
- **`visitor_id` reuse:** probe whether a cached visitor_id from an earlier session still works (cookie says 1-year validity).
- **Description in list:** `jobIdJobInfo` was null in captures — confirm whether any list field ever carries a description snippet to avoid the extra detail request.
- **Sort semantics:** pin down what `sort:1` (relevance) vs `sort:2` (date?) actually order by.
- **Legacy fallback:** `www.ctgoodjobs.hk/english/search/joblist.asp` and `/ajax/ctjob/listing/joblist-enc.asp` — verify as an alternate retrieval surface if the API ever breaks.

---

## Moovup

**URL(s):** moovup.com, api.moovup.com
**Last tested:** 2026-08-16

**Verdict:** keep as a **secondary (not primary) source** — the strongest anonymous, deterministic API surface found so far, but **apply is in-app only** (no external ATS URL), it's an HK part-time/grad-focused board, and there's no structured deadline field.

### Auth

- Creds needed? **No.** A free anonymous JWT is issued by `POST /v2/create-anonymous` (body `{}`, browser UA) — no signup, no key. The token unlocks full read access on the GraphQL API.
- Session vars used: `$MV_UA` (browser UA), `$MV_TOKEN` (anonymous access token).

```powershell
# One-time per session: obtain an anonymous access token
$MV_TOKEN = (curl.exe -s -A $MV_UA -X POST -H "Content-Type: application/json" -d '{}' "https://api.moovup.com/v2/create-anonymous" | ConvertFrom-Json).access_token
```

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| POST | `/v2/create-anonymous` | JSON | **Session bootstrap** — returns `access_token` (anonymous JWT). On `api.moovup.com`. |
| POST | `/v2/seeker` | GraphQL JSON | **Core surface.** `job_search(term, district, employment, job_type, sort, limit, offset)` → `{total, result[]}`; `get_jobs(_id:)` batch detail; `all_jobs(since:)` full ID enumeration. `Authorization: Bearer $MV_TOKEN`. |
| GET | `/hk/en/job/<en-slug>/<id>/` | HTML | **Detail** — server-rendered, full JSON-LD `JobPosting` (datePosted, employmentType, baseSalary, hiringOrganization, jobLocation, description). On `moovup.com`; the `/hk/en/` prefix renders the English locale where available. |

```powershell
# Search example
$MV_QUERY = '{"query":"query { job_search(term: \"intern\", limit: 30) { total result { _id job_name published_at is_closed employment company { name } address { address district_name } } } }"}'
curl.exe -s -X POST "https://api.moovup.com/v2/seeker" `
  -H "Content-Type: application/json" -H "Authorization: Bearer $MV_TOKEN" -A $MV_UA -d $MV_QUERY
```

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | `term`. ⚠️ **Loose/tokenized matching** — `"finance intern"` → 1 fuzzy result (unrelated job), `"intern"` → 360, `"accountant"` → 159, `"barista"` → 95. Phrase search is not exact; use broad terms + filters. |
| `location` | ✅ | `district: [<uuid>]` — HK district IDs (from any job's `address.district_id`, e.g. Island West → 439). `area` / `latlng` args exist but unverified. |
| `posted_within_days` | ⚠️ | No date filter arg on `job_search`; `published_at` is returned so post-filter client-side. |
| `employment_type` | ✅ | `employment: [FullTime] / [PartTime] / [Temp]` (FullTime → 9987, PartTime → 3940). |
| `sort` | ✅ | `sort: [Recency] / [HourlyRate] / [StartDate]`. |
| `page` / `cursor` | ✅ | `limit` (**max 30**) + `offset` (verified at offset 1000). |
| `seniority` | ⚠️ | `career_level` on `Job` was null on all sampled jobs; no filter arg. |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ⚠️ | **No external ATS URL — application is in-app** (form POST via `ja__button` on the job page). Best available = the job detail page itself. `short_link` (`e.moovup.com/<code>`) is a 302 share-redirect to that page, not a distinct apply URL. |
| `job_page_url` | ✅ | `https://moovup.com/hk/en/job/<en-slug>/<id>/` — build from `slug[locale=en]` + `_id`; 200, server-rendered. |
| `external_id` | ✅ | `_id` (UUID). Dedup key; `all_jobs` enumerates every UUID. |
| `title` | ✅ | `job_name` — poster-authored (zh/en mixed), not translatable. |
| `company` | ✅ | `company.name` (non-null). |
| `location` | ✅ | `address[]` — `district_name` (English), `address` (poster-authored street), `lat` / `lng`. |
| `description` | ✅ | `job_description` — full text straight from the search API (no extra detail request, unlike LinkedIn/JobsDB). |
| `posted_at` | ✅ | `published_at` ISO (e.g. 2026-08-14T08:11:40Z). |
| `expires_at` | ❌ | `closed_at` / `end_date` / `start_date` all null on sampled jobs; no structured deadline. |
| `is_open` | ✅ | `is_closed` + `state` (Posted). |
| `employment_type` | ✅ | `employment` enum + `employment_type.name` ("Full Time") + `job_type.name` (category, e.g. Accounts) + `job_type` filter. |
| `source` | ✅ | |

### Deprecation / ToS risk

- **Undocumented/unofficial API** — `/v2/seeker` is the app's own GraphQL widget endpoint, not a documented public API; can change without notice. Last-tested date above is the staleness guard.
- **robots.txt `Allow`s search crawling** and blocks AI bots (GPTBot, ClaudeBot, …) — deterministic retrieval is consistent with the search-allow signal.
- `create-anonymous` bootstrap is equally unofficial.
- A `job_search_rag` endpoint exists (returns an AI summary + session_id) — outside the deterministic-only constraint; not needed.

### Reliability notes

- **Deterministic, anonymous, zero signup.** ~40 requests in one session, no rate limiting hit; throttle ~1 s between calls.
- **Full enumeration path:** `all_jobs` → 14,064 UUIDs; `all_jobs(since: <timestamp>)` → incremental IDs (12,412 since 2026-08-14). `get_jobs(_id: [...])` batch-fetches full details (batch of ≥100 confirmed). A full sync is ~141 batches of 100, or ~470 offset pages at limit 30.
- `job_search` `total` (14,063) vs `all_jobs` (14,064) — off-by-one, presumably a suspended job.
- **`term` is loose/tokenized** — phrase queries can return poor matches. Practical path: broad `term` + `district` + optional `job_type`, then post-filter.
- **Language:** titles/descriptions/street addresses are poster-authored (zh/en mixed) and **not translatable** — `Accept-Language` has no effect (verified). Per-locale fields do exist: `slug` and `short_link` carry `en` + `zh-hant` variants → select the `en` one; `district_name` is English; `/hk/en/` URL prefix renders the English page where a translation exists.

### Raw captures

- `research-scratch/moovup/mv_robots.txt` — search allowed, AI bots blocked
- `research-scratch/moovup/mv_home.html`, `mv_search.html`, `mv_findjobs.html`, `mv_job_detail2.html`, `mv_canon_job.html`
- `research-scratch/moovup/mv_sitemap_job0.xml` — sitemap-job-0 = 20,000 job URLs
- `research-scratch/moovup/mv_introspection.json` — full GraphQL schema dump
- `research-scratch/moovup/mv_jobsearch.json` — `job_search` sample response

### Open questions / next steps

- Verify `area` / `latlng` radius args — currently only `district` tested.
- Find the max `get_jobs` batch size (≥100 confirmed).
- Is `career_level` ever populated? Samples were null.
- `all_jobs(since:)` semantics — filtered on `_created_at` or `published_at`? Do closed/suspended jobs drop out of the enumeration?
- Rate-limit envelope under a sustained full sweep (~14K jobs).

---

## eFinancialCareers

**URL(s):** efinancialcareers.hk, job-search-ui.efinancialcareers.com, job-application.efinancialcareers.com
**Last tested:** 2026-08-16

**Verdict:** keep — strong deterministic retrieval surface. Search API + apply-URL API both work anonymously (browser UA only, no cookies, no keys). Full description inline in the list (no extra request); direct external-ATS apply URL for ~73% of HK jobs via the `apply-information` API. Gaps: `postedDate` filter capped at 7 days, and `sortBy` is a server-side no-op (sort client-side on `postedDate`).

### Auth

- Creds needed? **No.** Browser `User-Agent` only. Verified from a home IP.
- Session vars used: `$EF_UA` (browser UA), `$EF_Q` (query), `$EF_LOC` (location), `$EF_ID` (internal job id).

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `job-search-ui.efinancialcareers.com/v1/efc/jobs/search?q=<query>&location=<city>&countryCode2=HK&page=<n>&pageSize=<m>&culture=en` | JSON | **List/discovery — the core surface.** `data[]` (full per-job objects incl. full `description`), `meta.totalResults` + `pageCount`, `_links` (HATEOAS pagination). Filters as dot-notation query params (`filters.postedDate=SEVEN`, `filters.seniority=INTERN_GRADUATE`, …). |
| GET | `job-application.efinancialcareers.com/v1/jobs/<internal_id>/apply-information` | JSON | **Apply URL.** External jobs → `external_job_application_url` (direct ATS apply page, e.g. SmartRecruiters); in-app jobs → `questionnaire` (application form questions) + `external_job_application_url: null`. Anonymous; `login_required: true` applies to submitting, not to reading the URL. |
| GET | `/jobs-<country>-<city>-<slug>.id<jobId>` | HTML | **Detail** — server-rendered, JSON-LD `JobPosting` (datePosted, validThrough, employmentType, hiringOrganization, geo). External ATS link also present in the HTML (alternative to the apply-information API). |
| GET | `/sitemap-secure/latestjobs/xml` | XML | **Full enumeration** — 2,875 individual job URLs (lastmod 2024→2026); matches the HK API total. |

(All on `https://www.efinancialcareers.hk` except the two API hosts.)

```powershell
# Search example (query + location + date filter)
curl.exe -s -A $EF_UA `
  "https://job-search-ui.efinancialcareers.com/v1/efc/jobs/search?q=$EF_Q&location=$EF_LOC&countryCode2=HK&filters.postedDate=SEVEN&page=1&pageSize=30&culture=en"

# Apply URL for a job (substitute the internal id from the search `id` field)
curl.exe -s -A $EF_UA "https://job-application.efinancialcareers.com/v1/jobs/$EF_ID/apply-information"
```

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | `q`. Global-scoped — then narrowed by `location`. Verified: "nurse" → 195 global / 6 in Hong Kong. Loose/tokenized like Moovup; use broad terms + facets. |
| `location` | ✅ | `location` free text (city/country). Verified: Hong Kong → 6, Singapore → 3, London → 18. |
| `posted_within_days` | ⚠️ | `filters.postedDate` — enum `ONE` / `THREE` / `SEVEN` only, **max 7 days** (other values 500). HK bucket counts: Today 345, 3d 953, 7d 1924 of 2,875. |
| `employment_type` | ✅ | `filters.employmentType` — `FULL_TIME` / `PART_TIME` (HK: 2870 / 5). |
| `sort` | ⚠️ | `sortBy` accepted and echoed but **server-side no-op** — `relevance` and `newest` returned identical orderings. Sort client-side on `postedDate`. |
| `page` / `cursor` | ✅ | `page` + `pageSize` (30 verified; `_links.last` page=96 for HK). |
| `seniority` | ✅ | `filters.seniority` — `INTERN_GRADUATE` / `ANALYST` / `ASSOCIATE_MID_LEVEL` / `AVP_SENIOR` / `VP_PRINCIPAL` / `SVP_HEAD_OF` / `DIRECTOR` / `MANAGING_DIRECTOR`. HK + INTERN_GRADUATE → 37. |
| `Other` | ✅ | `filters.positionType` (`PERMANENT` / `CONTRACT` / `TEMPORARY` / `INTERNSHIPS_AND_GRADUATE_TRAINEE`), `filters.workArrangementType` (`IN_OFFICE` / `HYBRID` / `FLEXIBLE` / `REMOTE`), `filters.experienceLevel` (`NO_EXPERIENCE` … `MORE_THAN_FIFTEEN_YEARS_EXPERIENCE`), `filters.salaryCurrency`, `filters.salaryRange`, `filters.sectors`, `filters.clientBrandNameFilter`. |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ✅ | External jobs (~73% of HK): `apply-information` → `external_job_application_url` = **direct application page on the employer's ATS** (verified: SmartRecruiters URL). In-app jobs: no external URL — apply through eFC questionnaire; best available = the detail page. |
| `job_page_url` | ✅ | `detailsPageUrl` in list (e.g. `/jobs-Hong_Kong-Hong_Kong-<slug>.id<id>`) → 200 server-rendered. |
| `external_id` | ✅ | `jobId` (numeric, URL id) + `id` (internal, required by apply-information). Both in list. |
| `title` | ✅ | `title` (poster-authored, may include location/brand noise e.g. "Nurse [26089]"). |
| `company` | ✅ | `companyName` / `clientBrandName`. |
| `location` | ✅ | `jobLocation.displayName` (city/country); geo + full address in detail JSON-LD. |
| `description` | ✅ | Full `description` inline in the list response — **no extra detail request** (like Moovup, unlike LinkedIn/JobsDB). |
| `posted_at` | ✅ | `postedDate` ISO (e.g. 2026-08-15T20:10:00.177Z). |
| `expires_at` | ✅ | `expirationDate` + `expirationDateType`. ⚠️ `INVENTORY` = evergreen employer posts (e.g. a job posted 2025-08 with `validThrough` 2028-06) — don't treat as a 3-year deadline. |
| `is_open` | ⚠️ | No structured open/closed field; infer from `expirationDate > now` (mind the `INVENTORY` evergreen caveat). |
| `employment_type` | ✅ | `employmentType` string ("Full time") + `filters.employmentType` facet. |
| `source` | ✅ | |

### Deprecation / ToS risk

- **Unofficial/embedded API** — `job-search-ui` + `job-application` hosts are the site's own widget endpoints, not a documented public API; can change without notice. Last-tested date above is the staleness guard.
- **robots.txt**: blocks AI bots (GPTBot, SemrushBot, SplitSignalBot) but `Allow`s **Googlebot-Jobs** on `/jobs/` and `/job-listings/`, and serves the job sitemaps. `crawl-delay: 10` requested — throttle accordingly.
- Sitemaps, detail pages, and both API hosts were all open to a plain browser UA (no Cloudflare on these paths).
- The `apply-information` endpoint is equally unofficial.

### Reliability notes

- **Deterministic.** Repeat query → 10/10 identical job IDs (unlike LinkedIn's rotation).
- Pagination: 2,875 HK jobs ≈ 96 pages at pageSize 30; `_links` HATEOAS (`next`/`last`) gives the walk.
- Location + filters combine cleanly (HK + 7d → 1,924; HK + intern seniority → 37).
- **Apply URL costs 1 extra request per job** (apply-information API) — or scrape it from the detail page HTML (same cost, less structured). No bulk apply-URL endpoint.
- External-application ratio ~73% of HK listings; the rest are in-app (questionnaire).
- No rate limiting hit at ~25 requests; still honor `crawl-delay: 10`.
- `sortBy` no-op and `postedDate` ≤7d are the two real contract gaps.

### Raw captures

- `research-scratch/efinancial/ef_robots.txt` — search allowed, AI bots blocked, Googlebot-Jobs allowed on `/jobs/`
- `research-scratch/efinancial/ef_latestjobs.xml` — latestjobs sitemap (2,875 job URLs)
- `research-scratch/efinancial/ef_jobs_sitemap.xml` — SEO category/location sitemap (2MB)
- `research-scratch/efinancial/ef_api.json` — search API response (q=finance, HK)
- `research-scratch/efinancial/ef_search2.html` — SERP page (embedded API URLs, footer filter conventions)
- `research-scratch/efinancial/ef_jobdetail.html` — in-app job detail (Quantitative Researcher, JSON-LD)
- `research-scratch/efinancial/ef_ext_detail.html` — external job detail (Nurse, SmartRecruiters link in HTML)
- `research-scratch/efinancial/ef_apply_ext.json` / `ef_apply_inapp.json` — apply-information responses

### Open questions / next steps

- **Max `pageSize`** — 30 verified; find the cap (pageSize=100? 200?) to cut page-walk count.
- **`sortBy` semantics** — confirm it's a hard no-op or whether some values (e.g. a date sort) do reorder; until then client-side sort on `postedDate`.
- **postedDate beyond 7 days** — any hidden param (`postedFrom`/`postedAfter` date-range)? Currently capped at `SEVEN`.
- **`login_required` on apply-information** — does it ever gate the URL for particular jobs/companies, or is the flag always true for anonymous?
- **is_open accuracy** — how often is `expirationDate` actually past vs `INVENTORY` evergreen; does the API filter out closed jobs already?
- **Location granularity** — HK is city-level only (no districts); confirm whether `location` accepts district names (e.g. "Wan Chai") or silently ignores.

---

## GradConnection (HK: "JobsDB Grad")

**URL(s):** hk.gradconnection.com, assets.cdn.gradconnection.com, api base `https://hk.gradconnection.com/api`
**Last tested:** 2026-08-16

**Verdict:** keep as a **secondary (not primary) source** — a strong anonymous, deterministic API for graduate/internship *programme* listings, with direct external apply URLs (`origin_target_url`). But: **no sort, no posted-within filter, no total count in the search API**, and the site's apply button (track-link) requires a login for login-to-apply employers (the `origin_target_url` bypasses that).

> **Not the JobsDB section above.** This is a *separate* SEEK-owned product (the general HK board is `hk.jobsdb.com`; this is the GradConnection graduate-programmes site, whose HK arm now displays the brand **"JobsDB Grad (formerly GradConnection)"** — its own config says `app_brand: "JobsDB Grad"`). Different domain, different API, different content. Kept as its own section.

### Auth

- Creds needed? **No.** Browser `User-Agent` only, no cookies, no keys. Verified from a home IP.
- Session vars used: `$GC_UA` (browser UA), `$GC_Q` (query), `$GC_ID` (campaign UUID).

### Working endpoints

| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `/api/campaignsearch/?query=<q>&job_type=<slug>&disciplines=<slug>&location=<addr>,<Type>&work_rights=<slug>&limit=<n>&offset=<n>` | JSON | **List/discovery — the core surface.** Array of campaign *groups* (`customer_organization`, `campaigns[]`, `disciplines`, `earliest_closing_date`, `ranking`). Per campaign: UUID `id`, `title`, `slug`, `job_type`, `interval {start,end}`, `description` (snippet), `locations`, `work_rights`, `target_mode`, `target_url`, **`origin_target_url` (the direct external apply URL)**, `salary`, `remote_option`, `is_event`. `limit`/`offset` paginate (`page` ignored); terminates with `[]`. All params combine. |
| GET | `/api/campaigns/<uuid>/` | JSON | **Detail.** Full record: `content.body` (complete HTML description), `target_email` (email-mode apply), `target_mode`/`target_url`/`origin_target_url`, `interval`, `salary`, `work_rights`, `citizenships`, `graduation_dates`, `degree_level`, `duration`, `job_commencement_date`, `created`, `canonical_url`. |
| GET | `/internships/`, `/graduate-jobs/`, `/entry-level-jobs/<discipline>/` (+ optional `/hong-kong/` suffix) | HTML | **Browse pages, server-rendered** — embed the full listing as `window.__initialState__` (loosely-serialized JS: contains literal `undefined` tokens — replace `undefined`→`null` before `JSON.parse`) plus the total `count`. They **ignore `?query=`**; keyword search is API-only. |
| GET | `/api/jobtypes/`, `/api/jobtimes/`, `/api/disciplines/`, `/api/workrights/`, `/api/locations/`, `/api/citizenships/` | JSON | **Taxonomy enums** for the filter params (job-type slugs, part-time/full-time, discipline slugs, work-rights slugs, full location tree, country codes). |
| GET | `/employers/<company>/jobs/<programme-slug>/` | HTML | **Detail page** — server-rendered, client-fetches the record; `.../apply/` sub-route hosts an in-app application form (for push-apply campaigns). |

(All on `https://hk.gradconnection.com`.)

```powershell
# Search example (query + job_type filter, offset pagination)
curl.exe -s -A $GC_UA `
  "https://hk.gradconnection.com/api/campaignsearch/?query=$GC_Q&job_type=internships&limit=20&offset=0"

# Full detail for a campaign (substitute the UUID from the search `id` field)
curl.exe -s -A $GC_UA "https://hk.gradconnection.com/api/campaigns/$GC_ID/"
```

### Capability matrix — inputs

| Param | Status | Notes |
|---|---|---|
| `query` | ✅ | `query`. Real keyword matching (verified: "quantitative trader" → Jane Street QT first). Loose/tokenized like Moovup; use broad terms + filters. |
| `location` | ⚠️ | Structured only: `location=hong-kong,HK,Country` (`{slug},{code},{Type}` from `/api/locations/`). Free text (e.g. `location=Kowloon`) is silently ignored. |
| `posted_within_days` | ❌ | No date filter. `interval {start,end}` is returned on every campaign so you can post-filter client-side. |
| `employment_type` | ✅ | `job_type` — `internships` / `graduate-jobs` / `entry-level-jobs` / `events` / `part-time-student-jobs` / `experienced-role` (also `job_time` = `part-time` / `full-time`). |
| `sort` | ❌ | `ordering` is a server-side no-op (verified identical results); default relevance/ranking. |
| `page` / `cursor` | ✅ | `offset` + `limit` (verified offset 0 → 20 → 40; `page` ignored; empty `[]` signals the end). No total count — paginate until `[]`, or read `count` from a browse page. |
| `seniority` | ⚠️ | No dedicated arg; mapped via `job_type` taxonomy (intern vs graduate vs entry-level). |
| Other | ✅ | `disciplines` (e.g. `banking-and-finance`), `work_rights` (e.g. `Hong Kong Permanent Resident` / slug `hk-hong-kong-citizen`). Verified all combine with `query`. |

### Capability matrix — outputs

| Field | Status | Notes |
|---|---|---|
| `apply_url` | ✅ | **`origin_target_url` is the direct external application URL** (e.g. `portal.careers.hsbc.com/careers/job/563774610019080`, `janestreet.com/join-jane-street/open-roles/?type=students-and-new-gr...`, monday.com forms). Email-mode jobs → `target_email` (e.g. `david@hybridmmafit.com`). The in-app button uses `target_url` = `/track-link/<uuid>/` (click tracker; 301s to `/login/?next=...` for login-to-apply employers — but `origin_target_url` bypasses the login). |
| `job_page_url` | ✅ | `/employers/<company>/jobs/<slug>/` (also `canonical_url` in the detail record). |
| `external_id` | ✅ | Campaign UUID (`id`). |
| `title` / `company` / `location` / `description` | ✅ | `title`; `customer_organization.name`; `locations[]`; snippet in search, full HTML via detail `content.body`. |
| `posted_at` | ⚠️ | No explicit field. `interval.start` = programme open date; `created` in the detail record. |
| `expires_at` | ✅ | `interval.end` = application deadline (per campaign); `earliest_closing_date` on the group. |
| `is_open` | ⚠️ | Not explicit — infer from `interval.end` vs now. |
| `employment_type` | ✅ | `job_type` (Internships / Graduate Jobs / Entry Level / Events). |
| `source` | ✅ | `GradConnection (HK)` — hk.gradconnection.com. |

### Deprecation / ToS risk

- Embedded/unofficial REST API under `/api/` — no versioning, no documented public contract; can change without notice. Last-tested date recorded above.
- **Rebrand risk:** SEEK-owned; the HK site presents as "JobsDB Grad (formerly GradConnection)". Domain/API may migrate under the JobsDB Grad banner.

### Reliability notes

- Anonymous + browser UA only; no blocks, rate limits, or Cloudflare challenges observed in-session (~40 requests).
- Deterministic ordering — two identical runs returned 10/10 identical campaigns.
- **Filter out non-job entries:** `is_event=true` campaigns (e.g. HSBC career info sessions) and "notify me" placeholder campaigns (empty `origin_target_url`, `apply_button_text: null`, description "Turn on notifications…") are mixed into results.
- Campaign sitemap (`/campaign-sitemap.xml`) holds only ~23 recent URLs — not a full enumeration source; enumerate via `offset` pagination instead.
- `query=` with an empty value returns a default recent listing (browse-style).

### Raw captures

- `research-scratch/gradconnection/` — gc_internships.html / gc_browse_*.html (embedded state, `window.__initialState__`), gc_api_campaignsearch.json (search), gc_api_campaign.json (detail), gc_hybrid_detail.json (email-mode), gc_param_*.json / gc_f2_*.json (filter probes), gc_api_jobtypes_*.json / gc_api_locations_* / gc_api_workrights_* / gc_api_disciplines_* / gc_api_citizenships_* (taxonomies), gc_jane_detail.html / gc_apply.html (detail + in-app apply page), gc_jobtype.xml (747 category URLs).

### Open questions / next steps

- **Exact-phrase vs tokenized matching** — confirm whether quoted phrases are honored or the search is always tokenized.
- **`location` `Type` values** — Country verified; confirm City/Region variants (from `/api/locations/`) and whether they filter on the API.
- **Which employers gate the track-link** — `login_to_apply_enabled` on the employer; confirm `origin_target_url` is always the real destination regardless.
- **Push-apply (in-app) campaigns** — which `target_mode`/`is_pushapply_url` jobs submit via the `/apply/` form vs redirect; whether their apply needs a GradConnection account.
- **Full enumeration** — no comprehensive detail sitemap; confirm offset-paginating `campaignsearch` with `query=` (empty) reaches every programme.

---

## Glassdoor (tombstone — dead end)

**URL(s):** glassdoor.com → country-redirects to www.glassdoor.com.hk
**Last tested:** 2026-08-16

SERP is deterministically scrapeable via Next.js flight data (`self.__next_f.push`, jobs under `searchResultsData.jobListings[].jobview`) — title, company + rating, district location, `ageInDays`, salary percentiles, and a 116–161 char description snippet. But the **apply path is hard-gated**: the detail page *and* the partner `jobLink` both return a 403 Cloudflare challenge, and `sortBy` / `jt` / `_IP2` URL params are all verified no-ops (only `fromAge` works, and it works well). Fails the core apply-URL contract → not worth an adapter. Captures in `research-scratch/glassdoor/`. Do not re-probe unless the site drops Cloudflare.

---

## Indeed (tombstone — dead end)

**URL(s):** hk.indeed.com, api.indeed.com (dead), apis.indeed.com
**Last tested:** 2026-08-16

SERP **page 1** is deterministically scrapeable (plain GET, browser UA, 200, server-rendered HTML + `window._initialData` JSON): title, company, location, salary (some), employment type; `totalJobCount`/`uniqueJobsCount` in `_initialData`. Filters on page 1 verified working: `fromage=7` (152→25), `jt=internship` (152→132), `sort=date` (reorders the set). But everything past page 1 is gated:
- **Pagination** (`start=15`) → **login wall** ("Sign In | Indeed Accounts") — only the first ~15 jobs are retrievable without auth
- **Detail page** (`/viewjob?jk=`) → 403 Cloudflare "Security Check" JS challenge; fails with cookie jar and Googlebot UA
- **Apply** (`/rc/clk?jk=`) → 403 — no apply URL escapes the SERP
- No description, no exact `posted_at` (relative age token only), and external-apply jobs share the dummy jk `a1b2c3d4e5f67890` (dedup hazard — needs fallback key)

**No API path exists:** legacy Publisher API host `api.indeed.com` is dead (NXDOMAIN); the embedded OneGraph endpoint (`apis.indeed.com/graphql`, key in `window._initialData.oneGraphApiKey`) rejects all standard auth transports (401 "API Key required"). The official Job Search API was deprecated May 2021 with no replacement; Publisher API XML feed retired 2023–24 and **keys haven't been issued since 2024** (program closed). Remaining official options are display-only (hosted-search iframe widget) or enterprise-scale (NDA, six-figure minimums). Fails the apply-URL contract at every layer → not worth an adapter. Captures in `research-scratch/indeed/`. Do not re-probe unless Indeed reopens an API.

---

## Recruit.net (tombstone — dead end)

**URL(s):** recruit.net / www.recruit.net / hongkong.recruit.net (`hk.recruit.net` is NXDOMAIN — the HK portal is `hongkong.recruit.net`)
**Last tested:** 2026-08-16

Site is alive (HK listings current, including 2026 internships) but **entirely Cloudflare Turnstile-gated**: every host + path returns the "Just a moment" JS challenge (403) — robots, root, SERP — even with a full Chrome fingerprint or Googlebot UA. No API/RSS/sitemap subdomain exists. Zero curl-reachable surface → not worth an adapter. Would need browser automation or a challenge solver, both outside the deterministic-only constraint. For reference if the wall ever drops: search is `hongkong.recruit.net/search.html?query=&location=&sortby=date&pageNo=&hitsPerPage=20`, job IDs are hex (`1CFE0A30B4758283`). Captures in `research-scratch/recruitnet/`. Do not re-probe unless Cloudflare is dropped.

---

## JIJIS (tombstone — dead end)

**URL(s):** jijis.org.hk / www.jijis.org.hk (API base `https://www.jijis.org.hk/api`)
**Last tested:** 2026-08-16

Pure React SPA (Vite) — no server-rendered pages, no sitemap (all routes return the same 1.3 KB index shell). The backend API is a clean, well-formed REST API, but **every data endpoint is 401-gated behind a Bearer token** — `/api/job-posts` (search), `/api/job-posts/<id>` (detail), `/api/companies`, `/api/campaigns` all return `{"status":401,"message":"Your request was made with invalid credentials."}` anonymously. The search contract itself is solid (documented from the app bundle, unverified 🔑): `GET /api/job-posts?title=<kw>&company=&jijis_ref=&open_date=&close_date=&industry[]=&function[]=&salary=&study_field[]=&location=&employment_type=GRAD|SUMMER|TEMP|INTERN&page=<n>&pageSize=<m>&sort=<key>[,asc|desc]&expand=availableJobCount` → Spring-style `{items, totalElements, totalPages, …}`; job fields include `jobPost.title`, `jobPost.company.name`, `jobPost.jijis_ref`, `vacancy`, `close_date`, `apply_to_name/title/department` (in-app application).

But **getting in is not scriptable**: login (`POST /api/account/login`) requires `username` + `password` + **hCaptcha** (verified: 422 "The verification code is incorrect"), and registration requires a `university_code` + `student_id` (UGC-funded university affiliation) plus hCaptcha. All `/job-search*` routes sit behind a login guard that redirects guests to `/site/login`. No anonymous token exists (unlike Moovup), no API key path (unlike eFinancialCareers), and the CAPTCHA on auth rules out curl-based credentialing within the deterministic-only constraint → not worth an adapter. 

Escape hatch if ever wanted: manually log in once in a browser, copy `user.auth_key` from devtools, and use it as `Authorization: Bearer $env:JIJIS_TOKEN` on the API — but it expires, needs a browser + university account to refresh, and sits outside the deterministic pattern. The only fully public endpoints are the taxonomy reads: `/api/values/{industries,functions,study-fields,education-levels,employment-modes,company-sizes,company-types,salary-currencies,salary-units,universities}` (verified, clean JSON). Captures in `research-scratch/jijis/`. Do not re-probe unless JIJIS opens an API or drops hCaptcha.

