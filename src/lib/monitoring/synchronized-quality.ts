const requiredAssets = ["BTC", "ETH", "SOL", "XRP"] as const;

export const synchronizedQualityRequirements = {
  minimumRecords: 1_000,
  minimumDurationHours: 48,
  minimumCoverage: 0.5,
  maximumP95SkewMs: 60_000,
  maximumP95AbsoluteBasisPct: 0.001,
  maximumCaptureGapMs: 5 * 60_000,
} as const;

export type SynchronizedQualityInput = {
  records: number;
  completeRecords: number;
  windowRecords: number;
  windowCompleteRecords: number;
  totalRecords: number;
  startedAt: Date | null;
  latestAt: Date | null;
  medianSkewMs: number | null;
  p95SkewMs: number | null;
  medianSpread: number | null;
  p95Spread: number | null;
  medianAbsoluteBasisPct: number | null;
  p95AbsoluteBasisPct: number | null;
  maximumCaptureGapMs: number | null;
  assets: Array<{ asset: string; records: number }>;
};

export function evaluateSynchronizedPriceQuality(input: SynchronizedQualityInput) {
  const durationHours = input.startedAt && input.latestAt
    ? Math.max(0, input.latestAt.getTime() - input.startedAt.getTime()) / (60 * 60 * 1_000)
    : 0;
  const coverage = input.totalRecords > 0 ? input.windowRecords / input.totalRecords : 0;
  const coveredAssets = new Set(input.assets.filter((asset) => asset.records > 0).map((asset) => asset.asset));
  const gates = [
    {
      id: "records" as const,
      label: `${synchronizedQualityRequirements.minimumRecords.toLocaleString("ja-JP")}件以上`,
      passed: input.records >= synchronizedQualityRequirements.minimumRecords,
    },
    {
      id: "duration" as const,
      label: `${synchronizedQualityRequirements.minimumDurationHours}時間連続`,
      passed: durationHours >= synchronizedQualityRequirements.minimumDurationHours
        && input.maximumCaptureGapMs !== null
        && input.maximumCaptureGapMs <= synchronizedQualityRequirements.maximumCaptureGapMs,
    },
    {
      id: "coverage" as const,
      label: `同期率${Math.round(synchronizedQualityRequirements.minimumCoverage * 100)}%以上`,
      passed: coverage >= synchronizedQualityRequirements.minimumCoverage,
    },
    {
      id: "timing" as const,
      label: "時刻ずれ95%点が60秒以内",
      passed: input.p95SkewMs !== null && input.p95SkewMs <= synchronizedQualityRequirements.maximumP95SkewMs,
    },
    {
      id: "assets" as const,
      label: `${requiredAssets.length}資産を網羅`,
      passed: requiredAssets.every((asset) => coveredAssets.has(asset)),
    },
    {
      id: "basis" as const,
      label: "価格差95%点が10bp以内",
      passed: input.p95AbsoluteBasisPct !== null
        && input.p95AbsoluteBasisPct <= synchronizedQualityRequirements.maximumP95AbsoluteBasisPct,
    },
  ];
  const enoughHistory = gates[0].passed && gates[1].passed;
  const status = !enoughHistory
    ? "collecting" as const
    : gates.every((gate) => gate.passed)
      ? "healthy" as const
      : "attention" as const;

  return {
    status,
    records: input.records,
    completeRecords: input.completeRecords,
    windowRecords: input.windowRecords,
    windowCompleteRecords: input.windowCompleteRecords,
    totalRecords: input.totalRecords,
    coverage,
    durationHours,
    startedAt: input.startedAt?.toISOString() ?? null,
    latestAt: input.latestAt?.toISOString() ?? null,
    medianSkewMs: input.medianSkewMs,
    p95SkewMs: input.p95SkewMs,
    medianSpread: input.medianSpread,
    p95Spread: input.p95Spread,
    medianAbsoluteBasisPct: input.medianAbsoluteBasisPct,
    p95AbsoluteBasisPct: input.p95AbsoluteBasisPct,
    maximumCaptureGapMs: input.maximumCaptureGapMs,
    assets: input.assets,
    passedGates: gates.filter((gate) => gate.passed).length,
    totalGates: gates.length,
    gates,
  };
}
