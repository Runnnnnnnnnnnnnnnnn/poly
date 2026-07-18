import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const forwardExecutionAuditReportSchemaVersion = 3;

export type ForwardExecutionAuditReportInput = {
  generatedAt: string;
  codeRevision: string | null;
  cohort: {
    experimentKey: string | null;
    modelVersion: string | null;
    specificationHash: string | null;
    startedAt: string | null;
  };
  audit: {
    status: string;
    readinessStatus: string;
    collectionStartedAt: string | null;
    eligiblePositions: number;
    auditedPositions: number;
    coverage: number;
    verifiedPositions: number;
    verifiedIndependentEvents: number;
    verifiedCoverage: number;
    directionCoverage: {
      minimumIndependentEventsPerSide: number;
      longIndependentEvents: number;
      shortIndependentEvents: number;
      passed: boolean;
    };
    portfolioNetReturnPct: number | null;
    benchmarkReturnPct: number | null;
    benchmarkLabel: string | null;
    excessReturnPct: number | null;
    excessConfidenceInterval95: [number, number] | null;
    deflatedSharpeProbability: number | null;
    maxDrawdownPct: number;
    controlCoverage: number;
    currentlyPassingReadinessGates: number;
    evaluatedReadinessGates: number;
    passedReadinessGates: number;
    totalReadinessGates: number;
    readinessGates: Array<{ id: string; label: string; state: string; passed: boolean }>;
    missingEntry: number;
    missingExit: number;
    missingResolution: number;
    maximumTimingErrorMs: number | null;
    allowedTimingErrorMs: number;
    maximumPolymarketQuoteAgeMs: number | null;
    allowedPolymarketQuoteAgeMs: number;
  };
  settlementResolution: {
    status: string;
    completeMarkets: number;
    missingBoundaryMarkets: number;
    matchedMarkets: number;
    mismatchedMarkets: number;
    coverage: number;
  } | null;
  synchronizedQuality: {
    status: string;
    durationHours: number;
    coverage: number;
    p95SkewMs: number | null;
    passedGates: number;
    totalGates: number;
  } | null;
};

export type ForwardExecutionAuditReport = ReturnType<typeof buildReport>;

export async function persistForwardExecutionAuditReport(
  input: ForwardExecutionAuditReportInput,
  options: { artifactRoot?: string; historyLimit?: number } = {},
) {
  const independentEvents = input.audit.verifiedIndependentEvents;
  if (independentEvents <= 0) {
    return { written: false as const, reason: "no-independent-events" as const, independentEvents, runId: null };
  }
  const artifactRoot = resolve(
    (options.artifactRoot ?? process.env.FORWARD_EXECUTION_AUDIT_ARTIFACT_ROOT
      ?? `${homedir()}/.polymarket-watch/artifacts/forward-execution-audits`)
      .replace(/^~(?=\/)/, homedir()),
  );
  const cohortId = sha256(JSON.stringify({
    ...input.cohort,
    collectionStartedAt: input.audit.collectionStartedAt,
  })).slice(0, 20);
  const fingerprintSha256 = sha256(JSON.stringify({
    schemaVersion: forwardExecutionAuditReportSchemaVersion,
    cohortId,
    codeRevision: input.codeRevision,
    audit: input.audit,
  }));
  const latestPath = resolve(artifactRoot, "latest.json");
  const latest = await readJson<ForwardExecutionAuditReport>(latestPath).catch(() => null);
  if (latest?.reproducibility.fingerprintSha256 === fingerprintSha256) {
    return {
      written: false as const,
      reason: "unchanged" as const,
      independentEvents,
      runId: latest.reproducibility.runId,
    };
  }

  const runId = `${cohortId}-${String(independentEvents).padStart(3, "0")}-${fingerprintSha256.slice(0, 10)}`;
  const report = buildReport(input, { cohortId, fingerprintSha256, runId });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const metrics = metricsCsv(report);
  const runDirectory = resolve(artifactRoot, runId);
  await Promise.all([
    writeAtomic(resolve(runDirectory, "report.json"), serialized),
    writeAtomic(resolve(runDirectory, "metrics.csv"), metrics),
  ]);

  const historyPath = resolve(artifactRoot, "history.json");
  const currentHistory = await readJson<{ items?: ReturnType<typeof historyItem>[] }>(historyPath).catch(() => null);
  const items = [historyItem(report), ...(currentHistory?.items ?? [])]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.runId === item.runId) === index)
    .slice(0, Math.max(10, options.historyLimit ?? 200));
  await writeAtomic(historyPath, `${JSON.stringify({ items }, null, 2)}\n`);
  await Promise.all([
    writeAtomic(latestPath, serialized),
    writeAtomic(resolve(artifactRoot, "latest-metrics.csv"), metrics),
  ]);

  return { written: true as const, reason: "new-result" as const, independentEvents, runId };
}

function buildReport(
  input: ForwardExecutionAuditReportInput,
  identity: { cohortId: string; fingerprintSha256: string; runId: string },
) {
  return {
    schemaVersion: forwardExecutionAuditReportSchemaVersion,
    generatedAt: input.generatedAt,
    purpose: "Polymarketの15分予測を使ったHyperliquid売買モデルの固定フォワード監査" as const,
    cohort: input.cohort,
    result: {
      ...input.audit,
      minimumAdditionalPerfectPositionsFor95PctCoverage: minimumAdditionalPerfectPositionsForCoverage(
        input.audit.eligiblePositions,
        input.audit.verifiedPositions,
        0.95,
      ),
    },
    evidence: {
      settlementResolution: input.settlementResolution,
      synchronizedQuality: input.synchronizedQuality,
    },
    reproducibility: {
      runId: identity.runId,
      cohortId: identity.cohortId,
      codeRevision: input.codeRevision,
      fingerprintSha256: identity.fingerprintSha256,
    },
  };
}

