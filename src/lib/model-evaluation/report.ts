import type { ModelEvaluationRun } from "@prisma/client";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ModelEvaluationExport,
  ModelEvaluationMetrics,
  ModelEvaluationSummary,
} from "@/src/lib/model-evaluation/types";

type EvaluationRunRecord = Pick<
  ModelEvaluationRun,
  "id" | "modelVersion" | "status" | "datasetHash" | "configJson" | "error" | "startedAt" | "completedAt"
>;

export function parseModelEvaluationConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function modelEvaluationConfigHash(configJson: string) {
  const config = parseModelEvaluationConfig(configJson);
  delete config.codeRevision;
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

export function summarizeModelEvaluation(
  run: EvaluationRunRecord,
  metrics: ModelEvaluationMetrics | null,
): ModelEvaluationSummary {
  const config = parseModelEvaluationConfig(run.configJson);
  const selected = metrics?.combinedTrading;
  const rejectedAudit = selected?.closestHoldoutAudit ?? null;
  const useRejectedAudit = Boolean(rejectedAudit && rejectedAudit.trades > 0 && (selected?.trades ?? 0) === 0);
  const display = useRejectedAudit ? rejectedAudit : selected;
  const qualityStatus = run.status === "failed"
    ? "failed"
    : run.status === "running"
      ? "running"
      : metrics?.quality?.status ?? "inconclusive";

  return {
    schemaVersion: "model-evaluation-summary-v1",
    id: run.id,
    modelVersion: run.modelVersion,
    status: run.status,
    datasetHash: run.datasetHash,
    configHash: modelEvaluationConfigHash(run.configJson),
    codeRevision: typeof config.codeRevision === "string" ? config.codeRevision : null,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs: run.completedAt ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime()) : null,
    qualityStatus,
    methodology: metrics?.methodology ?? null,
    primaryHorizonHours: metrics?.horizonHours ?? null,
    selectedStrategy: selected?.selectedStrategy?.id ?? null,
    selectedFromValidation: selected?.selectedFromValidation ?? false,
    dataset: {
      totalEvents: metrics?.dataset?.totalEvents ?? 0,
      testEvents: metrics?.dataset?.testEvents ?? 0,
      totalMarkets: metrics?.dataset?.totalMarkets ?? 0,
      testMarkets: metrics?.dataset?.testMarkets ?? 0,
      firstEndAt: metrics?.dataset?.firstEndAt ?? null,
      lastEndAt: metrics?.dataset?.lastEndAt ?? null,
      testExecutionFeatureCoverage: metrics?.dataset?.testExecutionFeatureCoverage ?? null,
      testSynchronizedExecutionCoverage: metrics?.dataset?.testSynchronizedExecutionCoverage ?? null,
    },
    result: {
      source: useRejectedAudit
        ? "closest-rejected-candidate"
        : selected
          ? "selected-strategy"
          : "unavailable",
      strategy: useRejectedAudit ? rejectedAudit?.strategy?.id ?? null : selected?.selectedStrategy?.id ?? null,
      trades: display?.trades ?? 0,
      netReturnPct: display?.netReturnPct ?? null,
      benchmarkReturnPct: display?.benchmarkReturnPct ?? null,
      benchmarkLabel: selected?.benchmarks?.bestLabel ?? null,
      excessReturnPct: display?.excessReturnPct ?? null,
      winRate: display?.winRate ?? null,
      maxDrawdownPct: display?.maxDrawdownPct ?? null,
      confidenceInterval95: useRejectedAudit
        ? rejectedAudit?.returnConfidenceInterval95 ?? null
        : selected?.returnConfidenceInterval95 ?? null,
      deflatedSharpeProbability: display?.deflatedSharpeProbability ?? null,
      statisticallyPositive: display?.statisticallyPositive ?? false,
    },
    costs: {
      initialCapital: selected?.initialCapital ?? null,
      totalFees: selected?.totalFees ?? null,
      totalSpread: selected?.totalSpread ?? null,
      totalSlippage: selected?.totalSlippage ?? null,
      totalFunding: selected?.totalFunding ?? null,
    },
    validation: {
      strategyTrials: selected?.strategyTrials ?? 0,
      walkForwardFolds: selected?.walkForwardFolds ?? 0,
      profitableValidationFolds: selected?.profitableValidationFolds ?? 0,
      passedGates: metrics?.quality?.gates?.filter((gate) => gate.passed).length ?? 0,
      totalGates: metrics?.quality?.gates?.length ?? 0,
    },
    horizons: Array.isArray(metrics?.horizonStudies) ? metrics.horizonStudies : [],
    error: run.error,
  };
}

