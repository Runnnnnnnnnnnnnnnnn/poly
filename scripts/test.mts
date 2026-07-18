import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calculateBacktestMetrics } from "../src/lib/backtest/metrics";
import { calculateCaptureSkewMs } from "../src/lib/backtest/service";
import {
  aggregateHyperliquidFills,
  compareTestnetOpenOrders,
  compareTestnetPositions,
  deriveHyperliquidCloid,
  evaluateHyperliquidTestnetVerificationReadiness,
  evaluateTestnetAccountSafety,
  HyperliquidDefinitiveOrderError,
  normalizeExchangeOrderStatus,
  normalizeHyperliquidFillAgainstRequestedQuantity,
  normalizeTestnetSmokeOrderSize,
  parseHyperliquidOrderEvidence,
  planTestnetReconciliationBatches,
  performHyperliquidTestnetEmergencyCleanup,
} from "../src/lib/combined-trading/hyperliquid-execution";
import { calculatePriceBasisPct } from "../src/lib/combined-trading/polymarket-reference";
import { calculateShortTermImpliedSignal } from "../src/lib/combined-trading/short-term-implied-signal";
import { authorizeApiRequest, requiredApiAccess, resolveViewerAccessToken } from "../src/lib/server/api-access";
import { createAsyncStaleWhileRevalidateCache } from "../src/lib/server/async-swr-cache";
import { selectCombinedSignalScan, type CombinedSignalScan } from "../src/lib/combined-trading/live-signal";
import { applyCombinedSignalRule, calculateCombinedClose, selectCombinedSignalCandidate, type CombinedShadowConfig, validateFrozenExperimentConfig } from "../src/lib/combined-trading/service";
import {
  isShortTermDecisionWindow,
  isShortTermDirectionControlKey,
  isShortTermDirectionFamilyKey,
  isShortTermDirectionStrategyKey,
  selectCausalStartPrice,
  selectLatestSynchronizedDecisionTick,
  shortTermDirectionControlKey,
  shortTermDirectionSpecificationHash,
  shortTermDirectionStrategyKey,
} from "../src/lib/combined-trading/short-term-direction";
import {
  evaluateForwardExperiment,
  forwardControlExperimentKey,
  forwardObservationHorizons,
  forwardStrategyExperimentKey,
  isForwardControlExperimentKey,
  isForwardStrategyExperimentKey,
  type ForwardEvaluationPosition,
} from "../src/lib/combined-trading/forward-evaluation";
import { planAlertDeliveries } from "../src/lib/monitoring/alert-state";
import { evaluateBackupStatus } from "../src/lib/monitoring/backup-status";
import { isTransientHeartbeatWriteError } from "../src/lib/monitoring/heartbeat";
import { evaluatePipelineAlerts, evaluateSettlementBasisAlerts, evaluateSettlementResolutionAlerts, evaluateTestnetReconciliationAlerts } from "../src/lib/monitoring/operational-alerts";
import { evaluateSynchronizedPriceQuality, synchronizedDataReadinessStatus } from "../src/lib/monitoring/synchronized-quality";
import { deriveTestnetDisplayStatus } from "../src/lib/monitoring/testnet-display";
import { resolveTunnelConfig } from "./tunnel-config.mjs";
import { decideTunnelRecovery } from "./tunnel-health-policy.mjs";
import { dashboardStateFingerprint, shouldPublishDashboardSnapshot } from "./live-snapshot-policy.mjs";
import { nextRealtimeReplayDelayMs } from "./realtime-short-term-schedule.mjs";
import { buildLiveConnectionRegistry } from "./publish-live-connection.mjs";
import { isProtectedRuntimeDatabasePath, runtimeDatabaseRsyncExcludes, untrackedRuntimeSourceRsyncExcludes } from "./runtime-deployment-policy.mjs";
import { processSignalTarget, supervisorExitDelayMs, supervisorForceKillDelayMs } from "./process-supervisor-policy.mjs";
import { evaluateRuntimeWatchdog } from "./runtime-watchdog-policy.mjs";
import { calculateDirectionalBookReturn, deflatedSharpeProbability, evaluateCombinedTrading, impliedTerminalMedianForCondition } from "../src/lib/model-evaluation/combined-trading";
import { evaluateChronologicalModel } from "../src/lib/model-evaluation/engine";
import { modelEvaluationConfigHash, modelEvaluationSummariesCsv, summarizeModelEvaluation } from "../src/lib/model-evaluation/report";
import { toHorizonStudy } from "../src/lib/model-evaluation/service";
import { fitMonotonicProbabilityLadder } from "../src/lib/model-evaluation/probability-ladder";
import { parseTerminalPriceCondition, probabilityForCondition, summarizeFundingAt } from "../src/lib/model-evaluation/price-structure";
import { selectProspectiveExecutionTriplet } from "../src/lib/model-evaluation/prospective-synchronized";
import {
  buildExpandingReplayFolds,
  buildRealtimeReplayBenchmarkSummary,
  binaryBrierScore,
  binaryLogLoss,
  calculateDigitalFairProbability,
  calculateHyperliquidReplayReturn,
  calculatePolymarketReplayReturn,
  selectCausalReferenceBoundary,
  summarizeReplayDirectionCoverage,
  summarizeRealtimeProbabilityScores,
} from "../src/lib/model-evaluation/realtime-short-term-replay";
import { applySynchronizedExecutionOverlay } from "../src/lib/model-evaluation/synchronized-execution";
import type { EvaluationSample } from "../src/lib/model-evaluation/types";
import { annualizeRealizedVolatility } from "../src/lib/model-evaluation/volatility";
import { normalizeHyperliquidOrderBook } from "../src/lib/monitoring/hyperliquid";
import { isTemporaryBackupArtifact, nextBackupDelayMs } from "./backup-policy.mjs";
import { buildRealtimeAssetTick, buildRealtimeMarketTick, isRealtimeCaptureWindow, selectRealtimeMarketsForCollection, shouldReconnectManagedSocket, shouldReportRealtimeCoverageFailure } from "../src/lib/realtime-market-data/collector";
import { calculatePolymarketTakerFee, evaluateExactExecutionAudit, selectCausalExecutionTick, summarizeExactAuditDirectionCoverage } from "../src/lib/realtime-market-data/execution-audit";
import { minimumAdditionalPerfectPositionsForCoverage, persistForwardExecutionAuditReport, type ForwardExecutionAuditReportInput } from "../src/lib/realtime-market-data/execution-audit-report";
import { evaluateReferenceSettlementAudit, filterReferenceSettlementRows } from "../src/lib/realtime-market-data/settlement-audit";
import {
  normalizeHyperliquidWebSocketMessage,
  normalizePolymarketWebSocketMessage,
  normalizeRtdsReferenceMessage,
  realtimeReferenceSubscriptions,
} from "../src/lib/realtime-market-data/normalizers";
import type { ActiveCryptoDirectionMarket } from "../src/lib/backtest/polymarket";

assert.deepEqual(deriveTestnetDisplayStatus(), {
  label: "確認中",
  note: "テストネットの状態を確認しています",
  tone: "neutral",
});
assert.equal(deriveTestnetDisplayStatus({
  installed: true,
  apiWalletConfigured: true,
  accountConfigured: false,
  enabled: false,
  transport: { status: "healthy" },
  nextStep: "マスター口座を登録",
}).label, "口座未設定");
assert.equal(deriveTestnetDisplayStatus({
  installed: true,
  apiWalletConfigured: true,
  accountConfigured: true,
  enabled: false,
}).label, "発注無効");
assert.deepEqual(deriveTestnetDisplayStatus({
  installed: true,
  apiWalletConfigured: true,
  accountConfigured: true,
  enabled: true,
  verifiedReady: true,
}), {
  label: "検証済み",
  note: "発注・取消・照合済み",
  tone: "good",
});
assert.deepEqual(deriveTestnetDisplayStatus({
  installed: true,
  apiWalletConfigured: true,
  accountConfigured: true,
  enabled: true,
  verification: { status: "FAILED", error: "注文照合に失敗" },
}), {
  label: "検証失敗",
  note: "注文照合に失敗",
  tone: "bad",
});
assert.equal(deriveTestnetDisplayStatus({
  installed: true,
  apiWalletConfigured: true,
  accountConfigured: true,
  enabled: true,
  transport: { status: "healthy" },
}).note, "公開API疎通済み・実注文検証待ち");
console.log("testnet display status tests passed");

const snapshotState = {
  monitoring: {
    status: "live",
    combinedShadow: {
      shortTermDirection: {
        trades: 1,
        openPositions: 0,
        executionAudit: { verifiedIndependentEvents: 1, missingResolution: 0 },
      },
    },
  },
};
assert.deepEqual(runtimeDatabaseRsyncExcludes, ["--exclude=prisma/dev.db*"]);
for (const path of ["prisma/dev.db", "prisma/dev.db-wal", "prisma/dev.db-shm", "prisma/dev.db-journal"]) {
  assert.equal(isProtectedRuntimeDatabasePath(path), true);
}
assert.equal(isProtectedRuntimeDatabasePath("prisma/schema.prisma"), false);
assert.deepEqual(
  untrackedRuntimeSourceRsyncExcludes(["app/api/copy 2/route.ts", "notes?.txt"]),
  ["--exclude=/app/api/copy 2/route.ts", "--exclude=/notes\\?.txt"],
);
assert.throws(() => untrackedRuntimeSourceRsyncExcludes(["../outside"]), /unsafe untracked runtime source path/);
console.log("runtime database deployment protection tests passed");

