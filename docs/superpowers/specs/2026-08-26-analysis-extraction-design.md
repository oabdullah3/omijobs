# Analysis — Structured Extraction Contract — Design

**Goal:** Replace the subjective `{ score, reason }` verdict (2026-08-20-analysis-design) with a **structured extraction contract**: the LLM extracts well-defined, normalized fields from each job description, and the user filters jobs by those fields. No subjective scoring, no "recommended threshold", no instruction set to craft. The contract (its schema and enum values) is a config file that is the single source of truth driving the prompt, output validation, and the dashboard filter UI.

**Date:** 2026-08-26 · **Status:** Design (approved 2026-08-26)

**Supersedes:** `2026-08-20-analysis-design.md` — the `{ score, reason }` data model, `recommendedThreshold`, the instructions textarea, and the "mark below threshold" action are all removed. The process model (§2 of the old design: spawn, lock, stop, retention, cron-as-analysis) is **unchanged** and retained.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **Contract** | The config file describing *which* fields to extract and *how* (type, multi, allowed values). Lives in the analysis settings file (`analysis.json`), shipped as `analysis.config.base.json`. |
| **Field** | One named extraction target (e.g. `domain`, `salary`). Every field is **optional** — absent from the JD ⇒ absent from the output. |
| **Field kind** | `enum` (controlled values), `list` (open vocabulary), `range` (min/max), `date`. |
| **Extraction** | The LLM's job: read a job's `{title, description, …}` and emit one JSON object containing only the fields present, never fabricated. |
| **schemaVersion** | An integer on the contract and on every stored extraction. Bumping it is **informational** — it marks old extractions as non-conforming but does **not** auto-re-analyze them (see §4.3). |

---

## 2. Core principle: every field is optional

The single hardest rule, restated everywhere (config, generated prompt, validator, docs):

> Extract a field **only if the JD specifies it**. If a field is not specified, **omit it entirely**. Never invent a value. Always fill a field when the JD provides it.

Concretely the stored extraction distinguishes:

- **"Not specified"** — the key is absent from the JSON.
- **"Specified, empty"** — the key is present with `[]` / `null` (used only when the JD *explicitly* states "none", e.g. "no degree required").
- **"Specified, valued"** — the key is present with a real value.

This distinction is what lets faceted filtering tell "genuinely no experience required" apart from "the JD didn't say".

---

## 3. The contract

### 3.1 Storage & load order

- Stored in the **existing** analysis settings file at `<stateDir>/analysis.json` (same file `loadAnalysisSettings`/`saveAnalysisSettings` already use), extended with `schemaVersion` and `fields`.
- Shipped default: `analysis.config.base.json` (the repo file the loader falls back to when no state file exists).
- Load order is unchanged: state file → base config → hardcoded minimal default.

### 3.2 Shape

```jsonc
{
  "schemaVersion": 1,
  "systemPrompt": "You are a job-description extractor. ...",   // persona/general preamble
  "descriptionMaxChars": 4000,
  "enabledProvider": null,
  "providers": [ /* unchanged: AnalysisProviderConfig[] */ ],
  "fields": [
    { "key": "domain",            "kind": "list", "multi": true,  "normalize": "lower" },
    { "key": "industry",          "kind": "list", "multi": true,  "normalize": "lower" },
    { "key": "mandatory_languages","kind": "list", "multi": true, "normalize": "canonical-language" },
    { "key": "preferred_languages","kind": "list", "multi": true, "normalize": "canonical-language" },
    { "key": "skills",            "kind": "list", "multi": true,  "normalize": "lower" },
    { "key": "licenses",          "kind": "list", "multi": true,  "normalize": "canonical-license" },

    { "key": "education",         "kind": "enum", "multi": false, "values": ["phd", "masters", "bachelors-y1", "bachelors-y2", "bachelors-y3", "bachelors-y4", "diploma", "secondary"] },
    { "key": "employment_type",   "kind": "enum", "multi": false, "values": ["full-time", "part-time", "contract", "internship", "graduate"] },
    { "key": "job_duration",      "kind": "enum", "multi": false, "values": ["permanent", "fixed-term"] },
    { "key": "seniority",         "kind": "enum", "multi": false, "values": ["intern", "graduate", "assistant", "officer", "associate", "manager", "senior-manager", "director", "vp", "head"] },
    { "key": "work_arrangement",  "kind": "enum", "multi": false, "values": ["onsite", "hybrid", "remote"] },

    { "key": "years_experience",  "kind": "range", "unit": "years" },
    { "key": "contract_length_months", "kind": "number" },
    { "key": "salary",            "kind": "range", "currency": "HKD", "period": "monthly" },
    { "key": "job_start_date",    "kind": "date" }
  ]
}
```

