# Analysis — Structured Extraction Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the subjective `{ score, reason }` analysis with a config-driven **extraction contract** — the LLM extracts normalized fields from each job description, stored per-row and surfaced through a client-side faceted filter on the dashboard.

**Architecture:** The contract (`schemaVersion` + `fields[]`) lives in the analysis settings file (shipped as `analysis.config.base.json`). It drives (a) the generated extraction prompt, (b) output coercion/validation via a new `extractContract()`, and (c) the dashboard facet bar. Every field is optional and never fabricated; extraction is gated on `status === "unapplied"`, incremental by default (non-null `analysis` skipped), with an opt-in per-run re-analyze toggle for non-conforming rows. The `analysis` SQLite text column is reused unchanged (no migration).

**Tech Stack:** Node.js ≥ 24, ESM (`"type": "module"`), TypeScript 5.5, Vitest 2.1.9, `node:sqlite` (loaded via `createRequire` + `require("node:sqlite")`), plain-JS dashboard views.

**Spec:** `docs/superpowers/specs/2026-08-26-analysis-extraction-design.md` — this plan argues from the spec; read both.

## Global Constraints

- **Every field is optional:** extract a field only if the JD states it; omit otherwise. Never fabricate. A stored extraction distinguishes *not-specified* (key absent) from *specified-empty* (`[]`/`null`) from *specified-valued*.
- **No score, no threshold, no instructions:** `recommendedThreshold`, `recommended`, `score`, the instructions textarea, `extractScoreReason`, and `bulkMarkBelowThreshold` are all removed. No re-introduction in any UI, prompt, or test.
- **`node:sqlite` load pattern:** `const require = createRequire(import.meta.url); const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");` — never `import ... from "node:sqlite"`. Alias `type DbConnection = InstanceType<typeof DatabaseSync>` if a type position is needed.
- **`JOB_STATUSES = ["unapplied", "applied", "uninterested"]`** (defined in `src/dashboardDb.ts`). Status is stored in `jobs.status`.
- **ESM + Node ≥ 24 + Vitest:** run tests with `vitest run`, typecheck with `tsc --noEmit`, build with `npm run build`. Package is `omijobs` in `omi-job-fetch/`.
- **Incremental versioning is never automatic:** a new `schemaVersion` applies only to new (`analysis IS NULL`) rows; the re-analyze toggle is opt-in, per-run, off by default, and never triggered by cron.
- **Schema version is informational:** `schemaVersion` is an integer on the contract and on every stored extraction; legacy `{score, reason}` rows have no `schemaVersion` and are "non-conforming".
- **Contract is the single source of truth:** flipping a field between `enum`/`list`, adding a value, or bumping `schemaVersion` is a config edit only — no code change.
- **Enum `"other"` bucket + `unmatched`:** unknown enum values are kept under a `"other"` bucket and their raw values recorded in a top-level `unmatched.<key>` array on the extraction.

---

### Task 1: Contract types + config validation

**Files:**
- Modify: `omi-job-fetch/src/types.ts` (add contract types; extend `AnalysisSettings`/`AnalysisSettingsPublic`)
- Modify: `omi-job-fetch/src/analysisConfig.ts` (add `validateField`/`validateContract`; update `validateSettings`/`loadAnalysisSettings`/`toPublicSettings`)
- Modify: `omi-job-fetch/analysis.config.base.json` (new `schemaVersion` + `fields`)
- Test: `omi-job-fetch/tests/analysisConfig.test.ts`

**Interfaces:**
- Produces (used by all later tasks): in `types.ts`:
  - `export type ContractFieldKind = "enum" | "list" | "range" | "number" | "date";`
  - `export type ContractNormalize = "lower" | "canonical-language" | "canonical-license";`
  - `export interface ContractField { key: string; kind: ContractFieldKind; multi?: boolean; normalize?: ContractNormalize; values?: string[]; unit?: string; currency?: string; period?: string; }`
  - `export interface ExtractionContract { schemaVersion: number; fields: ContractField[]; }`
  - `export interface ExtractionResult { schemaVersion: number; unmatched?: Record<string, string[]>; [key: string]: unknown; }`
  - `AnalysisSettings` gains `schemaVersion: number` and `fields: ContractField[]`; drops `recommendedThreshold`.
  - `AnalysisSettingsPublic` gains `schemaVersion: number` and `fields: ContractField[]`; drops `recommendedThreshold`.
- Produces (in `analysisConfig.ts`): `export function validateField(raw: unknown): ContractField`, `export function validateContract(raw: unknown): ExtractionContract`.

- [ ] **Step 1: Write the failing tests**

Append to `omi-job-fetch/tests/analysisConfig.test.ts`:

```ts
import { validateContract, validateField } from "../src/analysisConfig.js";

describe("validateField", () => {
  it("accepts a valid enum and list field", () => {
    expect(validateField({ key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] })).toEqual({ key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] });
    expect(validateField({ key: "skills", kind: "list", multi: true, normalize: "lower" })).toEqual({ key: "skills", kind: "list", multi: true, normalize: "lower" });
  });
  it("rejects bad keys, kinds, and enum-without-values", () => {
    expect(() => validateField({ key: "Bad Key", kind: "list" })).toThrow(/snake_case/);
    expect(() => validateField({ key: "x", kind: "nope" })).toThrow(/invalid kind/);
    expect(() => validateField({ key: "x", kind: "enum" })).toThrow(/values/);
    expect(() => validateField({ key: "x", kind: "list", values: ["a"] })).toThrow(/only allowed on enum/);
  });
});

describe("validateContract", () => {
  it("rejects duplicate field keys and non-positive schemaVersion", () => {
    expect(() => validateContract({ schemaVersion: 0, fields: [] })).toThrow(/positive integer/);
    expect(() => validateContract({ schemaVersion: 1, fields: [{ key: "a", kind: "list" }, { key: "a", kind: "list" }] })).toThrow(/unique/);
  });
  it("round-trips a valid contract", () => {
    const contract = validateContract({ schemaVersion: 2, fields: [{ key: "salary", kind: "range", currency: "HKD", period: "monthly" }] });
    expect(contract.schemaVersion).toBe(2);
    expect(contract.fields[0].currency).toBe("HKD");
  });
});

describe("AnalysisConfig - extraction contract settings", () => {
  it("seeds schemaVersion and fields from the bundled base config", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    expect(settings.schemaVersion).toBe(1);
    expect(settings.fields.length).toBeGreaterThan(0);
    expect(settings.fields.some((f) => f.key === "employment_type")).toBe(true);
    expect(settings).not.toHaveProperty("recommendedThreshold");
  });
  it("exposes schemaVersion and fields publicly", () => {
    const settings = loadAnalysisSettings(pkgDir, stateDir);
    const pub = toPublicSettings(settings);
    expect(pub.schemaVersion).toBe(1);
    expect(pub.fields.length).toBe(settings.fields.length);
    expect(pub).not.toHaveProperty("recommendedThreshold");
  });
});
```

Note: the existing test `"creates default settings when no example or state exists"` asserts `defaultSettings.recommendedThreshold` — replace that line with `expect(defaultSettings.schemaVersion).toBe(1);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/analysisConfig.test.ts`
Expected: FAIL — `validateField`/`validateContract` not exported; `schemaVersion`/`fields` missing; `recommendedThreshold` assertions fail.

- [ ] **Step 3: Write the minimal implementation**

In `omi-job-fetch/src/types.ts`, add the contract types and update the settings interfaces (exact text):

```ts
/** Structured extraction contract types (see analysisConfig.ts). */
export type ContractFieldKind = "enum" | "list" | "range" | "number" | "date";
export type ContractNormalize = "lower" | "canonical-language" | "canonical-license";

export interface ContractField {
  key: string;
  kind: ContractFieldKind;
  multi?: boolean;               // enum/list: allow multiple tags (default false)
  normalize?: ContractNormalize; // list only
  values?: string[];             // enum only
  unit?: string;                 // range metadata label (e.g. "years")
  currency?: string;             // range metadata label (e.g. "HKD")
  period?: string;               // range metadata label (e.g. "monthly")
}

export interface ExtractionContract {
  schemaVersion: number;
  fields: ContractField[];
}

export interface ExtractionResult {
  schemaVersion: number;
  /** Raw enum values that fell outside `values`, keyed by field key. */
  unmatched?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface AnalysisSettings {
  schemaVersion: number;
  systemPrompt: string;
  descriptionMaxChars: number;
  enabledProvider: string | null;
  providers: AnalysisProviderConfig[];
  fields: ContractField[];
}

export interface AnalysisSettingsPublic {
  schemaVersion: number;
  systemPrompt: string;
  descriptionMaxChars: number;
  enabledProvider: string | null;
  providers: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    retries: number;
    retryBackoffMs: number;
    apiKeyStatus: "set" | "unset";
  }[];
  fields: ContractField[];
}
```