const forwardAuditArtifactRoot = await mkdtemp(join(tmpdir(), "poly-forward-audit-"));
try {
  const reportInput: ForwardExecutionAuditReportInput = {
    generatedAt: "2026-01-01T00:15:00.000Z",
    codeRevision: "abc123",
    cohort: {
      experimentKey: "test-forward",
      modelVersion: "Test v1",
      specificationHash: "spec-1",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    audit: {
      status: "collecting",
      readinessStatus: "collecting",
      collectionStartedAt: "2026-01-01T00:00:00.000Z",
      eligiblePositions: 2,
      auditedPositions: 2,
      coverage: 1,
      verifiedPositions: 2,
      verifiedIndependentEvents: 1,
      verifiedCoverage: 1,
      directionCoverage: {
        minimumIndependentEventsPerSide: 5,
        longIndependentEvents: 1,
        shortIndependentEvents: 1,
        passed: false,
      },
      portfolioNetReturnPct: -0.001,
      benchmarkReturnPct: 0,
      benchmarkLabel: "always short",
      excessReturnPct: -0.001,
      excessConfidenceInterval95: [-0.002, 0.001],
      deflatedSharpeProbability: 0.5,
      maxDrawdownPct: 0.001,
      controlCoverage: 1,
      currentlyPassingReadinessGates: 2,
      evaluatedReadinessGates: 8,
      passedReadinessGates: 0,
      totalReadinessGates: 10,
      readinessGates: [{ id: "trades", label: "50件", state: "pending", passed: false }],
      missingEntry: 0,
      missingExit: 0,
      missingResolution: 0,
      maximumTimingErrorMs: 5_000,
      allowedTimingErrorMs: 15_000,
      maximumPolymarketQuoteAgeMs: 1_000,
      allowedPolymarketQuoteAgeMs: 120_000,
    },
    settlementResolution: {
      status: "healthy",
      completeMarkets: 50,
      missingBoundaryMarkets: 0,
      matchedMarkets: 50,
      mismatchedMarkets: 0,
      coverage: 1,
    },
    synchronizedQuality: {
      status: "collecting",
      durationHours: 12,
      coverage: 1,
      p95SkewMs: 4_000,
      passedGates: 5,
      totalGates: 6,
    },
  };
  const firstReport = await persistForwardExecutionAuditReport(reportInput, { artifactRoot: forwardAuditArtifactRoot });
  assert.equal(firstReport.written, true);
  const duplicateReport = await persistForwardExecutionAuditReport(reportInput, { artifactRoot: forwardAuditArtifactRoot });
  assert.equal(duplicateReport.written, false);
  assert.equal(duplicateReport.reason, "unchanged");
  const evidenceOnlyInput = structuredClone(reportInput);
  evidenceOnlyInput.synchronizedQuality!.durationHours = 13;
  assert.equal((await persistForwardExecutionAuditReport(evidenceOnlyInput, { artifactRoot: forwardAuditArtifactRoot })).written, false);
  const nextInput = structuredClone(reportInput);
  nextInput.generatedAt = "2026-01-01T00:30:00.000Z";
  nextInput.audit.verifiedPositions = 3;
  nextInput.audit.verifiedIndependentEvents = 2;
  nextInput.audit.directionCoverage.longIndependentEvents = 2;
  const nextReport = await persistForwardExecutionAuditReport(nextInput, { artifactRoot: forwardAuditArtifactRoot });
  assert.equal(nextReport.written, true);
  const history = JSON.parse(await readFile(join(forwardAuditArtifactRoot, "history.json"), "utf8")) as { items: Array<{ independentEvents: number }> };
  assert.deepEqual(history.items.map((item) => item.independentEvents), [2, 1]);
  const latestMetrics = await readFile(join(forwardAuditArtifactRoot, "latest-metrics.csv"), "utf8");
  const latestReport = JSON.parse(await readFile(join(forwardAuditArtifactRoot, "latest.json"), "utf8")) as { schemaVersion: number };
  assert.equal(latestReport.schemaVersion, 3);
  assert.match(latestMetrics, /verified_independent_events,2/);
  assert.match(latestMetrics, /report_schema_version,3/);
  assert.match(latestMetrics, /long_independent_events,2/);
  assert.match(latestMetrics, /execution_coverage,1/);
  assert.match(latestMetrics, /minimum_additional_perfect_positions_for_95pct_coverage,0/);
} finally {
  await rm(forwardAuditArtifactRoot, { recursive: true, force: true });
}
console.log("forward execution audit artifact tests passed");
assert.equal(minimumAdditionalPerfectPositionsForCoverage(47, 42, 0.95), 53);
assert.equal(minimumAdditionalPerfectPositionsForCoverage(48, 42, 0.95), 72);
assert.equal(minimumAdditionalPerfectPositionsForCoverage(100, 95, 0.95), 0);
assert.throws(() => minimumAdditionalPerfectPositionsForCoverage(1, 1, 1), RangeError);

assert.equal(nextRealtimeReplayDelayMs({ generatedAtMs: 0, nowMs: 20 * 60_000, intervalMs: 30 * 60_000 }), 10 * 60_000);
assert.equal(nextRealtimeReplayDelayMs({ generatedAtMs: 0, nowMs: 29.5 * 60_000, intervalMs: 30 * 60_000 }), 60_000);
assert.equal(nextRealtimeReplayDelayMs({ generatedAtMs: 0, nowMs: 35 * 60_000, intervalMs: 30 * 60_000 }), 60_000);
console.log("restart-safe replay schedule tests passed");

assert.equal(processSignalTarget(123, "darwin"), -123);
assert.equal(processSignalTarget(123, "win32"), 123);
assert.equal(processSignalTarget(0, "darwin"), null);
assert.ok(supervisorExitDelayMs > supervisorForceKillDelayMs);
console.log("process supervisor shutdown policy tests passed");

const healthyWatchdog = evaluateRuntimeWatchdog({
  nowMs: Date.parse("2026-01-01T00:04:00Z"),
  healthOk: true,
  dashboardGeneratedAt: "2026-01-01T00:03:30Z",
  previousFailures: 2,
});
assert.equal(healthyWatchdog.action, "healthy");
assert.equal(healthyWatchdog.consecutiveFailures, 0);
const waitingWatchdog = evaluateRuntimeWatchdog({
  nowMs: Date.parse("2026-01-01T00:10:00Z"),
  healthOk: true,
  dashboardGeneratedAt: "2026-01-01T00:00:00Z",
  previousFailures: 0,
  failureThreshold: 3,
});
assert.equal(waitingWatchdog.action, "waiting");
assert.equal(waitingWatchdog.consecutiveFailures, 1);
const restartWatchdog = evaluateRuntimeWatchdog({
  nowMs: Date.parse("2026-01-01T00:10:00Z"),
  healthOk: false,
  dashboardGeneratedAt: null,
  previousFailures: 2,
  failureThreshold: 3,
});
assert.equal(restartWatchdog.action, "restart");
const coolingWatchdog = evaluateRuntimeWatchdog({
  nowMs: Date.parse("2026-01-01T00:10:00Z"),
  healthOk: false,
  dashboardGeneratedAt: null,
  previousFailures: 2,
  failureThreshold: 3,
  lastRestartAt: "2026-01-01T00:05:00Z",
});
assert.equal(coolingWatchdog.action, "cooldown");
console.log("runtime watchdog policy tests passed");

let cacheNow = 1_000;
let cacheLoads = 0;
let releaseCacheRefresh: (() => void) | null = null;
const dashboardCache = createAsyncStaleWhileRevalidateCache({
  ttlMs: 100,
  now: () => cacheNow,
  load: async () => {
    cacheLoads += 1;
    if (cacheLoads > 1) await new Promise<void>((resolve) => { releaseCacheRefresh = resolve; });
    return { version: cacheLoads };
  },
});
assert.equal((await dashboardCache.get()).value.version, 1);
cacheNow = 1_200;
const staleCacheValue = await dashboardCache.get();
assert.equal(staleCacheValue.value.version, 1);
assert.equal(staleCacheValue.refreshing, true);
releaseCacheRefresh?.();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal((await dashboardCache.get()).value.version, 2);
assert.equal(cacheLoads, 2);
console.log("stale-while-revalidate cache tests passed");

assert.equal(
  dashboardStateFingerprint({ ...snapshotState, generatedAt: "2026-01-01T00:01:00Z" }),
  dashboardStateFingerprint({ ...snapshotState, generatedAt: "2026-01-01T00:02:00Z" }),
);
assert.notEqual(
  dashboardStateFingerprint(snapshotState),
  dashboardStateFingerprint({
    monitoring: {
      ...snapshotState.monitoring,
      combinedShadow: {
        shortTermDirection: {
          ...snapshotState.monitoring.combinedShadow.shortTermDirection,
          trades: 2,
        },
      },
    },
  }),
);
assert.notEqual(
  dashboardStateFingerprint(snapshotState),
  dashboardStateFingerprint({ ...snapshotState, modelEvaluations: [{ id: "evaluation-2", status: "completed" }] }),
);
assert.equal(shouldPublishDashboardSnapshot({
  currentFingerprint: "new",
  publishedFingerprint: "old",
  lastPublishedAtMs: 1_000,
  nowMs: 301_000,
  minimumIntervalMs: 300_000,
}), true);
assert.equal(shouldPublishDashboardSnapshot({
  currentFingerprint: "new",
  publishedFingerprint: "old",
  lastPublishedAtMs: 1_000,
  nowMs: 300_999,
  minimumIntervalMs: 300_000,
}), false);
assert.equal(shouldPublishDashboardSnapshot({
  currentFingerprint: "same",
  publishedFingerprint: "same",
  lastPublishedAtMs: null,
  nowMs: 1_000,
  minimumIntervalMs: 300_000,
}), false);

console.log("live snapshot publication policy tests passed");

assert.deepEqual(buildLiveConnectionRegistry("https://example.com/", new Date("2026-01-01T00:00:00Z")), {
  version: 2,
  apiBase: "https://example.com",
  publishedAt: "2026-01-01T00:00:00.000Z",
  snapshot: "live-dashboard.json",
});
assert.throws(() => buildLiveConnectionRegistry("http://example.com"), /HTTPS/);
console.log("live connection registry tests passed");

const metrics = calculateBacktestMetrics(
  [
    { marketId: "a", predictedProbability: 0.6, actualOutcome: 1, brierScore: 0.16, logLoss: 0.51, position: 1, pnl: 10 },
    { marketId: "a", predictedProbability: 0.7, actualOutcome: 1, brierScore: 0.09, logLoss: 0.36, position: 1, pnl: 0 },
    { marketId: "b", predictedProbability: 0.4, actualOutcome: 0, brierScore: 0.16, logLoss: 0.51, position: -1, pnl: 5 },
  ],
  1_000,
  2,
);

assert.equal(metrics.observations, 3);
assert.equal(metrics.tradedMarkets, 2);
assert.equal(metrics.totalPnl, 15);
assert.equal(metrics.markets, 2);
assert.equal(metrics.calibration.reduce((sum, bucket) => sum + bucket.count, 0), 3);
assert.ok(Math.abs((metrics.brierScore ?? 0) - 0.1366666667) < 1e-9);

const oneMinuteVolatility = annualizeRealizedVolatility([0.001, -0.001], 60_000);
const fifteenMinuteVolatility = annualizeRealizedVolatility([0.001, -0.001], 15 * 60_000);
assert.ok(oneMinuteVolatility !== null && fifteenMinuteVolatility !== null);
assert.ok(Math.abs(oneMinuteVolatility / fifteenMinuteVolatility - Math.sqrt(15)) < 1e-12);
assert.equal(annualizeRealizedVolatility([], 60_000), null);
assert.equal(annualizeRealizedVolatility([0.001], 0), null);

console.log("backtest metric tests passed");

assert.deepEqual(parseTerminalPriceCondition("Will Bitcoin be less than $100K on May 23?"), { kind: "below", lower: null, upper: 100_000 });
assert.deepEqual(parseTerminalPriceCondition("Will Bitcoin be between $90,000 and $88,000 on April 4?"), { kind: "between", lower: 88_000, upper: 90_000 });
assert.equal(parseTerminalPriceCondition("Will ETH dip below $3,000 in June?"), null);
assert.ok(Math.abs(probabilityForCondition(100, 0.1, { kind: "above", lower: 100, upper: null }) - 0.5) < 1e-6);
assert.ok(probabilityForCondition(100, 0.1, { kind: "above", lower: 90, upper: null }) > 0.5);
const fundingHour = 60 * 60 * 1_000;
assert.equal(calculateCaptureSkewMs([
  new Date("2026-01-01T00:00:00.000Z"),
  new Date("2026-01-01T00:00:00.750Z"),
  new Date("2026-01-01T00:00:01.200Z"),
]), 1_200);
assert.equal(calculateCaptureSkewMs([new Date("2026-01-01T00:00:00Z"), null]), null);
assert.equal(shouldReconnectManagedSocket({
  open: true,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  lastMessageAt: new Date("2026-01-01T00:00:20Z"),
  now: new Date("2026-01-01T00:00:40Z"),
  staleMs: 30_000,
}), false);
assert.equal(shouldReconnectManagedSocket({
  open: true,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  lastMessageAt: new Date("2026-01-01T00:00:05Z"),
  now: new Date("2026-01-01T00:00:40Z"),
  staleMs: 30_000,
}), true);
assert.equal(shouldReconnectManagedSocket({
  open: true,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  lastMessageAt: null,
  now: new Date("2026-01-01T00:00:40Z"),
  staleMs: 30_000,
}), true);
const synchronizedQualityInput = {
  records: 1_200,
  completeRecords: 1_300,
  windowRecords: 1_200,
  windowCompleteRecords: 1_300,
  totalRecords: 1_800,
  startedAt: new Date("2026-01-01T00:00:00Z"),
  continuousStartedAt: new Date("2026-01-01T00:00:00Z"),
  latestAt: new Date("2026-01-03T00:00:00Z"),
  medianSkewMs: 5_000,
  p95SkewMs: 55_000,
  medianSpread: 0.004,
  p95Spread: 0.03,
  medianAbsoluteBasisPct: 0.0002,
  p95AbsoluteBasisPct: 0.0008,
  maximumCaptureGapMs: 70_000,
  assets: ["BTC", "ETH", "SOL", "XRP"].map((asset) => ({ asset, records: 300 })),
};
const synchronizedQuality = evaluateSynchronizedPriceQuality(synchronizedQualityInput);
assert.equal(synchronizedQuality.status, "healthy");
assert.equal(synchronizedQuality.gates.every((gate) => gate.passed), true);
assert.equal(evaluateSynchronizedPriceQuality({ ...synchronizedQualityInput, p95SkewMs: 75_000 }).status, "attention");
assert.equal(evaluateSynchronizedPriceQuality({ ...synchronizedQualityInput, latestAt: new Date("2026-01-01T12:00:00Z") }).status, "collecting");
const restartedSynchronizedQuality = evaluateSynchronizedPriceQuality({
  ...synchronizedQualityInput,
  continuousStartedAt: new Date("2026-01-02T12:00:00Z"),
});
assert.equal(restartedSynchronizedQuality.durationHours, 12);
assert.equal(restartedSynchronizedQuality.status, "collecting");
assert.equal(synchronizedDataReadinessStatus({ monitoringStatus: "live", realtimePriceStatus: "healthy", synchronizedQualityStatus: "healthy" }), "ready");
assert.equal(synchronizedDataReadinessStatus({ monitoringStatus: "live", realtimePriceStatus: "healthy", synchronizedQualityStatus: "collecting" }), "running");
assert.equal(synchronizedDataReadinessStatus({ monitoringStatus: "live", realtimePriceStatus: "healthy", synchronizedQualityStatus: "attention" }), "attention");
assert.equal(synchronizedDataReadinessStatus({ monitoringStatus: "delayed", realtimePriceStatus: "healthy", synchronizedQualityStatus: "healthy" }), "attention");
const fundingPoints = Array.from({ length: 31 }, (_, hour) => ({ time: hour * fundingHour, rate: 0.00001 }));
const fundingSummary = summarizeFundingAt(fundingPoints, 24 * fundingHour, 24 * fundingHour, 30 * fundingHour);
assert.ok(Math.abs((fundingSummary.prior24h ?? 0) - 0.00024) < 1e-12);
assert.ok(Math.abs((fundingSummary.duringTrade ?? 0) - 0.00006) < 1e-12);

const hyperliquidBook = normalizeHyperliquidOrderBook({
  coin: "BTC",
  time: Date.parse("2026-01-01T00:00:00Z"),
  levels: [
    [{ px: "99.9", sz: "1", n: 1 }],
    [{ px: "100.1", sz: "1", n: 1 }],
  ],
});
assert.equal(hyperliquidBook?.bestBid, 99.9);
assert.equal(hyperliquidBook?.bestAsk, 100.1);
assert.ok(Math.abs((hyperliquidBook?.spread ?? 0) - 0.2) < 1e-12);
assert.equal(normalizeHyperliquidOrderBook({
  coin: "BTC",
  time: Date.parse("2026-01-01T00:00:00Z"),
  levels: [
    [{ px: "100.2", sz: "1", n: 1 }],
    [{ px: "100.1", sz: "1", n: 1 }],
  ],
}), null);

const realtimeNow = new Date("2026-01-01T00:05:00.000Z");
const polymarketUpdates = normalizePolymarketWebSocketMessage(JSON.stringify({
  event_type: "book",
  asset_id: "yes-token",
  timestamp: realtimeNow.getTime(),
  bids: [{ price: "0.44", size: "20" }, { price: "0.45", size: "10" }],
  asks: [{ price: "0.48", size: "30" }, { price: "0.47", size: "15" }],
}));
assert.equal(polymarketUpdates.length, 1);
assert.equal(polymarketUpdates[0]?.bestBid, 0.45);
assert.equal(polymarketUpdates[0]?.bestAsk, 0.47);
assert.equal(polymarketUpdates[0]?.bidSize, 10);
assert.equal(polymarketUpdates[0]?.askSize, 15);
assert.deepEqual(normalizePolymarketWebSocketMessage(JSON.stringify([{
  event_type: "price_change",
  timestamp: realtimeNow.getTime(),
  price_changes: [{ asset_id: "no-token", best_bid: "0.53", best_ask: "0.55" }],
}])), [{
  tokenId: "no-token",
  bestBid: 0.53,
  bestAsk: 0.55,
  bidSize: null,
  askSize: null,
  updatedAt: realtimeNow,
}]);

const realtimeHyperliquidBook = normalizeHyperliquidWebSocketMessage(JSON.stringify({
  channel: "l2Book",
  data: {
    coin: "BTC",
    time: realtimeNow.getTime() - 2_000,
    levels: [
      [{ px: "99.9", sz: "2" }, { px: "100.0", sz: "1" }],
      [{ px: "100.2", sz: "3" }, { px: "100.1", sz: "4" }],
    ],
  },
}));
assert.ok(realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook);
assert.equal(realtimeHyperliquidBook.bestBid, 100);
assert.equal(realtimeHyperliquidBook.bestAsk, 100.1);
const realtimeHyperliquidContext = normalizeHyperliquidWebSocketMessage({
  channel: "activeAssetCtx",
  data: { coin: "BTC", ctx: { markPx: "100.05", oraclePx: "99.98", funding: "0.00001" } },
});
assert.ok(realtimeHyperliquidContext && "markPrice" in realtimeHyperliquidContext);
assert.equal(realtimeHyperliquidContext.markPrice, 100.05);
assert.equal(realtimeHyperliquidContext.fundingRate, 0.00001);
const realtimeBinance = normalizeRtdsReferenceMessage({
  topic: "crypto_prices",
  payload: { symbol: "btcusdt", value: 99, timestamp: realtimeNow.getTime() - 500 },
});
assert.equal(realtimeBinance?.asset, "BTC");
assert.equal(realtimeBinance?.source, "BINANCE");
assert.deepEqual(realtimeReferenceSubscriptions(), [
  { topic: "crypto_prices", type: "update" },
  { topic: "crypto_prices_chainlink", type: "*", filters: "" },
]);

const realtimeMarket: ActiveCryptoDirectionMarket = {
  id: "market-15m",
  eventId: "event-15m",
  asset: "BTC",
  tokenId: "yes-token",
  noTokenId: "no-token",
  title: "Bitcoin Up or Down",
  slug: "btc-updown-15m",
  eventStartTime: "2026-01-01T00:00:00.000Z",
  endDate: "2026-01-01T00:15:00.000Z",
  durationMinutes: 15,
  resolved: false,
  result: null,
  currentProbability: 0.46,
  volume: 1_000,
  liquidity: 500,
  bestBid: 0.45,
  bestAsk: 0.47,
  minOrderSize: 5,
  tickSize: 0.01,
  feesEnabled: true,
  referenceSource: "UNKNOWN",
};
assert.equal(isRealtimeCaptureWindow(realtimeMarket, new Date("2025-12-31T23:58:59.999Z")), false);
assert.equal(isRealtimeCaptureWindow(realtimeMarket, new Date("2025-12-31T23:59:00.000Z")), true);
assert.equal(isRealtimeCaptureWindow(realtimeMarket, new Date("2026-01-01T00:16:00.001Z")), false);
const realtimeTick = buildRealtimeMarketTick({
  market: realtimeMarket,
  positiveBook: polymarketUpdates[0] ?? null,
  negativeBook: {
    bestBid: 0.53,
    bestAsk: 0.55,
    bidSize: 12,
    askSize: 18,
    updatedAt: new Date(realtimeNow.getTime() - 1_000),
  },
  hyperliquidBook: realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook ? realtimeHyperliquidBook : null,
  hyperliquidContext: realtimeHyperliquidContext && "markPrice" in realtimeHyperliquidContext ? realtimeHyperliquidContext : null,
  references: {
    BINANCE: realtimeBinance,
    CHAINLINK: { asset: "BTC", source: "CHAINLINK", price: 98.9, updatedAt: new Date(realtimeNow.getTime() - 20_000) },
  },
  now: realtimeNow,
  intervalMs: 5_000,
});
assert.ok(realtimeTick);
assert.ok(Math.abs(realtimeTick.probability - 0.46) < 1e-12);
assert.equal(realtimeTick.referenceSource, "BINANCE");
assert.equal(realtimeTick.chainlinkPrice, null);
assert.ok(Math.abs(realtimeTick.complementBidSum - 0.98) < 1e-12);
assert.ok(Math.abs(realtimeTick.complementAskSum - 1.02) < 1e-12);
assert.equal(realtimeTick.arbitrageViolation, false);
assert.equal(realtimeTick.captureSkewMs, 2_000);
assert.equal(realtimeTick.synchronizationVersion, "websocket-v6-near-term-discovery");
assert.ok(Math.abs(realtimeTick.priceBasisPct - (100.05 / 99 - 1)) < 1e-12);
const realtimeAssetTick = buildRealtimeAssetTick({
  asset: "BTC",
  hyperliquidBook: realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook ? realtimeHyperliquidBook : null,
  hyperliquidContext: realtimeHyperliquidContext && "markPrice" in realtimeHyperliquidContext ? realtimeHyperliquidContext : null,
  references: {
    BINANCE: realtimeBinance,
    CHAINLINK: { asset: "BTC", source: "CHAINLINK", price: 98.9, updatedAt: new Date(realtimeNow.getTime() - 1_000) },
  },
  now: realtimeNow,
  intervalMs: 5_000,
});
assert.ok(realtimeAssetTick);
assert.equal(realtimeAssetTick.synchronizationVersion, "websocket-asset-v1");
assert.equal(realtimeAssetTick.chainlinkPrice, 98.9);
assert.equal(realtimeAssetTick.binancePrice, 99);
assert.equal(realtimeAssetTick.captureSkewMs, 1_500);
const unchangedPolymarketTick = buildRealtimeMarketTick({
  market: realtimeMarket,
  positiveBook: { ...polymarketUpdates[0]!, updatedAt: new Date(realtimeNow.getTime() - 90_000) },
  negativeBook: { bestBid: 0.53, bestAsk: 0.55, bidSize: null, askSize: null, updatedAt: new Date(realtimeNow.getTime() - 90_000) },
  hyperliquidBook: realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook ? realtimeHyperliquidBook : null,
  hyperliquidContext: null,
  references: { BINANCE: realtimeBinance, CHAINLINK: null },
  now: realtimeNow,
});
assert.ok(unchangedPolymarketTick);
assert.equal(buildRealtimeMarketTick({
  market: realtimeMarket,
  positiveBook: { ...polymarketUpdates[0]!, updatedAt: new Date(realtimeNow.getTime() - 120_001) },
  negativeBook: { bestBid: 0.53, bestAsk: 0.55, bidSize: null, askSize: null, updatedAt: new Date(realtimeNow.getTime() - 120_001) },
  hyperliquidBook: realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook ? realtimeHyperliquidBook : null,
  hyperliquidContext: null,
  references: { BINANCE: realtimeBinance, CHAINLINK: null },
  now: realtimeNow,
}), null);
assert.equal(buildRealtimeMarketTick({
  market: realtimeMarket,
  positiveBook: polymarketUpdates[0] ?? null,
  negativeBook: { bestBid: 0.53, bestAsk: 0.55, bidSize: null, askSize: null, updatedAt: realtimeNow },
  hyperliquidBook: realtimeHyperliquidBook && "bestBid" in realtimeHyperliquidBook ? realtimeHyperliquidBook : null,
  hyperliquidContext: null,
  references: { BINANCE: { ...realtimeBinance!, updatedAt: new Date(realtimeNow.getTime() - 20_000) }, CHAINLINK: null },
  now: realtimeNow,
}), null);
const justClosedMarket = { ...realtimeMarket, id: "just-closed", endDate: "2026-01-01T00:04:30.000Z" };
const expiredMarket = { ...realtimeMarket, id: "expired", endDate: "2026-01-01T00:03:59.999Z" };
assert.deepEqual(
  selectRealtimeMarketsForCollection([], [justClosedMarket, expiredMarket], realtimeNow).map((market) => market.id),
  ["just-closed"],
);
const refreshedMarket = { ...justClosedMarket, title: "refreshed" };
assert.equal(
  selectRealtimeMarketsForCollection([refreshedMarket], [justClosedMarket], realtimeNow)[0]?.title,
  "refreshed",
);

console.log("realtime market data tests passed");

const auditStart = new Date("2026-01-01T00:00:00.000Z");
const auditEnd = new Date("2026-01-01T00:15:00.000Z");
const auditTick = (
  marketId: string,
  capturedAt: string,
  referenceUpdatedAt: string,
  referencePrice: number,
  hyperliquidBestBid: number,
  hyperliquidBestAsk: number,
  polymarketBestAsk: number,
  negativeBestAsk: number,
) => ({
  marketId,
  asset: marketId === "audit-long" ? "BTC" : "ETH",
  marketStartAt: auditStart,
  marketEndAt: auditEnd,
  polymarketBestAsk,
  polymarketUpdatedAt: new Date(capturedAt),
  negativeBestAsk,
  negativeUpdatedAt: new Date(capturedAt),
  hyperliquidBestBid,
  hyperliquidBestAsk,
  hyperliquidUpdatedAt: new Date(capturedAt),
  referencePrice,
  referenceUpdatedAt: new Date(referenceUpdatedAt),
  capturedAt: new Date(capturedAt),
});
const auditPositions = [
  {
    marketId: "audit-long",
    asset: "BTC",
    side: "LONG",
    quantity: 10,
    entryPrice: 100.12,
    entryFunding24h: 0.0001,
    polymarketSide: "LONG",
    realizedPnl: 5,
    status: "CLOSED",
    openedAt: new Date("2026-01-01T00:02:00.000Z"),
    exitAt: auditEnd,
    closedAt: new Date("2026-01-01T00:15:05.000Z"),
  },
  {
    marketId: "audit-short",
    asset: "ETH",
    side: "SHORT",
    quantity: 5,
    entryPrice: 199.76,
    entryFunding24h: -0.0002,
    polymarketSide: "SHORT",
    realizedPnl: -4,
    status: "CLOSED",
    openedAt: new Date("2026-01-01T00:02:00.000Z"),
    exitAt: auditEnd,
    closedAt: new Date("2026-01-01T00:15:05.000Z"),
  },
];
const auditTicks = [
  auditTick("audit-long", "2026-01-01T00:00:02Z", "2026-01-01T00:00:01Z", 100, 99.9, 100.1, 0.52, 0.5),
  auditTick("audit-long", "2026-01-01T00:02:03Z", "2026-01-01T00:02:02Z", 100.5, 100, 100.1, 0.6, 0.42),
  auditTick("audit-long", "2026-01-01T00:15:06Z", "2026-01-01T00:15:01Z", 101, 101, 101.1, 0.98, 0.03),
  auditTick("audit-short", "2026-01-01T00:00:02Z", "2026-01-01T00:00:01Z", 200, 199.8, 200.2, 0.51, 0.51),
  auditTick("audit-short", "2026-01-01T00:02:04Z", "2026-01-01T00:02:03Z", 200.1, 199.8, 200.2, 0.57, 0.45),
  auditTick("audit-short", "2026-01-01T00:15:04Z", "2026-01-01T00:15:01Z", 201, 201, 201.2, 0.98, 0.03),
];
const causalTick = selectCausalExecutionTick([
  auditTick("audit-long", "2026-01-01T00:01:59Z", "2026-01-01T00:01:59Z", 100, 98, 99, 0.55, 0.47),
  auditTick("audit-long", "2026-01-01T00:02:04Z", "2026-01-01T00:02:04Z", 100, 100, 101, 0.55, 0.47),
  auditTick("audit-long", "2026-01-01T00:02:02Z", "2026-01-01T00:02:02Z", 100, 99, 100, 0.55, 0.47),
], new Date("2026-01-01T00:02:00Z"), 15_000);
assert.equal(causalTick?.tick.capturedAt.toISOString(), "2026-01-01T00:02:02.000Z");
assert.equal(causalTick?.errorMs, 2_000);
assert.equal(selectCausalExecutionTick([
  auditTick("audit-long", "2026-01-01T00:01:59Z", "2026-01-01T00:01:59Z", 100, 98, 99, 0.55, 0.47),
], new Date("2026-01-01T00:02:00Z"), 15_000), null);
const auditConfig = {
  positions: auditPositions,
  controlPositions: auditPositions,
  ticks: auditTicks,
  resolutions: [
    { marketId: "audit-long", resolved: true, result: 1 },
    { marketId: "audit-short", resolved: true, result: 1 },
  ],
  collectionStartedAt: auditStart,
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
  initialEquity: 10_000,
  settlementBasisStatus: "healthy" as const,
  settlementResolutionStatus: "healthy" as const,
};
const exactAudit = evaluateExactExecutionAudit(auditConfig);
assert.equal(exactAudit.readinessStatus, "collecting");
assert.equal(exactAudit.eligiblePositions, 2);
assert.equal(exactAudit.auditedPositions, 2);
assert.equal(exactAudit.coverage, 1);
assert.equal(exactAudit.verifiedPositions, 2);
assert.equal(exactAudit.verifiedIndependentEvents, 1);
assert.deepEqual(exactAudit.directionCoverage, {
  minimumIndependentEventsPerSide: 5,
  longIndependentEvents: 1,
  shortIndependentEvents: 1,
  passed: false,
});
assert.equal(exactAudit.verifiedCoverage, 1);
assert.equal(exactAudit.resolvedPredictions, 2);
assert.equal(exactAudit.predictionAccuracy, 0.5);
assert.equal(exactAudit.polymarketAuditedPositions, 2);
assert.equal(exactAudit.maximumTimingErrorMs, 6_000);
assert.equal(exactAudit.medianTimingErrorMs, 4_000);
assert.equal(exactAudit.maximumCloseDelayMs, 5_000);
assert.ok((exactAudit.hyperliquidNetReturnPct ?? 1) < 0);
assert.ok(Math.abs((exactAudit.storedNetReturnPct ?? 0) - 1 / (10 * 100.12 + 5 * 199.76)) < 1e-12);
assert.ok((exactAudit.portfolioNetReturnPct ?? 1) < 0);
assert.equal(exactAudit.controlComparablePositions, 2);
assert.equal(exactAudit.comparableEvents, 2);
assert.equal(exactAudit.comparableIndependentEvents, 1);
assert.equal(exactAudit.controlCoverage, 1);
assert.equal(exactAudit.totalReadinessGates, 10);
assert.equal(exactAudit.passedReadinessGates, 0);
assert.equal(exactAudit.readinessGates.find((gate) => gate.id === "trades")?.state, "pending");
assert.equal(exactAudit.readinessGates.find((gate) => gate.id === "directions")?.state, "pending");
assert.equal(exactAudit.readinessGates.find((gate) => gate.id === "drawdown")?.state, "passing");
assert.equal(exactAudit.readinessGates.find((gate) => gate.id === "drawdown")?.passed, false);
assert.ok(exactAudit.currentlyPassingReadinessGates > 0);
assert.ok(exactAudit.evaluatedReadinessGates < exactAudit.totalReadinessGates);
assert.equal(exactAudit.settlementResolutionStatus, "healthy");
assert.deepEqual(exactAudit.attribution.byAsset.map((item) => ({ asset: item.asset, trades: item.trades })), [
  { asset: "BTC", trades: 1 },
  { asset: "ETH", trades: 1 },
]);
assert.deepEqual(exactAudit.attribution.bySide.map((item) => ({ side: item.side, trades: item.trades })), [
  { side: "LONG", trades: 1 },
  { side: "SHORT", trades: 1 },
]);
assert.ok(Math.abs(exactAudit.attribution.byAsset.reduce((total, item) => total + item.returnContributionPct, 0) - (exactAudit.portfolioNetReturnPct ?? 0)) < 1e-12);
const directionFailureAudit = evaluateExactExecutionAudit({
  ...auditConfig,
  minimumAuditedPositions: 1,
});
assert.equal(directionFailureAudit.readinessGates.find((gate) => gate.id === "directions")?.state, "failing");
assert.equal(directionFailureAudit.readinessGates.find((gate) => gate.id === "directions")?.passed, false);
assert.equal(directionFailureAudit.readinessStatus, "underperforming");
assert.deepEqual(summarizeExactAuditDirectionCoverage([
  { exitAt: auditEnd, side: "LONG" },
  { exitAt: auditEnd, side: "LONG" },
  { exitAt: auditEnd, side: "SHORT" },
  { exitAt: new Date(auditEnd.getTime() + 15 * 60_000), side: "SHORT" },
]), {
  minimumIndependentEventsPerSide: 5,
  longIndependentEvents: 1,
  shortIndependentEvents: 2,
  passed: false,
});
assert.equal(calculatePolymarketTakerFee(100, 0.5), 1.75);
const atTheMoneyFairProbability = calculateDigitalFairProbability({
  thresholdPrice: 100,
  currentPrice: 100,
  volatility24h: 0.02,
  remainingHours: 0.2,
});
assert.equal(atTheMoneyFairProbability < 0.5 && atTheMoneyFairProbability > 0.49, true);
const winningTokenReplay = calculatePolymarketReplayReturn({ price: 0.5, correct: true });
const losingTokenReplay = calculatePolymarketReplayReturn({ price: 0.5, correct: false });
assert.equal((winningTokenReplay?.returnPct ?? 0) > 0, true);
assert.equal((losingTokenReplay?.returnPct ?? 0) < -0.9, true);
const flatHyperliquidReplay = calculateHyperliquidReplayReturn({
  side: "LONG",
  entryBestBid: 99.99,
  entryBestAsk: 100.01,
  exitBestBid: 99.99,
  exitBestAsk: 100.01,
  fundingRatePerHour: 0,
  holdingHours: 0.2,
});
assert.equal((flatHyperliquidReplay?.returnPct ?? 0) < -0.001, true);
assert.equal(binaryBrierScore(0.5, 1), 0.25);
assert.ok(Math.abs(binaryLogLoss(0.5, 1) - Math.log(2)) < 1e-12);
const marketMatchedProbabilityScores = summarizeRealtimeProbabilityScores(Array.from({ length: 6 }, (_, index) => ({
  windowAt: `2026-01-01T0${index}:00:00Z`,
  officialResult: index % 2 as 0 | 1,
  marketProbability: index % 2 ? 0.6 : 0.4,
  forecastProbability: index % 2 ? 0.6 : 0.4,
})));
assert.equal(marketMatchedProbabilityScores.brierImprovement, 0);
assert.equal(marketMatchedProbabilityScores.brierSkillScore, 0);
assert.equal(marketMatchedProbabilityScores.probabilityEdgePassed, false);
const improvedProbabilityScores = summarizeRealtimeProbabilityScores(Array.from({ length: 6 }, (_, index) => ({
  windowAt: `2026-01-02T0${index}:00:00Z`,
  officialResult: index % 2 as 0 | 1,
  marketProbability: index % 2 ? 0.6 : 0.4,
  forecastProbability: index % 2 ? 0.8 : 0.2,
})));
assert.ok(Math.abs((improvedProbabilityScores.brierImprovement ?? 0) - 0.12) < 1e-12);
assert.ok(Math.abs((improvedProbabilityScores.brierSkillScore ?? 0) - 0.75) < 1e-12);
assert.ok((improvedProbabilityScores.brierImprovementConfidenceInterval95?.[0] ?? 0) > 0);
assert.equal(improvedProbabilityScores.probabilityEdgePassed, true);
assert.deepEqual(summarizeReplayDirectionCoverage([
  { windowAt: "2026-01-01T00:00:00Z", side: "LONG" },
  { windowAt: "2026-01-01T00:00:00Z", side: "LONG" },
  { windowAt: "2026-01-01T00:15:00Z", side: "SHORT" },
  { windowAt: "2026-01-01T00:30:00Z", side: "SHORT" },
]), {
  longTrades: 2,
  shortTrades: 2,
  longIndependentWindows: 1,
  shortIndependentWindows: 2,
});
const delayedBoundaryTick = {
  capturedAt: new Date("2026-01-01T00:00:40Z"),
  chainlinkPrice: 100,
  chainlinkUpdatedAt: new Date("2026-01-01T00:00:01Z"),
  hyperliquidMidPrice: 100.1,
};
assert.equal(selectCausalReferenceBoundary(
  [delayedBoundaryTick],
  new Date("2026-01-01T00:00:00Z"),
  new Date("2026-01-01T00:00:30Z"),
  15_000,
), null);
assert.equal(selectCausalReferenceBoundary(
  [delayedBoundaryTick],
  new Date("2026-01-01T00:00:00Z"),
  new Date("2026-01-01T00:00:45Z"),
  15_000,
)?.price, 100);
const beforeBoundaryTick = {
  capturedAt: new Date("2026-01-01T00:00:00Z"),
  chainlinkPrice: 99,
  chainlinkUpdatedAt: new Date("2025-12-31T23:59:57Z"),
  hyperliquidMidPrice: 99.9,
};
const afterBoundaryTick = {
  capturedAt: new Date("2026-01-01T00:00:04Z"),
  chainlinkPrice: 101,
  chainlinkUpdatedAt: new Date("2026-01-01T00:00:03Z"),
  hyperliquidMidPrice: 100.1,
};
assert.equal(selectCausalReferenceBoundary(
  [beforeBoundaryTick, afterBoundaryTick],
  new Date("2026-01-01T00:00:00Z"),
  new Date("2026-01-01T00:00:05Z"),
  15_000,
)?.price, 101);
assert.equal(selectCausalReferenceBoundary(
  [beforeBoundaryTick],
  new Date("2026-01-01T00:00:00Z"),
  new Date("2026-01-01T00:00:05Z"),
  15_000,
), null);
const replayBenchmark = buildRealtimeReplayBenchmarkSummary([
  {
    windowAt: "2026-01-01T00:00:00Z",
    polymarketBaselineReturnPct: 0.2,
    hyperliquidBaselineReturnPct: 0,
    equalWeightReturnPct: 0.1,
    longEqualWeightReturnPct: 0.1,
    shortEqualWeightReturnPct: -0.1,
  },
  {
    windowAt: "2026-01-01T00:15:00Z",
    polymarketBaselineReturnPct: 0.2,
    hyperliquidBaselineReturnPct: 0,
    equalWeightReturnPct: 0.1,
    longEqualWeightReturnPct: -0.1,
    shortEqualWeightReturnPct: 0.1,
  },
]);
assert.equal(replayBenchmark.bestBenchmarkId, "polymarket_only");
assert.ok(Math.abs((replayBenchmark.bestBenchmarkNetReturnPct ?? 0) - 0.02) < 1e-12);
assert.ok(Math.abs((replayBenchmark.excessReturnPct ?? 0) + 0.01) < 1e-12);
assert.deepEqual(replayBenchmark, buildRealtimeReplayBenchmarkSummary([
  {
    windowAt: "2026-01-01T00:00:00Z",
    polymarketBaselineReturnPct: 0.2,
    hyperliquidBaselineReturnPct: 0,
    equalWeightReturnPct: 0.1,
    longEqualWeightReturnPct: 0.1,
    shortEqualWeightReturnPct: -0.1,
  },
  {
    windowAt: "2026-01-01T00:15:00Z",
    polymarketBaselineReturnPct: 0.2,
    hyperliquidBaselineReturnPct: 0,
    equalWeightReturnPct: 0.1,
    longEqualWeightReturnPct: -0.1,
    shortEqualWeightReturnPct: 0.1,
  },
]));
const independentReplayBenchmark = buildRealtimeReplayBenchmarkSummary([
  {
    windowAt: "2026-01-02T00:00:00Z",
    polymarketBaselineReturnPct: -0.2,
    hyperliquidBaselineReturnPct: -0.1,
    equalWeightReturnPct: 0.5,
    longEqualWeightReturnPct: -0.1,
    shortEqualWeightReturnPct: -0.1,
  },
], ["2026-01-02T00:00:00Z", "2026-01-02T00:15:00Z"]);
assert.equal(independentReplayBenchmark.bestBenchmarkId, "hyperliquid_only");
assert.ok(Math.abs((independentReplayBenchmark.excessReturnPct ?? 0) - 0.03) < 1e-12);
assert.ok(Math.abs((independentReplayBenchmark.excessAverageReturnPct ?? 0) - 0.015) < 1e-12);
const replayWindows = Array.from({ length: 15 }, (_, index) => `2026-01-01T${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}:00Z`);
const expandingReplayFolds = buildExpandingReplayFolds(replayWindows, 4, 0.2);
assert.deepEqual(expandingReplayFolds.map((fold) => [fold.calibration.length, fold.validation.length]), [
  [3, 3],
  [6, 3],
  [9, 3],
  [12, 3],
]);
assert.deepEqual(expandingReplayFolds.flatMap((fold) => fold.validation), replayWindows.slice(3));
for (const fold of expandingReplayFolds) {
  assert.equal(fold.calibration.some((window) => fold.validation.includes(window)), false);
  assert.equal(fold.calibration.at(-1)! < fold.validation[0], true);
}
const settlementRows = [
  { marketId: "settlement-up", asset: "BTC", officialResult: 1, startPrice: 100, endPrice: 101, startErrorMs: 1_000, endErrorMs: 2_000 },
  { marketId: "settlement-down", asset: "ETH", officialResult: 0, startPrice: 200, endPrice: 199, startErrorMs: 3_000, endErrorMs: 4_000 },
  { marketId: "settlement-mismatch", asset: "SOL", officialResult: 1, startPrice: 50, endPrice: 49, startErrorMs: 5_000, endErrorMs: 6_000 },
  { marketId: "settlement-missing", asset: "XRP", officialResult: 0, startPrice: 1, endPrice: null, startErrorMs: 1_000, endErrorMs: null },
];
const collectingSettlement = evaluateReferenceSettlementAudit(settlementRows, { targetMarkets: 4 });
assert.equal(collectingSettlement.status, "collecting");
assert.equal(collectingSettlement.resolvedObservedMarkets, 4);
assert.equal(collectingSettlement.completeMarkets, 3);
assert.equal(collectingSettlement.missingBoundaryMarkets, 1);
assert.equal(collectingSettlement.matchedMarkets, 2);
assert.equal(collectingSettlement.mismatchedMarkets, 1);
assert.equal(collectingSettlement.medianBoundaryErrorMs, 3_500);
assert.equal(collectingSettlement.maximumBoundaryErrorMs, 6_000);
const attentionSettlement = evaluateReferenceSettlementAudit(settlementRows.slice(0, 3), { targetMarkets: 3 });
assert.equal(attentionSettlement.status, "attention");
assert.equal(attentionSettlement.gates.find((gate) => gate.id === "agreement")?.passed, false);
const healthySettlement = evaluateReferenceSettlementAudit([
  settlementRows[0],
  settlementRows[1],
  { ...settlementRows[2], officialResult: 0 },
], { targetMarkets: 3 });
assert.equal(healthySettlement.status, "healthy");
assert.equal(healthySettlement.matchRate, 1);
assert.equal(healthySettlement.passedGates, healthySettlement.totalGates);
assert.deepEqual(
  filterReferenceSettlementRows(settlementRows, [settlementRows[1].marketId]).map((row) => row.marketId),
  [settlementRows[1].marketId],
);
assert.equal(filterReferenceSettlementRows(settlementRows, []).length, 0);
assert.equal(filterReferenceSettlementRows(settlementRows), settlementRows);
assert.equal(evaluateSettlementResolutionAlerts(healthySettlement).length, 0);
assert.equal(evaluateSettlementResolutionAlerts(attentionSettlement)[0]?.severity, "critical");
assert.equal(isTransientHeartbeatWriteError(Object.assign(new Error("Socket timeout"), { code: "P1008" })), true);
assert.equal(isTransientHeartbeatWriteError(new Error("database is locked")), true);
assert.equal(isTransientHeartbeatWriteError(new Error("validation failed")), false);
assert.equal(shouldReportRealtimeCoverageFailure({ activeMarkets: 4, savedRows: 0, consecutiveEmptyFlushes: 1, startupGrace: false }), false);
assert.equal(shouldReportRealtimeCoverageFailure({ activeMarkets: 4, savedRows: 0, consecutiveEmptyFlushes: 3, startupGrace: false }), true);
assert.equal(shouldReportRealtimeCoverageFailure({ activeMarkets: 4, savedRows: 0, consecutiveEmptyFlushes: 3, startupGrace: true }), false);
assert.equal(shouldReportRealtimeCoverageFailure({ activeMarkets: 4, savedRows: 4, consecutiveEmptyFlushes: 3, startupGrace: false }), false);
const incompleteAudit = evaluateExactExecutionAudit({
  ...auditConfig,
  positions: [{ ...auditPositions[0], marketId: "missing-market" }],
  ticks: [],
  resolutions: [],
});
assert.equal(incompleteAudit.eligiblePositions, 1);
assert.equal(incompleteAudit.auditedPositions, 0);
assert.equal(incompleteAudit.missingEntry, 1);
assert.equal(incompleteAudit.missingExit, 1);
assert.equal(incompleteAudit.missingResolution, 1);
const independentAssetExitAudit = evaluateExactExecutionAudit({
  ...auditConfig,
  positions: [auditPositions[0]],
  controlPositions: [],
  ticks: [auditTicks[1]],
  assetTicks: [{
    asset: "BTC",
    hyperliquidBestBid: 101,
    hyperliquidBestAsk: 101.1,
    hyperliquidUpdatedAt: new Date("2026-01-01T00:15:03Z"),
    capturedAt: new Date("2026-01-01T00:15:04Z"),
  }],
  resolutions: [{ marketId: "audit-long", resolved: true, result: 1 }],
});
assert.equal(independentAssetExitAudit.auditedPositions, 1);
assert.equal(independentAssetExitAudit.missingEntry, 0);
assert.equal(independentAssetExitAudit.missingExit, 0);
const filteredAudit = evaluateExactExecutionAudit({
  ...auditConfig,
  positions: [auditPositions[0]],
});
assert.equal(filteredAudit.verifiedPositions, 1);
assert.equal(filteredAudit.verifiedIndependentEvents, 1);
assert.equal(filteredAudit.comparableEvents, 2);
assert.equal(filteredAudit.controlComparablePositions, 2);
assert.equal(filteredAudit.controlCoverage, 1);

const profitableAuditPositions = Array.from({ length: 60 }, (_, index) => {
  const long = index % 2 === 0;
  const windowStart = new Date(auditStart.getTime() + index * 15 * 60_000);
  const openedAt = new Date(windowStart.getTime() + 2 * 60_000);
  const exitAt = new Date(windowStart.getTime() + 15 * 60_000);
  return {
    marketId: `profitable-${index}`,
    asset: index % 4 === 0 ? "BTC" : "ETH",
    side: long ? "LONG" : "SHORT",
    quantity: 5,
    entryPrice: long ? 100.1 : 99.9,
    entryFunding24h: 0,
    polymarketSide: long ? "LONG" : "SHORT",
    realizedPnl: 8,
    status: "CLOSED",
    openedAt,
    exitAt,
    closedAt: exitAt,
  };
});
const profitableAuditTicks = profitableAuditPositions.flatMap((position, index) => {
  const long = position.side === "LONG";
  const move = 1.5 + (index % 7) * 0.15;
  const exitMid = long ? 100 + move : 100 - move;
  return [
    auditTick(position.marketId, position.openedAt.toISOString(), position.openedAt.toISOString(), 100, 99.9, 100.1, long ? 0.62 : 0.4, long ? 0.4 : 0.62),
    auditTick(position.marketId, position.exitAt.toISOString(), position.exitAt.toISOString(), exitMid, exitMid - 0.1, exitMid + 0.1, long ? 0.98 : 0.02, long ? 0.02 : 0.98),
  ];
});
const profitableAudit = evaluateExactExecutionAudit({
  ...auditConfig,
  positions: profitableAuditPositions,
  controlPositions: profitableAuditPositions.map((position) => ({
    ...position,
    side: position.side === "LONG" ? "SHORT" : "LONG",
  })),
  ticks: profitableAuditTicks,
  resolutions: profitableAuditPositions.map((position) => ({
    marketId: position.marketId,
    resolved: true,
    result: position.polymarketSide === "LONG" ? 1 : 0,
  })),
  minimumAuditedPositions: 50,
});
assert.equal(profitableAudit.status, "healthy");
assert.equal(profitableAudit.readinessStatus, "promising");
assert.equal(profitableAudit.verifiedPositions, 60);
assert.equal(profitableAudit.verifiedIndependentEvents, 60);
assert.deepEqual(profitableAudit.directionCoverage, {
  minimumIndependentEventsPerSide: 5,
  longIndependentEvents: 30,
  shortIndependentEvents: 30,
  passed: true,
});
assert.equal(profitableAudit.strategyTrials, 11);
assert.equal(profitableAudit.passedReadinessGates, profitableAudit.totalReadinessGates);
assert.equal(profitableAudit.currentlyPassingReadinessGates, profitableAudit.totalReadinessGates);
assert.equal(profitableAudit.evaluatedReadinessGates, profitableAudit.totalReadinessGates);
assert.ok((profitableAudit.portfolioNetReturnPct ?? 0) > 0);
assert.ok((profitableAudit.excessReturnPct ?? 0) > 0);
assert.ok((profitableAudit.excessConfidenceInterval95?.[0] ?? 0) > 0);
assert.ok((profitableAudit.deflatedSharpeProbability ?? 0) >= 0.95);
assert.ok(profitableAudit.maxDrawdownPct <= 0.05);

console.log("exact 5-second execution audit tests passed");

const longBookReturn = calculateDirectionalBookReturn({
  entryPrice: 100,
  exitPrice: 102,
  entryBestBid: 99.9,
  entryBestAsk: 100.1,
  exitBestBid: 101.9,
  exitBestAsk: 102.1,
}, 1);
assert.equal(longBookReturn.usedOrderBook, true);
assert.ok(Math.abs(longBookReturn.grossReturn - (101.9 / 100.1 - 1)) < 1e-12);
assert.ok(longBookReturn.spreadRate > 0);
const shortBookReturn = calculateDirectionalBookReturn({
  entryPrice: 100,
  exitPrice: 98,
  entryBestBid: 99.9,
  entryBestAsk: 100.1,
  exitBestBid: 97.9,
  exitBestAsk: 98.1,
}, -1);
assert.equal(shortBookReturn.usedOrderBook, true);
assert.ok(Math.abs(shortBookReturn.grossReturn - -(98.1 / 99.9 - 1)) < 1e-12);
const fallbackReturn = calculateDirectionalBookReturn({ entryPrice: 100, exitPrice: 102 }, 1);
assert.equal(fallbackReturn.usedOrderBook, false);
assert.ok(Math.abs(fallbackReturn.grossReturn - 0.02) < 1e-12);

console.log("price structure tests passed");

const synchronizedTargetAt = Date.parse("2026-01-01T00:00:00.000Z");
const synchronizedEndAt = Date.parse("2026-01-02T00:00:00.000Z");
const synchronizedSample: EvaluationSample = {
  eventId: "event-sync",
  marketId: "market-sync",
  asset: "BTC",
  title: "Will Bitcoin be above $100,000 on January 2?",
  endAt: new Date(synchronizedEndAt).toISOString(),
  observedAt: new Date(synchronizedTargetAt - 60 * 60 * 1_000).toISOString(),
  marketProbability: 0.4,
  horizonHours: 24,
  realizedVolatility24h: 0.05,
  hyperliquidEntryPrice: 98_000,
  hyperliquidExitPrice: 99_000,
  executionPriceSource: "hyperliquid-1h",
  outcome: 1,
};
const synchronizedOverlay = applySynchronizedExecutionOverlay(synchronizedSample, {
  targetAt: synchronizedTargetAt,
  endAt: synchronizedEndAt,
  signal: {
    capturedAt: new Date(synchronizedTargetAt - 30_000),
    probability: 0.62,
    bestBid: 0.61,
    bestAsk: 0.63,
    spread: 0.02,
    hyperliquidMidPrice: 101_000,
    hyperliquidBestBid: 100_995,
    hyperliquidBestAsk: 101_005,
    hyperliquidSpread: 10,
    priceBasisPct: 0.0004,
    captureSkewMs: 1_200,
  },
  entry: {
    capturedAt: new Date(synchronizedTargetAt + 30_000),
    probability: 0.63,
    bestBid: 0.62,
    bestAsk: 0.64,
    spread: 0.02,
    hyperliquidMidPrice: 101_100,
    hyperliquidBestBid: 101_095,
    hyperliquidBestAsk: 101_105,
    hyperliquidSpread: 10,
    priceBasisPct: 0.0005,
    captureSkewMs: 2_400,
  },
  exit: {
    capturedAt: new Date(synchronizedEndAt - 45_000),
    probability: 0.98,
    bestBid: 0.97,
    bestAsk: 0.99,
    spread: 0.02,
    hyperliquidMidPrice: 104_500,
    hyperliquidBestBid: 104_495,
    hyperliquidBestAsk: 104_505,
    hyperliquidSpread: 10,
    priceBasisPct: 0.0003,
    captureSkewMs: 1_800,
  },
});
assert.equal(synchronizedOverlay.executionPriceSource, "synchronized-1m");
assert.equal(synchronizedOverlay.marketProbability, 0.62);
assert.equal(synchronizedOverlay.hyperliquidEntryPrice, 101_100);
assert.equal(synchronizedOverlay.hyperliquidExitPrice, 104_500);
assert.equal(synchronizedOverlay.hyperliquidEntryBestBid, 101_095);
assert.equal(synchronizedOverlay.hyperliquidEntryBestAsk, 101_105);
assert.equal(synchronizedOverlay.hyperliquidExitBestBid, 104_495);
assert.equal(synchronizedOverlay.hyperliquidExitBestAsk, 104_505);
assert.equal(synchronizedOverlay.observationLagMinutes, 0.5);
assert.equal(synchronizedOverlay.hyperliquidEntryLagMinutes, 0.5);
assert.equal(synchronizedOverlay.hyperliquidExitLeadMinutes, 0.75);
assert.equal(synchronizedOverlay.marketBestBid, 0.61);
assert.equal(synchronizedOverlay.marketBestAsk, 0.63);
assert.equal(synchronizedOverlay.marketSpread, 0.02);
assert.equal(synchronizedOverlay.executionPriceBasisPct, 0.0004);
assert.equal(synchronizedOverlay.executionSynchronizationSkewMs, 2_400);
assert.ok((synchronizedOverlay.structuralProbability ?? 0) > 0.5);

console.log("synchronized execution overlay tests passed");

const prospectiveSnapshot = (capturedAt: number) => ({
  marketId: "market-sync",
  capturedAt: new Date(capturedAt),
  probability: 0.6,
  bestBid: 0.59,
  bestAsk: 0.61,
  spread: 0.02,
  hyperliquidMidPrice: 100_000,
  hyperliquidBestBid: 99_995,
  hyperliquidBestAsk: 100_005,
  hyperliquidSpread: 10,
  priceBasisPct: 0.0001,
  captureSkewMs: 1_000,
});
const prospectiveTriplet = selectProspectiveExecutionTriplet([
  prospectiveSnapshot(synchronizedTargetAt - 4 * 60_000),
  prospectiveSnapshot(synchronizedTargetAt - 30_000),
  prospectiveSnapshot(synchronizedTargetAt + 30_000),
  prospectiveSnapshot(synchronizedTargetAt + 60_000),
  prospectiveSnapshot(synchronizedEndAt - 4 * 60_000),
  prospectiveSnapshot(synchronizedEndAt - 30_000),
], synchronizedTargetAt, synchronizedEndAt);
assert.equal(prospectiveTriplet.signal?.capturedAt.getTime(), synchronizedTargetAt - 30_000);
assert.equal(prospectiveTriplet.entry?.capturedAt.getTime(), synchronizedTargetAt + 30_000);
assert.equal(prospectiveTriplet.exit?.capturedAt.getTime(), synchronizedEndAt - 30_000);
assert.equal(selectProspectiveExecutionTriplet([
  prospectiveSnapshot(synchronizedTargetAt - 6 * 60_000),
], synchronizedTargetAt, synchronizedEndAt).signal, null);

console.log("prospective synchronized selection tests passed");

const bullishTarget = impliedTerminalMedianForCondition("above", 100, null, 0.8, 0.05);
const bearishTarget = impliedTerminalMedianForCondition("below", null, 100, 0.8, 0.05);
assert.ok((bullishTarget ?? 0) > 100);
assert.ok((bearishTarget ?? 200) < 100);
assert.equal(impliedTerminalMedianForCondition("between", 90, 110, 0.5, 0.05), null);

console.log("live signal inversion tests passed");

const ladder = fitMonotonicProbabilityLadder([
  { id: "90", kind: "above", threshold: 90, probability: 0.6 },
  { id: "100", kind: "above", threshold: 100, probability: 0.7 },
  { id: "110", kind: "above", threshold: 110, probability: 0.2 },
]);
assert.equal(ladder.violations, 1);
const corrected = new Map(ladder.points.map((point) => [point.id, point.correctedProbability]));
assert.ok((corrected.get("90") ?? 0) >= (corrected.get("100") ?? 1));
assert.ok((corrected.get("100") ?? 0) >= (corrected.get("110") ?? 1));
assert.ok((deflatedSharpeProbability(Array.from({ length: 20 }, () => 0.01), 5) ?? 0) > 0.95);

console.log("probability ladder and selection-bias tests passed");

const closeCost = {
  quantity: 10,
  entryPrice: 100,
  entryFee: 0.45,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  now: new Date("2026-01-02T00:00:00Z"),
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};
const longClose = calculateCombinedClose({ ...closeCost, side: "LONG", markPrice: 102 });
const shortClose = calculateCombinedClose({ ...closeCost, side: "SHORT", markPrice: 98 });
assert.ok(longClose.realizedPnl > 18);
assert.ok(shortClose.realizedPnl > 18);
assert.ok(longClose.realizedPnl < longClose.grossPnl);
assert.ok(shortClose.realizedPnl < shortClose.grossPnl);
const fundingPayingLong = calculateCombinedClose({ ...closeCost, side: "LONG", markPrice: 100, fundingRate24h: 0.0007 });
const fundingReceivingShort = calculateCombinedClose({ ...closeCost, side: "SHORT", markPrice: 100, fundingRate24h: 0.0007 });
assert.ok(fundingPayingLong.funding > 0);
assert.ok(fundingReceivingShort.funding < 0);
assert.ok(fundingReceivingShort.realizedPnl > fundingPayingLong.realizedPnl);

console.log("combined shadow cost tests passed");

function syntheticForwardPosition(index: number, winning: boolean): ForwardEvaluationPosition {
  const side = index % 2 === 0 ? "SHORT" : "LONG";
  const sideMultiplier = side === "LONG" ? 1 : -1;
  const openedAt = new Date(Date.UTC(2026, 0, 1 + index * 2));
  const closedAt = new Date(openedAt.getTime() + 24 * 60 * 60 * 1_000);
  const entrySpotPrice = 100;
  const entryPrice = entrySpotPrice * (1 + sideMultiplier * closeCost.slippagePerSide);
  const quantity = 500 / entryPrice;
  const entryFee = 500 * closeCost.takerFeePerSide;
  const markPrice = entrySpotPrice * (1 + sideMultiplier * (winning ? 0.02 : -0.02));
  const close = calculateCombinedClose({
    ...closeCost,
    side,
    quantity,
    entryPrice,
    entryFee,
    markPrice,
    openedAt,
    now: closedAt,
    fundingRate24h: 0,
  });
  return {
    eventId: `forward-${index}`,
    asset: index % 3 === 0 ? "ETH" : "BTC",
    side,
    quantity,
    entryPrice,
    entrySpotPrice,
    markPrice,
    entryFee,
    realizedPnl: close.realizedPnl,
    polymarketSide: side,
    entryFunding24h: 0,
    status: "CLOSED",
    openedAt,
    closedAt,
  };
}

const forwardStrategyPositions = Array.from({ length: 60 }, (_, index) => syntheticForwardPosition(index, true));
const forwardControlPositions = Array.from({ length: 120 }, (_, index) => syntheticForwardPosition(index, index < 60));
const forwardEvaluationInput = {
  strategyPositions: forwardStrategyPositions,
  controlPositions: forwardControlPositions,
  strategyStartedAt: new Date("2026-01-01T00:00:00Z"),
  controlStartedAt: new Date("2026-01-01T00:00:00Z"),
  initialEquity: 10_000,
  takerFeePerSide: closeCost.takerFeePerSide,
  slippagePerSide: closeCost.slippagePerSide,
  fundingPer24h: closeCost.fundingPer24h,
  maxDrawdownPct: 0.01,
  settlementBasisStatus: "healthy" as const,
};
const forwardEvaluation = evaluateForwardExperiment(forwardEvaluationInput);
assert.equal(forwardEvaluation.status, "promising");
assert.equal(forwardEvaluation.trades, 60);
assert.equal(forwardEvaluation.independentEvents, 60);
assert.equal(forwardEvaluation.minimumIndependentEvents, 50);
assert.equal(forwardEvaluation.comparableEvents, 120);
assert.equal(forwardEvaluation.randomBenchmarkTrials, 200);
assert.ok((forwardEvaluation.netReturnPct ?? 0) > 0);
assert.ok((forwardEvaluation.excessReturnPct ?? 0) > 0);
assert.ok((forwardEvaluation.excessConfidenceInterval95?.[0] ?? 0) > 0);
assert.ok((forwardEvaluation.deflatedSharpeProbability ?? 0) >= 0.95);
assert.equal(forwardEvaluation.gates.every((gate) => gate.passed), true);
assert.equal(forwardEvaluation.attribution.byAsset.reduce((total, group) => total + group.trades, 0), 60);
assert.equal(typeof forwardEvaluation.benchmarks.randomMedianReturnPct, "number");

const collectingForwardEvaluation = evaluateForwardExperiment({
  ...forwardEvaluationInput,
  strategyPositions: forwardStrategyPositions.slice(0, 10),
  controlPositions: forwardControlPositions.slice(0, 20),
});
assert.equal(collectingForwardEvaluation.status, "collecting");
assert.equal(collectingForwardEvaluation.trades, 10);
assert.equal(collectingForwardEvaluation.independentEvents, 10);

const unprovenForwardEvaluation = evaluateForwardExperiment({
  ...forwardEvaluationInput,
  controlPositions: forwardStrategyPositions,
});
assert.equal(unprovenForwardEvaluation.status, "underperforming");
assert.equal(unprovenForwardEvaluation.gates.find((gate) => gate.id === "benchmark")?.passed, false);

const sameEventAcrossHorizons = [6, 12].map((horizonHours, index) => ({
  ...syntheticForwardPosition(index, true),
  eventId: "shared-event",
  horizonHours,
}));
const sameEventControl = sameEventAcrossHorizons.map((position) => ({ ...position }));
const separateHorizonEvaluation = evaluateForwardExperiment({
  ...forwardEvaluationInput,
  strategyPositions: sameEventAcrossHorizons,
  controlPositions: sameEventControl,
});
assert.equal(separateHorizonEvaluation.trades, 2);
assert.equal(separateHorizonEvaluation.independentEvents, 2);
assert.equal(separateHorizonEvaluation.comparableEvents, 2);

const sameEventSameHorizon = [
  { ...syntheticForwardPosition(0, true), eventId: "multi-asset-event", asset: "BTC", horizonHours: 24 },
  { ...syntheticForwardPosition(1, true), eventId: "multi-asset-event", asset: "ETH", horizonHours: 24 },
];
const groupedEventEvaluation = evaluateForwardExperiment({
  ...forwardEvaluationInput,
  strategyPositions: sameEventSameHorizon,
  controlPositions: sameEventSameHorizon.map((position) => ({ ...position })),
});
assert.equal(groupedEventEvaluation.trades, 2);
assert.equal(groupedEventEvaluation.independentEvents, 1);
assert.equal(groupedEventEvaluation.comparableEvents, 1);
assert.equal(groupedEventEvaluation.progressPct, 1 / 50);
assert.ok(Math.abs(
  (groupedEventEvaluation.netReturnPct ?? 0)
    - sameEventSameHorizon.reduce((total, position) => total + (position.realizedPnl ?? 0), 0) / forwardEvaluationInput.initialEquity,
) < 1e-12);

assert.deepEqual(forwardObservationHorizons, [6, 12, 24, 48]);
for (const horizonHours of forwardObservationHorizons) {
  assert.equal(isForwardStrategyExperimentKey(forwardStrategyExperimentKey(horizonHours)), true);
  assert.equal(isForwardControlExperimentKey(forwardControlExperimentKey(horizonHours)), true);
}
assert.equal(new Set(forwardObservationHorizons.map(forwardStrategyExperimentKey)).size, 4);

console.log("forward experiment evaluation tests passed");

const syntheticLiveSignal = {
  eventId: "event",
  marketId: "market",
  asset: "BTC" as const,
  observedAt: "2026-01-01T00:00:00Z",
  exitAt: "2026-01-02T00:00:00Z",
  horizonHours: 24,
  actualHoursToEnd: 24,
  marketProbability: 0.8,
  marketBestBid: 0.79,
  marketBestAsk: 0.81,
  marketSpread: 0.02,
  polymarketReferencePrice: 100,
  referenceSource: "BINANCE" as const,
  referenceCapturedAt: "2026-01-01T00:00:00Z",
  spotPrice: 100,
  priceBasisPct: 0,
  impliedTarget: 102,
  realizedVolatility24h: 0.02,
  hyperliquidMomentum6h: 0.01,
  trendZ6h: 1,
  hyperliquidFunding24h: 0.0007,
  signalZ: 1,
  side: "LONG" as const,
  sourceMarkets: 3,
  ladderViolations: 0,
  ladderAdjustmentRms: 0,
};
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "polymarket-only").side, "LONG");
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "contrarian").side, "SHORT");
assert.equal(applyCombinedSignalRule({ ...syntheticLiveSignal, side: "SHORT", trendZ6h: 1 }, "hyperliquid-momentum").side, "LONG");
assert.equal(applyCombinedSignalRule({ ...syntheticLiveSignal, side: "LONG", trendZ6h: -1 }, "hyperliquid-reversion").side, "LONG");
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "hyperliquid-funding-carry").side, "SHORT");
assert.equal(applyCombinedSignalRule({ ...syntheticLiveSignal, hyperliquidFunding24h: -0.0007 }, "hyperliquid-funding-momentum").side, "SHORT");
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "polymarket-funding-consensus").side, "SHORT");

