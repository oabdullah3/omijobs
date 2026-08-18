# job-fetcher — Design Spec

**Date:** 2026-08-17
**Status:** Approved by user (design reviewed section-by-section)
**Next step:** writing-plans (implementation plan)

## 1. Purpose

`job-fetcher` is an independent **npm package** inside the `professional-hunter` repo. It replaces the Python `run_job_digest.py` scraping layer (Playwright + LLM + email digest) with **deterministic, programmatic retrieval** of job listings from aggregator portals and ATS backends.

Given a search query and filters, it returns **one JSON file** containing an array of deduped job objects — each with the direct application URL, job page URL, title, company, location, description, and posting metadata. That JSON is the single output contract for the rest of the user's pipeline (actions, website, LLM processing — all downstream, out of scope for this package).

**Hard constraints (carried from portal research):**
- Deterministic programmatic retrieval only — HTTP against public/embedded APIs. **No browser automation (Playwright), no AI in the retrieval loop.**
- Credentials only via `$env:VAR`, never in config.json or the repo.
- The tool is generic — it retrieves **any jobs the user configures**. Finance/intern are only test queries, not the product goal.

## 2. Package layout

Independent package in a top-level repo folder, **`omi-job-fetch/`**:

```
job-fetcher/
  package.json            # name, bin: job-fetcher → dist/cli.js; zero runtime deps (fetch is native in Node 20+)
  tsconfig.json
  config.json             # user's control file (committed)
  config.example.json
  src/
    contract.ts           # default contract v0.1 + merge logic (default ← config ← CLI)
    runtime.ts            # orchestrator: resolve contract → load adapters → run all → normalize → dedup → write
    cli.ts                # entry point; flags bound to the effective contract
    dedup.ts              # signature hash, default fields + config-extensible
    normalize.ts          # platform-native job → contract-shaped job (null for unprovided outputs)
    types.ts              # Manifest, Adapter, Job, ContractInput/Output
    portals/              # one file per aggregator: jobsdb.ts, gradconnection.ts, ctgoodjobs.ts, …
    ats/                  # one file per ATS: workday.ts, icims.ts, …
  tests/
  dist/                   # compiled output
```

- **Language:** TypeScript, compiled to plain JS in `dist/`. Node 20+ (native `fetch`).
- **Two adapter folders:** `src/portals/` (aggregators) and `src/ats/` (ATS backends). One file per platform.

## 3. Architecture (Approach A: manifest-declared adapters, orchestrator-enforced contract)

Three-stage pipeline:

1. **CLI** reads config.json, resolves the **effective contract** = default v0.1 merged with config overrides and CLI flags.
2. **Orchestrator** builds the adapter list from `portals.enabled` + `ats.enabled`, checks each adapter's manifest against the effective contract (fallback or skip just that adapter), runs all enabled adapters **concurrently, each in its own try/catch**.
3. **Normalizer + dedup** map platform-native jobs to contract shape, dedup across sources, and write one JSON file per run. The CLI prints the output path.

**Conformance logic lives in the orchestrator, not in the adapters.** Adapters stay focused on HTTP + parsing. Adapters may accept/return more than the contract; the orchestrator guarantees the contract is honored exactly.

## 4. Contract v0.1

Source of truth for defaults: `docs/portal-research/plan.md` §3.

### Inputs

| Key | Meaning | Notes |
|---|---|---|
| `query` | keywords | only input hard-required by default |
| `location` | place, e.g. "Hong Kong" | primary input priority; config can set a default |
| `posted_within_days` | recency filter, e.g. 7/30 | adapters infer from available date info when no exact date exists |
| `employment_type` | internship / full-time / contract | mapped to portal enums per adapter |
| `sort` | relevance / date / newest | honored where supported |
| `page` / `cursor` | pagination | offset vs cursor per adapter |
| `seniority` | intern / entry / graduate | where supported |

**Input priority (user-stated):** location (most important) > search query > posting date. Reflected in defaults/required-ness; per-adapter `requiredInputs` still decide skip/fallback behavior.

### Outputs (per job)

| Field | Meaning |
|---|---|
| `apply_url` | **direct application page URL** — the core goal |
| `job_page_url` | canonical job page |
| `external_id` | portal-native ID |
| `title` | job title |
| `company` | hiring organization |
| `location` | job location |
| `description` | full or truncated (truncation policy per adapter, noted in `meta`) |
| `posted_at` | posting date |
| `expires_at` | application deadline (rare) |
| `is_open` | still accepting applications (often inferred) |
| `employment_type` | intern / full-time / etc. |
| `source` | portal/ATS id that surfaced the job |

### Override mechanics

config.json can:
- change an input's `required` flag or `default`,
- add a **new input field** (becomes a `--<name>` CLI flag automatically),
- trim the output set.

CLI flags are bound to the **effective** contract. Unknown `--key value` pairs pass through to adapters as extra inputs (they may use or ignore them).

**Precedence:** CLI flags > config.json > default contract.

## 5. config.json

```jsonc
{
  "contract": {
    "inputs": {
      "query":             { "required": true, "default": null },
      "location":          { "required": false, "default": "Hong Kong" },
      "posted_within_days": { "required": false, "default": null }
      // add a new input here → becomes a --<name> CLI flag
    },
    "outputs": { }
  },
  "portals": {
    "enabled": ["jobsdb", "gradconnection", "ctgoodjobs"],
    "config": {
      "gradconnection": { "country": "hk" }
    }
  },
  "ats": { "enabled": [], "config": {} },
  "dedup": {
    "fields": ["title", "company", "location"]
  }
}
```