In `omi-job-fetch/src/analysisConfig.ts`, add imports, validators, and update the three functions:

```ts
import type { AnalysisProviderConfig, AnalysisSettings, AnalysisSettingsPublic, ContractField, ContractFieldKind, ContractNormalize, ExtractionContract } from "./types.js";

const FIELD_KINDS: ContractFieldKind[] = ["enum", "list", "range", "number", "date"];
const NORMALIZERS: ContractNormalize[] = ["lower", "canonical-language", "canonical-license"];

export function validateField(raw: unknown): ContractField {
  if (typeof raw !== "object" || raw === null) throw new Error("field must be an object");
  const f = raw as Record<string, unknown>;
  if (typeof f.key !== "string" || !/^[a-z][a-z0-9_]*$/.test(f.key)) throw new Error(`field.key must be a snake_case string`);
  if (typeof f.kind !== "string" || !(FIELD_KINDS as string[]).includes(f.kind)) throw new Error(`field "${f.key}" has invalid kind`);
  const kind = f.kind as ContractFieldKind;
  if (f.multi !== undefined && typeof f.multi !== "boolean") throw new Error(`field "${f.key}" multi must be a boolean`);
  if (f.normalize !== undefined && (typeof f.normalize !== "string" || !(NORMALIZERS as string[]).includes(f.normalize))) throw new Error(`field "${f.key}" normalize is invalid`);
  const out: ContractField = { key: f.key as string, kind, multi: f.multi === true };
  if (f.normalize !== undefined) out.normalize = f.normalize as ContractNormalize;
  if (kind === "enum") {
    if (!Array.isArray(f.values) || f.values.length === 0 || !f.values.every((v) => typeof v === "string" && v.trim() !== "")) throw new Error(`field "${f.key}" enum requires a non-empty values[] array`);
    out.values = (f.values as string[]).map((v) => v.trim());
  } else if (f.values !== undefined) {
    throw new Error(`field "${f.key}" values is only allowed on enum fields`);
  }
  if (kind === "range") {
    if (f.unit !== undefined) out.unit = String(f.unit);
    if (f.currency !== undefined) out.currency = String(f.currency);
    if (f.period !== undefined) out.period = String(f.period);
  }
  return out;
}

export function validateContract(raw: unknown): ExtractionContract {
  if (typeof raw !== "object" || raw === null) throw new Error("contract must be an object");
  const c = raw as Record<string, unknown>;
  if (!Number.isInteger(c.schemaVersion) || (c.schemaVersion as number) < 1) throw new Error("schemaVersion must be a positive integer");
  if (!Array.isArray(c.fields)) throw new Error("fields must be an array");
  const fields = c.fields.map(validateField);
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new Error("field keys must be unique");
  return { schemaVersion: c.schemaVersion as number, fields };
}
```

Replace the body of `validateSettings` (drop the `recommendedThreshold` check, add `schemaVersion` + `fields`):

```ts
export function validateSettings(raw: unknown): AnalysisSettings {
  if (typeof raw !== "object" || raw === null) throw new Error("analysis settings must be an object");
  const settings = raw as Record<string, unknown>;
  if (typeof settings.systemPrompt !== "string" || settings.systemPrompt.trim() === "") throw new Error("systemPrompt is required");
  if (!isFiniteNumber(settings.descriptionMaxChars) || !Number.isInteger(settings.descriptionMaxChars) || settings.descriptionMaxChars < 1 || settings.descriptionMaxChars > 100_000) throw new Error("descriptionMaxChars must be a positive integer");
  if (settings.enabledProvider !== null && settings.enabledProvider !== undefined && typeof settings.enabledProvider !== "string") throw new Error("enabledProvider must be a provider id or null");
  if (!Array.isArray(settings.providers)) throw new Error("providers must be an array");
  const providers = settings.providers.map(validateProvider);
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error("provider ids must be unique");
  const enabledProvider = settings.enabledProvider === undefined ? null : settings.enabledProvider as string | null;
  if (enabledProvider !== null && !providers.some((provider) => provider.id === enabledProvider)) throw new Error(`enabled provider "${enabledProvider}" does not exist`);
  const contract = validateContract({ schemaVersion: settings.schemaVersion, fields: settings.fields });
  return { schemaVersion: contract.schemaVersion, systemPrompt: settings.systemPrompt, descriptionMaxChars: settings.descriptionMaxChars, enabledProvider, providers, fields: contract.fields };
}
```

Update the hardcoded fallback in `loadAnalysisSettings`:

```ts
const settings = existsSync(basePath) ? validateSettings(JSON.parse(readFileSync(basePath, "utf8"))) : validateSettings({ schemaVersion: 1, systemPrompt: "You are a job-description extractor.", descriptionMaxChars: 4000, enabledProvider: null, providers: [], fields: [] });
```

Add `schemaVersion` + `fields` to `toPublicSettings` (drop `recommendedThreshold`):

```ts
export function toPublicSettings(settings: AnalysisSettings, stateDir = ""): AnalysisSettingsPublic {
  return {
    schemaVersion: settings.schemaVersion,
    systemPrompt: settings.systemPrompt,
    descriptionMaxChars: settings.descriptionMaxChars,
    enabledProvider: settings.enabledProvider,
    fields: settings.fields,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKeyEnv: provider.apiKeyEnv,
      temperature: provider.temperature,
      maxTokens: provider.maxTokens,
      timeoutMs: provider.timeoutMs,
      retries: provider.retries,
      retryBackoffMs: provider.retryBackoffMs,
      apiKeyStatus: providerApiKeyStatus(provider, stateDir),
    })),
  };
}
```

Replace `omi-job-fetch/analysis.config.base.json` with:

```json
{
  "schemaVersion": 1,
  "systemPrompt": "You are a job-description extractor. Read the job posting and output ONLY the fields that are explicitly stated, as a single JSON object. Never invent or assume a value; when a field is not specified in the posting, omit it entirely.",
  "descriptionMaxChars": 4000,
  "enabledProvider": null,
  "providers": [
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "openrouter/auto",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "temperature": 0.2,
      "maxTokens": 400,
      "timeoutMs": 60000,
      "retries": 3,
      "retryBackoffMs": 2000
    }
  ],
  "fields": [
    { "key": "domain", "kind": "list", "multi": true, "normalize": "lower" },
    { "key": "industry", "kind": "list", "multi": true, "normalize": "lower" },
    { "key": "mandatory_languages", "kind": "list", "multi": true, "normalize": "canonical-language" },
    { "key": "preferred_languages", "kind": "list", "multi": true, "normalize": "canonical-language" },
    { "key": "skills", "kind": "list", "multi": true, "normalize": "lower" },
    { "key": "licenses", "kind": "list", "multi": true, "normalize": "canonical-license" },
    { "key": "education", "kind": "enum", "multi": false, "values": ["phd", "masters", "bachelors-y1", "bachelors-y2", "bachelors-y3", "bachelors-y4", "diploma", "secondary"] },
    { "key": "employment_type", "kind": "enum", "multi": false, "values": ["full-time", "part-time", "contract", "internship", "graduate"] },
    { "key": "job_duration", "kind": "enum", "multi": false, "values": ["permanent", "fixed-term"] },
    { "key": "seniority", "kind": "enum", "multi": false, "values": ["intern", "graduate", "assistant", "officer", "associate", "manager", "senior-manager", "director", "vp", "head"] },
    { "key": "work_arrangement", "kind": "enum", "multi": false, "values": ["onsite", "hybrid", "remote"] },
    { "key": "years_experience", "kind": "range", "unit": "years" },
    { "key": "contract_length_months", "kind": "number" },
    { "key": "salary", "kind": "range", "currency": "HKD", "period": "monthly" },
    { "key": "job_start_date", "kind": "date" }
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/analysisConfig.test.ts`
Expected: PASS. Also run `npx tsc --noEmit` — expect failures in *other* files still referencing `recommendedThreshold`/`extractScoreReason` (resolved in later tasks); this is expected mid-plan.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/types.ts omi-job-fetch/src/analysisConfig.ts omi-job-fetch/analysis.config.base.json omi-job-fetch/tests/analysisConfig.test.ts
git commit -m "feat: add extraction contract schema and validation"
```

---

### Task 2: `extractContract` coercion

**Files:**
- Modify: `omi-job-fetch/src/analysisProvider.ts` (remove `ScoreReason`/`extractScoreReason`; add `extractContract` + coercers)
- Test: `omi-job-fetch/tests/analysisProvider.test.ts`

**Interfaces:**
- Consumes: `ExtractionContract`, `ExtractionResult`, `ContractField`, `ContractNormalize` from `types.ts`.
- Produces: `export function extractContract(content: unknown, contract: ExtractionContract): ExtractionResult | null` — returns `null` only for unparseable output (failed); returns `{ schemaVersion }` (possibly empty) for parseable-but-zero-fields (done).

- [ ] **Step 1: Write the failing tests**

Replace the `extractScoreReason` describe block in `omi-job-fetch/tests/analysisProvider.test.ts` with:

```ts
import { extractContract } from "../src/analysisProvider.js";
import type { ExtractionContract } from "../src/types.js";

