import type { DedupedCase, Job } from "./types.js";

/** Best link for manual review of a job: apply_url, else job_page_url, else null. */
export function linkOf(job: Job): string | null {
  return (
    (typeof job.apply_url === "string" && job.apply_url.trim()) ||
    (typeof job.job_page_url === "string" && job.job_page_url.trim()) ||
    null
  );
}

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
 * accumulates every adapter id that surfaced the same signature. Returns the
 * kept jobs plus a `removed` list (one DedupedCase per discarded duplicate,
 * with both the removed and kept links) for manual review.
 */
export function dedupJobs(
  jobs: Job[],
  fields: string[],
): { kept: Job[]; removed: DedupedCase[] } {
  const seen = new Map<string, Job>();
  const kept: Job[] = [];
  const removed: DedupedCase[] = [];
  for (const job of jobs) {
    const sig = signature(job, fields);
    if (sig === "") {
      job.sources = job.source ? [String(job.source)] : [];
      kept.push(job);
      continue;
    }
    const existing = seen.get(sig);
    if (existing) {
      removed.push({
        title: job.title ?? null,
        company: job.company ?? null,
        link: linkOf(job),
        keptLink: linkOf(existing),
      });
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
  return { kept, removed };
}
