import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildInput, requiredOutputs, resolveContract } from "./contract.js";
import { dedupJobs, linkOf } from "./dedup.js";
import { normalizeJobWithReason } from "./normalize.js";
import type { Adapter, AdapterStatus, ContractInput, DedupedCase, DroppedCase, Job, RunConfig, RunSummary } from "./types.js";

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
  const droppedCases: DroppedCase[] = [];

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
  const { kept: deduped, removed: dedupedCases } = dedupJobs(rawJobs, dedupFields);
  const duplicatesRemoved = dedupedCases.length;

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
    droppedCases,
    dedupedCases,
  };
  await writeFile(runFile, JSON.stringify(summary, null, 2), "utf8");

  return { jobsFile, runFile, summary };
}

/** Exit code policy: 0 if >=1 adapter produced jobs, non-zero otherwise. */
export function exitCode(summary: RunSummary): number {
  const anyJobs = summary.adapters.some((status) => status.status === "ok" && (status.jobCount ?? 0) > 0);
  return anyJobs ? 0 : 1;
}
