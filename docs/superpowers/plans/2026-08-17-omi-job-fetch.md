# omi-job-fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `omi-job-fetch` npm package — a deterministic, programmatic job-retrieval CLI (manifest-declared adapters, orchestrator-enforced contract) with one proof-of-concept GradConnection adapter.

**Architecture:** TypeScript CLI. `runtime.ts` resolves the effective contract (default v0.1 + config.json overrides + CLI flags), checks each adapter's manifest (skip or fallback when required inputs are missing), runs all adapters concurrently in isolation, normalizes platform-native jobs to contract outputs (null for unprovided, extras preserved, required-output validity enforced), dedups across sources by signature hash, and writes one timestamped JSON run folder. Adapters declare their contract surface via a manifest and stay focused on HTTP + parsing.

**Tech Stack:** Node 20+ (native `fetch`), TypeScript (strict, NodeNext ESM), vitest, zero runtime dependencies.

## Global Constraints

- **No auto-commit.** Project convention: the user stages and commits manually. No step runs `git commit`; every task ends at green tests and a note that the task is ready for the user to commit.
- **Deterministic retrieval only:** HTTP against public/embedded APIs. No browser automation (Playwright), no AI in the retrieval loop.
- **Credentials via `$env:VAR` only** — never in config.json or any committed file.
- **Generic job retrieval** — adapters must not be biased to any one query/industry. Finance/intern are only sample inputs.
- **Spec:** `docs/superpowers/specs/2026-08-17-job-fetcher-design.md`. Contract v0.1 yardstick: `docs/portal-research/plan.md` §3.
- All relative imports in `src/` use the `.js` extension (NodeNext ESM convention); vitest resolves `.js` → `.ts` automatically.
- **Aggregator-first, ATS later:** v1 ships portal/aggregator adapters only — `ats.enabled` stays `[]`. ATS backends are per-employer and need a company list in config; see **Future scope** below. Out of scope for this build.

---

## Future scope: named-employer ATS (out of scope for v1)

ATS backends (Workday, Greenhouse — findings in `docs/portal-research/ats-findings.md`) retrieve jobs **per employer**: one Workday tenant or one Greenhouse board token per company. They cannot answer a market-wide query like "tech intern jobs in HK" — that is what aggregator (portal) adapters do, and portals are the v1 search layer.

If ATS adapters are ever built, they run in **named-employer mode**: the user lists companies in config and the adapter pulls each one. The list lives per adapter under `ats.config.<adapterId>` — the same shape as `portals.config.<adapterId>`, so no schema or type change is needed (`RunConfig.ats.config` already accepts `Record<string, Record<string, unknown>>`):

```json
"ats": {
  "enabled": ["greenhouse"],
  "config": { "greenhouse": { "companies": ["stripe", "airbnb"] } }
}
```

- Each ATS adapter declares its list key as an `extraInput` in its manifest (`companies` for Greenhouse, `tenants` for Workday) and reads it from `ctx.config`; an empty/missing list returns zero jobs with a `meta` reason rather than failing the run.
- Credentials for backends that need them (Greenhouse Harvest) stay `$env:VAR`-only, per Global Constraints.
- **This build ships portals only.** `ats.enabled` stays `[]`, no ATS adapter is registered, and `src/ats/` is reserved.

---

## File structure

```
omi-job-fetch/
  package.json            # bin: omi-job-fetch → dist/cli.js; zero runtime deps
  tsconfig.json
  vitest.config.ts
  config.json             # default control file (gradconnection enabled)
  config.example.json
  README.md
  src/
    types.ts              # shared types + INPUT_KEYS/OUTPUT_KEYS + RunConfig/Adapter types
    contract.ts           # DEFAULT_CONTRACT, resolveContract, buildInput, requiredOutputs
    normalize.ts          # normalizeJob: native job → contract shape
    dedup.ts              # normalizeForHash, signature, dedupJobs
    runtime.ts            # runPipeline (orchestrator), timestampId, exitCode, DEFAULT_DEDUP_FIELDS
    cli.ts                # parseArgs, coerce, findConfig, printHelp, main
    registry.ts           # exports `adapters` array (single registration point)
    portals/gradconnection.ts   # PoC adapter
    ats/.gitkeep
  tests/
    types.test.ts
    contract.test.ts
    normalize.test.ts
    dedup.test.ts
    runtime.test.ts
    cli.test.ts
    fixtures/gradconnection-search.json
    adapters/gradconnection.test.ts
  dist/                   # build output (gitignored)
  output/                 # run output (gitignored)
```

---

### Task 1: Package scaffold + core types

**Files:**
- Create: `omi-job-fetch/package.json`
- Create: `omi-job-fetch/tsconfig.json`
- Create: `omi-job-fetch/vitest.config.ts`
- Create: `omi-job-fetch/config.json`
- Create: `omi-job-fetch/config.example.json`
- Create: `omi-job-fetch/src/types.ts`
- Create: `omi-job-fetch/src/ats/.gitkeep`
- Create: `omi-job-fetch/tests/types.test.ts`
- Modify: `.gitignore` (append the omi-job-fetch entries)

**Interfaces:**
- Produces: `INPUT_KEYS`, `OUTPUT_KEYS` (string tuple types `InputKey`/`OutputKey`), `ContractInput`, `Job`, `ContractFieldDef`, `EffectiveContract`, `AdapterManifest`, `AdapterContext`, `AdapterResult`, `Adapter`, `RunConfig`, `AdapterStatus`, `RunSummary` — all consumed by every later task.

- [ ] **Step 1: Create the package folder and config files**

`omi-job-fetch/package.json`:
```json
{
  "name": "omi-job-fetch",
  "version": "0.1.0",
  "description": "Deterministic programmatic job retrieval from aggregator portals and ATS backends",
  "type": "module",
  "bin": { "omi-job-fetch": "./dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "keywords": ["jobs", "ats", "recruitment", "scraper"],
  "license": "UNLICENSED",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`omi-job-fetch/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`omi-job-fetch/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

`omi-job-fetch/config.json`:
```json
{
  "contract": {
    "inputs": {
      "query": { "required": true, "default": null },
      "location": { "required": false, "default": null },
      "posted_within_days": { "required": false, "default": null },
      "employment_type": { "required": false, "default": null },
      "sort": { "required": false, "default": null },
      "page": { "required": false, "default": 1 },
      "seniority": { "required": false, "default": null }
    },
    "outputs": {}
  },
  "portals": {
    "enabled": ["gradconnection"],
    "config": { "gradconnection": { "country": "hk" } }
  },
  "ats": { "enabled": [], "config": {} },
  "dedup": { "fields": ["title", "company", "location"] }
}
```

`ats` stays empty for v1 (aggregators only). The future named-employer ATS mode — see **Future scope** — will carry the company list per adapter under `ats.config.<adapterId>`, e.g. `"config": { "greenhouse": { "companies": ["stripe"] } }`. No schema change needed.

`omi-job-fetch/config.example.json`: byte-identical copy of `config.json`.

Create empty dir `omi-job-fetch/src/ats/` and put a `.gitkeep` in it.

- [ ] **Step 2: Append omi-job-fetch entries to the repo `.gitignore`**

Append to the end of `./.gitignore`:
```
# omi-job-fetch
omi-job-fetch/node_modules/
omi-job-fetch/dist/
omi-job-fetch/output/
```

- [ ] **Step 3: Write the failing test**

`omi-job-fetch/tests/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { INPUT_KEYS, OUTPUT_KEYS } from "../src/types.js";