const secondaryLiveSignal = { ...syntheticLiveSignal, eventId: "event-2", marketId: "market-2", signalZ: 0.8 };
const selectedCandidate = selectCombinedSignalCandidate(
  [syntheticLiveSignal, secondaryLiveSignal],
  { minimumSignalZ: 0.25, minimumTrendZ: 0, minimumFunding24h: 0, signalRule: "polymarket-only" },
  new Set(["event:24"]),
);
assert.equal(selectedCandidate?.actionable, true);
assert.equal(selectedCandidate?.signal.eventId, "event-2");
const differentHorizonCandidate = selectCombinedSignalCandidate(
  [{ ...syntheticLiveSignal, horizonHours: 12 }],
  { minimumSignalZ: 0.25, minimumTrendZ: 0, minimumFunding24h: 0, signalRule: "polymarket-only" },
  new Set(["event:24"]),
);
assert.equal(differentHorizonCandidate?.actionable, true);

const multiHorizonScan: CombinedSignalScan = {
  signal: syntheticLiveSignal,
  signals: [syntheticLiveSignal, { ...secondaryLiveSignal, horizonHours: 12 }],
  horizons: [
    { horizonHours: 12, signal: { ...secondaryLiveSignal, horizonHours: 12 }, signals: [{ ...secondaryLiveSignal, horizonHours: 12 }], horizonEligibleMarkets: 4, groupedEvents: 1, priceReadyEvents: 1, nextWindowAt: null, closestHoursToEnd: 12, reason: "12h" },
    { horizonHours: 24, signal: syntheticLiveSignal, signals: [syntheticLiveSignal], horizonEligibleMarkets: 6, groupedEvents: 2, priceReadyEvents: 1, nextWindowAt: null, closestHoursToEnd: 24, reason: "24h" },
  ],
  scannedMarkets: 20,
  structuredMarkets: 10,
  horizonEligibleMarkets: 10,
  groupedEvents: 3,
  priceReadyEvents: 2,
  eligibleEvents: 2,
  nextWindowAt: null,
  closestHoursToEnd: 24,
  reason: "all",
};
const twelveHourScan = selectCombinedSignalScan(multiHorizonScan, 12);
assert.equal(twelveHourScan.signal?.horizonHours, 12);
assert.equal(twelveHourScan.horizonEligibleMarkets, 4);
assert.equal(twelveHourScan.groupedEvents, 1);
const absentShortTermScan = selectCombinedSignalScan(multiHorizonScan, 0);
assert.equal(absentShortTermScan.signal, null);
assert.equal(absentShortTermScan.signals.length, 0);
assert.equal(absentShortTermScan.horizonEligibleMarkets, 0);