const contract: ExtractionContract = {
  schemaVersion: 1,
  fields: [
    { key: "employment_type", kind: "enum", multi: false, values: ["full-time", "part-time", "contract"] },
    { key: "skills", kind: "list", multi: true, normalize: "lower" },
    { key: "salary", kind: "range", currency: "HKD", period: "monthly" },
    { key: "years_experience", kind: "range", unit: "years" },
    { key: "job_start_date", kind: "date" },
  ],
};

describe("extractContract", () => {
  it("coerces enum, list, range, and date; omits absent fields", () => {
    const result = extractContract('```json\n{"employment_type":"Full-Time","skills":"SQL, Excel and Python","salary":{"min":"38000","max":45000},"job_start_date":"2026-09-01"}\n```', contract);
    expect(result).toEqual({ schemaVersion: 1, employment_type: "full-time", skills: ["sql", "excel", "python"], salary: { min: 38000, max: 45000 }, job_start_date: "2026-09-01" });
  });
  it("buckets unknown enum values to other and records unmatched", () => {
    const result = extractContract('{"employment_type":"freelance"}', contract);
    expect(result).toEqual({ schemaVersion: 1, employment_type: "other", unmatched: { employment_type: ["freelance"] } });
  });
  it("returns schemaVersion-only for zero recognized fields (done, not failed)", () => {
    expect(extractContract('{"nothing":"here"}', contract)).toEqual({ schemaVersion: 1 });
    expect(extractContract('{}', contract)).toEqual({ schemaVersion: 1 });
  });
  it("returns null for malformed output", () => {
    expect(extractContract("no json", contract)).toBeNull();
    expect(extractContract(123 as unknown, contract)).toBeNull();
  });
  it("drops invalid range values and non-ISO dates", () => {
    expect(extractContract('{"salary":{"min":-5,"max":10},"job_start_date":"not-a-date"}', contract)).toEqual({ schemaVersion: 1, salary: { max: 10 } });
  });
});
```

Also remove the `extractScoreReason` import from the top of the test file (keep `callProvider`, `AuthConfigError`, `TransientProviderError`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/analysisProvider.test.ts`
Expected: FAIL — `extractContract` not exported.

- [ ] **Step 3: Write the minimal implementation**

In `omi-job-fetch/src/analysisProvider.ts`, replace the `ScoreReason` interface + `extractScoreReason` function with (keep `balancedObject` and `callProvider` unchanged):

```ts
import type { AnalysisProviderConfig, ContractField, ContractNormalize, ExtractionContract, ExtractionResult } from "./types.js";

function normalizeTag(value: string, normalize?: ContractNormalize): string {
  const trimmed = value.trim();
  // v1: all three normalizers share lowercasing (alias tables are a future extension).
  if (normalize === "lower" || normalize === "canonical-language" || normalize === "canonical-license") return trimmed.toLowerCase();
  return trimmed;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function coerceEnum(raw: unknown, field: ContractField, unmatched: Record<string, string[]>): unknown {
  const values = field.values ?? [];
  const tags = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const chosen: string[] = [];
  for (const tag of tags) {
    const t = tag.trim();
    if (!t) continue;
    if (values.includes(t)) chosen.push(t);
    else { chosen.push("other"); unmatched[field.key] = [...(unmatched[field.key] ?? []), t]; }
  }
  if (chosen.length === 0) return undefined;
  return field.multi ? [...new Set(chosen)] : chosen[0];
}

function coerceList(raw: unknown, field: ContractField): unknown {
  if (!field.multi) {
    const single = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw);
    const t = normalizeTag(single, field.normalize);
    return t ? t : undefined;
  }
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[/,;]|\s+and\s+/i);
  const tags: string[] = [];
  for (const part of parts) {
    const t = normalizeTag(String(part), field.normalize);
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags.length ? tags : undefined;
}

function coerceRange(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const min = toNumber(obj.min);
  const max = toNumber(obj.max);
  if (min === null && max === null) return undefined;
  if (min !== null && min < 0) return undefined;
  if (max !== null && max < 0) return undefined;
  const out: Record<string, number> = {};
  if (min !== null) out.min = min;
  if (max !== null) out.max = max;
  return out;
}

function coerceNumber(raw: unknown): unknown {
  const n = toNumber(raw);
  return n === null ? undefined : n;
}

function coerceDate(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(t)) return t;
  const d = Date.parse(t);
  return Number.isNaN(d) ? undefined : new Date(d).toISOString().slice(0, 10);
}

export function extractContract(content: unknown, contract: ExtractionContract): ExtractionResult | null {
  if (typeof content !== "string") return null;
  const object = balancedObject(content.replace(/```(?:json)?/gi, ""));
  if (!object) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(object) as Record<string, unknown>; } catch { return null; }
  const result: ExtractionResult = { schemaVersion: contract.schemaVersion };
  const unmatched: Record<string, string[]> = {};
  for (const field of contract.fields) {
    const raw = parsed[field.key];
    if (raw === undefined) continue;
    const value = coerceField(raw, field, unmatched);
    if (value !== undefined) result[field.key] = value;
  }
  if (Object.keys(unmatched).length > 0) result.unmatched = unmatched;
  return result;
}

