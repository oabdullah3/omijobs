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
  const result = normalizeJobWithReason(raw, adapterId, providedOutputs, required);
  return "job" in result ? result.job : null;
}

/**
 * Like normalizeJob, but reports the reason a job was dropped: the required
 * outputs that were null/empty after normalization. `.job` is the normalized
 * job when it survives, `.missing` the missing fields when it doesn't.
 */
export function normalizeJobWithReason(
  raw: Record<string, unknown>,
  adapterId: string,
  providedOutputs: OutputKey[],
  required: string[],
): { job: Record<string, unknown> } | { missing: string[] } {
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
  const missing = required.filter((key) => {
    const value = out[key];
    return value === null || value === undefined || value === "";
  });
  return missing.length > 0 ? { missing } : { job: out };
}