### 3.3 Field kinds

| Kind | Semantics | Output shape | Filter UI |
|---|---|---|---|
| `enum` | Value must be one of `values`. Unknown → `"other"` bucket (kept, flagged for promotion). | string, or `["a","b"]` when `multi` | checkboxes (values + "other") |
| `list` | Open vocabulary. LLM emits normalized atomic tags, one per array entry. | string[] (or string when `multi:false`) | auto-detected distinct values + counts, pick any |
| `range` | `{ min, max }`, both optional numbers. `currency`/`period` are metadata labels only. | `{ "min": n, "max": n }` | min/max sliders or inputs |
| `number` | Single number (`contract_length_months`). | number | min/max inputs |
| `date` | ISO date or `"YYYY-MM"`. | string | before/after inputs |

`multi: true` allows multiple tags (domain, languages, skills, licenses). `multi: false` forces one value.

`normalize` is a hint used by the validator to canonicalize open-list tags (`lower`, `canonical-language`, `canonical-license`). It keeps "Cantonese" and "cantonese" from becoming two distinct filter buckets.

### 3.4 Why `list` not `enum` for domain/languages

The user's explicit decision: for high-cardinality fields (domain, industry, languages, skills, licenses) we do **not** enumerate an exhaustive list. Instead the LLM emits the value it sees, and the filter UI auto-detects every distinct value with a count so the user can select any. This is the "excel auto-detect" behavior, and it cannot silently drop a real-world value the way a strict enum would. Strict enums are reserved for the small, controlled sets above.

Because the contract is config-driven, flipping any field between `enum` and `list` is a one-line config edit — no code change.

---

## 4. The extraction run

### 4.1 Prompt generation

- `systemPrompt` from the config is the persona/general preamble (unchanged role).
- The tool **appends** a generated "extraction block" derived from `fields`:

  ```
  Extract the following fields from the job. Only include a field when the
  job description specifies it; omit it otherwise. Never invent values.

  - domain (one or more of the job's functional domains; free text, lowercase)
  - employment_type (exactly one of: full-time, part-time, contract, internship, graduate)
  - salary ({"min": number, "max": number} in HKD monthly, when stated)
  - years_experience ({"min": number, "max": number}, when stated)
  ...

  Respond with ONLY one JSON object and no prose or code fences.
  ```

- The user prompt is the job (same `{title, description, …}` JSON as today, truncated to `descriptionMaxChars`). The instructions textarea is gone.

### 4.2 Output validation & coercion

New `extractContract(content, contract)` replaces `extractScoreReason`:

1. Parse balanced JSON object (reuse the existing fence/balance extraction).
2. For each contract field:
   - absent key → omit (keep absent).
   - `enum`: keep if value ∈ `values` (or any tag ∈ `values` when multi); unknown → move to an `"other"` bucket under that key, and record the raw value in `data.unmatched.<key>` so the user can see what to promote.
   - `list`: split non-array strings on common separators (`/`, `,`, `and`), trim, apply `normalize`, dedupe, drop empties.
   - `range`: coerce `{min,max}`; reject negatives; drop if both missing or non-numeric.
   - `number`/`date`: coerce, drop if invalid.
3. If the result has **zero** recognized fields, store `{ "schemaVersion": n }` only and count the row as **done** (not failed, not re-called). The JD genuinely had nothing extractable (e.g. near-empty/paywalled description) — re-calling the LLM would just burn tokens.

### 4.3 Loop semantics

The per-row loop in `runAnalysis` keeps the existing buckets (`skipped`/`deleted`/`failed`/`analyzed`) but gains a status gate and an incremental-version policy.

**Status gate (new):** only `status === "unapplied"` rows are extracted. `applied` and `uninterested` rows are skipped outright — you never spend tokens re-extracting a job you already applied to or discarded, and their existing extraction (if any) stays filterable. This applies in **both** default and re-analyze modes.

**Incremental versioning (default):** a row is `skipped` when its `analysis` is non-null **regardless of schemaVersion**. Old extractions persist and remain filterable; a new contract version applies only to **new** jobs (`analysis === null`). Stale rows are never silently re-sent to the LLM.

**Opt-in re-analyze (user toggle):** a dashboard **toggle** — off by default — switches the run into re-analyze mode, re-extracting only **non-conforming** rows: those whose `analysis.schemaVersion !== contract.schemaVersion`, including the legacy `{score, reason}` shape (no schemaVersion) and empty `{schemaVersion}` rows from older versions. It does **not** re-run conforming current-schema rows, and it still skips `applied`/`uninterested`. The user flips it on when they want stale rows refreshed, then off again; it is never automatic.