const trendConfirmed = selectCombinedSignalCandidate(
  [{ ...syntheticLiveSignal, horizonHours: 0, trendZ6h: 0.8 }],
  { minimumSignalZ: 1, minimumTrendZ: 0.15, minimumFunding24h: 0, signalRule: "trend-confirmed" },
);
assert.equal(trendConfirmed?.actionable, true);
const trendRejected = selectCombinedSignalCandidate(
  [{ ...syntheticLiveSignal, horizonHours: 0, trendZ6h: -0.8 }],
  { minimumSignalZ: 1, minimumTrendZ: 0.15, minimumFunding24h: 0, signalRule: "trend-confirmed" },
);
assert.equal(trendRejected?.actionable, false);
assert.match(trendRejected?.reason ?? "", /一致していません/);

const shortMarketWindow = { eventStartTime: "2026-01-01T00:00:00Z", durationMinutes: 15 };
assert.equal(isShortTermDecisionWindow(shortMarketWindow, new Date("2026-01-01T00:01:59Z")), false);
assert.equal(isShortTermDecisionWindow(shortMarketWindow, new Date("2026-01-01T00:02:00Z")), true);
assert.equal(isShortTermDecisionWindow(shortMarketWindow, new Date("2026-01-01T00:03:59Z")), true);
assert.equal(isShortTermDecisionWindow(shortMarketWindow, new Date("2026-01-01T00:04:00Z")), false);
const synchronizedDecisionTick = (capturedAt: string, hyperliquidMidPrice: number, sourceUpdatedAt = capturedAt, captureSkewMs = 0) => ({
  capturedAt: new Date(capturedAt),
  polymarketUpdatedAt: new Date(sourceUpdatedAt),
  negativeUpdatedAt: new Date(sourceUpdatedAt),
  hyperliquidUpdatedAt: new Date(sourceUpdatedAt),
  referenceUpdatedAt: new Date(sourceUpdatedAt),
  captureSkewMs,
  hyperliquidMidPrice,
});
const synchronizedDecisionTicks = [
  synchronizedDecisionTick("2026-01-01T00:01:59Z", 99),
  synchronizedDecisionTick("2026-01-01T00:02:01Z", 100),
  synchronizedDecisionTick("2026-01-01T00:02:04Z", 101),
];
assert.equal(
  selectLatestSynchronizedDecisionTick(synchronizedDecisionTicks, new Date("2026-01-01T00:02:05Z"), 15_000)?.hyperliquidMidPrice,
  101,
);
assert.equal(selectLatestSynchronizedDecisionTick(synchronizedDecisionTicks, new Date("2026-01-01T00:02:30Z"), 15_000), null);
assert.equal(selectLatestSynchronizedDecisionTick([
  synchronizedDecisionTick("2026-01-01T00:02:04Z", 101, "2026-01-01T00:00:04Z", 120_000),
], new Date("2026-01-01T00:02:05Z"), 15_000), null);
assert.equal(selectCausalStartPrice(synchronizedDecisionTicks, new Date("2026-01-01T00:02:00Z"), 90_000), 100);
assert.equal(selectCausalStartPrice(synchronizedDecisionTicks, new Date("2026-01-01T00:02:05Z"), 90_000), null);
assert.equal(isShortTermDirectionStrategyKey(shortTermDirectionStrategyKey), true);
assert.equal(isShortTermDirectionControlKey(shortTermDirectionControlKey), true);
assert.equal(isShortTermDirectionFamilyKey("poly-updown-hl-trend-forward-v2-m15"), true);
assert.equal(isShortTermDirectionFamilyKey("poly-updown-forward-control-v1-m15"), true);
assert.equal(isShortTermDirectionFamilyKey("polymarket-only-forward-control-v2-h24"), false);
assert.match(shortTermDirectionSpecificationHash, /^[a-f0-9]{16}$/);
const frozenConfig: CombinedShadowConfig = {
  experimentKey: shortTermDirectionStrategyKey,
  experimentLabel: "fixed",
  forwardOnly: true,
  observationHorizonHours: 0,
  initialEquity: 10_000,
  minimumSignalZ: 1,
  minimumTrendZ: 0.15,
  minimumFunding24h: 0,
  signalRule: "trend-confirmed",
  modelVersion: "v4",
  specificationHash: shortTermDirectionSpecificationHash,
  positionPct: 0.05,
  maxPositionNotional: 500,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.05,
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};
assert.equal(validateFrozenExperimentConfig(frozenConfig, frozenConfig), "compatible");
assert.throws(
  () => validateFrozenExperimentConfig({ ...frozenConfig, specificationHash: null }, frozenConfig),
  /has no specification hash/,
);
assert.throws(
  () => validateFrozenExperimentConfig({ ...frozenConfig, minimumTrendZ: 0.2 }, frozenConfig),
  /configuration changed/,
);
assert.throws(
  () => validateFrozenExperimentConfig({ ...frozenConfig, specificationHash: "0000000000000000" }, frozenConfig),
  /specification changed/,
);

