/** Canonical output keys (see docs/portal-research/plan.md §3). */
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

export type OutputKey = (typeof OUTPUT_KEYS)[number];

/** Search-param record passed to adapters (query, location, …). */
export type ContractInput = Record<string, unknown>;

/** One job, normalized to contract outputs plus any adapter extras. */
export type Job = Record<string, unknown>;

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
  /**
   * Optional abort signal. Adapters poll it inside their sweep and enrichment
   * loops and stop early, returning whatever partial results they collected.
   * Set when the run is stopped from the dashboard (stop button) — the results
   * fetched so far are still written to the DB and the output.
   */
  aborted?: () => boolean;
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
  /**
   * Shared defaults: the `queries` list (each run against every enabled adapter)
   * plus pacing knobs (delayMs, retryBackoffMs, maxPages, detailConcurrency,
   * detailDelayMs) that are merged into every adapter's config. Per-adapter
   * config wins where the two overlap.
   */
  global?: Record<string, unknown>;
  portals: { enabled: string[]; config?: Record<string, Record<string, unknown>> };
  ats: { enabled: string[]; config?: Record<string, Record<string, unknown>> };
  /** Required outputs — a job missing one of these is dropped by the normalizer. */
  outputs?: { required?: string[] };
  dedup: { fields?: string[] };
  /** Where run output lands (default "output"). */
  outputDir?: string;
  /**
   * db — optional aggregate database. Enabled by DEFAULT for every config
   * (`enabled !== false`); the dashboard relies on it. Set `enabled: false`
   * to opt out of DB writes for a config.
   */
  db?: {
    /** Enabled by default (`!== false`); set false to opt out. */
    enabled?: boolean;
    /** DB file path, resolved relative to outputDir. Default "<outputDir>/jobs.db". */
    file?: string;
    /** Expire jobs whose posted_at is older than this many days. Default 30. */
    retentionDays?: number;
  };
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

/** Outcome of one run's aggregate-DB sync. */
export interface DbStats {
  /** Rows inserted (new signatures). */
  added: number;
  /** Existing rows overwritten by this run's fresher copy. */
  updated: number;
  /** Rows deleted by retention (posted_at older than retentionDays). */
  removed: number;
  /** Rows remaining in the table after the sync. */
  total: number;
}

export interface RunSummary {
  /** The query list this run swept (from config.global.queries). */
  queries: string[];
  startedAt: string;
  adapters: AdapterStatus[];
  jobs: number;
  dropped: number;
  duplicatesRemoved: number;
  droppedCases: DroppedCase[];
  dedupedCases: DedupedCase[];
  /** Present when db.enabled — the aggregate-DB sync outcome. */
  db?: DbStats;
  /** Present when db.enabled but the sync failed (the run still succeeds). */
  dbError?: string;
  /** Who started this run: "cron" when spawned by the cron gateway, else omitted (manual). */
  trigger?: string;
  /** True when the run was stopped early (stop button) and only partial results were written. */
  stopped?: boolean;
}

/** A parsed human-friendly schedule: an interval, or a time-of-day on certain days. */
export type CronSchedule =
  | { type: "interval"; minutes: number }
  | { type: "clock"; hour: number; minute: number; days: number[] | null }; // days: 0=Sun..6=Sat, null = every day

export interface CronJob {
  id: string;
  /** Config path passed to `--config` when the job's run is spawned. */
  config: string;
  /** Raw human-friendly schedule string as written in cron.json (validated on load). */
  schedule: string;
  /** Parsed schedule; persisted for display/tools, recomputed from `schedule` on load. */
  parsed: CronSchedule;
  enabled: boolean;
  /** ISO timestamp of the last spawn, or null if never run. */
  lastRun: string | null;
  /** Exit outcome of the last spawn: 0 / error string, or null if never run. */
  lastStatus: string | null;
}

export interface CronFile {
  /** Master switch — `cron pause` / `cron resume`. */
  paused: boolean;
  jobs: CronJob[];
}
