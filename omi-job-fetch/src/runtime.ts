import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requiredOutputs } from "./contract.js";
import { dbFile, DEFAULT_RETENTION_DAYS, syncDb } from "./db.js";
import { dedupJobs, linkOf } from "./dedup.js";
import { normalizeJobWithReason } from "./normalize.js";
import type { Adapter, AdapterStatus, ContractInput, DbStats, DedupedCase, DroppedCase, Job, RunConfig, RunSummary } from "./types.js";

export const DEFAULT_DEDUP_FIELDS = ["title", "company", "location"];

export interface RunResult {
  jobsFile: string;
  runFile: string;
  summary: RunSummary;
}

export interface RunOptions {
  outputDir?: string;
  now?: Date;
  /** Set to "cron" when the cron gateway spawned this run; recorded in run.json. */
  trigger?: string;
  /** Called right before each enabled adapter×query run starts (index 1-based, total = queries × enabled). */
  onAdapterStart?: (index: number, total: number, adapterId: string, query?: string) => void;
  /** Called right after each adapter×query run finishes (ok / skipped / error). */
  onAdapterDone?: (index: number, total: number, status: AdapterStatus, query?: string) => void;
  /** Live progress ticks from an adapter's ctx.log() calls. */
  onProgress?: (adapterId: string, status: string) => void;
}

/**
 * Normalize config.global.queries: accepts a string[] or a comma-separated
 * string; trims each entry, drops empties and exact duplicates.
 */