console.log("combined shadow signal-rule tests passed");

const freshBinarySignal = calculateShortTermImpliedSignal({
  marketProbability: 0.8,
  thresholdReferencePrice: 100,
  currentReferencePrice: 100,
  currentHyperliquidPrice: 100.1,
  volatility24h: 0.02,
  remainingHours: 0.2,
});
assert.equal(freshBinarySignal?.side, "LONG");
assert.ok((freshBinarySignal?.expectedReturnPct ?? 0) > 0);
const alreadyMovedBinarySignal = calculateShortTermImpliedSignal({
  marketProbability: 0.8,
  thresholdReferencePrice: 100,
  currentReferencePrice: 102,
  currentHyperliquidPrice: 102.1,
  volatility24h: 0.02,
  remainingHours: 0.2,
});
assert.equal(alreadyMovedBinarySignal?.side, "SHORT");
assert.ok((alreadyMovedBinarySignal?.expectedReturnPct ?? 0) < 0);
assert.equal(calculateShortTermImpliedSignal({
  marketProbability: 1,
  thresholdReferencePrice: 100,
  currentReferencePrice: 100,
  currentHyperliquidPrice: 100,
  volatility24h: 0.02,
  remainingHours: 0.2,
}), null);

console.log("short-term implied signal tests passed");