- `failed` = provider error or unparseable output.
- `recommended` is removed (no threshold).

### 4.4 Storage

`setJobAnalysis` stores the extraction JSON as-is:

```jsonc
{ "schemaVersion": 1, "domain": ["finance"], "salary": { "min": 38000, "max": 45000 }, "mandatory_languages": ["english", "cantonese", "mandarin"], "seniority": "manager" }
```

Empty extraction shape: `{ "schemaVersion": 1 }` (no fields) when the JD had nothing extractable.

The `analysis` SQLite column is unchanged (text). No schema migration.

---

## 5. Dashboard — faceted filter

Replaces the score/threshold surface on the Analysis tab.

- **DB selector + "Run extraction"** (was "Run analysis") — no instructions textarea.
- **Re-analyze toggle** — off by default; when on, the run targets non-conforming rows only (§4.3). It is a per-run mode, not a persistent state.
- **Facet bar**: one facet per contract field, generated from the contract:
  - `enum` → checkbox list of `values` (+ "other" when present in data).
  - `list` → auto-detected distinct values with counts, checkboxes.
  - `range`/`number` → min/max inputs.
  - `date` → before/after inputs.
- **Job list**: filters client-side (DBs are ~1–1.3k rows; all extractions + jobs fetched once, filtered in memory, no server round-trip per toggle). Show title/company/location/salary + extracted chips.
- **Filter state** persisted to `localStorage` (per DB key) — restores on reopen. Saved named presets are a future addition, not v1.
- **Unmatched values** (`data.unmatched.<key>`) surface inline as a hint ("3 jobs had 'CPA' → add to licenses enum").
- **"Mark uninterested"** stays as a plain status action (unchanged), but the "Mark below threshold" bulk button is removed.

Dashboard-only for v1: no CLI filtering subcommand (deferred).

---

## 6. Migration

- Existing rows store `{score, reason}` (no `schemaVersion`). They are **left in place** — the score/reason fields are ignored by the new facet UI, and the rows are treated as "non-conforming" so they are eligible for the opt-in re-analyze (§4.3). Nothing re-runs automatically; no information is lost (the full JD remains in the `job` column).
- Legacy `{score, reason}` rows can still be filtered by the fields that *do* carry through (title/company/location/status), just not by extraction facets until re-analyzed.
- `recommendedThreshold`, the instructions field, and `extractScoreReason` are removed from settings/types/prompt/test surfaces.
- `countAnalysis` / dashboard counts drop `recommended`; `analyzed` = rows with non-null `analysis` (any schemaVersion).
- `bulkMarkBelowThreshold` is deleted (no threshold exists).

### 6.1 Analysis cron

The analysis-as-cron path (`kind: "analysis"` cron jobs → spawn `analyze run <dbKey>`) is **unchanged** and inherits everything above automatically, because it goes through the same `runAnalysis` loop: it skips `applied`/`uninterested`, extracts only new `unapplied` jobs under the current contract, and never re-runs conforming rows. The opt-in re-analyze is a dashboard/manual action only — cron never triggers it.

---

## 7. Files touched

- `analysis.config.base.json` — new `schemaVersion` + `fields`.
- `src/types.ts` — `AnalysisSettings`/`AnalysisSettingsPublic` gain `schemaVersion` + `fields`; drop `recommendedThreshold`.
- `src/analysisConfig.ts` — validate/serialize the contract; `toPublicSettings` emits fields for the UI.
- `src/analysisProvider.ts` — replace `extractScoreReason` with `extractContract` (+ helper coercers).
- `src/analysis.ts` — prompt generation, status gate + incremental skip + opt-in re-analyze, drop score/threshold.
- `src/analysisDb.ts` — `listAnalysisRows` selects `status`; `countAnalysis`/`bulkMarkBelowThreshold` updates; `parsedAnalysis` reads the new shape.
- `src/analysisCli.ts` — drop `instructions`; pass contract; logger events rename `analysis.job.analyzed` payload.
- `src/dashboardAnalysis.ts` — serve contract + per-DB extractions for facets.
- `dashboard/views/analysis.js` — faceted filter UI.
- `tests/` — update analysis/analysisConfig/analysisDb tests; new `extractContract` tests.

---

## 8. Testing

- `extractContract`: enum coercion, multi-list splitting + normalize, range coercion, "other" bucketing, empty-result → null, malformed → null.
- Prompt generation: field list present, optionality instruction present, no `recommendedThreshold` references.
- Version skip: non-null `analysis` skipped by default (any schemaVersion); non-conforming rows re-analyzed **only** when the re-analyze toggle is on.
- Dashboard facet rendering + localStorage persistence (existing view-test harness).
