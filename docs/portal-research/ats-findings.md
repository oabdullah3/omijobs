# ATS Backend Findings — Work in Progress

> This doc accumulates what we actually learn, ATS-backend by ATS-backend. Each section follows the template in [plan.md §6](plan.md). The contract this is measured against lives in [plan.md §3](plan.md) (draft v0.1, subject to change).
>
> **Legend:** ✅ available · ⚠️ partial · ❌ not available · 🔑 needs auth · ❓ unverified

**Backends researched so far:** workday, greenhouse (2026-08-17). **Status: PAUSED** — ATS endpoints are per-employer (must name companies), which contradicts the tool's query-driven design (no hardcoding companies). Findings retained as reference for a possible future opt-in "named-employer" adapter set. Aggregator/portal adapters remain the search layer.

Candidate backends are listed in [plan.md §9.2](plan.md).

## Workday
**URL(s):** `<tenant>.wd{1,2,3}.myworkdayjobs.com` — the `/wday/cxs/` JSON API each career site's own widget consumes
**Last tested:** 2026-08-17

### Auth
- No creds, no env vars — anonymous POST to the embedded cxs API (✅ on open tenants).
- Gated tenants reject the identical request with Workday `422 {"errorCode":"HTTP_422","message":""}`. Per-tenant "anonymous cxs disabled" flag, not a request-shape problem and not fixable with headers/cookies (tried ~10 body shapes, Origin/Referer, cookie jar, `wd-browser-id` — same 422; Wegmans 200s on the same call).

### Working endpoints
| Method | URL template | Response format | Notes |
|---|---|---|---|
| POST | `https://<host>/wday/cxs/<siteId>/<siteId>/jobs` | JSON `{total, jobPostings[], facets, userAuthenticated}` | Search. Body `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"","locationSearch":"","searchLocationSegments":[]}`, `Content-Type: application/json`. Open tenants → 200; gated → 422. |
| GET | `https://<host>/en-US/<siteId><externalPath>` | HTML SPA shell + embedded JSON-LD JobPosting | Job detail. `externalPath` from search result. JSON-LD has full description, ISO `datePosted`, `validThrough`, `employmentType`, `identifier.value` (req ID), `hiringOrganization.name`, address. |
| POST | (same cxs) with `appliedFacets` | same | Location filter = State/City facet IDs; employment type = `timeType` facet IDs. |

### Capability matrix — inputs
| Param | Status | Notes |
|---|---|---|
| query | ✅ | `searchText` keyword search |
| location | ⚠️ | Free-text `locationSearch` does **not** filter (Wegmans: 533 unfiltered). Use `appliedFacets` with State (`Location_Region_State_Province`) or City (`locationMainGroup`>locations) facet IDs. 2-step: request facets → match descriptor → apply ID. IDs tenant-specific but self-describing. |
| posted_within_days | ⚠️ | No date filter param. Search returns relative `postedOn` text ("Posted 3 Days Ago") → coarse client-side filter. Exact ISO `datePosted` only via per-job JSON-LD fetch (N+1). |
| employment_type | ✅ | `timeType` facet in `appliedFacets`; IDs look stable across tenants (Full time `1bc860f9675201390f431434e94c4f00`, Part time `1bc860f9675201628b301434e94c4e00`). |
| sort | ❓ | `sortBy` param accepted; effect unverified |
| page / cursor | ✅ | `offset`+`limit` pagination; `total` reliable on offset 0 only |
| seniority | ❌ | No seniority field/facet seen |

