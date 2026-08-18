# omi-job-fetch

Deterministic, programmatic job retrieval from aggregator portals and ATS backends.
Replaces the `run_job_digest.py` scraping layer. No browser automation, no AI in the retrieval loop.

## Install & build

```bash
npm install
npm run build
```

## Run

```bash
node dist/cli.js --query "graduate program" --location "Hong Kong"
```

Prints the path to `output/runs/<timestamp>/jobs.json` — an array of deduped jobs
(contract outputs + any adapter extras + a `sources` array). Each run also writes
`run.json` with the effective contract, per-adapter status, and dedup stats.

## Config

`config.json` controls:

- `portals.enabled` / `ats.enabled` — which adapters run. ATS adapters are a future
  named-employer mode (`ats.config.<id>.companies`); v1 ships portals only.
- `contract.inputs` — override required/default flags, or add brand-new input fields
  (each becomes a `--<name>` CLI flag).
- `dedup.fields` — fields used for the cross-source signature hash
  (default: `["title", "company", "location"]`).

Credentials are read from `$env:VAR` by adapters; never put them in config.json.
