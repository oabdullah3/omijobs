# Portal Technique Research — Plan

**Last updated:** 2026-08-16
**Status:** Living plan — the contract in §3 is draft v0.1 and will be reshaped by what portals actually expose.

## 1. Purpose

Discover, for every job portal and ATS backend we target, the most reliable **deterministic, programmatic** way to retrieve jobs. That means curl/HTTP requests against public or embedded APIs only — **no browser automation (Playwright), no AI in the retrieval loop**. The research output is what feeds the future shared adapter layer and the standard communication contract.

**For each portal we must be able to answer:**

| Question | Meaning |
|---|---|
| What search inputs can it accept? | query, location, posted-within-days, employment type, sort, pagination |
| What job fields can it return? | apply URL, job page URL, title, company, location, description, posted date, deadline/is-open, employment type, ID |
| How do we get them deterministically? | exact endpoint, HTTP method, response format, auth |
| Is it stable enough to rely on? | official vs embedded vs scraped, deprecation risk, ToS, blocks, rate limits |
| Does it need credentials? | where to get them, which env var, what they unlock |

## 2. Session protocol (repeat per portal)

| Step | Who | What |
|---|---|---|
| 1 | User | Name a portal |
| 2 | Claude | Produce plug-and-play `curl.exe` commands. If creds are needed: state **where to get them** + a `$env:VAR = "..."` command, then reference `$env:VAR` in the actual commands |
| 3 | User | Run them in PowerShell; paste the output or save it to a file and give the path |
| 4 | Claude | Analyze what came back — response format (HTML/JSON/XML/RSS), which contract fields are present, how stable/parseable it is |
| 5 | Both | Fill the capability matrix and notes for that portal in `findings.md` |

**During a session:** raw responses are saved to a gitignored scratch dir (`research-scratch/`) so we can re-inspect them; only distilled notes go into the findings docs — aggregators into `aggregator-findings.md`, ATS backends into `ats-findings.md`.

