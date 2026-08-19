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
  /**
   * Optional progress sink. Adapters call it with a one-line status at sweep-page
   * boundaries and enrichment milestones; the CLI renders it as a calm live line.
   */
  log?: (status: string) => void;
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
  /** The query this run was for — set when the pipeline runs multiple queries. */
  query?: string;
  reason?: string;
  jobCount?: number;
  dropped?: number;
  error?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

/** A job dropped by normalization: which required outputs were missing, plus its link for manual review. */
export interface DroppedCase {
  adapter: string;
  missing: string[];
  title: unknown;
  link: string | null;
}

/** A job removed by content-signature dedup, and the kept job it was folded into. */
export interface DedupedCase {
  title: unknown;
  company: unknown;
  link: string | null;
  keptLink: string | null;
}

export interface RunSummary {
  contract: EffectiveContract;
  input: ContractInput;
  startedAt: string;
  adapters: AdapterStatus[];
  jobs: number;
  dropped: number;
  duplicatesRemoved: number;
  droppedCases: DroppedCase[];
  dedupedCases: DedupedCase[];
}
