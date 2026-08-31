import type { RunConfig } from "./types.js";

/** Default required outputs — a job missing one of these is dropped by the normalizer. */
export const DEFAULT_REQUIRED_OUTPUTS = ["apply_url", "title", "company", "location", "source"];

/** Required outputs from config.outputs.required, or the defaults when unset. */
export function requiredOutputs(config: RunConfig): string[] {
  const required = config.outputs?.required;
  return Array.isArray(required) ? required : DEFAULT_REQUIRED_OUTPUTS;
}