function coerceField(raw: unknown, field: ContractField, unmatched: Record<string, string[]>): unknown {
  switch (field.kind) {
    case "enum": return coerceEnum(raw, field, unmatched);
    case "list": return coerceList(raw, field);
    case "range": return coerceRange(raw);
    case "number": return coerceNumber(raw);
    case "date": return coerceDate(raw);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/analysisProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/analysisProvider.ts omi-job-fetch/tests/analysisProvider.test.ts
git commit -m "feat: replace score extraction with contract coercion"
```

---

### Task 3: analysisDb row shape + counts

**Files:**
- Modify: `omi-job-fetch/src/analysisDb.ts`
- Test: `omi-job-fetch/tests/analysisDb.test.ts`

**Interfaces:**
- Consumes: `ExtractionResult` from `types.ts`.
- Produces:
  - `export interface AnalysisRow { signature: string; postedAt: string | null; status: string; analysis: string | null; job: Record<string, unknown>; }`
  - `export interface AnalysisCounts { total: number; analyzed: number; pending: number; }`
  - `export function listAnalysisRows(file: string): AnalysisRow[]` (now selects `status`, returns raw `analysis` text)
  - `export function setJobAnalysis(file: string, signature: string, result: ExtractionResult): void`
  - `export function parsedAnalysis(raw: unknown): ExtractionResult | null`
  - `export function conformingVersion(raw: unknown, version: number): boolean`
  - `export function countAnalysis(file: string): AnalysisCounts` (drops `threshold`/`recommended`)
  - Removed: `bulkMarkBelowThreshold`.

- [ ] **Step 1: Write the failing tests**

Replace `omi-job-fetch/tests/analysisDb.test.ts` imports + tests (keep the `fixture()` helper, update its seed rows to add `status` variety and an extraction row):

```ts
import { conformingVersion, countAnalysis, deleteJobRow, listAnalysisRows, parsedAnalysis, setJobAnalysis } from "../src/analysisDb.js";

describe("analysisDb", () => {
  it("lists rows with status and raw analysis text", async () => {
    const { dir, file } = await fixture();
    try {
      const rows = listAnalysisRows(file);
      expect(rows.map((r) => r.signature)).toEqual(["high", "low", "bad"]);
      expect(rows[0].status).toBe("applied");
      expect(rows[1].analysis).toBe(JSON.stringify({ score: 2, reason: "poor" }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("stores an extraction and parses it back, conforming only on version match", async () => {
    const { dir, file } = await fixture();
    try {
      setJobAnalysis(file, "high", { schemaVersion: 1, domain: ["finance"] });
      const db = new DatabaseSync(file);
      const raw = (db.prepare("SELECT analysis FROM jobs WHERE signature = ?").get("high") as Record<string, unknown>).analysis;
      db.close();
      expect(parsedAnalysis(raw)).toEqual({ schemaVersion: 1, domain: ["finance"] });
      expect(conformingVersion(raw, 1)).toBe(true);
      expect(conformingVersion(raw, 2)).toBe(false);
      expect(conformingVersion(JSON.stringify({ score: 2, reason: "poor" }), 1)).toBe(false); // legacy
      expect(parsedAnalysis("not json")).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("counts analyzed vs pending without a threshold", async () => {
    const { dir, file } = await fixture();
    try {
      expect(countAnalysis(file)).toEqual({ total: 3, analyzed: 1, pending: 2 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("lists newest rows and deletes by signature", async () => {
    const { dir, file } = await fixture();
    try { expect(listAnalysisRows(file).map((row) => row.signature)).toEqual(["high", "low", "bad"]); expect(deleteJobRow(file, "bad")).toBe(true); expect(deleteJobRow(file, "missing")).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

Update the `fixture()` seed so `high` has `analysis` null and status `applied`, `low` has `{score:2,reason:"poor"}` and status `applied`, `bad` has `"not json"` and status `unapplied` — the `analyzed` count above assumes only `low` has parseable analysis (legacy `{score,reason}` is NOT parseable under `parsedAnalysis` because it lacks `schemaVersion`). Adjust `fixture()` accordingly:

```ts
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-db-"));
  const file = join(dir, "jobs.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("high", "2026-08-20", JSON.stringify({ title: "High" }), "applied", null, "created", "old");
  insert.run("low", "2026-08-19", JSON.stringify({ title: "Low" }), "applied", JSON.stringify({ score: 2, reason: "poor" }), "created", "old");
  insert.run("bad", "2026-08-18", JSON.stringify({ title: "Bad" }), "unapplied", "not json", "created", "old");
  db.close();
  return { dir, file };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/analysisDb.test.ts`
Expected: FAIL — `conformingVersion`/`parsedAnalysis` not exported; `countAnalysis` signature changed; `listAnalysisRows` lacks `status`.

- [ ] **Step 3: Write the minimal implementation**

Rewrite `omi-job-fetch/src/analysisDb.ts` (keep `open`, `parseJob`, `deleteJobRow`):

```ts
import { createRequire } from "node:module";
import type { ExtractionResult } from "./types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Row = Record<string, unknown>;

function open(file: string): { db: InstanceType<typeof DatabaseSync>; close: () => void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, close: () => db.close() };
}
function parseJob(raw: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(raw ?? "{}")); return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

export interface AnalysisRow { signature: string; postedAt: string | null; status: string; analysis: string | null; job: Record<string, unknown>; }
export interface AnalysisCounts { total: number; analyzed: number; pending: number; }

export function listAnalysisRows(file: string): AnalysisRow[] {
  const { db, close } = open(file);
  try {
    return (db.prepare("SELECT signature, posted_at, status, analysis, job FROM jobs ORDER BY posted_at DESC").all() as Row[]).map((row) => ({
      signature: String(row.signature),
      postedAt: row.posted_at == null ? null : String(row.posted_at),
      status: String(row.status),
      analysis: row.analysis == null ? null : String(row.analysis),
      job: parseJob(row.job),
    }));
  } finally { close(); }
}

export function parsedAnalysis(raw: unknown): ExtractionResult | null {
  if (raw === null || raw === undefined) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return null; }
  if (typeof obj !== "object" || obj === null || typeof obj.schemaVersion !== "number") return null;
  return obj as unknown as ExtractionResult;
}

export function conformingVersion(raw: unknown, version: number): boolean {
  const parsed = parsedAnalysis(raw);
  return parsed !== null && parsed.schemaVersion === version;
}

export function setJobAnalysis(file: string, signature: string, result: ExtractionResult): void {
  if (!Number.isInteger(result.schemaVersion) || result.schemaVersion < 1) throw new Error("invalid extraction result");
  const { db, close } = open(file);
  try { db.prepare("UPDATE jobs SET analysis = ?, updated_at = ? WHERE signature = ?").run(JSON.stringify(result), new Date().toISOString(), signature); }
  finally { close(); }
}

export function deleteJobRow(file: string, signature: string): boolean {
  const { db, close } = open(file);
  try { return Number(db.prepare("DELETE FROM jobs WHERE signature = ?").run(signature).changes) > 0; }
  finally { close(); }
}

export function countAnalysis(file: string): AnalysisCounts {
  const rows = listAnalysisRows(file);
  const analyzed = rows.filter((row) => parsedAnalysis(row.analysis) !== null).length;
  return { total: rows.length, analyzed, pending: rows.length - analyzed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/analysisDb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/analysisDb.ts omi-job-fetch/tests/analysisDb.test.ts
git commit -m "feat: store extractions and drop score counts in analysis db"
```

---

### Task 4: runAnalysis loop — prompt, status gate, incremental skip, re-analyze

**Files:**
- Modify: `omi-job-fetch/src/analysis.ts`
- Test: `omi-job-fetch/tests/analysis.test.ts`

**Interfaces:**
- Consumes: `extractContract` (Task 2), `listAnalysisRows`/`setJobAnalysis`/`conformingVersion`/`deleteJobRow` (Task 3), `ExtractionContract`/`ExtractionResult`/`AnalysisProviderConfig`.
- Produces:
  - `export function extractionBlock(contract: ExtractionContract): string`
  - `export interface AnalysisOptions { file: string; systemPrompt: string; descriptionMaxChars: number; retentionDays: number; contract: ExtractionContract; provider: AnalysisProviderConfig; now?: () => Date; aborted?: () => boolean; callProvider: (messages: ChatMessage[]) => Promise<string>; progress?: { line: (text: string) => void; result: (text: string) => void }; logger?: Logger; reanalyze?: boolean; }`
  - `export interface AnalysisSummary { startedAt: string; finishedAt: string; outcome: "completed" | "stopped" | "error"; error: string | null; total: number; analyzed: number; skipped: number; failed: number; deleted: number; provider: string; model: string; }` (drops `recommended` + `instructions`)

- [ ] **Step 1: Write the failing tests**

Rewrite `omi-job-fetch/tests/analysis.test.ts` to drive the new loop semantics. Update the `fixture()` rows: add a `done` (applied, already-extracted) row and a `legacy` (unapplied, `{score,reason}`) row:

```ts
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractionBlock, runAnalysis } from "../src/analysis.js";
import { AuthConfigError } from "../src/analysisProvider.js";
import { createLogger, queryLogs } from "../src/logger.js";
import type { AnalysisProviderConfig, ExtractionContract } from "../src/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const provider: AnalysisProviderConfig = { id: "test", name: "Test", baseUrl: "https://example.test", model: "model", apiKeyEnv: "KEY", temperature: 0.2, maxTokens: 10, timeoutMs: 1000, retries: 0, retryBackoffMs: 1 };
const contract: ExtractionContract = { schemaVersion: 1, fields: [{ key: "domain", kind: "list", multi: true, normalize: "lower" }, { key: "employment_type", kind: "enum", multi: false, values: ["full-time", "contract"] }] };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "analysis-loop-")); const file = join(dir, "jobs.db"); const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs (signature TEXT PRIMARY KEY, posted_at TEXT, job TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unapplied', analysis TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const add = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("new", "2026-08-20", JSON.stringify({ title: "New", description: "long description" }), "unapplied", null, "c", "u");
  add.run("old", "2020-01-01", JSON.stringify({ title: "Old" }), "unapplied", null, "c", "u");
  add.run("done", "2026-08-19", JSON.stringify({ title: "Done" }), "unapplied", JSON.stringify({ schemaVersion: 1, domain: ["finance"] }), "c", "u");
  add.run("legacy", "2026-08-18", JSON.stringify({ title: "Legacy" }), "unapplied", JSON.stringify({ score: 9, reason: "old" }), "c", "u");
  add.run("applied", "2026-08-17", JSON.stringify({ title: "Applied" }), "applied", null, "c", "u");
  add.run("bad", "2026-08-16", JSON.stringify({ title: "Bad" }), "unapplied", null, "c", "u");
  db.close(); return { dir, file };
}
const base = (file: string, callProvider: (messages: any[]) => Promise<string>, aborted?: () => boolean) => ({ file, systemPrompt: "extract", descriptionMaxChars: 5, retentionDays: 30, contract, provider, callProvider, now: () => new Date("2026-08-21"), aborted });

describe("extractionBlock", () => {
  it("lists fields, optionality, and no threshold references", () => {
    const block = extractionBlock(contract);
    expect(block).toContain("domain");
    expect(block).toContain("employment_type");
    expect(block).toContain("Only include a field when the job description specifies it");
    expect(block).not.toContain("score");
    expect(block).not.toContain("threshold");
  });
});

describe("runAnalysis", () => {
  it("extracts only unapplied rows, skips analyzed/status rows by default", async () => {
    const { dir, file } = await fixture(); const lines: string[] = [];
    try {
      const summary = await runAnalysis({ ...base(file, async () => JSON.stringify({ domain: ["tech"] })), progress: { line: (l) => lines.push(l), result: (l) => lines.push(`result:${l}`) } });
      expect(summary).toMatchObject({ outcome: "completed", analyzed: 2, skipped: 3, deleted: 1, failed: 0 });
      expect(summary).not.toHaveProperty("recommended");
      expect(lines.at(-1)).toContain("analyzed 2");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("re-analyzes only non-conforming rows when the toggle is on", async () => {
    const { dir, file } = await fixture();
    try {
      let calls = 0;
      const summary = await runAnalysis({ ...base(file, async () => { calls++; return JSON.stringify({ domain: ["tech"] }); }), reanalyze: true });
      expect(summary.analyzed).toBe(3); // new + legacy + bad (done is conforming → skipped)
      expect(calls).toBe(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("stops between rows and aborts on auth/config errors", async () => {
    const first = await fixture();
    try {
      let calls = 0;
      const summary = await runAnalysis(base(first.file, async () => { calls++; return JSON.stringify({ domain: ["tech"] }); }, () => calls > 0));
      expect(summary.outcome).toBe("stopped");
    } finally { await rm(first.dir, { recursive: true, force: true }); }
  });
  it("emits per-job analysis events and an aborting provider.fail", async () => {
    const { dir, file } = await fixture();
    const logDir = join(dir, "logs");
    const logger = createLogger({ source: "analysis", runId: "a1", jobId: "base" }, logDir);
    try {
      await runAnalysis({ ...base(file, async () => { throw new AuthConfigError("401", 401); }), logger });
      const { events } = queryLogs({ source: "analysis" }, logDir);
      expect(events.some((e) => e.event === "analysis.started")).toBe(true);
      expect(events.some((e) => e.event === "analysis.provider.fail")).toBe(true);
      expect(events.some((e) => e.event === "analysis.error")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/analysis.test.ts`
Expected: FAIL — `extractionBlock` not exported; `AnalysisOptions`/`AnalysisSummary` changed.

- [ ] **Step 3: Write the minimal implementation**

Rewrite `omi-job-fetch/src/analysis.ts`:

```ts
import { AuthConfigError, extractContract, type ChatMessage } from "./analysisProvider.js";
import { conformingVersion, deleteJobRow, listAnalysisRows, setJobAnalysis } from "./analysisDb.js";
import { errorData, type Logger } from "./logger.js";
import type { AnalysisProviderConfig, ContractField, ExtractionContract } from "./types.js";

export interface AnalysisSummary {
  startedAt: string;
  finishedAt: string;
  outcome: "completed" | "stopped" | "error";
  error: string | null;
  total: number;
  analyzed: number;
  skipped: number;
  failed: number;
  deleted: number;
  provider: string;
  model: string;
}
export interface AnalysisOptions {
  file: string;
  systemPrompt: string;
  descriptionMaxChars: number;
  retentionDays: number;
  contract: ExtractionContract;
  provider: AnalysisProviderConfig;
  now?: () => Date;
  aborted?: () => boolean;
  reanalyze?: boolean;
  callProvider: (messages: ChatMessage[]) => Promise<string>;
  progress?: { line: (text: string) => void; result: (text: string) => void };
  logger?: Logger;
}

function fieldDescription(field: ContractField): string {
  switch (field.kind) {
    case "enum": {
      const list = (field.values ?? []).join(", ");
      return field.multi ? `one or more of: ${list}` : `exactly one of: ${list}`;
    }
    case "list": {
      const lower = field.normalize === "lower" || field.normalize === "canonical-language" || field.normalize === "canonical-license" ? "lowercase " : "";
      return `one or more ${lower}values; free text`;
    }
    case "range": {
      const currency = field.currency ? ` in ${field.currency}` : "";
      const period = field.period ? ` ${field.period}` : "";
      const unit = field.unit ? ` (${field.unit})` : "";
      return `{"min": number, "max": number}${currency}${period}${unit}, when stated`;
    }
    case "number": return "number, when stated";
    case "date": return 'ISO date or "YYYY-MM", when stated';
  }
}

export function extractionBlock(contract: ExtractionContract): string {
  const lines = contract.fields.map((field) => `- ${field.key} (${fieldDescription(field)})`);
  return [
    "Extract the following fields from the job. Only include a field when the job description specifies it; omit it otherwise. Never invent values.",
    ...lines,
    "Respond with ONLY one JSON object and no prose or code fences.",
  ].join("\n");
}

function userPrompt(job: Record<string, unknown>, maxChars: number): string {
  const copy = { ...job, description: typeof job.description === "string" ? job.description.slice(0, maxChars) : job.description };
  return `--- JOB ---\n${JSON.stringify(copy)}`;
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisSummary> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const rows = listAnalysisRows(options.file);
  const summary: AnalysisSummary = { startedAt, finishedAt: startedAt, outcome: "completed", error: null, total: rows.length, analyzed: 0, skipped: 0, failed: 0, deleted: 0, provider: options.provider.id, model: options.provider.model };
  const cutoff = options.retentionDays > 0 ? clock().getTime() - options.retentionDays * 86_400_000 : null;
  const progress = () => options.progress?.line(`${summary.analyzed}/${summary.total} jobs analyzed`);
  const logger = options.logger;
  logger?.info("analysis.started", "analysis started", { file: options.file, provider: options.provider.id, model: options.provider.model, total: rows.length });
  try {
    for (const row of rows) {
      if (options.aborted?.()) { summary.outcome = "stopped"; logger?.warn("analysis.stopped", "stopped"); break; }
      if (row.status !== "unapplied") { summary.skipped++; logger?.debug("analysis.job.skipped", "row not unapplied", { signature: row.signature, status: row.status }); progress(); continue; }
      if (row.analysis !== null) {
        if (!options.reanalyze || conformingVersion(row.analysis, options.contract.schemaVersion)) { summary.skipped++; logger?.debug("analysis.job.skipped", "row already extracted", { signature: row.signature }); progress(); continue; }
      }
      if (cutoff !== null && row.postedAt && !Number.isNaN(Date.parse(row.postedAt)) && Date.parse(row.postedAt) < cutoff) {
        if (deleteJobRow(options.file, row.signature)) { summary.deleted++; logger?.debug("analysis.job.deleted", "row deleted by retention", { signature: row.signature }); }
        progress();
        continue;
      }
      logger?.debug("analysis.job.evaluating", "calling provider", { signature: row.signature });
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: `${options.systemPrompt}\n\n${extractionBlock(options.contract)}` },
          { role: "user", content: userPrompt(row.job, options.descriptionMaxChars) },
        ];
        const result = extractContract(await options.callProvider(messages), options.contract);
        if (!result) { summary.failed++; logger?.warn("analysis.job.failed", "unparseable extraction", { signature: row.signature }); progress(); continue; }
        setJobAnalysis(options.file, row.signature, result);
        summary.analyzed++;
        const fieldCount = Object.keys(result).filter((k) => k !== "schemaVersion" && k !== "unmatched").length;
        logger?.info("analysis.job.analyzed", `extracted ${fieldCount} fields`, { signature: row.signature, schemaVersion: result.schemaVersion });
        progress();
      } catch (error) {
        if (error instanceof AuthConfigError) {
          summary.outcome = "error"; summary.error = error.message;
          logger?.error("analysis.provider.fail", "auth/config error — aborting", errorData(error));
          break;
        }
        summary.failed++;
        logger?.warn("analysis.job.failed", "provider failed", { signature: row.signature, ...errorData(error) });
        progress();
      }
    }
  } finally {
    summary.finishedAt = clock().toISOString();
    if (summary.outcome === "error") logger?.error("analysis.error", "analysis errored", { error: summary.error });
    else if (summary.outcome === "stopped") logger?.warn("analysis.finished", "analysis stopped", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted });
    else logger?.info("analysis.finished", "analysis completed", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted });
    options.progress?.result(`analyzed ${summary.analyzed}, skipped ${summary.skipped}, failed ${summary.failed}, deleted ${summary.deleted}`);
  }
  return summary;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/analysis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/analysis.ts omi-job-fetch/tests/analysis.test.ts
git commit -m "feat: contract-driven extraction loop with status gate and re-analyze"
```

---

### Task 5: CLI wiring — drop instructions/threshold, add reanalyze

**Files:**
- Modify: `omi-job-fetch/src/analysisCli.ts`

**Interfaces:**
- Consumes: `runAnalysis` new `AnalysisOptions` (Task 4), `AnalysisSettings` now with `schemaVersion`/`fields` (Task 1).
- Produces: `AnalysisCliOptions { packageDir?: string; stateDir?: string; reanalyze?: boolean; }` (drops `instructions`); `runAnalyzeCommand` parses a boolean `--reanalyze` flag and drops `--instructions` parsing.

- [ ] **Step 1: Confirm the type change is flagged**

`tests/cli.test.ts` does not exercise the analyze command, so there is no CLI unit test to add here. The `AnalysisCliOptions` change is enforced by the compiler: removing `instructions` makes any existing `instructions`-typed call site a type error. Run the typecheck to surface them:

Run: `cd omi-job-fetch; npx tsc --noEmit`
Expected: FAIL with errors pointing at `instructions`/`recommendedThreshold` usages in `analysisCli.ts` (and the still-pending `dashboardAnalysis.ts`/`dashboardServer.ts` from later tasks — those are expected mid-plan and resolved in Task 7).

- [ ] **Step 2: Write the minimal implementation**

In `omi-job-fetch/src/analysisCli.ts`:

1. Change the options interface:

```ts
export interface AnalysisCliOptions { packageDir?: string; stateDir?: string; reanalyze?: boolean; }
```

2. In `runAnalysisCommand`, drop `instructions` and `threshold`, pass `contract` + `reanalyze`:

```ts
const summary = await runAnalysis({
  file: dbPath, systemPrompt: settings.systemPrompt, descriptionMaxChars: settings.descriptionMaxChars,
  retentionDays: resolveBaseRetention(stateDir) ?? 30, contract: { schemaVersion: settings.schemaVersion, fields: settings.fields },
  reanalyze: options.reanalyze ?? false, provider,
  callProvider: (messages) => callProvider(provider, apiKey, messages, fetch, undefined, logger),
  aborted: () => existsSync(state.stop(dbKey)),
  logger,
  progress: { line: (line) => { progressLines.push(line); writeFileSync(state.log(dbKey), `${progressLines.join("\n")}\n`); }, result: (line) => { progressLines.push(`result: ${line}`); writeFileSync(state.log(dbKey), `${progressLines.join("\n")}\n`); } },
});
```

3. In `runAnalyzeCommand`, drop the `--instructions` parsing block and parse `--reanalyze`:

```ts
if (!command || command === "run") {
  const runOptions = { ...options };
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--reanalyze") runOptions.reanalyze = true;
  return runAnalysisCommand(command === "run" ? target : command, runOptions);
}
```

Leave the cron `--instructions` call site in `src/cron.ts` untouched (per spec §7, cron.ts is out of scope; the flag is now silently ignored).

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/analysis.test.ts`
Expected: PASS. Run `npx tsc --noEmit` to confirm no remaining `instructions`/`threshold` references in `analysisCli.ts`.

- [ ] **Step 4: Commit**

```bash
git add omi-job-fetch/src/analysisCli.ts
git commit -m "feat: drop instructions and threshold from analysis CLI"
```

---

### Task 6: dashboardDb listJobs — drop score, expose extraction

**Files:**
- Modify: `omi-job-fetch/src/dashboardDb.ts`
- Test: `omi-job-fetch/tests/dashboard-db.test.ts`

**Interfaces:**
- Consumes: none new (drop `extractScoreReason` import).
- Produces: `JobListQuery` drops `minScore`; `JobListRow` drops `score` and types `analysis` as `Record<string, unknown> | null`; `listJobs` returns parsed `analysis` without scoring/sorting.

- [ ] **Step 1: Write the failing tests**

Update `omi-job-fetch/tests/dashboard-db.test.ts` `listJobs` describe: the existing `seed()` writes `analysis` values; add an assertion that `analysis` is a parsed object and `score` is absent:

```ts
it("returns parsed analysis and no score field", async () => {
  const { dir, file } = await withDb();
  try {
    const { rows } = listJobs(file);
    expect(rows[0]).not.toHaveProperty("score");
    expect(rows[0].analysis).toEqual(expect.anything());
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

(Check the `seed()` helper to confirm which row is newest and what its `analysis` value is; assert that value.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/dashboard-db.test.ts`
Expected: FAIL — `score` still present on rows.

- [ ] **Step 3: Write the minimal implementation**

In `omi-job-fetch/src/dashboardDb.ts`:

1. Remove `import { extractScoreReason } from "./analysisProvider.js";`.
2. Update `JobListQuery` (drop `minScore`), `JobListRow` (drop `score`, type `analysis`), and `SORTERS` (drop the `score` sorter):

```ts
export interface JobListQuery {
  status?: string;
  q?: string;
  sort?: string;   // "posted_at" | "title" | "company" | "location" | "status"
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
export interface JobListRow { signature: string; status: string; postedAt: string | null; analysis: Record<string, unknown> | null; job: Record<string, unknown>; }
```

```ts
const SORTERS: Record<string, (r: JobListRow) => string | null> = {
  posted_at: (r) => r.postedAt,
  title: (r) => String(r.job.title ?? ""),
  company: (r) => String(r.job.company ?? ""),
  location: (r) => String(r.job.location ?? ""),
  status: (r) => r.status,
};
```

3. In `listJobs`, replace the `analysis` + `score` mapping and drop the `minScore` filter:

```ts
const rows = (db.prepare(sql).all(...params) as Row[]).map(
  (r): JobListRow => ({
    signature: String(r.signature),
    status: String(r.status),
    postedAt: nullOrString(r.posted_at),
    analysis: r.analysis === null || r.analysis === undefined ? null : (() => { try { return JSON.parse(String(r.analysis)) as Record<string, unknown>; } catch { return null; } })(),
    job: parseJob(r.job),
  }),
);
```

Remove this block:

```ts
if (query.minScore !== undefined) filtered = filtered.filter((r) => r.score !== null && r.score >= query.minScore!);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/dashboard-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/dashboardDb.ts omi-job-fetch/tests/dashboard-db.test.ts
git commit -m "feat: remove score from job listing in favor of extraction facets"
```

---

### Task 7: dashboard server + analysis dashboard state — serve contract, drop mark/threshold, reanalyze

**Files:**
- Modify: `omi-job-fetch/src/dashboardAnalysis.ts`
- Modify: `omi-job-fetch/src/dashboardServer.ts`
- Test: `omi-job-fetch/tests/dashboard-server.test.ts` (and/or `dashboard-runs.test.ts` if it touches these routes)

**Interfaces:**
- Consumes: `countAnalysis(file)` new signature (Task 3), `AnalysisSettings` with `schemaVersion`/`fields` (Task 1), `listJobs` (Task 6).
- Produces:
  - `getAnalysisDashboardState` returns `{ settings, dbs, runningDb }` where each `db` has `{ key, label, path, exists, total, analyzed, pending, retentionDays, status, lastRun, summary, running }` (no `recommended`).
  - `/api/analysis/run` reads `body.reanalyze` and appends `--reanalyze`; drops `--instructions`.
  - `/api/dbs/:key/jobs` drops the `recommended`/`minScore` param and returns `fields` in the response.

- [ ] **Step 1: Write the failing tests**

In `omi-job-fetch/tests/dashboard-server.test.ts` (or the file covering these routes), add/update:

```ts
it("serves contract fields on the jobs list and drops the mark-unrecommended route", async () => {
  // POST /api/analysis/{db}/mark-unrecommended → expect 404 (route removed).
  // GET /api/dbs/{key}/jobs → expect response.fields to be an array with schemaVersion-driven fields.
});
```

If the server test harness is heavy, at minimum assert the type-level change (compile) plus a direct `getAnalysisDashboardState` assertion:

```ts
it("analysis dashboard state reports analyzed/pending without recommended", async () => {
  const state = getAnalysisDashboardState({ packageDir, configDir, cronFile, stateDir });
  expect(state.dbs.every((db: any) => !("recommended" in db))).toBe(true);
  expect(state.settings.fields.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd omi-job-fetch; npx vitest run tests/dashboard-server.test.ts tests/dashboard-runs.test.ts`
Expected: FAIL — `countAnalysis` call sites broken; `recommended` still present.

- [ ] **Step 3: Write the minimal implementation**

In `omi-job-fetch/src/dashboardAnalysis.ts`:

```ts
const counts = exists ? countAnalysis(path) : { total: 0, analyzed: 0, pending: 0 };
```

(remove the `settings.recommendedThreshold` argument.)

In `omi-job-fetch/src/dashboardServer.ts`:

1. Remove `import { bulkMarkBelowThreshold } from "./analysisDb.js";` and delete the `mark-unrecommended` route block (lines with `markRoute`/`bulkMarkBelowThreshold`).
2. In `/api/analysis/run`, drop `--instructions` and add `--reanalyze`:

```ts
const args = [cliPath, "analyze", "run", dbKey];
if (body.reanalyze === true) args.push("--reanalyze");
```

3. In `/api/dbs/:key/jobs`, drop the `minScore` line and attach `fields`:

```ts
const result = listJobs(meta.db.path, {
  status: q.get("status") ?? undefined,
  q: q.get("q") ?? undefined,
  sort: q.get("sort") ?? undefined,
  dir: dirParam === "asc" || dirParam === "desc" ? dirParam : undefined,
  limit: Number(q.get("limit") ?? 200),
  offset: Number(q.get("offset") ?? 0),
});
sendJson(res, 200, { ...result, fields: loadAnalysisSettings(packageDir, stateDir).fields });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd omi-job-fetch; npx vitest run tests/dashboard-server.test.ts tests/dashboard-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add omi-job-fetch/src/dashboardAnalysis.ts omi-job-fetch/src/dashboardServer.ts omi-job-fetch/tests/dashboard-server.test.ts
git commit -m "feat: serve extraction contract and drop threshold from dashboard API"
```

---

### Task 8: analysis view — run controls (rename, re-analyze toggle, drop instructions/threshold/mark)

**Files:**
- Modify: `omi-job-fetch/dashboard/views/analysis.js`

**Interfaces:**
- Consumes: `/api/analysis` now returns `settings.schemaVersion`/`settings.fields` and per-DB `analyzed`/`pending` (no `recommended`); `/api/analysis/run` accepts `{ db, reanalyze }`; `/api/analysis/settings` PUT no longer takes `recommendedThreshold`.

- [ ] **Step 1: Make the edits (view — no unit harness; verify by build + browser)**

In `omi-job-fetch/dashboard/views/analysis.js`:

1. State: replace `instructions: ""` with `reanalyze: false`:

```js
const state = { data: null, timer: null, db: "", reanalyze: false, testResults: {} };
```

2. `run()`: drop `instructions`, send `reanalyze`:

```js
async function run() {
  try { await api.post("/api/analysis/run", { db: state.db, reanalyze: state.reanalyze }); toast(state.reanalyze ? "Re-analyze started" : "Extraction started", "good"); refresh(); }
  catch (error) { toast(error.message, "warn"); }
}
```

3. Delete the `mark(db)` function (the "Mark below threshold" bulk action).

4. `settingsCard(s)`: remove the `threshold` input and the `recommendedThreshold` PUT field; keep `systemPrompt` + `descriptionMaxChars`; change the eyebrow/title from "Prompt & threshold" to "Prompt":

```js
function settingsCard(s) {
  const systemPrompt = el("textarea", { class: "input", rows: 5, value: s.systemPrompt ?? "" });
  const descriptionMaxChars = el("input", { class: "input", type: "number", min: "1", value: s.descriptionMaxChars ?? 2000 });
  const form = el("form", { class: "form-grid" },
    el("div", { class: "field" }, el("label", {}, "System prompt"), systemPrompt, el("div", { class: "hint" }, "Persona sent to the model; the extraction instructions are generated from the contract fields.")),
    el("div", { class: "form-row" },
      el("div", { class: "field" }, el("label", {}, "Description max chars"), descriptionMaxChars)),
    el("button", { class: "btn btn-primary", type: "submit" }, "Save settings"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api.put("/api/analysis/settings", { systemPrompt: systemPrompt.value, descriptionMaxChars: Number(descriptionMaxChars.value) });
      toast("Settings saved", "good");
      refresh();
    } catch (error) { toast(error.message, "warn"); }
  });
  return el("div", { class: "card" },
    el("p", { class: "eyebrow" }, "Extraction settings"),
    el("h3", {}, "Prompt"),
    form);
}
```

5. `renderDbCards()`: drop `recommended` from the count line and remove the "Mark below threshold" button. Replace the final two elements of the card with just the count line:

```js
    el("p", {}, `${db.analyzed} analyzed · ${db.pending} pending`)));
```

(remove the `el("button", { class: "btn small btn-danger", disabled: !db.exists || db.running, onclick: () => mark(db.key) }, "Mark below threshold uninterested")` element entirely).

6. `renderActions()`: rename the run button and add a re-analyze checkbox bound to `state.reanalyze` (per-run, not persisted):

```js
function renderActions() {
  const enabled = Boolean(data().settings.providers.find((provider) => provider.id === data().settings.enabledProvider));
  const running = Boolean(data().runningDb);
  const dbOptions = data().dbs ?? [];
  return [
    !enabled ? el("div", { class: "callout warn" }, el("p", {}, "No AI provider configured — extraction is disabled.")) : null,
    running ? el("div", { class: "callout" },
      el("p", {}, `This DB is still being extracted: ${esc(data().runningDb)}`),
      el("button", { class: "btn btn-danger", onclick: stop }, "Stop")) : null,
    el("div", { class: "toolbar" },
      el("button", { class: "btn btn-primary", disabled: !enabled || !dbOptions.length || running, onclick: run }, "Run extraction"),
      el("label", { class: "inline" },
        el("input", { type: "checkbox", checked: state.reanalyze, onchange: (e) => { state.reanalyze = e.target.checked; } }),
        " Re-analyze non-conforming rows")),
  ];
}
```

7. `render()`: remove the `instruction` textarea and retitle the tab. Replace the `const instruction = ...` line and the card body:

```js
export async function render() {
  if (!state.data) await refresh();
  const s = data();
  const dbOptions = s.dbs.map((db) => el("option", { value: db.key }, db.label));
  const dbSelect = el("select", { id: "analysis-db-select", class: "select", value: state.db, onchange: (event) => { state.db = event.target.value; } }, dbOptions);
  return el("div", { id: "analysis-root" },
    el("p", { class: "eyebrow" }, "Analysis"),
    el("h2", { class: "docs" }, "AI job extraction"),
    el("div", { class: "card" },
      el("p", { class: "eyebrow" }, "Run extraction"),
      dbSelect,
      el("div", { id: "analysis-actions" }, ...renderActions())),
    el("div", { id: "analysis-cards" }, ...renderDbCards()),
    el("div", { id: "analysis-providers" }, providersCard(s.settings)),
    settingsCard(s.settings));
}
```

(the `instruction` textarea is removed entirely; there is no longer any instructions input.)

- [ ] **Step 2: Verify**

Run: `cd omi-job-fetch; npm run build`
Expected: PASS (no TS errors — this file is plain JS, so this mainly checks the JS files are still syntactically valid when bundled, if the build includes them; otherwise `node --check dashboard/views/analysis.js`).

Run: `cd omi-job-fetch; node --check dashboard/views/analysis.js`
Expected: no syntax errors.

Manual: open the dashboard, Analysis tab → confirm no instructions textarea, no threshold setting, run button says "Run extraction", re-analyze checkbox present, per-DB cards show "analyzed · pending" without "recommended".

- [ ] **Step 3: Commit**

```bash
git add omi-job-fetch/dashboard/views/analysis.js
git commit -m "feat: add re-analyze toggle and drop score surfaces from analysis view"
```

---

### Task 9: jobs view — faceted filter + drop score UI

**Files:**
- Modify: `omi-job-fetch/dashboard/views/jobs.js`

**Interfaces:**
- Consumes: `/api/dbs/:key/jobs` now returns `{ total, rows, fields }` where `rows[].analysis` is the parsed extraction and `fields` is the contract `fields[]` (Task 7).

- [ ] **Step 1: Make the edits (view — verify by build + browser)**

In `omi-job-fetch/dashboard/views/jobs.js`:

1. State: drop `recommended`, add `facets` (selected values per field key) and `contract` (fields):

```js
const state = {
  sources: [], key: null, status: "", q: "", sort: "posted_at", dir: "desc",
  facets: {},        // fieldKey -> string[] selected values
  min: {},           // fieldKey -> number (range/number min)
  max: {},           // fieldKey -> number (range/number max)
  contract: [],      // fields[] from the API
  list: null, info: null, timer: null, searchTimer: null,
};
```

2. `refresh()`: drop the `recommended` query param, store `fields`:

```js
state.list = state.key
  ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&limit=500`)
  : null;
if (state.list?.fields) state.contract = state.list.fields;
```

3. `openDetail()`: replace the `score/reason` verdict with extraction chips. Replace the block:

```js
if (detail.analysis) {
  const verdict = detail.analysis.score !== undefined && detail.analysis.reason ? `${detail.analysis.score}/10 — ${detail.analysis.reason}` : JSON.stringify(detail.analysis, null, 2);
  rows.push(el("dt", {}, "Analysis"), el("dd", {}, verdict));
}
```

with:

```js
if (detail.analysis && detail.analysis.schemaVersion) {
  const chips = [];
  for (const [k, v] of Object.entries(detail.analysis)) {
    if (k === "schemaVersion" || k === "unmatched") continue;
    const text = Array.isArray(v) ? v.join(", ") : (v && typeof v === "object" ? JSON.stringify(v) : String(v));
    chips.push(el("span", { class: "chip" }, `${esc(k)}: ${esc(text)}`));
  }
  rows.push(el("dt", {}, "Extraction"), el("dd", {}, ...chips));
}
```

4. `renderTable()`: drop the `score` column from the head array and body cells:

```js
const head = el("tr", {}, ...(["posted_at", "title", "company", "location", "status"].map((key) => ...)));
```

Remove the `<td>` `row.score` line from the body rows.

5. `renderBody()`: remove the `recommended` checkbox, add the facet bar between the toolbar and the table. Add a helper to render one facet per contract field:

```js
function renderFacets() {
  const rows = state.list?.rows ?? [];
  const bars = state.contract.map((field) => {
    if (field.kind === "enum") return enumFacet(field, rows);
    if (field.kind === "list") return listFacet(field, rows);
    if (field.kind === "range" || field.kind === "number") return numericFacet(field, rows);
    if (field.kind === "date") return dateFacet(field, rows);
    return null;
  }).filter(Boolean);
  return bars.length ? el("div", { class: "facets" }, ...bars) : null;
}

function selectedFor(field) { return state.facets[field.key] ?? []; }

function toggleFacet(field, value) {
  const cur = new Set(state.facets[field.key] ?? []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  state.facets[field.key] = [...cur];
  saveFacets();
  applyFilter();
}

function enumFacet(field, rows) {
  const options = [...(field.values ?? [])];
  const hasOther = rows.some((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes("other") : v === "other"; });
  if (hasOther) options.push("other");
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    ...options.map((value) => {
      const checked = selectedFor(field).includes(value);
      const count = rows.filter((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes(value) : v === value; }).length;
      return el("label", { class: "facet-option" },
        el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
        ` ${esc(value)} (${count})`);
    }));
}

function listFacet(field, rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = r.analysis?.[field.key];
    const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
    for (const t of tags) if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    ...options.map(([value, count]) => {
      const checked = selectedFor(field).includes(value);
      return el("label", { class: "facet-option" },
        el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
        ` ${esc(value)} (${count})`);
    }));
}

function numericFacet(field, rows) {
  const min = el("input", { class: "input", type: "number", placeholder: "min", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  const max = el("input", { class: "input", type: "number", placeholder: "max", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  return el("div", { class: "facet" }, el("div", { class: "eyebrow" }, field.key), el("div", { class: "facet-range" }, min, el("span", {}, "–"), max));
}

function dateFacet(field, rows) {
  const before = el("input", { class: "input", type: "date", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  const after = el("input", { class: "input", type: "date", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  return el("div", { class: "facet" }, el("div", { class: "eyebrow" }, field.key), el("div", { class: "facet-range" }, el("span", {}, "after"), before, el("span", {}, "before"), after));
}
```

6. Client-side filter: keep the full `rows` on `state.list` but filter in `renderTable()`. Add `applyFilter()` that recomputes a filtered copy:

```js
function applyFilter() {
  // re-render the table only; the full list stays on state.list for facet counts.
  const body = document.getElementById("jobs-body");
  if (body) body.replaceChildren(renderTicker(), renderTable());
}

function matchesFacets(row) {
  const a = row.analysis ?? {};
  for (const field of state.contract) {
    const selected = state.facets[field.key];
    if (selected && selected.length) {
      const v = a[field.key];
      const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
      if (!selected.some((s) => tags.includes(s))) return false;
    }
    if (field.kind === "range" || field.kind === "number") {
      const n = field.kind === "number" ? a[field.key] : undefined;
      const range = field.kind === "range" ? a[field.key] : undefined;
      const lo = state.min[field.key]; const hi = state.max[field.key];
      if (field.kind === "number" && n != null) { if (lo != null && n < lo) return false; if (hi != null && n > hi) return false; }
      else if (range && typeof range === "object") { if (lo != null && range.max != null && range.max < lo) return false; if (hi != null && range.min != null && range.min > hi) return false; }
    }
    if (field.kind === "date") {
      const d = a[field.key];
      if (typeof d === "string") {
        const lo = state.min[field.key]; const hi = state.max[field.key];
        if (lo && d < lo) return false;
        if (hi && d > hi) return false;
      }
    }
  }
  return true;
}
```

Then in `renderTable()`, filter the rows first:

```js
const rows = (state.list?.rows ?? []).filter(matchesFacets);
```

and use `rows` in place of `list.rows` for `total`/`body`. Show a `list.total === 0` empty message when the *filtered* set is empty.

7. localStorage persistence per DB key:

```js
function facetsKey() { return `omijobs-facets:${state.key}`; }
function saveFacets() { try { localStorage.setItem(facetsKey(), JSON.stringify({ facets: state.facets, min: state.min, max: state.max })); } catch {} }
function loadFacets() {
  try {
    const saved = JSON.parse(localStorage.getItem(facetsKey()) ?? "{}");
    state.facets = saved.facets ?? {}; state.min = saved.min ?? {}; state.max = saved.max ?? {};
  } catch { state.facets = {}; state.min = {}; state.max = {}; }
}
```

Call `loadFacets()` after `state.key` is resolved in `refresh()` (and clear/ignore facets whose field keys no longer exist in `state.contract`).

- [ ] **Step 2: Verify**

Run: `cd omi-job-fetch; node --check dashboard/views/jobs.js`
Expected: no syntax errors. If the build lints JS, also `npm run build`.

Manual: open the Jobs tab → confirm the "AI recommended" checkbox and "score" column are gone; a facet bar renders one facet per contract field; checking enum/list values filters the table client-side; range/number/date inputs filter; facet selection survives reload for the same DB; detail modal shows extraction chips instead of a score.

- [ ] **Step 3: Commit**

```bash
git add omi-job-fetch/dashboard/views/jobs.js
git commit -m "feat: add client-side extraction facet filter to jobs view"
```

---

### Final verification

- [ ] Run the full suite + typecheck + build:

```bash
cd omi-job-fetch
npx vitest run
npx tsc --noEmit
npm run build
```

Expected: all pass (273 tests prior to this change; the count shifts with added/removed tests but must be fully green).

- [ ] Grep for any leftover `score`, `recommended`, `extractScoreReason`, `bulkMarkBelowThreshold`, `recommendedThreshold`, or `instructions` references in `omi-job-fetch/src` and `omi-job-fetch/dashboard`:

```bash
cd omi-job-fetch
npx grep -rniE "recommendedThreshold|extractScoreReason|bulkMarkBelowThreshold|minScore|recommended|instructions" src dashboard
```

Expected: only legitimate hits (e.g. cron `instructions` in `src/cron.ts`, which is intentionally out of scope per spec §7) — confirm no score/threshold surfaces remain in the extraction path.
