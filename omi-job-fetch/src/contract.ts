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