### Capability matrix — outputs
| Field | Status | Notes |
|---|---|---|
| apply_url | ✅ | Job page URL (`/en-US/<siteId><externalPath>`) — on-page apply |
| job_page_url | ✅ | Same canonical URL |
| external_id | ✅ | `bulletFields[0]` in search / `identifier.value` in JSON-LD (requisition ID, e.g. R0291301) |
| title | ✅ | `title` |
| company | ✅ | JSON-LD `hiringOrganization.name`; search has no company field (tenant is one org) |
| location | ⚠️ | Search `locationsText` = city/state list (better); JSON-LD `address.addressLocality` is the store/unit name + `addressCountry` |
| description | ✅ | JSON-LD `description`, full text |
| posted_at | ⚠️ | Search: relative text only. JSON-LD: exact ISO `datePosted` |
| expires_at | ✅ | JSON-LD `validThrough` (ISO) |
| is_open | ✅ | `validThrough` — expires_at > now ⇒ open |
| employment_type | ✅ | JSON-LD `employmentType` (schema.org `FULL_TIME` etc.); search `timeType` facet |
| source | ✅ | adapter id `workday:<siteId>` |

### Deprecation / ToS risk
- cxs is the career-site widget's own JSON API (product feature), not documented-public; shape changes with Workday releases. Per-tenant gates (422 / maintenance / Cloudflare) already demonstrate Workday applies site-level policy — treat every tenant as independently unstable.
- ToS = employer's own careers site; scraping posture employer-dependent. No creds, low per-request risk; pace requests conservatively.

### Reliability notes
- **Per-tenant gate is THE blocker.** 2026-08-17: Wegmans (wd1) → cxs **200**, open. HSBC (wd3), Starbucks (wd1), Target (wd1), JPM (wd1) → cxs **422**. BlackRock → **404** `not found: Job_Posting_Site_ID=...` (org segment is a site-ID lookup, not tenant name).
- HSBC HTML currently → 500 redirect to `community.workday.com/maintenance-page`; Starbucks HTML → Cloudflare 406. **Gated tenants gate both API and page — no JSON-LD rescue path.**
- No rate limits observed on Wegmans. `total` on later offsets can drift.

### Raw captures
- `research-scratch/workday/wegmans_search.json` — cxs search 200 (533 total, State/timeType/location facets)
- `research-scratch/workday/wegmans_jobpage.html` — job page shell (window.workday config) + JSON-LD JobPosting
- `research-scratch/workday/cxs_probe.json` — the 422 gate envelope