describe("types", () => {
  it("defines the v0.1 contract input keys", () => {
    expect(INPUT_KEYS).toEqual([
      "query",
      "location",
      "posted_within_days",
      "employment_type",
      "sort",
      "page",
      "seniority",
    ]);
  });

  it("defines the v0.1 contract output keys", () => {
    expect(OUTPUT_KEYS).toContain("apply_url");
    expect(OUTPUT_KEYS).toContain("job_page_url");
    expect(OUTPUT_KEYS).toContain("external_id");
    expect(OUTPUT_KEYS).toContain("source");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/types.js'` (file doesn't exist yet).

- [ ] **Step 5: Install deps and write `src/types.ts`**

Run: `npm install`
Expected: installs typescript, vitest, @types/node; creates `package-lock.json` and `node_modules/`.

`omi-job-fetch/src/types.ts`:
```ts
/** Contract v0.1 — default input/output keys (see docs/portal-research/plan.md §3). */
export const INPUT_KEYS = [
  "query",
  "location",
  "posted_within_days",
  "employment_type",
  "sort",
  "page",
  "seniority",
] as const;

export const OUTPUT_KEYS = [
  "apply_url",
  "job_page_url",
  "external_id",
  "title",
  "company",
  "location",
  "description",
  "posted_at",
  "expires_at",
  "is_open",
  "employment_type",
  "source",
] as const;

export type InputKey = (typeof INPUT_KEYS)[number];
export type OutputKey = (typeof OUTPUT_KEYS)[number];

/** Contract input after defaults + CLI overrides are applied. */
export type ContractInput = Record<string, unknown>;

/** One job, normalized to contract outputs plus any adapter extras. */
export type Job = Record<string, unknown>;

/** Field definition in the effective contract. */
export interface ContractFieldDef {
  required: boolean;
  default?: unknown;
}

/** Effective contract: input field definitions + required outputs. */
export interface EffectiveContract {
  inputs: Record<string, ContractFieldDef>;
  outputs: Record<string, { required: boolean }>;
}

export interface AdapterManifest {
  id: string;
  family: "portal" | "ats";
  name: string;
  requiredInputs: string[];
  optionalInputs: string[];
  providedOutputs: OutputKey[];
  fallbacks?: Record<string, unknown>;
  extraInputs?: Record<string, { desc: string; env?: string }>;
}

export interface AdapterContext {
  input: ContractInput;
  env: Record<string, string | undefined>;
  config: Record<string, unknown>;
}

export interface AdapterResult {
  jobs: Job[];
  meta: Record<string, unknown>;
}

export interface Adapter {
  manifest: AdapterManifest;
  run(ctx: AdapterContext): Promise<AdapterResult>;
}

export interface RunConfig {
  contract?: {
    inputs?: Record<string, ContractFieldDef>;
    outputs?: Record<string, { required: boolean }>;
  };
  portals: { enabled: string[]; config?: Record<string, Record<string, unknown>> };
  ats: { enabled: string[]; config?: Record<string, Record<string, unknown>> };
  dedup: { fields?: string[] };
}

export interface AdapterStatus {
  adapter: string;
  family: "portal" | "ats";
  status: "ok" | "skipped" | "error";
  reason?: string;
  jobCount?: number;
  dropped?: number;
  error?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface RunSummary {
  contract: EffectiveContract;
  input: ContractInput;
  startedAt: string;
  adapters: AdapterStatus[];
  jobs: number;
  dropped: number;
  duplicatesRemoved: number;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Task complete — ready for the user to commit.

---

### Task 2: Contract resolution

**Files:**
- Create: `omi-job-fetch/src/contract.ts`
- Test: `omi-job-fetch/tests/contract.test.ts`

**Interfaces:**
- Consumes: `EffectiveContract`, `RunConfig` from `./types.js`.
- Produces:
  - `DEFAULT_CONTRACT: EffectiveContract`
  - `resolveContract(config?: RunConfig["contract"]): EffectiveContract`
  - `buildInput(contract: EffectiveContract, cli: Record<string, unknown>): ContractInput`
  - `requiredOutputs(contract: EffectiveContract): string[]`

- [ ] **Step 1: Write the failing test**

`omi-job-fetch/tests/contract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CONTRACT, buildInput, requiredOutputs, resolveContract } from "../src/contract.js";

describe("resolveContract", () => {
  it("returns the default contract when no config is given", () => {
    const c = resolveContract();
    expect(c.inputs.query.required).toBe(true);
    expect(c.inputs.page.default).toBe(1);
    expect(requiredOutputs(c)).toEqual(["apply_url", "title", "company", "location", "source"]);
  });

  it("merges config overrides on top of defaults", () => {
    const c = resolveContract({
      inputs: { location: { required: true } },
      outputs: { description: { required: true } },
    });
    expect(c.inputs.location.required).toBe(true);
    expect(c.inputs.query.required).toBe(true); // unchanged
    expect(c.outputs.description.required).toBe(true);
    expect(c.outputs.title.required).toBe(true); // unchanged
  });

  it("adds brand-new inputs from config", () => {
    const c = resolveContract({ inputs: { discipline: { required: false, default: "finance" } } });
    expect(c.inputs.discipline).toEqual({ required: false, default: "finance" });
  });
});

describe("buildInput", () => {
  it("applies defaults for unset non-required inputs", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad" });
    expect(input.query).toBe("grad");
    expect(input.page).toBe(1);
  });

  it("prefers CLI values over defaults", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad", page: 3 });
    expect(input.page).toBe(3);
  });

  it("throws when a required input is missing", () => {
    expect(() => buildInput(DEFAULT_CONTRACT, {})).toThrow(/Missing required contract inputs: query/);
  });

  it("passes through CLI keys not in the contract", () => {
    const input = buildInput(DEFAULT_CONTRACT, { query: "grad", country: "sg" });
    expect(input.country).toBe("sg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract.test.ts`
Expected: FAIL with `Cannot find module '../src/contract.js'`.

- [ ] **Step 3: Write the implementation**

`omi-job-fetch/src/contract.ts`:
```ts
import type { ContractInput, EffectiveContract, RunConfig } from "./types.js";

/** Default contract v0.1 — the yardstick from docs/portal-research/plan.md §3. */
export const DEFAULT_CONTRACT: EffectiveContract = {
  inputs: {
    query: { required: true, default: null },
    location: { required: false, default: null },
    posted_within_days: { required: false, default: null },
    employment_type: { required: false, default: null },
    sort: { required: false, default: null },
    page: { required: false, default: 1 },
    seniority: { required: false, default: null },
  },
  outputs: {
    apply_url: { required: true },
    job_page_url: { required: false },
    external_id: { required: false },
    title: { required: true },
    company: { required: true },
    location: { required: true },
    description: { required: false },
    posted_at: { required: false },
    expires_at: { required: false },
    is_open: { required: false },
    employment_type: { required: false },
    source: { required: true },
  },
};

/** Required outputs: a job missing one of these is dropped by the normalizer. */
export function requiredOutputs(contract: EffectiveContract): string[] {
  return Object.entries(contract.outputs)
    .filter(([, def]) => def.required)
    .map(([key]) => key);
}

/** Merge the default contract with config.json overrides. Returns the effective contract. */
export function resolveContract(config: RunConfig["contract"] = {}): EffectiveContract {
  const inputs: EffectiveContract["inputs"] = { ...DEFAULT_CONTRACT.inputs };
  for (const [key, def] of Object.entries(config.inputs ?? {})) {
    const base = inputs[key] ?? { required: false, default: null };
    inputs[key] = {
      required: def.required ?? base.required,
      default: def.default !== undefined ? def.default : base.default,
    };
  }
  const outputs: EffectiveContract["outputs"] = { ...DEFAULT_CONTRACT.outputs };
  for (const [key, def] of Object.entries(config.outputs ?? {})) {
    const base = outputs[key] ?? { required: false };
    outputs[key] = { required: def.required ?? base.required };
  }
  return { inputs, outputs };
}

/**
 * Build the effective contract input from defaults + CLI-provided values.
 * Throws if a required input is still missing after defaults are applied.
 * CLI keys not declared in the contract pass through unchanged (extra inputs).
 */
export function buildInput(contract: EffectiveContract, cli: Record<string, unknown>): ContractInput {
  const input: ContractInput = {};
  const missing: string[] = [];
  for (const [key, def] of Object.entries(contract.inputs)) {
    if (cli[key] !== undefined) {
      input[key] = cli[key];
    } else if (def.default !== undefined && def.default !== null) {
      input[key] = def.default;
    } else if (def.required) {
      missing.push(key);
    }
  }
  for (const [key, value] of Object.entries(cli)) {
    if (!(key in contract.inputs)) input[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing required contract inputs: ${missing.join(", ")}`);
  }
  return input;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract.test.ts`
Expected: PASS (7 tests). Task complete — ready for the user to commit.

---

### Task 3: Normalizer

**Files:**
- Create: `omi-job-fetch/src/normalize.ts`
- Test: `omi-job-fetch/tests/normalize.test.ts`

**Interfaces:**
- Consumes: `OUTPUT_KEYS`, `OutputKey` from `./types.js`.
- Produces: `normalizeJob(raw: Record<string, unknown>, adapterId: string, providedOutputs: OutputKey[], required: string[]): Record<string, unknown> | null`

- [ ] **Step 1: Write the failing test**

`omi-job-fetch/tests/normalize.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeJob } from "../src/normalize.js";

const provided = ["apply_url", "title", "company", "location", "external_id"];

describe("normalizeJob", () => {
  it("fills provided outputs, nulls the rest, sets source, preserves extras", () => {
    const job = normalizeJob(
      { title: "T", company: "C", location: "HK", apply_url: "https://a", external_id: "123", extra: "keep" },
      "gc",
      provided,
      ["apply_url", "title", "company", "location", "source"],
    );
    expect(job).not.toBeNull();
    expect(job!.title).toBe("T");
    expect(job!.description).toBeNull();
    expect(job!.source).toBe("gc");
    expect(job!.extra).toBe("keep");
  });

  it("returns null when a required output is missing", () => {
    const job = normalizeJob({ title: "T", company: "C", location: "HK" }, "gc", provided, ["apply_url", "title"]);
    expect(job).toBeNull();
  });

  it("treats an empty string as missing for required outputs", () => {
    const job = normalizeJob({ title: "", company: "C", location: "HK", apply_url: "https://a" }, "gc", provided, ["title"]);
    expect(job).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL with `Cannot find module '../src/normalize.js'`.

- [ ] **Step 3: Write the implementation**

`omi-job-fetch/src/normalize.ts`:
```ts
import { OUTPUT_KEYS } from "./types.js";
import type { OutputKey } from "./types.js";

/**
 * Map a platform-native job to the contract shape.
 * Fills providedOutputs from the raw record, null for the rest, preserves extras.
 * Returns null if any required output is missing/empty (job dropped).
 */
export function normalizeJob(
  raw: Record<string, unknown>,
  adapterId: string,
  providedOutputs: OutputKey[],
  required: string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of OUTPUT_KEYS) {
    out[key] = null;
  }
  for (const key of providedOutputs) {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(OUTPUT_KEYS as readonly string[]).includes(key)) out[key] = value;
  }
  out.source = adapterId;
  for (const key of required) {
    const value = out[key];
    if (value === null || value === undefined || value === "") return null;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS (3 tests). Task complete — ready for the user to commit.

---

### Task 4: Dedup

**Files:**
- Create: `omi-job-fetch/src/dedup.ts`
- Test: `omi-job-fetch/tests/dedup.test.ts`

**Interfaces:**
- Consumes: `Job` from `./types.js`.
- Produces:
  - `normalizeForHash(value: unknown): string`
  - `signature(job: Job, fields: string[]): string`
  - `dedupJobs(jobs: Job[], fields: string[]): Job[]`

- [ ] **Step 1: Write the failing test**

`omi-job-fetch/tests/dedup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dedupJobs, normalizeForHash, signature } from "../src/dedup.js";

describe("normalizeForHash", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeForHash("  HSBC   HONG KONG ")).toBe("hsbc hong kong");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeForHash(null)).toBe("");
    expect(normalizeForHash(undefined)).toBe("");
  });
});

