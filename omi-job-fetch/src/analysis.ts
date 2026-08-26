import { AuthConfigError, extractContract, type ChatMessage } from "./analysisProvider.js";
import { conformingVersion, deleteJobRow, listAnalysisRows, setJobAnalysis } from "./analysisDb.js";
import { errorData, type Logger } from "./logger.js";
import type { AnalysisProviderConfig, ContractField, ExtractionContract } from "./types.js";

export interface AnalysisSummary {
  startedAt: string;
  finishedAt: string;
  outcome: "completed" | "stopped" | "error";
  error: string | null;
  total: number;
  analyzed: number;
  skipped: number;
  failed: number;
  deleted: number;
  provider: string;
  model: string;
}
export interface AnalysisOptions {
  file: string;
  systemPrompt: string;
  descriptionMaxChars: number;
  retentionDays: number;
  contract: ExtractionContract;
  provider: AnalysisProviderConfig;
  now?: () => Date;
  aborted?: () => boolean;
  reanalyze?: boolean;
  callProvider: (messages: ChatMessage[]) => Promise<string>;
  progress?: { line: (text: string) => void; result: (text: string) => void };
  logger?: Logger;
}

function fieldDescription(field: ContractField): string {
  switch (field.kind) {
    case "enum": {
      const list = (field.values ?? []).join(", ");
      return field.multi ? `one or more of: ${list}` : `exactly one of: ${list}`;
    }
    case "list": {
      const lower = field.normalize === "lower" || field.normalize === "canonical-language" || field.normalize === "canonical-license" ? "lowercase " : "";
      return `one or more ${lower}values; free text`;
    }
    case "range": {
      const currency = field.currency ? ` in ${field.currency}` : "";
      const period = field.period ? ` ${field.period}` : "";
      const unit = field.unit ? ` (${field.unit})` : "";
      return `{"min": number, "max": number}${currency}${period}${unit}, when stated`;
    }
    case "number": return "number, when stated";
    case "date": return 'ISO date or "YYYY-MM", when stated';
  }
}

export function extractionBlock(contract: ExtractionContract): string {
  const lines = contract.fields.map((field) => `- ${field.key} (${fieldDescription(field)})`);
  return [
    "Extract the following fields from the job. Only include a field when the job description specifies it; omit it otherwise. Never invent values.",
    ...lines,
    "Respond with ONLY one JSON object and no prose or code fences.",
  ].join("\n");
}

function userPrompt(job: Record<string, unknown>, maxChars: number): string {
  const copy = { ...job, description: typeof job.description === "string" ? job.description.slice(0, maxChars) : job.description };
  return `--- JOB ---\n${JSON.stringify(copy)}`;
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisSummary> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const rows = listAnalysisRows(options.file);
  const summary: AnalysisSummary = { startedAt, finishedAt: startedAt, outcome: "completed", error: null, total: rows.length, analyzed: 0, skipped: 0, failed: 0, deleted: 0, provider: options.provider.id, model: options.provider.model };
  const cutoff = options.retentionDays > 0 ? clock().getTime() - options.retentionDays * 86_400_000 : null;
  const progress = () => options.progress?.line(`${summary.analyzed}/${summary.total} jobs analyzed`);
  const logger = options.logger;
  logger?.info("analysis.started", "analysis started", { file: options.file, provider: options.provider.id, model: options.provider.model, total: rows.length });
  try {
    for (const row of rows) {
      if (options.aborted?.()) { summary.outcome = "stopped"; logger?.warn("analysis.stopped", "stopped"); break; }
      if (row.status !== "unapplied") { summary.skipped++; logger?.debug("analysis.job.skipped", "row not unapplied", { signature: row.signature, status: row.status }); progress(); continue; }
      if (row.analysis !== null) {
        if (!options.reanalyze || conformingVersion(row.analysis, options.contract.schemaVersion)) { summary.skipped++; logger?.debug("analysis.job.skipped", "row already extracted", { signature: row.signature }); progress(); continue; }
      }
      if (cutoff !== null && row.postedAt && !Number.isNaN(Date.parse(row.postedAt)) && Date.parse(row.postedAt) < cutoff) {
        if (deleteJobRow(options.file, row.signature)) { summary.deleted++; logger?.debug("analysis.job.deleted", "row deleted by retention", { signature: row.signature }); }
        progress();
        continue;
      }
      logger?.debug("analysis.job.evaluating", "calling provider", { signature: row.signature });
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: `${options.systemPrompt}\n\n${extractionBlock(options.contract)}` },
          { role: "user", content: userPrompt(row.job, options.descriptionMaxChars) },
        ];
        const result = extractContract(await options.callProvider(messages), options.contract);
        if (!result) { summary.failed++; logger?.warn("analysis.job.failed", "unparseable extraction", { signature: row.signature }); progress(); continue; }
        setJobAnalysis(options.file, row.signature, result);
        summary.analyzed++;
        const fieldCount = Object.keys(result).filter((k) => k !== "schemaVersion" && k !== "unmatched").length;
        logger?.info("analysis.job.analyzed", `extracted ${fieldCount} fields`, { signature: row.signature, schemaVersion: result.schemaVersion });
        progress();
      } catch (error) {
        if (error instanceof AuthConfigError) {
          summary.outcome = "error"; summary.error = error.message;
          logger?.error("analysis.provider.fail", "auth/config error — aborting", errorData(error));
          break;
        }
        summary.failed++;
        logger?.warn("analysis.job.failed", "provider failed", { signature: row.signature, ...errorData(error) });
        progress();
      }
    }
  } finally {
    summary.finishedAt = clock().toISOString();
    if (summary.outcome === "error") logger?.error("analysis.error", "analysis errored", { error: summary.error });
    else if (summary.outcome === "stopped") logger?.warn("analysis.finished", "analysis stopped", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted });
    else logger?.info("analysis.finished", "analysis completed", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted });
    options.progress?.result(`analyzed ${summary.analyzed}, skipped ${summary.skipped}, failed ${summary.failed}, deleted ${summary.deleted}`);
  }
  return summary;
}