Real credentials never appear in config.json — adapters read them from `$env:VAR` (plan.md §7). Per-platform config blocks hold only non-secret settings (e.g. GradConnection `country`).

## 6. CLI

```
job-fetcher --query "graduate program" --location "Hong Kong" \
  [--posted-within-days 30] [--employment-type internship] [--sort date] \
  [--page 1] [--config path/to/config.json]
```

- Flags map 1:1 to effective-contract inputs.
- Unknown `--k v` pairs pass through to adapters.
- Default config path: resolved from **cwd**, falling back to the package dir; overridable with `--config`.
- Prints the absolute path to `jobs.json` on success.

## 7. Adapter interface

One file per platform, exporting a single `Adapter`:

```ts
interface AdapterManifest {
  id: string;                    // "gradconnection"
  family: "portal" | "ats";
  name: string;
  requiredInputs: InputKey[];    // contract inputs it can't work without
  optionalInputs: InputKey[];    // contract inputs it honors when present
  providedOutputs: OutputKey[];  // contract outputs it can fill
  fallbacks?: Partial<Record<InputKey, unknown>>; // used when a required input is missing
  extraInputs?: Record<string, { desc: string; env?: string }>; // platform-specific, e.g. gradConnection country
}

interface AdapterContext {
  input: EffectiveContractInput;     // ONLY what the contract provides
  env: NodeJS.ProcessEnv;            // $env:VAR creds
  config: Record<string, unknown>;   // this platform's block from config.json
}

interface AdapterResult {
  jobs: Job[];                       // may include fields beyond the contract
  meta: Record<string, unknown>;     // platform notes (totals, pagination, warnings, truncation)
}

type Adapter = { manifest: AdapterManifest; run(ctx: AdapterContext): Promise<AdapterResult> };
```

**Manifest check (orchestrator):** for each enabled adapter, any `requiredInput` missing from the effective contract → use `fallbacks[name]` if declared, else **skip that adapter** with the reason logged. `optionalInputs` are honored when present, ignored otherwise. **"We only skip what's necessary — not everything."**

## 8. Normalization

For each platform-native job, the normalizer maps to the contract shape:
- fills each `providedOutputs` field from the native record,
- sets `null` for contract outputs the adapter does not provide,
- preserves any extra fields the adapter attached beyond the contract.

## 9. Dedup

- **Default signature:** hash of normalized `title` + `company` + `location` (trim, lowercase, collapse whitespace). Rationale: the same job listed on different portals has different URLs but the poster keeps title/company/location consistent.
- config.json `dedup.fields` extends/replaces the field set (e.g. add `"apply_url"`).
- **First-seen wins.** The kept job carries `source` (the adapter id that surfaced it first) plus `sources: string[]` listing every adapter that matched the same signature.

## 10. Output & run metadata

```
output/runs/2026-08-17T14-30-00-123Z/
  jobs.json      # deduped job array (contract outputs + extras + sources)
  run.json       # metadata: contract used, enabled adapters, per-adapter
                 #   {status, jobCount, error?, durationMs}, dedup stats
```

- **Every run is a new timestamped folder**; nothing is overwritten.
- The CLI prints the absolute path to `jobs.json`.
- `jobs.json` is the sole output contract to the downstream pipeline.

## 11. Error handling & exit codes

- Each adapter `run()` is wrapped independently; failure records `{ adapter, error }` in `run.json` and the pipeline continues.
- Exit code **0** if ≥1 adapter produced jobs; non-zero if all adapters failed.

## 12. Testing

- **Unit:** contract resolution (precedence + config overrides), manifest check / skip / fallback, normalize (provided → filled, unprovided → null, extras preserved), dedup (incl. cross-source collision and config-extended fields), run folder writing.
- **Adapter tests replay raw captures** from `research-scratch/` (e.g. GradConnection `campaignsearch` JSON) as fixtures → assert parsed jobs map to contract fields. Deterministic, no network. Each future portal's captured responses become its test fixtures.
- Runner: **vitest** (`npm test`).

## 13. Scope

**In scope for this effort:**
- Scaffolding: package.json, tsconfig, folder structure.
- Contract module (v0.1 + merge/precedence), CLI, orchestrator, normalizer, dedup, output writer, run metadata.
- Types (Manifest / Adapter / Job / Contract).
- Test harness + unit tests for the core (no adapter fixtures yet).
- **Proof-of-concept adapter** for at least one already-verified portal (e.g. GradConnection) using existing `research-scratch/` captures as fixtures.

**Deferred (separate efforts):**
- Writing the full portal/ATS adapter set — each written against verified endpoints, one by one, after the ATS backend research is done.
- Anything downstream of `jobs.json` (actions pipeline, website, LLM processing).

**Non-goals:**
- No browser automation, no AI in retrieval.
- No email digest / scheduling (that was `run_job_digest.py`; this replaces its scraping layer only).

## 14. Resolved decisions

- **Package folder name:** `omi-job-fetch/`. Published npm name can be scoped later; local first.
- **Config default location:** resolved from cwd, falling back to the package dir; `--config` overrides.
- **Description truncation:** adapter-declared — each adapter states its own policy (e.g. GradConnection keeps full text) in its `meta`.