function historyItem(report: ForwardExecutionAuditReport) {
  return {
    schemaVersion: report.schemaVersion,
    runId: report.reproducibility.runId,
    cohortId: report.reproducibility.cohortId,
    generatedAt: report.generatedAt,
    codeRevision: report.reproducibility.codeRevision,
    modelVersion: report.cohort.modelVersion,
    specificationHash: report.cohort.specificationHash,
    status: report.result.readinessStatus,
    verifiedPositions: report.result.verifiedPositions,
    eligiblePositions: report.result.eligiblePositions,
    auditedPositions: report.result.auditedPositions,
    executionCoverage: report.result.coverage,
    missingExecutionTicks: report.result.missingEntry + report.result.missingExit,
    minimumAdditionalPerfectPositionsFor95PctCoverage: report.result.minimumAdditionalPerfectPositionsFor95PctCoverage,
    independentEvents: report.result.verifiedIndependentEvents,
    longIndependentEvents: report.result.directionCoverage.longIndependentEvents,
    shortIndependentEvents: report.result.directionCoverage.shortIndependentEvents,
    portfolioNetReturnPct: report.result.portfolioNetReturnPct,
    benchmarkReturnPct: report.result.benchmarkReturnPct,
    excessReturnPct: report.result.excessReturnPct,
    confidenceLowerPct: report.result.excessConfidenceInterval95?.[0] ?? null,
    maxDrawdownPct: report.result.maxDrawdownPct,
    passedGates: report.result.passedReadinessGates,
    totalGates: report.result.totalReadinessGates,
  };
}

function metricsCsv(report: ForwardExecutionAuditReport) {
  const settlement = report.evidence.settlementResolution;
  const quality = report.evidence.synchronizedQuality;
  const values: Array<[string, string | number | boolean | null]> = [
    ["report_schema_version", report.schemaVersion],
    ["eligible_positions", report.result.eligiblePositions],
    ["audited_positions", report.result.auditedPositions],
    ["execution_coverage", report.result.coverage],
    ["verified_positions", report.result.verifiedPositions],
    ["verified_independent_events", report.result.verifiedIndependentEvents],
    ["verified_coverage", report.result.verifiedCoverage],
    ["long_independent_events", report.result.directionCoverage.longIndependentEvents],
    ["short_independent_events", report.result.directionCoverage.shortIndependentEvents],
    ["direction_coverage_passed", report.result.directionCoverage.passed],
    ["portfolio_net_return_pct", report.result.portfolioNetReturnPct],
    ["benchmark_return_pct", report.result.benchmarkReturnPct],
    ["excess_return_pct", report.result.excessReturnPct],
    ["excess_confidence_lower_pct", report.result.excessConfidenceInterval95?.[0] ?? null],
    ["excess_confidence_upper_pct", report.result.excessConfidenceInterval95?.[1] ?? null],
    ["deflated_sharpe_probability", report.result.deflatedSharpeProbability],
    ["max_drawdown_pct", report.result.maxDrawdownPct],
    ["control_coverage", report.result.controlCoverage],
    ["currently_passing_gates", report.result.currentlyPassingReadinessGates],
    ["evaluated_gates", report.result.evaluatedReadinessGates],
    ["passed_gates", report.result.passedReadinessGates],
    ["total_gates", report.result.totalReadinessGates],
    ["missing_entry_ticks", report.result.missingEntry],
    ["missing_exit_ticks", report.result.missingExit],
    ["missing_resolutions", report.result.missingResolution],
    ["minimum_additional_perfect_positions_for_95pct_coverage", report.result.minimumAdditionalPerfectPositionsFor95PctCoverage],
    ["maximum_timing_error_ms", report.result.maximumTimingErrorMs],
    ["allowed_timing_error_ms", report.result.allowedTimingErrorMs],
    ["maximum_polymarket_quote_age_ms", report.result.maximumPolymarketQuoteAgeMs],
    ["allowed_polymarket_quote_age_ms", report.result.allowedPolymarketQuoteAgeMs],
    ["settlement_complete_markets", settlement?.completeMarkets ?? null],
    ["settlement_missing_boundary_markets", settlement?.missingBoundaryMarkets ?? null],
    ["settlement_mismatched_markets", settlement?.mismatchedMarkets ?? null],
    ["settlement_coverage", settlement?.coverage ?? null],
    ["synchronized_duration_hours", quality?.durationHours ?? null],
    ["synchronized_coverage", quality?.coverage ?? null],
    ["synchronized_p95_skew_ms", quality?.p95SkewMs ?? null],
    ["synchronized_passed_gates", quality?.passedGates ?? null],
    ["synchronized_total_gates", quality?.totalGates ?? null],
  ];
  return `metric,value\n${values.map(([key, value]) => `${key},${csvCell(value)}`).join("\n")}\n`;
}

function csvCell(value: string | number | boolean | null) {
  if (value === null) return "";
  const normalized = String(value);
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeAtomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function minimumAdditionalPerfectPositionsForCoverage(
  eligiblePositions: number,
  auditedPositions: number,
  targetCoverage: number,
) {
  if (targetCoverage <= 0 || targetCoverage >= 1) throw new RangeError("target coverage must be between 0 and 1");
  const eligible = Math.max(0, Math.floor(eligiblePositions));
  const audited = Math.min(eligible, Math.max(0, Math.floor(auditedPositions)));
  return Math.max(0, Math.ceil(((targetCoverage * eligible) - audited) / (1 - targetCoverage)));
}
