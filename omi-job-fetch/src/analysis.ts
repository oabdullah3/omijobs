import { AuthConfigError, extractScoreReason, type ChatMessage } from "./analysisProvider.js";
import { deleteJobRow, listAnalysisRows, setJobAnalysis } from "./analysisDb.js";
import { errorData, type Logger } from "./logger.js";
import type { AnalysisProviderConfig } from "./types.js";

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
  recommended: number;
  instructions: string;
  provider: string;
  model: string;
}
export interface AnalysisOptions {
  file: string;
  instructions: string;
  systemPrompt: string;
  descriptionMaxChars: number;
  retentionDays: number;
  threshold: number;
  provider: AnalysisProviderConfig;
  now?: () => Date;
  aborted?: () => boolean;
  callProvider: (messages: ChatMessage[]) => Promise<string>;
  progress?: { line: (text: string) => void; result: (text: string) => void };
  logger?: Logger;
}

function jobPrompt(job: Record<string, unknown>, instructions: string, maxChars: number): ChatMessage[] {
  const copy = { ...job, description: typeof job.description === "string" ? job.description.slice(0, maxChars) : job.description };
  return [{ role: "system", content: undefined as never }, { role: "user", content: `user: ${instructions}\n\n--- JOB ---\n${JSON.stringify(copy)}` }];
}

export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisSummary> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const rows = listAnalysisRows(options.file);
  const summary: AnalysisSummary = { startedAt, finishedAt: startedAt, outcome: "completed", error: null, total: rows.length, analyzed: 0, skipped: 0, failed: 0, deleted: 0, recommended: 0, instructions: options.instructions, provider: options.provider.id, model: options.provider.model };
  const cutoff = options.retentionDays > 0 ? clock().getTime() - options.retentionDays * 86_400_000 : null;
  const progress = () => options.progress?.line(`${summary.analyzed}/${summary.total} jobs analyzed`);
  const logger = options.logger;
  logger?.info("analysis.started", "analysis started", { file: options.file, provider: options.provider.id, model: options.provider.model, total: rows.length });
  try {
    for (const row of rows) {
      if (options.aborted?.()) { summary.outcome = "stopped"; logger?.warn("analysis.stopped", "stopped"); break; }
      if (row.analysis !== null && row.analysis !== undefined) { summary.skipped++; logger?.debug("analysis.job.skipped", "row already analyzed", { signature: row.signature }); progress(); continue; }
      if (cutoff !== null && row.postedAt && !Number.isNaN(Date.parse(row.postedAt)) && Date.parse(row.postedAt) < cutoff) {
        if (deleteJobRow(options.file, row.signature)) { summary.deleted++; logger?.debug("analysis.job.deleted", "row deleted by retention", { signature: row.signature }); }
        progress();
        continue;
      }
      logger?.debug("analysis.job.evaluating", "calling provider", { signature: row.signature });
      try {
        const messages = jobPrompt(row.job, options.instructions, options.descriptionMaxChars);
        messages[0].content = options.systemPrompt;
        const verdict = extractScoreReason(await options.callProvider(messages));
        if (!verdict) { summary.failed++; logger?.warn("analysis.job.failed", "unparseable verdict", { signature: row.signature }); progress(); continue; }
        setJobAnalysis(options.file, row.signature, verdict);
        summary.analyzed++;
        if (verdict.score >= options.threshold) summary.recommended++;
        logger?.info("analysis.job.analyzed", `scored ${verdict.score}`, { signature: row.signature, score: verdict.score });
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
    else if (summary.outcome === "stopped") logger?.warn("analysis.finished", "analysis stopped", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted, recommended: summary.recommended });
    else logger?.info("analysis.finished", "analysis completed", { analyzed: summary.analyzed, skipped: summary.skipped, failed: summary.failed, deleted: summary.deleted, recommended: summary.recommended });
    options.progress?.result(`analyzed ${summary.analyzed}, skipped ${summary.skipped}, failed ${summary.failed}, deleted ${summary.deleted} · ${summary.recommended} recommended`);
  }
  return summary;
}