### Open questions / next steps
- Resolve BlackRock's correct Job_Posting_Site_ID (org segment) to separate 422-gated vs 404-wrong-ID.
- Is HSBC's maintenance redirect persistent or a window? Retest in a day.
- Controlled `sortBy` test on Wegmans (does sort actually sort?).
- **Adapter consequence:** Workday adapter = per-tenant manifest. Must probe cxs first run and report "tenant gated" cleanly (skip, don't fail). HSBC — the plan.md target — is gated today; HSBC would need an alternative source (e.g. hsbc.com careers JSON) rather than its Workday site.

## Greenhouse
**URL(s):** API `boards-api.greenhouse.io` — hosted boards `boards.greenhouse.io/<token>` / `job-boards.greenhouse.io/<token>`
**Last tested:** 2026-08-17

### Auth
- Anonymous board API: no creds, no env vars. ✅
- **Harvest API** (`harvest-api.greenhouse.io/v1/jobs`, Basic-auth org key) is the auth'd alternative — more fields/status/pagination — but keys are employer-specific, unusable for generic retrieval. Untested (no key in env). 🔑

### Working endpoints
| Method | URL template | Response format | Notes |
|---|---|---|---|
| GET | `https://boards-api.greenhouse.io/v1/boards/<token>/jobs` | JSON `{jobs[], meta:{total}}` | **Full-board dump.** `page`/`per_page`/`query` all ignored (verified identical output). One request = every live job. |
| GET | `.../jobs?content=true` | same + `content` (HTML-escaped description) | description inline, ~1.3KB/job |
| GET | `.../jobs/<id>` | JSON single job | Adds `departments`, `offices`, `company_name`, `requisition_id`, `metadata` |
| GET | `.../departments` | JSON `{departments[]}` | id/name/parent/child/jobs[] |
| GET | `.../offices` | JSON `{offices[]}` | office name + full location string + nested departments/jobs |

### Capability matrix — inputs
| Param | Status | Notes |
|---|---|---|
| query | ❌ | No server-side search (`?query=` ignored). Client-side filter over dump. |
| location | ⚠️ | No server-side filter. `offices` endpoint gives canonical location strings; jobs carry `location.name` (often multi-city: "SF, NYC, SEA, CHI"). Client-side match. |
| posted_within_days | ✅ | `first_published` = exact ISO posting date → precise client-side filter, no N+1 |
| employment_type | ❌ | Not exposed anonymously (no field; metadata company-custom). Harvest may expose — unverified. |
| sort | ✅ | Client-side sort. No server-side sort. |
| page / cursor | ❌ | No pagination — one response holds the whole board (578 max tested) |
| seniority | ❌ | No field |

### Capability matrix — outputs
| Field | Status | Notes |
|---|---|---|
| apply_url | ⚠️ | `absolute_url` — host varies per company: classic board, new `job-boards` host, or fully custom (careers.duolingo.com, careers.airbnb.com/positions/, careers.datadoghq.com/detail/, stripe.com/jobs/search). All are live apply pages. |
| job_page_url | ✅ | same `absolute_url` |
| external_id | ✅ | `id` (numeric Greenhouse job id) |
| title | ✅ | `title` |
| company | ✅ | `company_name` (listing + detail) |
| location | ✅ | `location.name`; `offices` adds full address strings |
| description | ✅ | `content` — full HTML, escaped in JSON |
| posted_at | ✅ | `first_published` ISO |
| expires_at | ❌ | `application_deadline` null on all 1406 jobs scanned (5 boards) |
| is_open | ⚠️ | Board only lists live jobs ⇒ present ⇒ open; no explicit status |
| employment_type | ❌ | Not exposed |
| source | ✅ | adapter id `greenhouse:<token>` |

### Deprecation / ToS risk
- `boards-api` is Greenhouse's **documented public API** for job boards (built for aggregators) — lowest-risk ATS so far; shape stable across years. `application_deadline`/`requisition_id` gaps are employer-population issues, not API defects.
- Harvest (auth) is the contractual integration path but employer-keyed.

### Reliability notes
- No auth, no rate limit observed under rapid requests; 200 to plain curl (no Cloudflare).
- **Full-board dump, no incremental sync** — each run re-downloads the whole board (Stripe: 578 jobs / ~735KB with content). Boards hold all live jobs regardless of age — filter by `posted_within_days` client-side when set.
- `requisition_id` employer-dependent (real `R-…` for reddit/datadog; placeholders for stripe/airbnb) — prefer `id` as external_id.
- No JSON-LD on job pages (classic, new-host, custom all lack schema.org) — description must come from the API.

### Raw captures
- `research-scratch/greenhouse/board_{reddit,airbnb,datadog,stripe}_p1.json` — full boards (151/185/425/578 jobs)
- `research-scratch/greenhouse/stripe_jobs_content_p1.json` — content=true dump
- `research-scratch/greenhouse/board_reddit_q.json` — `?query=` ignored proof
- `research-scratch/greenhouse/reddit_job_detail.json`, `stripe_job_8077887.json` — detail shape
- `research-scratch/greenhouse/stripe_departments.json`, `stripe_offices.json` — org endpoints
- `research-scratch/greenhouse/reddit_jobpage.html`, `duolingo_jobpage.html` — no-JSON-LD proofs

### Open questions / next steps
- Harvest API (auth): confirm `employment_type`, `opened_at`/`closed_at`, `status`, pagination, `updated_after` incremental sync — needs an org key. Only path to employment_type / true is_open.
- Adapter consequence: one GET per company token; `query`/`location` client-side filters; fetch `offices` only when location matching needs canonical strings.

---

<!--
Sections below get filled as we run research sessions. Copy the §6 template from plan.md for each portal. Do not hand-edit this header.
-->