assert.ok(Math.abs((calculatePriceBasisPct(100.1, 100) ?? 0) - 0.001) < 1e-12);
assert.equal(calculatePriceBasisPct(0, 100), null);
assert.equal(calculatePriceBasisPct(100, Number.NaN), null);

console.log("settlement reference basis tests passed");

const evaluationSamples: EvaluationSample[] = [];
for (let eventIndex = 0; eventIndex < 80; eventIndex += 1) {
  const endAt = new Date(Date.UTC(2024, 0, eventIndex + 1, 12)).toISOString();
  const observedAt = new Date(new Date(endAt).getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const marketCount = eventIndex === 79 ? 20 : 1;
  for (let marketIndex = 0; marketIndex < marketCount; marketIndex += 1) {
    const probability = 0.15 + ((eventIndex + marketIndex) % 8) * 0.1;
    evaluationSamples.push({
      eventId: `event-${eventIndex}`,
      marketId: `market-${eventIndex}-${marketIndex}`,
      asset: "BTC",
      title: `Synthetic market ${eventIndex}-${marketIndex}`,
      endAt,
      observedAt,
      marketProbability: probability,
      outcome: probability >= 0.5 ? 1 : 0,
    });
  }
}

const evaluation = evaluateChronologicalModel(evaluationSamples);
assert.equal(evaluation.dataset.totalEvents, 80);
assert.equal(evaluation.dataset.trainEvents, 48);
assert.equal(evaluation.dataset.validationEvents, 16);
assert.equal(evaluation.dataset.testEvents, 16);
assert.equal(evaluation.dataset.testMarkets, 35);
assert.ok(evaluation.trading.trades <= evaluation.dataset.testEvents);
assert.equal(evaluation.quality.gates.find((gate) => gate.id === "same-holdout")?.passed, false);
assert.equal(evaluation.combinedTrading.selectedStrategy.id, "no-trade guard");
assert.equal(evaluation.combinedTrading.excessReturnPct, 0);
assert.equal(evaluation.quality.gates.find((gate) => gate.id === "benchmark")?.passed, false);
assert.equal(evaluation.dataset.hash, evaluateChronologicalModel([...evaluationSamples].reverse()).dataset.hash);

console.log("chronological model evaluation tests passed");

const combinedSamples: EvaluationSample[] = [];
for (let eventIndex = 0; eventIndex < 60; eventIndex += 1) {
  const long = eventIndex % 5 === 0 || eventIndex % 5 === 1;
  const polymarketLong = eventIndex % 2 === 0;
  const entryAt = new Date(Date.UTC(2024, 0, 1 + eventIndex * 2, 0));
  const exitAt = new Date(entryAt.getTime() + 24 * 60 * 60 * 1_000);
  combinedSamples.push({
    eventId: `combined-${eventIndex}`,
    marketId: `combined-market-${eventIndex}`,
    asset: "BTC",
    title: "Will Bitcoin be above $100 on the test date?",
    endAt: exitAt.toISOString(),
    observedAt: entryAt.toISOString(),
    marketProbability: polymarketLong ? 0.8 : 0.2,
    realizedVolatility24h: 0.02,
    hyperliquidEntryAt: entryAt.toISOString(),
    hyperliquidEntryPrice: 100,
    hyperliquidExitAt: exitAt.toISOString(),
    hyperliquidExitPrice: long ? 102 : 98,
    executionPriceSource: "synchronized-1m",
    hyperliquidMomentum6h: long ? 0.01 : -0.01,
    hyperliquidMomentum24h: long ? 0.02 : -0.02,
    thresholdKind: "above",
    thresholdLower: 100,
    thresholdUpper: null,
    outcome: long ? 1 : 0,
  });
}

const combined = evaluateCombinedTrading(combinedSamples);
assert.notEqual(combined.selectedStrategy.id, "no-trade guard");
assert.equal(combined.trades, 24);
assert.equal(combined.longTrades + combined.shortTrades, 24);
assert.ok(combined.longTrades > 0 && combined.shortTrades > 0);
assert.ok(combined.netReturnPct > 0);
assert.ok(combined.excessReturnPct > 0);
assert.equal(combined.statisticallyPositive, true);
assert.ok((combined.deflatedSharpeProbability ?? 0) > 0.95);
assert.equal(combined.strategyTrials, 19);
assert.equal(combined.walkForwardFolds, 4);
assert.equal(combined.walkForwardChronologyValid, true);
assert.equal(combined.walkForwardSelections.length, 4);
assert.equal(combined.walkForwardSelections.every((fold) => fold.selectedFromPastOnly), true);
assert.equal(combined.walkForwardSelections.every((fold) => (
  new Date(fold.trainingEndedAt as string).getTime() <= new Date(fold.testStartedAt as string).getTime()
)), true);
assert.equal(combined.selectedFromValidation, true);
assert.equal(combined.closestHoldoutAudit?.strategy.id, combined.closestValidationCandidate?.id);
assert.equal(combined.closestHoldoutAudit?.trades, 24);
assert.equal(combined.closestHoldoutAudit?.attribution.byAsset.reduce((sum, slice) => sum + slice.trades, 0), 24);
assert.equal(combined.closestHoldoutAudit?.attribution.bySide.reduce((sum, slice) => sum + slice.trades, 0), 24);
assert.equal(combined.closestHoldoutAudit?.attribution.byFundingStrength.reduce((sum, slice) => sum + slice.trades, 0), 24);
assert.equal(combined.closestHoldoutAudit?.attribution.byConsensus.reduce((sum, slice) => sum + slice.trades, 0), 24);
assert.equal(combined.candidateDiagnostics.length, 10);
assert.equal(combined.candidateDiagnostics.some((candidate) => candidate.passed), true);
assert.equal(
  combined.candidateDiagnostics
    .find((candidate) => candidate.strategy.signalRule === "polymarket-only")
    ?.gates.find((gate) => gate.id === "benchmark")?.passed,
  false,
);
assert.equal(combined.benchmarks.randomTrials, 200);
assert.ok(Number.isFinite(combined.benchmarks.polymarketDirectionReturnPct));
assert.ok(Number.isFinite(combined.benchmarks.randomMedianReturnPct));
assert.deepEqual(combined.benchmarks, evaluateCombinedTrading(combinedSamples).benchmarks);

const hourlyFallbackCombined = evaluateCombinedTrading(combinedSamples.map((sample) => ({
  ...sample,
  executionPriceSource: "hyperliquid-1h",
})));
assert.equal(hourlyFallbackCombined.totalEligibleSignals, 0);
assert.equal(hourlyFallbackCombined.trades, 0);
assert.equal(hourlyFallbackCombined.selectedStrategy.id, "no-trade guard");
assert.equal(hourlyFallbackCombined.walkForwardChronologyValid, false);

const combinedChronologicalEvaluation = evaluateChronologicalModel(combinedSamples);
assert.equal(combinedChronologicalEvaluation.quality.gates.find((gate) => gate.id === "chronology")?.passed, true);
const combinedHorizonStudy = toHorizonStudy(combinedChronologicalEvaluation);
assert.equal(combinedHorizonStudy.testEvents, combinedChronologicalEvaluation.dataset.testEvents);
assert.equal(combinedHorizonStudy.eligibleSignals, combinedChronologicalEvaluation.combinedTrading.eligibleSignals);
assert.equal(combinedHorizonStudy.netReturnPct, combinedChronologicalEvaluation.combinedTrading.netReturnPct);
assert.equal(combinedHorizonStudy.excessReturnPct, combinedChronologicalEvaluation.combinedTrading.excessReturnPct);

const evaluationRunFixture = {
  id: "evaluation-run-1",
  modelVersion: combinedChronologicalEvaluation.modelVersion,
  status: "completed",
  datasetHash: combinedChronologicalEvaluation.dataset.hash,
  configJson: JSON.stringify({ codeRevision: "revision-abc", primaryHorizonHours: 24 }),
  error: null,
  startedAt: new Date("2026-07-18T00:00:00Z"),
  completedAt: new Date("2026-07-18T00:02:00Z"),
};
const evaluationSummary = summarizeModelEvaluation(evaluationRunFixture, combinedChronologicalEvaluation);
assert.equal(evaluationSummary.id, evaluationRunFixture.id);
assert.equal(evaluationSummary.codeRevision, "revision-abc");
assert.equal(evaluationSummary.durationMs, 120_000);
assert.equal(evaluationSummary.result.source, "selected-strategy");
assert.equal(evaluationSummary.result.trades, combinedChronologicalEvaluation.combinedTrading.trades);
assert.equal(evaluationSummary.horizons.length, 0);
assert.equal(
  modelEvaluationConfigHash(JSON.stringify({ b: 2, a: 1 })),
  modelEvaluationConfigHash(JSON.stringify({ a: 1, b: 2 })),
);
assert.equal(
  modelEvaluationConfigHash(JSON.stringify({ codeRevision: "revision-a", threshold: 0.5 })),
  modelEvaluationConfigHash(JSON.stringify({ codeRevision: "revision-b", threshold: 0.5 })),
);
const evaluationCsv = modelEvaluationSummariesCsv([{ ...evaluationSummary, modelVersion: 'model,"quoted"' }]);
assert.ok(evaluationCsv.startsWith("run_id,completed_at,status"));
assert.ok(evaluationCsv.includes('"model,""quoted"""'));

const concurrentCombined = evaluateCombinedTrading([
  ...combinedSamples,
  ...combinedSamples.map((sample) => ({
    ...sample,
    eventId: `${sample.eventId}-eth`,
    marketId: `${sample.marketId}-eth`,
    asset: "ETH" as const,
  })),
]);
assert.equal(concurrentCombined.totalEligibleSignals, 120);
assert.equal(concurrentCombined.validationEligibleSignals, 72);
assert.equal(concurrentCombined.trades, 48);

const reversionCombined = evaluateCombinedTrading(combinedSamples.map((sample) => ({
  ...sample,
  hyperliquidExitPrice: sample.hyperliquidExitPrice === 102 ? 98 : 102,
})));
assert.equal(reversionCombined.selectedStrategy.signalRule, "hyperliquid-reversion");
assert.equal(reversionCombined.trades, 24);
assert.ok(reversionCombined.netReturnPct > 0);
assert.ok(reversionCombined.excessReturnPct > 0);

const fundingCombined = evaluateCombinedTrading(combinedSamples.map((sample, index) => {
  const positiveFunding = index % 4 < 2;
  const carryLong = !positiveFunding;
  return {
    ...sample,
    hyperliquidExitPrice: carryLong ? 102 : 98,
    hyperliquidMomentum6h: 0,
    hyperliquidFunding24h: positiveFunding ? 0.0007 : -0.0007,
    hyperliquidFundingDuringTrade: positiveFunding ? 0.0007 : -0.0007,
  };
}));
assert.equal(fundingCombined.selectedStrategy.signalRule, "hyperliquid-funding-carry");
assert.equal(fundingCombined.closestHoldoutAudit?.strategy.signalRule, "hyperliquid-funding-carry");
assert.equal(fundingCombined.trades, 24);
assert.ok(fundingCombined.netReturnPct > 0);
assert.ok(fundingCombined.excessReturnPct > 0);

const guarded = evaluateCombinedTrading(combinedSamples.map((sample, index) => index < 36 ? ({
  ...sample,
  hyperliquidExitPrice: 100,
}) : sample));
assert.equal(guarded.selectedStrategy.id, "no-trade guard");
assert.equal(guarded.selectedFromValidation, false);
assert.ok(guarded.closestValidationCandidate);
assert.ok(guarded.closestHoldoutAudit);
assert.equal(guarded.candidateDiagnostics.every((candidate) => !candidate.passed), true);
assert.notEqual(guarded.benchmarkReturnPct, 0);
assert.ok(Math.abs(guarded.excessReturnPct + guarded.benchmarkReturnPct) < 1e-12);

console.log("combined Polymarket and Hyperliquid strategy tests passed");

assert.equal(normalizeExchangeOrderStatus({ status: "query_error", error: "temporary timeout" }), null);
assert.equal(normalizeExchangeOrderStatus({ status: "unknownOid" }), null);
assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status: "filled" } }), "FILLED");
assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status: "open" } }), "OPEN");
assert.deepEqual(parseHyperliquidOrderEvidence({
  status: "ok",
  response: { data: { statuses: [{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } }] } },
}, "order"), {
  recognized: true,
  status: "FILLED",
  exchangeStatus: "filled",
  exchangeOrderId: "77747314",
  filledQuantity: 0.02,
  averageFillPrice: 1891.4,
  feePaid: 0,
  reason: null,
});
assert.equal(parseHyperliquidOrderEvidence({
  status: "ok",
  response: { data: { statuses: [{ error: "Order must have minimum value of $10." }] } },
}, "order").status, "REJECTED");
assert.equal(parseHyperliquidOrderEvidence({
  status: "order",
  order: { status: "open", order: { oid: 42, origSz: "1", sz: "0.4" } },
}, "query").status, "PARTIALLY_FILLED");
const partialIocEvidence = normalizeHyperliquidFillAgainstRequestedQuantity(parseHyperliquidOrderEvidence({
  status: "ok",
  response: { data: { statuses: [{ filled: { totalSz: "0.4", avgPx: "100", oid: 43 } }] } },
}, "order"), 1);
assert.equal(partialIocEvidence.status, "PARTIALLY_FILLED");
assert.equal(normalizeHyperliquidFillAgainstRequestedQuantity({ ...partialIocEvidence, status: "FILLED", filledQuantity: 1 }, 1).status, "FILLED");
assert.equal(parseHyperliquidOrderEvidence({
  status: "ok",
  response: { data: { statuses: ["success"] } },
}, "cancel").status, "CANCELLED");
assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status: "marginCanceled" } }), "CANCELLED");
for (const status of [
  "vaultWithdrawalCanceled",
  "openInterestCapCanceled",
  "selfTradeCanceled",
  "reduceOnlyCanceled",
  "siblingFilledCanceled",
  "delistedCanceled",
  "liquidatedCanceled",
  "scheduledCancel",
]) {
  assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status } }), "CANCELLED", status);
}
for (const status of [
  "tickRejected",
  "minTradeNtlRejected",
  "perpMarginRejected",
  "reduceOnlyRejected",
  "badAloPxRejected",
  "iocCancelRejected",
  "badTriggerPxRejected",
  "marketOrderNoLiquidityRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "positionFlipAtOpenInterestCapRejected",
  "tooAggressiveAtOpenInterestCapRejected",
  "openInterestIncreaseRejected",
  "insufficientSpotBalanceRejected",
  "oracleRejected",
  "perpMaxPositionRejected",
]) {
  assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status } }), "REJECTED", status);
}
const aggregatedTestnetFill = aggregateHyperliquidFills([
  { oid: 42, sz: "0.2", px: "100", fee: "0.01" },
  { oid: 42, sz: "0.3", px: "102", fee: "0.02" },
]).get("42");
assert.equal(aggregatedTestnetFill?.filledQuantity, 0.5);
assert.ok(Math.abs((aggregatedTestnetFill?.averageFillPrice ?? 0) - 101.2) < 1e-12);
assert.ok(Math.abs((aggregatedTestnetFill?.feePaid ?? 0) - 0.03) < 1e-12);
assert.deepEqual(evaluateTestnetAccountSafety({
  accountValue: 100,
  previousAccountValue: 102,
  orderMismatchCount: 0,
  positionMismatchCount: 0,
  maximumAccountLossPct: 0.05,
}), {
  healthy: true,
  accountLossPct: 2 / 102,
  referenceAccountValue: 102,
  maximumAccountLossPct: 0.05,
  issues: [],
});
assert.deepEqual(evaluateTestnetAccountSafety({
  accountValue: 92,
  previousAccountValue: 96,
  highWaterAccountValue: 100,
  orderMismatchCount: 0,
  positionMismatchCount: 0,
  maximumAccountLossPct: 0.05,
}), {
  healthy: false,
  accountLossPct: 0.08,
  referenceAccountValue: 100,
  maximumAccountLossPct: 0.05,
  issues: ["account-loss-limit"],
});
assert.deepEqual(evaluateTestnetAccountSafety({
  accountValue: 90,
  previousAccountValue: 100,
  orderMismatchCount: 1,
  positionMismatchCount: 1,
  maximumAccountLossPct: 0.05,
}).issues, ["account-loss-limit", "order-mismatch", "position-mismatch"]);
assert.deepEqual(evaluateTestnetAccountSafety({
  accountValue: 0,
  previousAccountValue: null,
  orderMismatchCount: 0,
  positionMismatchCount: 0,
}).issues, ["account-value-unavailable"]);
const testnetVerificationNow = new Date("2026-01-08T00:00:00Z");
const completeTestnetVerification = {
  status: "PASSED",
  connectivityPassed: true,
  openFillPassed: true,
  closeFillPassed: true,
  restingOrderPassed: true,
  cancelPassed: true,
  partialFillObserved: true,
  reconnectPassed: true,
  reconciliationPassed: true,
  emergencyCleanupPassed: true,
  orphanOrderCount: 0,
  positionMismatchCount: 0,
  completedAt: new Date("2026-01-07T23:00:00Z"),
};
const cleanTestnetAccount = {
  healthy: true,
  openOrderCount: 0,
  positionCount: 0,
  orderMismatchCount: 0,
  positionMismatchCount: 0,
  capturedAt: new Date("2026-01-07T23:59:00Z"),
};
assert.equal(evaluateHyperliquidTestnetVerificationReadiness({
  executionReady: true,
  verification: completeTestnetVerification,
  account: cleanTestnetAccount,
  now: testnetVerificationNow,
}).ready, true);
const partialFillUnverified = evaluateHyperliquidTestnetVerificationReadiness({
  executionReady: true,
  verification: { ...completeTestnetVerification, status: "PARTIAL", partialFillObserved: false },
  account: cleanTestnetAccount,
  now: testnetVerificationNow,
});
assert.equal(partialFillUnverified.ready, false);
assert.ok(partialFillUnverified.failedChecks.includes("partialFill"));
assert.equal(evaluateHyperliquidTestnetVerificationReadiness({
  executionReady: true,
  verification: completeTestnetVerification,
  account: { ...cleanTestnetAccount, openOrderCount: 1 },
  now: testnetVerificationNow,
}).failedChecks.includes("zeroExposure"), true);
assert.equal(new HyperliquidDefinitiveOrderError("blocked").name, "HyperliquidDefinitiveOrderError");
assert.equal(normalizeTestnetSmokeOrderSize("BTC", 12, 64_000, 25), 0.00019);
assert.equal(normalizeTestnetSmokeOrderSize("SOL", 12, 75, 25), 0.16);
assert.throws(() => normalizeTestnetSmokeOrderSize("XRP", 12, 100, 9), /minimum notional/);
assert.deepEqual(planTestnetReconciliationBatches([]), [[]]);
const reconciliationBatches = planTestnetReconciliationBatches(
  Array.from({ length: 61 }, (_, index) => `order-${index + 1}`),
);
assert.deepEqual(reconciliationBatches.map((batch) => batch.length), [25, 25, 11]);
assert.equal(new Set(reconciliationBatches.flat()).size, 61);
assert.deepEqual(planTestnetReconciliationBatches(["a", "a", "b"], 50), [["a", "b"]]);