export function normalizeQueries(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const q = String(item).trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

/** Deterministic timestamp folder id: 2026-08-17T14-30-00-123Z (no colons/dots). */
export function timestampId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function runPipeline(
  config: RunConfig,
  adapters: Adapter[],
  options: RunOptions = {},
): Promise<RunResult> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const required = requiredOutputs(config);
  const queries = normalizeQueries(config.global?.queries);
  if (queries.length === 0) {
    throw new Error('No queries configured — set "global.queries" in config.json (e.g. ["finance intern"]).');
  }

  const enabledIds = new Set([...(config.portals.enabled ?? []), ...(config.ats.enabled ?? [])]);
  const selected = adapters.filter((adapter) => enabledIds.has(adapter.manifest.id));
  const total = selected.length * queries.length;

  // Everything in `global` except the queries list is a pacing/cap knob; it
  // becomes the base platform config, with each adapter block overriding.
  const { queries: _queries, ...globalKnobs } = config.global ?? {};

  const statuses: AdapterStatus[] = [];
  const rawJobs: ContractInput[] = [];
  const droppedCases: DroppedCase[] = [];

  let runIndex = 0;
  for (const query of queries) {
    for (let i = 0; i < selected.length; i++) {
      const adapter = selected[i];
      const index = ++runIndex;
      const familyConfig = adapter.manifest.family === "portal" ? config.portals.config : config.ats.config;
      const adapterBlock = familyConfig?.[adapter.manifest.id] ?? {};

      // Split the adapter block: keys named by the manifest's input lists are
      // search params (→ ctx.input); everything else is a knob (→ ctx.config,
      // overriding the global defaults).
      const inputKeys = new Set([...adapter.manifest.requiredInputs, ...adapter.manifest.optionalInputs]);
      const searchParams: ContractInput = {};
      const adapterKnobs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(adapterBlock)) {
        if (inputKeys.has(key)) searchParams[key] = value;
        else adapterKnobs[key] = value;
      }

      const adapterInput: ContractInput = { query, ...searchParams };
      const platformConfig = { ...globalKnobs, ...adapterKnobs };

      const missingRequired = adapter.manifest.requiredInputs.filter(
        (key) => adapterInput[key] === undefined || adapterInput[key] === null,
      );
      const unfillable = missingRequired.filter((key) => !(adapter.manifest.fallbacks && key in adapter.manifest.fallbacks));
      if (unfillable.length > 0) {
        const status: AdapterStatus = {
          adapter: adapter.manifest.id,
          family: adapter.manifest.family,
          status: "skipped",
          query,
          reason: `missing required input(s): ${unfillable.join(", ")}`,
        };
        options.onAdapterStart?.(index, total, adapter.manifest.id, query);
        options.onAdapterDone?.(index, total, status, query);
        statuses.push(status);
        continue;
      }
      for (const key of missingRequired) {
        adapterInput[key] = adapter.manifest.fallbacks![key];
      }

      options.onAdapterStart?.(index, total, adapter.manifest.id, query);
      const startedMs = Date.now();
      let status: AdapterStatus;
      try {
        const result = await adapter.run({
          input: adapterInput,
          env: process.env,
          config: platformConfig,
          log: (status: string) => options.onProgress?.(adapter.manifest.id, status),
        });
        const durationMs = Date.now() - startedMs;
        const jobs: Job[] = [];
        for (const raw of result.jobs) {
          const normalized = normalizeJobWithReason(
            raw,
            adapter.manifest.id,
            adapter.manifest.providedOutputs,
            required,
          );
          if ("job" in normalized) {
            jobs.push(normalized.job);
          } else {
            droppedCases.push({
              adapter: adapter.manifest.id,
              missing: normalized.missing,
              title: raw.title ?? null,
              link: linkOf(raw),
            });
          }
        }
        rawJobs.push(...jobs);
        status = {
          adapter: adapter.manifest.id,
          family: adapter.manifest.family,
          status: "ok",
          query,
          jobCount: result.jobs.length,
          dropped: result.jobs.length - jobs.length,
          durationMs,
          ...(result.meta && Object.keys(result.meta).length > 0 ? { meta: result.meta } : {}),
        };
        statuses.push(status);
      } catch (error) {
        const durationMs = Date.now() - startedMs;
        status = {
          adapter: adapter.manifest.id,
          family: adapter.manifest.family,
          status: "error",
          query,
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        };
        statuses.push(status);
      }
      options.onAdapterDone?.(index, total, status, query);
    }
  }

  const dedupFields = config.dedup?.fields ?? DEFAULT_DEDUP_FIELDS;
  const { kept: deduped, removed: dedupedCases } = dedupJobs(rawJobs, dedupFields);
  const duplicatesRemoved = dedupedCases.length;

  const outputBase = resolve(options.outputDir ?? config.outputDir ?? "output");
  const runDir = resolve(outputBase, "runs", timestampId(now));
  await mkdir(runDir, { recursive: true });
  const jobsFile = resolve(runDir, "jobs.json");
  const runFile = resolve(runDir, "run.json");
  await writeFile(jobsFile, JSON.stringify(deduped, null, 2), "utf8");

  // Aggregate-DB step: on top of the normal run output, upsert the run's
  // deduped jobs into the DB and expire old rows. Non-fatal — a DB failure
  // surfaces as a warning but never aborts the run.
  let db: DbStats | undefined;
  let dbError: string | undefined;
  if (config.db?.enabled) {
    try {
      db = syncDb(
        dbFile(config, outputBase),
        deduped,
        dedupFields,
        now,
        config.db?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      );
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }
  }

  const summary: RunSummary = {
    queries,
    startedAt,
    adapters: statuses,
    jobs: deduped.length,
    dropped: statuses.reduce((n, s) => n + (s.dropped ?? 0), 0),
    duplicatesRemoved,
    droppedCases,
    dedupedCases,
    ...(db !== undefined ? { db } : {}),
    ...(dbError !== undefined ? { dbError } : {}),
    ...(options.trigger ? { trigger: options.trigger } : {}),
  };
  await writeFile(runFile, JSON.stringify(summary, null, 2), "utf8");

  return { jobsFile, runFile, summary };
}

/** Exit code policy: 0 if >=1 adapter produced jobs, non-zero otherwise. */
export function exitCode(summary: RunSummary): number {
  const anyJobs = summary.adapters.some((status) => status.status === "ok" && (status.jobCount ?? 0) > 0);
  return anyJobs ? 0 : 1;
}
