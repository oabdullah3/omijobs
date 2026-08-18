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
