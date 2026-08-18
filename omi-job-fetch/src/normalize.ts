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