describe("signature", () => {
  it("joins normalized fields with |", () => {
    expect(
      signature({ title: "Graduate Program", company: "  HSBC", location: "Hong Kong" }, ["title", "company", "location"]),
    ).toBe("graduate program|hsbc|hong kong");
  });
});

describe("dedupJobs", () => {
  it("dedups identical title/company/location and merges sources", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "gradconnection" },
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "jobsdb" },
      ],
      ["title", "company", "location"],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sources).toEqual(["gradconnection", "jobsdb"]);
  });

  it("keeps distinct jobs", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", source: "gc" },
        { title: "Trading Intern", company: "Jane Street", location: "Hong Kong", source: "gc" },
      ],
      ["title", "company", "location"],
    );
    expect(jobs).toHaveLength(2);
  });

  it("does not dedup when a config-extended field differs", () => {
    const jobs = dedupJobs(
      [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a", source: "gc" },
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://b", source: "gc" },
      ],
      ["title", "company", "location", "apply_url"],
    );
    expect(jobs).toHaveLength(2);
  });

  it("keeps jobs with an empty signature without deduping", () => {
    const jobs = dedupJobs([{ title: "", company: "", location: "", source: "gc" }], ["title", "company", "location"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sources).toEqual(["gc"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dedup.test.ts`
Expected: FAIL with `Cannot find module '../src/dedup.js'`.

- [ ] **Step 3: Write the implementation**

`omi-job-fetch/src/dedup.ts`:
```ts
import type { Job } from "./types.js";

/** Normalize a field value for hashing: trim, lowercase, collapse internal whitespace. */
export function normalizeForHash(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build the dedup signature from the configured fields. */
export function signature(job: Job, fields: string[]): string {
  return fields.map((field) => normalizeForHash(job[field])).join("|");
}

/**
 * Dedup jobs across sources. First-seen wins; the kept job's `sources` array
 * accumulates every adapter id that surfaced the same signature.
 */
export function dedupJobs(jobs: Job[], fields: string[]): Job[] {
  const seen = new Map<string, Job>();
  const kept: Job[] = [];
  for (const job of jobs) {
    const sig = signature(job, fields);
    if (sig === "") {
      job.sources = job.source ? [String(job.source)] : [];
      kept.push(job);
      continue;
    }
    const existing = seen.get(sig);
    if (existing) {
      const sources = (existing.sources as string[]) ?? [];
      const src = job.source;
      if (src && !sources.includes(String(src))) sources.push(String(src));
      existing.sources = sources;
    } else {
      job.sources = job.source ? [String(job.source)] : [];
      seen.set(sig, job);
      kept.push(job);
    }
  }
  return kept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dedup.test.ts`
Expected: PASS (6 tests). Task complete — ready for the user to commit.

---

### Task 5: Orchestrator (runtime)

**Files:**
- Create: `omi-job-fetch/src/runtime.ts`
- Test: `omi-job-fetch/tests/runtime.test.ts`

**Interfaces:**
- Consumes: `buildInput`, `resolveContract`, `requiredOutputs` from `./contract.js`; `normalizeJob` from `./normalize.js`; `dedupJobs` from `./dedup.js`; `Adapter`, `AdapterStatus`, `ContractInput`, `RunConfig`, `RunSummary` from `./types.js`.
- Produces:
  - `DEFAULT_DEDUP_FIELDS: string[]` (`["title", "company", "location"]`)
  - `timestampId(date: Date): string`
  - `runPipeline(config: RunConfig, cliInput: ContractInput, adapters: Adapter[], options?: { outputDir?: string; now?: Date }): Promise<{ jobsFile: string; runFile: string; summary: RunSummary }>`
  - `exitCode(summary: RunSummary): number`

- [ ] **Step 1: Write the failing test**

`omi-job-fetch/tests/runtime.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEDUP_FIELDS, exitCode, runPipeline } from "../src/runtime.js";
import type { Adapter, RunConfig } from "../src/types.js";

function makeAdapter(
  id: string,
  family: "portal" | "ats",
  jobs: Record<string, unknown>[],
  manifest: Partial<Adapter["manifest"]> = {},
): Adapter {
  return {
    manifest: {
      id,
      family,
      name: id,
      requiredInputs: ["query"],
      optionalInputs: [],
      providedOutputs: ["apply_url", "title", "company", "location"],
      ...manifest,
    },
    async run() {
      return { jobs, meta: { note: "fake" } };
    },
  };
}

function config(enabled: string[]): RunConfig {
  return {
    portals: { enabled, config: {} },
    ats: { enabled: [], config: {} },
    dedup: { fields: DEFAULT_DEDUP_FIELDS },
  };
}

describe("runPipeline", () => {
  it("runs adapters, writes jobs.json and run.json, exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "Grad Program", company: "HSBC", location: "Hong Kong", apply_url: "https://a" },
      ]);
      const result = await runPipeline(config(["gc"]), { query: "grad" }, [adapter], { outputDir: dir });
      expect(result.summary.adapters[0].status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
      const jobs = JSON.parse(await readFile(result.jobsFile, "utf8"));
      expect(jobs[0].source).toBe("gc");
      const runMeta = JSON.parse(await readFile(result.runFile, "utf8"));
      expect(runMeta.contract.inputs.query.required).toBe(true);
      expect(exitCode(result.summary)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues after an adapter error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const bad: Adapter = {
        manifest: { id: "bad", family: "portal", name: "Bad", requiredInputs: ["query"], optionalInputs: [], providedOutputs: [] },
        async run() {
          throw new Error("boom");
        },
      };
      const good = makeAdapter("gc", "portal", [{ title: "T", company: "C", location: "HK", apply_url: "https://a" }]);
      const result = await runPipeline(config(["bad", "gc"]), { query: "q" }, [bad, good], { outputDir: dir });
      const statuses = result.summary.adapters;
      expect(statuses.find((s) => s.adapter === "bad")!.status).toBe("error");
      expect(statuses.find((s) => s.adapter === "bad")!.error).toContain("boom");
      expect(statuses.find((s) => s.adapter === "gc")!.status).toBe("ok");
      expect(result.summary.jobs).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips an adapter whose required input is missing (no fallback)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [], { requiredInputs: ["location"], providedOutputs: [] });
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      const status = result.summary.adapters[0];
      expect(status.status).toBe("skipped");
      expect(status.reason).toContain("location");
      expect(result.summary.jobs).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies a fallback when a required input is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const seen: unknown[] = [];
      const adapter: Adapter = {
        manifest: {
          id: "gc",
          family: "portal",
          name: "GC",
          requiredInputs: ["location"],
          optionalInputs: [],
          providedOutputs: [],
          fallbacks: { location: "HK" },
        },
        async run(ctx) {
          seen.push(ctx.input.location);
          return { jobs: [], meta: {} };
        },
      };
      await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      expect(seen).toEqual(["HK"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedups across adapters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const a = makeAdapter("gc", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://a" }]);
      const b = makeAdapter("jobsdb", "portal", [{ title: "Grad", company: "HSBC", location: "HK", apply_url: "https://b" }]);
      const result = await runPipeline(config(["gc", "jobsdb"]), { query: "q" }, [a, b], { outputDir: dir });
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.duplicatesRemoved).toBe(1);
      const jobs = JSON.parse(await readFile(result.jobsFile, "utf8"));
      expect(jobs[0].sources).toEqual(["gc", "jobsdb"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops jobs missing a required output and counts them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", [
        { title: "T", company: "C", location: "HK", apply_url: "https://a" },
        { title: "NoUrl", company: "C", location: "HK" },
      ]);
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      const status = result.summary.adapters[0];
      expect(status.jobCount).toBe(2);
      expect(status.dropped).toBe(1);
      expect(result.summary.jobs).toBe(1);
      expect(result.summary.dropped).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exitCode is non-zero when nothing produced jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-"));
    try {
      const adapter = makeAdapter("gc", "portal", []);
      const result = await runPipeline(config(["gc"]), { query: "q" }, [adapter], { outputDir: dir });
      expect(exitCode(result.summary)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL with `Cannot find module '../src/runtime.js'`.

- [ ] **Step 3: Write the implementation**

`omi-job-fetch/src/runtime.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildInput, requiredOutputs, resolveContract } from "./contract.js";
import { dedupJobs } from "./dedup.js";
import { normalizeJob } from "./normalize.js";
import type { Adapter, AdapterStatus, ContractInput, RunConfig, RunSummary } from "./types.js";

export const DEFAULT_DEDUP_FIELDS = ["title", "company", "location"];

export interface RunResult {
  jobsFile: string;
  runFile: string;
  summary: RunSummary;
}

/** Deterministic timestamp folder id: 2026-08-17T14-30-00-123Z (no colons/dots). */
export function timestampId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function runPipeline(
  config: RunConfig,
  cliInput: ContractInput,
  adapters: Adapter[],
  options: { outputDir?: string; now?: Date } = {},
): Promise<RunResult> {
  const startedAt = (options.now ?? new Date()).toISOString();
  const contract = resolveContract(config.contract);
  const input = buildInput(contract, cliInput);
  const required = requiredOutputs(contract);

  const enabledIds = new Set([...(config.portals.enabled ?? []), ...(config.ats.enabled ?? [])]);
  const selected = adapters.filter((adapter) => enabledIds.has(adapter.manifest.id));

  const statuses: AdapterStatus[] = [];
  const rawJobs: ContractInput[] = [];

  for (const adapter of selected) {
    const familyConfig = adapter.manifest.family === "portal" ? config.portals.config : config.ats.config;
    const platformConfig = familyConfig?.[adapter.manifest.id] ?? {};

    const missingRequired = adapter.manifest.requiredInputs.filter(
      (key) => input[key] === undefined || input[key] === null,
    );
    const unfillable = missingRequired.filter((key) => !(adapter.manifest.fallbacks && key in adapter.manifest.fallbacks));
    if (unfillable.length > 0) {
      statuses.push({
        adapter: adapter.manifest.id,
        family: adapter.manifest.family,
        status: "skipped",
        reason: `missing required input(s): ${unfillable.join(", ")}`,
      });
      continue;
    }

    const adapterInput: ContractInput = { ...input };
    for (const key of missingRequired) {
      adapterInput[key] = adapter.manifest.fallbacks![key];
    }

    const startedMs = Date.now();
    try {
      const result = await adapter.run({ input: adapterInput, env: process.env, config: platformConfig });
      const durationMs = Date.now() - startedMs;
      const jobs = result.jobs
        .map((job) => normalizeJob(job, adapter.manifest.id, adapter.manifest.providedOutputs, required))
        .filter((job): job is ContractInput => job !== null);
      rawJobs.push(...jobs);
      statuses.push({
        adapter: adapter.manifest.id,
        family: adapter.manifest.family,
        status: "ok",
        jobCount: result.jobs.length,
        dropped: result.jobs.length - jobs.length,
        durationMs,
        ...(result.meta && Object.keys(result.meta).length > 0 ? { meta: result.meta } : {}),
      });
    } catch (error) {
      const durationMs = Date.now() - startedMs;
      statuses.push({
        adapter: adapter.manifest.id,
        family: adapter.manifest.family,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      });
    }
  }

  const dedupFields = config.dedup?.fields ?? DEFAULT_DEDUP_FIELDS;
  const deduped = dedupJobs(rawJobs, dedupFields);
  const duplicatesRemoved = rawJobs.length - deduped.length;

  const outputBase = resolve(options.outputDir ?? "output");
  const runDir = resolve(outputBase, "runs", timestampId(options.now ?? new Date()));
  await mkdir(runDir, { recursive: true });
  const jobsFile = resolve(runDir, "jobs.json");
  const runFile = resolve(runDir, "run.json");
  await writeFile(jobsFile, JSON.stringify(deduped, null, 2), "utf8");

  const summary: RunSummary = {
    contract,
    input,
    startedAt,
    adapters: statuses,
    jobs: deduped.length,
    dropped: statuses.reduce((n, s) => n + (s.dropped ?? 0), 0),
    duplicatesRemoved,
  };
  await writeFile(runFile, JSON.stringify(summary, null, 2), "utf8");

  return { jobsFile, runFile, summary };
}

/** Exit code policy: 0 if >=1 adapter produced jobs, non-zero otherwise. */
export function exitCode(summary: RunSummary): number {
  const anyJobs = summary.adapters.some((status) => status.status === "ok" && (status.jobCount ?? 0) > 0);
  return anyJobs ? 0 : 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime.test.ts`
Expected: PASS (7 tests). Task complete — ready for the user to commit.

---

### Task 6: CLI + registry

**Files:**
- Create: `omi-job-fetch/src/cli.ts`
- Create: `omi-job-fetch/src/registry.ts` (empty adapter list for now)
- Test: `omi-job-fetch/tests/cli.test.ts`

**Interfaces:**
- Consumes: `resolveContract`, `buildInput` from `./contract.js`; `runPipeline`, `exitCode` from `./runtime.js`; `adapters` from `./registry.js`; `RunConfig` from `./types.js`.
- Produces:
  - `coerce(value: unknown): unknown`
  - `parseArgs(argv: string[]): ParsedArgs` (where `ParsedArgs = { flags: Record<string, unknown>; configPath?: string; help: boolean }`)
  - `findConfig(explicit?: string): { path: string; config: RunConfig }`

- [ ] **Step 1: Write the failing test**

`omi-job-fetch/tests/cli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfig, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses --key value flags", () => {
    const { flags, configPath, help } = parseArgs(["--query", "grad program", "--location", "Hong Kong"]);
    expect(flags).toEqual({ query: "grad program", location: "Hong Kong" });
    expect(configPath).toBeUndefined();
    expect(help).toBe(false);
  });

  it("parses --key=value and coerces numbers", () => {
    const { flags } = parseArgs(["--query=grad", "--page", "3"]);
    expect(flags).toEqual({ query: "grad", page: 3 });
  });

  it("captures --config", () => {
    const { configPath } = parseArgs(["--config", "my/config.json", "--query", "x"]);
    expect(configPath).toBe("my/config.json");
  });

  it("treats a flag with no value as boolean true", () => {
    const { flags } = parseArgs(["--sort"]);
    expect(flags.sort).toBe(true);
  });

  it("rejects positional arguments", () => {
    expect(() => parseArgs(["grad"])).toThrow(/Unexpected positional/);
  });
});

describe("findConfig", () => {
  it("loads the config at the explicit path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-cfg-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          portals: { enabled: ["gradconnection"], config: {} },
          ats: { enabled: [], config: {} },
          dedup: { fields: ["title"] },
        }),
      );
      const { config } = findConfig(path);
      expect(config.portals.enabled).toEqual(["gradconnection"]);
      expect(config.dedup.fields).toEqual(["title"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL with `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Write the implementation**

`omi-job-fetch/src/registry.ts`:
```ts
import type { Adapter } from "./types.js";

/** Single place to register adapters. Add new portals/ATS here as they're built. */
export const adapters: Adapter[] = [];
```

`omi-job-fetch/src/cli.ts`:
```ts
#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildInput, resolveContract } from "./contract.js";
import { adapters } from "./registry.js";
import { exitCode, runPipeline } from "./runtime.js";
import type { RunConfig } from "./types.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Coerce obvious types: "true"/"false" -> boolean, number-like strings -> number. */
export function coerce(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export interface ParsedArgs {
  flags: Record<string, unknown>;
  configPath?: string;
  help: boolean;
}

/** Parse CLI flags: --key value, --key=value. A flag with no value is boolean true. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, unknown> = {};
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "help") return { flags, configPath, help: true };
    let value: unknown = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (name === "config") {
      configPath = String(value);
      continue;
    }
    flags[name] = coerce(value);
  }
  return { flags, configPath, help: false };
}

/** Locate + parse config.json: explicit path, else cwd, else package dir. */
export function findConfig(explicit?: string): { path: string; config: RunConfig } {
  const candidates = explicit ? [resolve(explicit)] : [resolve("config.json"), resolve(PACKAGE_DIR, "config.json")];
  for (const path of candidates) {
    if (existsSync(path)) {
      return { path, config: JSON.parse(readFileSync(path, "utf8")) as RunConfig };
    }
  }
  throw new Error("No config.json found. Pass --config <path> or create config.json in cwd.");
}

function printHelp(): void {
  const contract = resolveContract();
  console.log("Usage: omi-job-fetch [options]");
  console.log("Contract input flags:");
  for (const [key, def] of Object.entries(contract.inputs)) {
    console.log(`  --${key}  ${def.required ? "(required) " : ""}default: ${JSON.stringify(def.default ?? null)}`);
  }
  console.log("  --config <path>  Path to config.json (default: cwd or package dir)");
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  const { config } = findConfig(parsed.configPath);
  const contract = resolveContract(config.contract);
  const input = buildInput(contract, parsed.flags);

  const { jobsFile, summary } = await runPipeline(config, input, adapters);
  console.log(`Wrote ${summary.jobs} jobs to ${jobsFile}`);
  for (const s of summary.adapters) {
    const detail =
      s.status === "ok"
        ? ` (${s.jobCount} raw, ${s.dropped ?? 0} dropped)`
        : s.reason
          ? ` — ${s.reason}`
          : s.error
            ? ` — ${s.error}`
            : "";
    console.log(`  [${s.status}] ${s.adapter}${detail}`);
  }
  process.exit(exitCode(summary));
}

// Only run when executed directly (e.g. `node dist/cli.js`), not when imported by tests.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (6 tests). Task complete — ready for the user to commit.

---

### Task 7: GradConnection adapter + fixture

**Files:**
- Create: `omi-job-fetch/src/portals/gradconnection.ts`
- Create: `omi-job-fetch/tests/fixtures/gradconnection-search.json`
- Create: `omi-job-fetch/tests/adapters/gradconnection.test.ts`
- Modify: `omi-job-fetch/src/registry.ts` (register the adapter)

**Interfaces:**
- Consumes: `Adapter`, `AdapterResult`, `AdapterContext` from `../../src/types.js`.
- Produces: `gradConnectionAdapter: Adapter` (id `"gradconnection"`, family `"portal"`, `requiredInputs: ["query"]`, `optionalInputs: ["location", "employment_type", "page"]`, `providedOutputs` = all contract outputs except `source`).

**Endpoint being implemented (verified 2026-08-16, see `docs/portal-research/aggregator-findings.md` §GradConnection):**
`GET https://<country>.gradconnection.com/api/campaignsearch/?query=&job_type=&location=<text>&limit=&offset=` → JSON array of groups, each `{ campaigns: GcCampaign[], customer_organization: { name, slug } }`. Search is API-only (browse pages ignore `query`).

- [ ] **Step 1: Write the fixture**

`omi-job-fetch/tests/fixtures/gradconnection-search.json` — trimmed, representative capture (one real campaign, one event, one "notify me" placeholder). End dates use year 2099 so `is_open` assertions never rot:
```json
[
  {
    "campaigns": [
      {
        "id": "ba203332-7dac-4f0c-a6dc-67feea884367",
        "title": "2027 HSBC Hong Kong CIB Summer Internship Programmes",
        "slug": "hsbc-2027-hsbc-hong-kong-cib-summer-internship-programmes",
        "interval": { "start": "2026-07-15T00:00:50+00:00", "end": "2099-12-31T12:59:00+00:00" },
        "description": "Begin your career in Corporate and Institutional Banking.",
        "is_event": false,
        "target_mode": "url",
        "locations": ["Hong Kong"],
        "job_type": "Internships",
        "item_type": "keyword_searched_campaign",
        "origin_target_url": "https://www.hsbc.com/careers/students-and-graduates/find-a-programme?location=hong-kong-sar&page=1&programme-type=graduate-programme",
        "target_url": "/track-link/55ab35af-19fe-4411-83b4-5bbc8a440f57/"
      }
    ],
    "customer_organization": {
      "id": "74698e2f-9c71-4ba1-8da4-6e3442c685e4",
      "name": "HSBC",
      "slug": "hsbc",
      "login_to_apply_enabled": true
    }
  },
  {
    "campaigns": [
      {
        "id": "886e18f6-bc57-4bc1-9276-bd27211fcb76",
        "title": "HSBC Hong Kong Career Information Session",
        "slug": "hsbc-hsbc-hong-kong-career-information-session-2",
        "interval": { "start": "2026-08-07T02:11:47+00:00", "end": "2026-08-28T13:59:00+00:00" },
        "description": "Join us at HSBC's main office for a career info session.",
        "is_event": true,
        "target_mode": "url",
        "locations": ["Hong Kong"],
        "job_type": "Graduate Jobs",
        "item_type": "keyword_searched_campaign",
        "origin_target_url": "https://forms.monday.com/forms/89ed93e19894f73255c0611d2600e98f?r=use1"
      }
    ],
    "customer_organization": {
      "id": "74698e2f-9c71-4ba1-8da4-6e3442c685e4",
      "name": "HSBC",
      "slug": "hsbc",
      "login_to_apply_enabled": true
    }
  },
  {
    "campaigns": [
      {
        "id": "ff508233-e6d3-4fa8-8069-02dbb9c19ee9",
        "slug": "notify-me-dbs-internships",
        "title": "Notify Me - DBS Internships",
        "description": "Turn on notifications for DBS's Internships.",
        "interval": { "start": "2024-10-17T03:39:28.615129+00:00", "end": null },
        "locations": ["Hong Kong"],
        "job_type": { "id": "69c485e5-b96f-4730-8891-4ecafcae90da", "name": "Internships", "slug": "internships", "count": null },
        "item_type": "notify_me"
      }
    ],
    "customer_organization": {
      "id": "d48b6bf4-2cb2-4b13-9279-404cb46875e8",
      "name": "DBS",
      "slug": "dbs",
      "login_to_apply_enabled": false
    }
  }
]
```

- [ ] **Step 2: Write the failing test**

`omi-job-fetch/tests/adapters/gradconnection.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradConnectionAdapter } from "../../src/portals/gradconnection.js";

function loadFixture(): unknown {
  const path = fileURLToPath(new URL("../fixtures/gradconnection-search.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function mockFetch(respondWith: unknown): { capturedUrl: string | null } {
  const state = { capturedUrl: null as string | null };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    state.capturedUrl = String(input);
    return new Response(JSON.stringify(respondWith), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gradConnectionAdapter", () => {
  it("builds the search URL from contract inputs", async () => {
    const state = mockFetch(loadFixture());
    await gradConnectionAdapter.run({
      input: { query: "finance intern", location: "Hong Kong", employment_type: "internship", page: 2 },
      env: {},
      config: { country: "hk" },
    });
    expect(state.capturedUrl).toContain("https://hk.gradconnection.com/api/campaignsearch/?");
    expect(state.capturedUrl).toContain("query=finance+intern");
    expect(state.capturedUrl).toContain("location=Hong+Kong");
    expect(state.capturedUrl).toContain("job_type=internships");
    expect(state.capturedUrl).toContain("limit=20");
    expect(state.capturedUrl).toContain("offset=20");
  });

  it("maps campaigns to contract fields and filters events + notify-me placeholders", async () => {
    mockFetch(loadFixture());
    const result = await gradConnectionAdapter.run({ input: { query: "finance intern" }, env: {}, config: { country: "hk" } });
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job.title).toBe("2027 HSBC Hong Kong CIB Summer Internship Programmes");
    expect(job.company).toBe("HSBC");
    expect(job.location).toBe("Hong Kong");
    expect(job.apply_url).toBe(
      "https://www.hsbc.com/careers/students-and-graduates/find-a-programme?location=hong-kong-sar&page=1&programme-type=graduate-programme",
    );
    expect(job.external_id).toBe("ba203332-7dac-4f0c-a6dc-67feea884367");
    expect(job.job_page_url).toBe(
      "https://hk.gradconnection.com/employers/hsbc/jobs/hsbc-2027-hsbc-hong-kong-cib-summer-internship-programmes/",
    );
    expect(job.posted_at).toBe("2026-07-15T00:00:50+00:00");
    expect(job.expires_at).toBe("2099-12-31T12:59:00+00:00");
    expect(job.is_open).toBe(true);
    expect(job.employment_type).toBe("Internships");
  });

  it("omits the location param when location is not provided", async () => {
    const state = mockFetch(loadFixture());
    await gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: { country: "hk" } });
    expect(state.capturedUrl).not.toContain("location=");
  });

  it("throws a descriptive error on non-200", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(
      gradConnectionAdapter.run({ input: { query: "x" }, env: {}, config: {} }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/adapters/gradconnection.test.ts`
Expected: FAIL with `Cannot find module '../../src/portals/gradconnection.js'`.

- [ ] **Step 4: Write the implementation**

`omi-job-fetch/src/portals/gradconnection.ts`:
```ts
import type { Adapter, AdapterResult } from "../types.js";

/** Generic employment_type phrases → GradConnection job_type slugs (from /api/jobtypes/). */
const JOB_TYPE_SLUGS: Record<string, string> = {
  internship: "internships",
  intern: "internships",
  internships: "internships",
  graduate: "graduate-jobs",
  "graduate job": "graduate-jobs",
  "graduate jobs": "graduate-jobs",
  "entry-level": "entry-level-jobs",
  "entry level": "entry-level-jobs",
  "part-time": "part-time-student-jobs",
  "part time": "part-time-student-jobs",
};

const SEARCH_LIMIT = 20;

interface GcCampaign {
  id?: string;
  slug?: string;
  title?: string;
  description?: string | null;
  interval?: { start?: string | null; end?: string | null } | null;
  is_event?: boolean;
  item_type?: string;
  origin_target_url?: string | null;
  target_email?: string | null;
  locations?: string[];
  job_type?: string | { name?: string } | null;
}

interface GcGroup {
  campaigns?: GcCampaign[];
  customer_organization?: { name?: string; slug?: string };
}

function toJobTypeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return JOB_TYPE_SLUGS[value.trim().toLowerCase()] ?? null;
}

function normalizeJobType(value: GcCampaign["job_type"]): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) return value.name ?? null;
  return null;
}

export const gradConnectionAdapter: Adapter = {
  manifest: {
    id: "gradconnection",
    family: "portal",
    name: "GradConnection",
    requiredInputs: ["query"],
    optionalInputs: ["location", "employment_type", "page"],
    providedOutputs: [
      "apply_url",
      "job_page_url",
      "external_id",
      "title",
      "company",
      "location",
      "description",
      "posted_at",
      "expires_at",
      "is_open",
      "employment_type",
    ],
    extraInputs: {
      country: { desc: "GradConnection country subdomain (hk, sg, au). Default: hk." },
    },
  },
  async run(ctx): Promise<AdapterResult> {
    const country = String(ctx.config.country ?? "hk");
    const base = `https://${country}.gradconnection.com`;
    const page = Number(ctx.input.page ?? 1);
    const offset = (page - 1) * SEARCH_LIMIT;

    const params = new URLSearchParams();
    if (typeof ctx.input.query === "string" && ctx.input.query.trim()) params.set("query", ctx.input.query.trim());
    if (typeof ctx.input.location === "string" && ctx.input.location.trim()) params.set("location", ctx.input.location.trim());
    const jobTypeSlug = toJobTypeSlug(ctx.input.employment_type);
    if (jobTypeSlug) params.set("job_type", jobTypeSlug);
    params.set("limit", String(SEARCH_LIMIT));
    params.set("offset", String(offset));

    const url = `${base}/api/campaignsearch/?${params.toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GradConnection search failed: HTTP ${res.status} (${url})`);
    const groups = (await res.json()) as GcGroup[];

    const jobs = [];
    for (const group of groups) {
      const employer = group.customer_organization?.name ?? null;
      const employerSlug = group.customer_organization?.slug ?? "";
      for (const campaign of group.campaigns ?? []) {
        // Non-job entries mixed into results: "notify me" placeholders and events.
        if (campaign.item_type !== "keyword_searched_campaign") continue;
        if (campaign.is_event) continue;
        const applyUrl =
          campaign.origin_target_url ?? (campaign.target_email ? `mailto:${campaign.target_email}` : null);
        const slug = campaign.slug ?? "";
        const jobPageUrl = slug && employerSlug ? `${base}/employers/${employerSlug}/jobs/${slug}/` : null;
        const end = campaign.interval?.end ?? null;
        jobs.push({
          title: campaign.title ?? null,
          company: employer,
          location: (campaign.locations ?? []).join(", ") || null,
          description: campaign.description ?? null,
          apply_url: applyUrl,
          job_page_url: jobPageUrl,
          external_id: campaign.id ?? null,
          posted_at: campaign.interval?.start ?? null,
          expires_at: end,
          is_open: end === null ? true : Date.parse(end) > Date.now(),
          employment_type: normalizeJobType(campaign.job_type),
        });
      }
    }

    return {
      jobs,
      meta: {
        country,
        searchUrl: url,
        limit: SEARCH_LIMIT,
        offset,
        note: "Search response only: description is the snippet (full HTML via /api/campaigns/<uuid>/); posted_at = interval.start (programme open date, not posting date); no posted-within filter (GC has no reliable posted date).",
      },
    };
  },
};
```

- [ ] **Step 5: Register the adapter**

Replace the body of `omi-job-fetch/src/registry.ts`:
```ts
import { gradConnectionAdapter } from "./portals/gradconnection.js";
import type { Adapter } from "./types.js";

/** Single place to register adapters. Add new portals/ATS here as they're built. */
export const adapters: Adapter[] = [gradConnectionAdapter];
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/adapters/gradconnection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors. Task complete — ready for the user to commit.

---

### Task 8: End-to-end verification + README

**Files:**
- Create: `omi-job-fetch/README.md`

**Interfaces:**
- Consumes: the built CLI (`dist/cli.js`).

- [ ] **Step 1: Write the README**

`omi-job-fetch/README.md`:
```markdown
# omi-job-fetch

Deterministic, programmatic job retrieval from aggregator portals and ATS backends.
Replaces the `run_job_digest.py` scraping layer. No browser automation, no AI in the retrieval loop.

## Install & build

```bash
npm install
npm run build
```

## Run

```bash
node dist/cli.js --query "graduate program" --location "Hong Kong"
```

Prints the path to `output/runs/<timestamp>/jobs.json` — an array of deduped jobs
(contract outputs + any adapter extras + a `sources` array). Each run also writes
`run.json` with the effective contract, per-adapter status, and dedup stats.

## Config

`config.json` controls:

- `portals.enabled` / `ats.enabled` — which adapters run. ATS adapters are a future
  named-employer mode (`ats.config.<id>.companies`); v1 ships portals only.
- `contract.inputs` — override required/default flags, or add brand-new input fields
  (each becomes a `--<name>` CLI flag).
- `dedup.fields` — fields used for the cross-source signature hash
  (default: `["title", "company", "location"]`).

Credentials are read from `$env:VAR` by adapters; never put them in config.json.
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/cli.js` (and other modules) emitted with no errors.

- [ ] **Step 3: Live smoke run (requires network — best effort)**

Run from `omi-job-fetch/`:
`node dist/cli.js --query "graduate program" --location "Hong Kong"`
Expected: prints `Wrote N jobs to .../output/runs/<timestamp>/jobs.json` and a line `[ok] gradconnection (M raw, K dropped)`. If the network is blocked or GradConnection returns an error, the run must still complete and exit non-zero with `[error] gradconnection — <message>` in the log (that is the designed failure path).

- [ ] **Step 4: Offline CLI check (no network needed)**

Run: `node dist/cli.js --help`
Expected: prints the contract input flags and `--config` usage.

Task complete — the PoC pipeline is done. Ready for the user to review and commit.

---

## Self-review notes

- **Spec coverage:** package scaffold (§2), contract + overrides (§4), config.json (§5), CLI (§6), adapter interface/manifest-check (§3, §7), normalize (§8), dedup (§9), timestamped run output + run.json (§10), per-adapter error isolation + exit codes (§11), vitest + fixture-replay tests (§12), PoC GradConnection adapter (§13). All spec sections map to a task.
- **Type consistency:** `Adapter.manifest` fields are produced in Task 1 and consumed identically in Tasks 5–7. `normalizeJob`'s `required` parameter is wired to `requiredOutputs(contract)` in `runtime.ts`. Dedup fields default to the `DEFAULT_DEDUP_FIELDS` constant used by both `runtime.ts` and the runtime tests. `runPipeline` options (`outputDir`, `now`) are optional and covered by tests that pass a temp dir.
- **No placeholders:** every step contains real code and exact commands with expected output.