const emergencySequence: string[] = [];
const verifiedEmergencyCleanup = await performHyperliquidTestnetEmergencyCleanup({
  cancelOutstanding: async () => {
    emergencySequence.push("cancel");
    return { verified: true, attempted: 1, cancelled: 1, failed: 0, remainingOpenOrders: [] };
  },
  flattenPositions: async () => {
    emergencySequence.push("flatten");
    return { verified: true, attempted: 1, flattened: 1, failed: 0, remainingPositions: [] };
  },
  reconcile: async () => {
    emergencySequence.push("reconcile");
    return { connected: true, openOrders: [], positions: [], orderMismatches: [], positionMismatches: [] };
  },
});
assert.deepEqual(emergencySequence, ["cancel", "flatten", "reconcile"]);
assert.equal(verifiedEmergencyCleanup.verified, true);
assert.deepEqual(verifiedEmergencyCleanup.issues, []);

const recoveredEmergencyCleanup = await performHyperliquidTestnetEmergencyCleanup({
  cancelOutstanding: async () => { throw new Error("temporary cancellation failure"); },
  flattenPositions: async () => ({ verified: true, attempted: 1, flattened: 1, failed: 0, remainingPositions: [] }),
  reconcile: async () => ({ connected: true, openOrders: [], positions: [], orderMismatches: [], positionMismatches: [] }),
});
assert.equal(recoveredEmergencyCleanup.verified, true);
assert.match(recoveredEmergencyCleanup.issues[0] ?? "", /^cancel-error:/);