**Shell environment:** commands target **PowerShell on Windows** (5.1 or 7). Use `curl.exe` explicitly — plain `curl` is aliased to `Invoke-WebRequest` in Windows PowerShell and behaves differently. Multi-line commands continue with a backtick (`` ` ``); parameters are session variables (`$LI_UA`, `$LI_KEYWORDS`, ...). Bash users adapt: `export VAR=...`, `\` continuation, plain `curl`.

## 3. Target contract — draft v0.1 (subject to change)

The **ideal** input/output every portal should satisfy. This is the yardstick; portals will fall short, and *that shortfall is exactly what we document*.

### Inputs (search parameters)

| Param | Meaning | Notes |
|---|---|---|
| `query` | keywords, e.g. "Finance Intern" | always supported in some form |
| `location` | e.g. "Hong Kong" | free text vs structured geo varies |
| `posted_within_days` | post-date filter | often the first thing to break |
| `employment_type` | internship / full-time / contract | mapping to portal enums needed |
| `sort` | relevance / date / newest | |
| `page` / `cursor` | pagination | offset vs cursor-based matters |
| `seniority` | intern / entry / graduate | where supported |

### Outputs (per job)

| Field | Meaning | Notes |
|---|---|---|
| `apply_url` | **direct application page URL** | the core goal |
| `job_page_url` | canonical job page | |
| `external_id` | portal-native ID | dedup key candidate |
| `title` | job title | |
| `company` | hiring organization | |
| `location` | job location | |
| `description` | full or truncated | truncation + noise policy |
| `posted_at` | when posted | availability varies wildly |
| `expires_at` | application deadline | rare |
| `is_open` | still accepting applications | rare; often inferred |
| `employment_type` | intern / full-time / etc. | |
| `source` | portal name | |

## 4. Capability matrix legend

| Mark | Meaning |
|---|---|
| ✅ | available, verified |
| ⚠️ | partial / degraded |
| ❌ | not available |
| 🔑 | needs auth (see that portal's Auth section) |
| ❓ | unverified / to be tested |

Each portal's section in the findings docs (`aggregator-findings.md` / `ats-findings.md`) contains two matrices — **inputs** and **outputs** — one row per contract field.

## 5. Probe order (fixed priority, least-config first)

For each portal, try these surfaces in order and stop at the first that returns usable job URLs:

1. **Official public API** — documented, versioned, stable
2. **Embedded JSON/XML API** — the endpoint the portal's own search widget hits (often the best source; unofficial but usually stable)
3. **Sitemap.xml / RSS / category listings** — server-rendered XML/HTML, rarely bot-challenged
4. **Server-rendered search results** — plain HTTP GET on the portal's search URL template
5. **Scoped search-engine discovery** — `site:` search + URL-pattern validation

For each candidate: run curl → capture raw response → assess parseability → record in the matrix.

## 6. Per-portal findings template

Each portal section in the findings docs follows this shape:

```markdown
## <Portal name>
**URL(s):** <domains>
**Last tested:** <date>

### Auth
- Creds needed? <yes/no>
- Where to get them + env var to export: ...

### Working endpoints
| Method | URL template | Response format | Notes |
|---|---|---|---|

### Capability matrix — inputs
| Param | Status | Notes |
|---|---|---|

### Capability matrix — outputs
| Field | Status | Notes |
|---|---|---|

### Deprecation / ToS risk
- <official API / embedded endpoint / scraped; how likely to change or break>

### Reliability notes
- <blocks, rate limits, IP sensitivity, pagination behavior, sitemap freshness>

### Raw captures
- <paths under research-scratch/>

### Open questions / next steps
- ...
```

## 7. Credentials policy

- No creds required = preferred and documented as-is.
- Creds needed = acceptable, but the doc must state **where to get them** and the **env var** (`$env:VAR`) so commands are plug-and-play.
- Never put real credentials in docs or the repo. The `.env` rule applies: never read/write/display `.env`.

## 8. Deprecation policy

- Prefer documented, versioned APIs.
- Embedded/unofficial endpoints: note that they can change without notice; record the **last-tested date** next to every endpoint so staleness is visible.
- If a portal offers an official API that is slated for deprecation, record that explicitly and mark the alternative.

## 9. Candidate portals & backends

Two families. **Aggregators** have their own search UI; **ATS backends** are the platforms employer career pages are built on, and usually expose the JSON/XML their own search widget consumes.

### 9.1 Aggregator job portals

| Portal | Domains | Notes |
|---|---|---|
| LinkedIn | linkedin.com, hk.linkedin.com | highest-value source historically |
| Indeed | indeed.com, hk.indeed.com | has an official Publisher API (needs key) |
| Glassdoor | glassdoor.com | heavy bot protection |
| Google for Jobs | jobs.google.com | aggregator of aggregators; no official public API (unofficial endpoints exist) |
| JobsDB | hk.jobsdb.com | HK's largest local board |
| CTgoodjobs | ctgoodjobs.hk | large HK board |
| JobStreet | jobstreet.com.hk | Seek-owned, HK/SEA |
| Recruit.net | hk.recruit.net | HK/global listings |
| Moovup | moovup.com | HK part-time/grad focused |
| CPjobs | cpjobs.com | HK |
| WorkinHongKong | workinhongkong.com | HK expat-oriented |
| eFinancialCareers | efinancialcareers.com, efinancialcareers.hk | finance-specific; Cloudflare-protected |
| GradConnection | gradconnection.com, sg.gradconnection.com | graduate programs, AU/SG/HK |
| MyCareerFuture | mycareerfuture.gov.hk | HK govt job-matching platform |
| JIJIS | jijis.org.hk | HK university graduate jobs |
| Monster | monster.com, monster.hk | legacy global |

### 9.2 ATS backends (employer career-site platforms)

| Platform | Notes | Typical users |
|---|---|---|
| Workday | huge enterprise ATS; public JSON endpoints per tenant | HSBC, JPMorgan, BlackRock, many banks |
| iCIMS | large financial-services ATS | banks, FS firms |
| Oracle Taleo / Oracle Recruiting | taleo.net and oracle cloud | large corporates |
| SAP SuccessFactors | successfactors.eu | large corporates |
| Greenhouse | greenhouse.io; clean public API | fintech / startups |
| Lever | lever.co | startups / fintech |
| Ashby | ashbyhq.com | modern startups |
| SmartRecruiters | smartrecruiters.com | retail / banks |
| BambooHR | bamboohr.com | SMBs |
| Jobvite | jobvite.com | mid-market |
| Phenom People | phenompeople.com | employer career-site CX |
| Avature | avature.net | some banks |
| Bullhorn | bullhorn.com | staffing agencies |
| PageUp | pageuppeople.com | universities / HK employers |
| JazzHR / Recruitee / Teamtailor / Pinpoint | — | SMB ATS |
| Brassring / Kenexa (IBM) | — | legacy ATS still in the wild |

## 10. How to add a portal

1. Add a row to the relevant table in §9 (or start a new category).
2. Create a portal section in the matching findings doc — `aggregator-findings.md` for §9.1 portals, `ats-findings.md` for §9.2 backends — from the §6 template, all fields marked ❓.
3. Run a session per §2. Fill the matrices and notes as evidence comes in.
4. If the portal reshapes the contract, update §3 and bump its version.
