import { createHash } from "node:crypto";

export function dashboardStateFingerprint(snapshot) {
  const monitoring = snapshot?.monitoring ?? {};
  const combined = monitoring.combinedShadow ?? {};
  const shortTerm = combined.shortTermDirection ?? {};
  const audit = shortTerm.executionAudit ?? {};
  const forward = combined.forwardEvaluation ?? {};
  const testnet = combined.testnet ?? {};
  const latestEvaluation = snapshot?.modelEvaluations?.[0] ?? {};

  const state = {
    status: monitoring.status ?? null,
    tradeReadiness: monitoring.tradeReadiness ?? null,
    shortTerm: {
      status: shortTerm.status ?? null,
      running: shortTerm.running ?? null,
      trades: shortTerm.trades ?? null,
      openPositions: shortTerm.openPositions ?? null,
      progressPct: shortTerm.progressPct ?? null,
      netReturnPct: shortTerm.netReturnPct ?? null,
      excessReturnPct: shortTerm.excessReturnPct ?? null,
      confidenceLowerPct: shortTerm.confidenceLowerPct ?? null,
      maxDrawdownPct: shortTerm.maxDrawdownPct ?? null,
      passedGates: shortTerm.passedGates ?? null,
      totalGates: shortTerm.totalGates ?? null,
      latestAction: shortTerm.latestAction ?? null,
      latestReason: shortTerm.latestReason ?? null,
      specificationHash: shortTerm.specificationHash ?? null,
      realTradingEnabled: shortTerm.realTradingEnabled ?? null,
      audit: {
        status: audit.status ?? null,
        readinessStatus: audit.readinessStatus ?? null,
        eligiblePositions: audit.eligiblePositions ?? null,
        auditedPositions: audit.auditedPositions ?? null,
        verifiedPositions: audit.verifiedPositions ?? null,
        verifiedIndependentEvents: audit.verifiedIndependentEvents ?? null,
        verifiedCoverage: audit.verifiedCoverage ?? null,
        portfolioNetReturnPct: audit.portfolioNetReturnPct ?? null,
        benchmarkReturnPct: audit.benchmarkReturnPct ?? null,
        excessReturnPct: audit.excessReturnPct ?? null,
        maxDrawdownPct: audit.maxDrawdownPct ?? null,
        passedReadinessGates: audit.passedReadinessGates ?? null,
        missingEntry: audit.missingEntry ?? null,
        missingExit: audit.missingExit ?? null,
        missingResolution: audit.missingResolution ?? null,
      },
    },
    forward: {
      status: forward.status ?? null,
      trades: forward.trades ?? null,
      progressPct: forward.progressPct ?? null,
      netReturnPct: forward.netReturnPct ?? null,
      excessReturnPct: forward.excessReturnPct ?? null,
      passedGates: forward.passedGates ?? null,
      totalGates: forward.totalGates ?? null,
    },
    testnet: {
      ready: testnet.ready ?? null,
      verifiedReady: testnet.verifiedReady ?? null,
      enabled: testnet.enabled ?? null,
      reconciliationStatus: testnet.reconciliation?.status ?? null,
      verificationStatus: testnet.verification?.status ?? null,
      partialFillObserved: testnet.verification?.partialFillObserved ?? null,
      orphanOrderCount: testnet.verification?.orphanOrderCount ?? null,
      positionMismatchCount: testnet.verification?.positionMismatchCount ?? null,
    },
    modelEvaluation: {
      id: latestEvaluation.id ?? null,
      status: latestEvaluation.status ?? null,
      qualityStatus: latestEvaluation.qualityStatus ?? null,
      datasetHash: latestEvaluation.datasetHash ?? null,
      trades: latestEvaluation.result?.trades ?? null,
      netReturnPct: latestEvaluation.result?.netReturnPct ?? null,
      excessReturnPct: latestEvaluation.result?.excessReturnPct ?? null,
    },
  };

  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function shouldPublishDashboardSnapshot(input) {
  if (!input.currentFingerprint || input.currentFingerprint === input.publishedFingerprint) return false;
  if (input.lastPublishedAtMs === null) return true;
  return input.nowMs - input.lastPublishedAtMs >= input.minimumIntervalMs;
}