const unresolvedEmergencyCleanup = await performHyperliquidTestnetEmergencyCleanup({
  cancelOutstanding: async () => ({ verified: false, attempted: 1, cancelled: 0, failed: 1, remainingOpenOrders: [{}] }),
  flattenPositions: async () => ({ verified: false, attempted: 1, flattened: 0, failed: 1, remainingPositions: [{ coin: "BTC", size: 0.01 }] }),
  reconcile: async () => ({
    connected: true,
    openOrders: [{}],
    positions: [{ coin: "BTC", size: 0.01 }],
    orderMismatches: [{}],
    positionMismatches: [{}],
  }),
});
assert.equal(unresolvedEmergencyCleanup.verified, false);
assert.deepEqual(unresolvedEmergencyCleanup.final, {
  connected: true,
  openOrders: 1,
  positions: 1,
  orderMismatches: 1,
  positionMismatches: 1,
});
assert.ok(unresolvedEmergencyCleanup.issues.includes("final-reconciliation-unverified"));

const reconciliationNow = new Date("2026-01-01T00:10:00Z");
assert.deepEqual(evaluateTestnetReconciliationAlerts(undefined, reconciliationNow, false), []);
assert.equal(evaluateTestnetReconciliationAlerts(undefined, reconciliationNow, true)[0]?.title, "テストネット照合が未起動");
assert.equal(evaluateTestnetReconciliationAlerts({
  id: "testnet-reconcile",
  status: "healthy",
  message: null,
  lastSuccessAt: new Date("2026-01-01T00:09:00Z"),
  lastAttemptAt: new Date("2026-01-01T00:09:00Z"),
}, reconciliationNow, true).length, 0);
assert.equal(evaluateTestnetReconciliationAlerts({
  id: "testnet-reconcile",
  status: "healthy",
  message: null,
  lastSuccessAt: new Date("2026-01-01T00:00:00Z"),
  lastAttemptAt: new Date("2026-01-01T00:00:00Z"),
}, reconciliationNow, true)[0]?.title, "テストネット照合が停止");
assert.equal(evaluateTestnetReconciliationAlerts({
  id: "testnet-reconcile",
  status: "error",
  message: "order mismatch",
  lastSuccessAt: null,
  lastAttemptAt: reconciliationNow,
}, reconciliationNow, true)[0]?.message, "order mismatch");

console.log("testnet reconciliation status tests passed");

const knownTestnetCloid = deriveHyperliquidCloid("paper-order-1");
assert.match(knownTestnetCloid, /^0x[0-9a-f]{32}$/);
assert.deepEqual(compareTestnetOpenOrders(
  [{ coin: "BTC", oid: 42, cloid: knownTestnetCloid }],
  [{ asset: "BTC", clientOrderId: "paper-order-1", exchangeOrderId: null, status: "OPEN" }],
), []);
assert.deepEqual(compareTestnetOpenOrders(
  [{ coin: "ETH", oid: 99, cloid: "0x00000000000000000000000000000000" }],
  [{ asset: "BTC", clientOrderId: "paper-order-1", exchangeOrderId: "42", status: "PARTIALLY_FILLED" }],
), [
  { kind: "missing", asset: "BTC", clientOrderId: "paper-order-1", exchangeOrderId: "42" },
  { kind: "orphan", asset: "ETH", clientOrderId: null, exchangeOrderId: "99" },
]);
assert.deepEqual(compareTestnetOpenOrders(
  [],
  [{ asset: "BTC", clientOrderId: "paper-order-2", exchangeOrderId: null, status: "PENDING" }],
), []);
assert.deepEqual(compareTestnetOpenOrders(
  [],
  [{ asset: "SOL", clientOrderId: "uncertain-order", exchangeOrderId: null, status: "UNKNOWN", createdAt: new Date("2026-01-01T00:00:00Z") }],
  new Date("2026-01-01T00:01:00Z"),
), [
  { kind: "missing", asset: "SOL", clientOrderId: "uncertain-order", exchangeOrderId: null },
]);

assert.deepEqual(compareTestnetPositions(
  [{ coin: "BTC", size: 0.1 }, { coin: "ETH", size: -0.2 }],
  [
    { asset: "BTC", side: "LONG", action: "OPEN", quantity: 0.1 },
    { asset: "ETH", side: "SHORT", action: "OPEN", quantity: 0.1 },
  ],
), [{ asset: "ETH", expectedSize: -0.1, actualSize: -0.2, kind: "quantity" }]);
assert.deepEqual(compareTestnetPositions(
  [{ coin: "BTC", size: 0.04 }],
  [{ asset: "BTC", side: "LONG", action: "OPEN", quantity: 0.1, filledQuantity: 0.04, status: "PARTIALLY_FILLED" }],
), []);
assert.deepEqual(compareTestnetPositions(
  [],
  [
    { asset: "BTC", side: "LONG", action: "OPEN", quantity: 0.04, filledQuantity: 0.04, status: "FILLED" },
    { asset: "BTC", side: "LONG", action: "FLATTEN", quantity: 0.04, filledQuantity: 0.04, status: "FILLED" },
  ],
), []);

assert.equal(requiredApiAccess("GET", "/api/public-dashboard"), "public");
assert.equal(requiredApiAccess("GET", "/api/model-evaluations"), "public");
assert.equal(requiredApiAccess("GET", "/api/model-evaluations/evaluation-run-1"), "public");
assert.equal(requiredApiAccess("GET", "/api/short-term-backtests/latest"), "public");
assert.equal(requiredApiAccess("GET", "/api/realtime-short-term-backtests/latest"), "public");
assert.equal(requiredApiAccess("GET", "/api/forward-execution-audits/latest"), "public");
assert.equal(requiredApiAccess("POST", "/api/model-evaluations"), "admin");
assert.equal(requiredApiAccess("GET", "/api/markets/123"), "public");
assert.equal(requiredApiAccess("POST", "/api/markets"), "admin");
assert.equal(requiredApiAccess("POST", "/api/ai/chat"), "viewer");
const derivedViewerToken = await resolveViewerAccessToken("admin-secret", "");
assert.equal(derivedViewerToken.length, 64);
assert.equal(await resolveViewerAccessToken("admin-secret", "explicit-viewer"), "explicit-viewer");
assert.equal(authorizeApiRequest({
  method: "POST",
  pathname: "/api/ai/chat",
  authorization: `Bearer ${derivedViewerToken}`,
  adminToken: "admin-secret",
  viewerToken: derivedViewerToken,
}), "viewer");
assert.equal(authorizeApiRequest({
  method: "POST",
  pathname: "/api/combined-trading",
  authorization: `Bearer ${derivedViewerToken}`,
  adminToken: "admin-secret",
  viewerToken: derivedViewerToken,
}), null);
assert.equal(authorizeApiRequest({
  method: "POST",
  pathname: "/api/combined-trading",
  authorization: "Bearer admin-secret",
  adminToken: "admin-secret",
  viewerToken: derivedViewerToken,
}), "admin");
console.log("API access-scope tests passed");

const alertNow = new Date("2026-01-01T01:00:00Z");
const healthyHeartbeats = ["polymarket", "hyperliquid", "realtime-market-data", "forward-experiment", "short-term-direction", "forward-execution-audit-report", "realtime-short-term-backtest", "backtest"].map((id) => ({
  id,
  status: "healthy",
  message: null,
  lastSuccessAt: new Date(id === "realtime-market-data" ? "2026-01-01T00:59:55Z" : "2026-01-01T00:55:00Z"),
  lastAttemptAt: new Date(id === "realtime-market-data" ? "2026-01-01T00:59:55Z" : "2026-01-01T00:55:00Z"),
}));
assert.equal(evaluatePipelineAlerts(healthyHeartbeats, alertNow).length, 0);
assert.equal(evaluatePipelineAlerts(healthyHeartbeats.map((item) => item.id === "short-term-direction"
  ? { ...item, lastSuccessAt: new Date("2026-01-01T00:30:00Z"), lastAttemptAt: new Date("2026-01-01T00:59:00Z") }
  : item), alertNow).length, 0);
const staleAlerts = evaluatePipelineAlerts(healthyHeartbeats.map((item) => item.id === "polymarket"
  ? { ...item, lastSuccessAt: new Date("2026-01-01T00:30:00Z"), lastAttemptAt: new Date("2026-01-01T00:30:00Z") }
  : item), alertNow);
assert.equal(staleAlerts.some((alert) => alert.key === "pipeline-stale:polymarket"), true);
const firstAlertPlan = planAlertDeliveries(staleAlerts, {}, alertNow, 60 * 60 * 1_000);
assert.equal(firstAlertPlan.deliveries[0]?.event, "triggered");
const recoveredAlertPlan = planAlertDeliveries([], firstAlertPlan.next, new Date("2026-01-01T01:05:00Z"), 60 * 60 * 1_000);
assert.equal(recoveredAlertPlan.deliveries[0]?.event, "recovered");

const basisAlertRows = Array.from({ length: 10 }, (_, index) => ({
  exitPriceBasisPct: index % 2 ? 0.0012 : -0.0012,
  exitReferenceCapturedAt: new Date("2026-01-01T00:00:00Z"),
  closedAt: new Date("2026-01-01T00:01:30Z"),
}));
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.slice(0, 9)).length, 0);
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows)[0]?.severity, "warning");
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.map((row) => ({ ...row, exitPriceBasisPct: 0.004 })))[0]?.severity, "critical");
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.map((row) => ({ ...row, exitReferenceCapturedAt: null })))[0]?.severity, "warning");

const verifiedBackupRecord = {
  status: "healthy" as const,
  fileName: "polymarket-2026.db.enc",
  createdAt: "2026-01-01T00:55:00Z",
  verifiedAt: "2026-01-01T00:56:00Z",
  sizeBytes: 1_024,
  message: "verified",
};
const backupFiles = [{ name: "polymarket-2026.db.enc", modifiedAt: new Date("2026-01-01T00:55:00Z"), sizeBytes: 1_024 }];
assert.equal(evaluateBackupStatus({ files: backupFiles, record: verifiedBackupRecord, now: alertNow, maximumAgeMs: 2 * 60 * 60 * 1_000 }).status, "healthy");
assert.equal(evaluateBackupStatus({ files: backupFiles, record: { ...verifiedBackupRecord, sizeBytes: 512 }, now: alertNow, maximumAgeMs: 2 * 60 * 60 * 1_000 }).status, "error");
assert.equal(evaluateBackupStatus({ files: backupFiles, record: verifiedBackupRecord, now: new Date("2026-01-01T04:00:00Z"), maximumAgeMs: 2 * 60 * 60 * 1_000 }).status, "error");
assert.equal(evaluateBackupStatus({ files: backupFiles, record: null, now: alertNow, maximumAgeMs: 2 * 60 * 60 * 1_000 }).status, "waiting");
assert.equal(evaluateBackupStatus({ files: [], record: null, now: alertNow, maximumAgeMs: 2 * 60 * 60 * 1_000 }).status, "waiting");
assert.equal(nextBackupDelayMs({
  record: verifiedBackupRecord,
  latestFile: { name: "polymarket-2026.db.enc", sizeBytes: 1_024 },
  nowMs: new Date("2026-01-01T01:56:00Z").getTime(),
  intervalMs: 24 * 60 * 60 * 1_000,
}), 23 * 60 * 60 * 1_000);
assert.equal(nextBackupDelayMs({
  record: verifiedBackupRecord,
  latestFile: { name: "polymarket-newer.db.enc", sizeBytes: 1_024 },
  nowMs: alertNow.getTime(),
  intervalMs: 24 * 60 * 60 * 1_000,
}), 0);
assert.equal(nextBackupDelayMs({
  record: { ...verifiedBackupRecord, status: "error" },
  latestFile: { name: "polymarket-2026.db.enc", sizeBytes: 1_024 },
  nowMs: alertNow.getTime(),
  intervalMs: 24 * 60 * 60 * 1_000,
}), 0);
for (const name of [
  ".polymarket-2026.db",
  ".polymarket-2026.db-shm",
  ".polymarket-2026.db-wal",
  ".polymarket-2026.db-journal",
  ".polymarket-2026.db.enc.tmp",
  ".verify-2026.db-shm",
]) assert.equal(isTemporaryBackupArtifact(name), true, name);
assert.equal(isTemporaryBackupArtifact("polymarket-2026.db.enc"), false);

console.log("operational alert tests passed");

assert.deepEqual(resolveTunnelConfig({}, "3001"), {
  mode: "quick",
  args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3001"],
  publicUrl: "",
  allowQuickFallback: false,
});
const namedTunnel = resolveTunnelConfig({
  CLOUDFLARED_TUNNEL_TOKEN: "test-token",
  CLOUDFLARED_PUBLIC_URL: "https://api.example.com/",
}, "3001");
assert.equal(namedTunnel.mode, "named-token");
assert.equal(namedTunnel.publicUrl, "https://api.example.com");
assert.equal(namedTunnel.allowQuickFallback, true);
assert.throws(() => resolveTunnelConfig({ CLOUDFLARED_TUNNEL_TOKEN: "test-token" }, "3001"));
assert.equal(decideTunnelRecovery({ mode: "quick", allowQuickFallback: false }, 2, 3), "retry");
assert.equal(decideTunnelRecovery({ mode: "quick", allowQuickFallback: false }, 3, 3), "restart-quick");
assert.equal(decideTunnelRecovery({ mode: "named-token", allowQuickFallback: true }, 3, 3), "fallback-quick");
assert.equal(decideTunnelRecovery({ mode: "named-token", allowQuickFallback: false }, 3, 3), "retry");

console.log("tunnel configuration and recovery tests passed");