export function createModelEvaluationExport(
  run: EvaluationRunRecord,
  metrics: ModelEvaluationMetrics | null,
  exportedAt = new Date(),
): ModelEvaluationExport {
  return {
    schemaVersion: "model-evaluation-report-v1",
    exportedAt: exportedAt.toISOString(),
    summary: summarizeModelEvaluation(run, metrics),
    config: parseModelEvaluationConfig(run.configJson),
    metrics,
  };
}

export function modelEvaluationSummariesCsv(items: ModelEvaluationSummary[]) {
  const headers = [
    "run_id", "completed_at", "status", "quality_status", "model_version", "code_revision",
    "dataset_hash", "config_hash", "horizon_hours", "test_events", "result_source", "strategy",
    "trades", "net_return_pct", "benchmark_return_pct", "excess_return_pct", "win_rate",
    "max_drawdown_pct", "deflated_sharpe_probability", "walk_forward_folds", "profitable_folds",
    "passed_gates", "total_gates", "test_execution_coverage", "test_synchronized_coverage",
  ];
  const rows = items.map((item) => [
    item.id,
    item.completedAt,
    item.status,
    item.qualityStatus,
    item.modelVersion,
    item.codeRevision,
    item.datasetHash,
    item.configHash,
    item.primaryHorizonHours,
    item.dataset.testEvents,
    item.result.source,
    item.result.strategy,
    item.result.trades,
    item.result.netReturnPct,
    item.result.benchmarkReturnPct,
    item.result.excessReturnPct,
    item.result.winRate,
    item.result.maxDrawdownPct,
    item.result.deflatedSharpeProbability,
    item.validation.walkForwardFolds,
    item.validation.profitableValidationFolds,
    item.validation.passedGates,
    item.validation.totalGates,
    item.dataset.testExecutionFeatureCoverage,
    item.dataset.testSynchronizedExecutionCoverage,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function modelEvaluationMarkdown(report: ModelEvaluationExport) {
  const item = report.summary;
  const percent = (value: number | null) => value === null ? "-" : `${(value * 100).toFixed(2)}%`;
  return [
    `# Backtest ${item.id}`,
    "",
    `- Completed: ${item.completedAt ?? "running"}`,
    `- Quality: ${item.qualityStatus}`,
    `- Model: ${item.modelVersion}`,
    `- Code revision: ${item.codeRevision ?? "unknown"}`,
    `- Dataset hash: ${item.datasetHash ?? "unavailable"}`,
    `- Config hash: ${item.configHash}`,
    `- Test events: ${item.dataset.testEvents}`,
    `- Result source: ${item.result.source}`,
    `- Strategy: ${item.result.strategy ?? "unavailable"}`,
    `- Trades: ${item.result.trades}`,
    `- Net return: ${percent(item.result.netReturnPct)}`,
    `- Best benchmark: ${percent(item.result.benchmarkReturnPct)}`,
    `- Excess return: ${percent(item.result.excessReturnPct)}`,
    `- Max drawdown: ${percent(item.result.maxDrawdownPct)}`,
    `- Deflated Sharpe probability: ${percent(item.result.deflatedSharpeProbability)}`,
    "",
    "Full parameters and metrics are stored in report.json. Flat comparison metrics are stored in metrics.csv.",
    "",
  ].join("\n");
}

export async function persistModelEvaluationArtifacts(
  report: ModelEvaluationExport,
  history: ModelEvaluationSummary[],
) {
  const root = process.env.MODEL_EVALUATION_ARTIFACT_DIR?.trim()
    || join(homedir(), ".polymarket-watch", "artifacts", "model-evaluations");
  const runDirectory = join(root, report.summary.id);
  await mkdir(runDirectory, { recursive: true });
  const json = JSON.stringify(report, null, 2) + "\n";
  const csv = modelEvaluationSummariesCsv([report.summary]);
  await Promise.all([
    writeFile(join(runDirectory, "report.json"), json, "utf8"),
    writeFile(join(runDirectory, "metrics.csv"), csv, "utf8"),
    writeFile(join(runDirectory, "README.md"), modelEvaluationMarkdown(report), "utf8"),
    writeFile(join(root, "latest.json"), json, "utf8"),
    writeFile(join(root, "history.csv"), modelEvaluationSummariesCsv(history), "utf8"),
  ]);
  return runDirectory;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
