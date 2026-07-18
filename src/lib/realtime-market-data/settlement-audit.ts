import { prisma } from "@/src/lib/server/prisma";
import { realtimeAssetSynchronizationVersion, realtimeSynchronizationVersion } from "@/src/lib/realtime-market-data/collector";

const defaultTargetMarkets = 50;
const defaultMaximumBoundaryErrorMs = 60_000;

export type ReferenceSettlementBoundary = {
  marketId: string;
  asset: string;
  officialResult: number;
  startPrice: number | null;
  endPrice: number | null;
  startErrorMs: number | null;
  endErrorMs: number | null;
};

export type ReferenceSettlementAudit = ReturnType<typeof evaluateReferenceSettlementAudit>;

export async function loadReferenceSettlementAudit(options: {
  targetMarkets?: number;
  maximumBoundaryErrorMs?: number;
} = {}) {
  const maximumBoundaryErrorMs = positiveInteger(
    options.maximumBoundaryErrorMs,
    defaultMaximumBoundaryErrorMs,
  );
  const rows = await prisma.$queryRaw<Array<{
    marketId: string;
    asset: string;
    officialResult: number | bigint;
    startPrice: number | null;
    endPrice: number | null;
    startErrorMs: number | bigint | null;
    endErrorMs: number | bigint | null;
  }>>`
    WITH collection_bounds AS (
      SELECT MIN("capturedAt") AS "firstAt", MAX("capturedAt") AS "lastAt"
      FROM "RealtimeMarketTick"
      WHERE "synchronizationVersion" = ${realtimeSynchronizationVersion}
    ), observed AS (
      SELECT
        tick."marketId" AS "marketId",
        tick."asset" AS "asset",
        MIN(tick."marketStartAt") AS "marketStartAt",
        MAX(tick."marketEndAt") AS "marketEndAt"
      FROM "RealtimeMarketTick" tick
      CROSS JOIN collection_bounds
      WHERE tick."synchronizationVersion" = ${realtimeSynchronizationVersion}
      GROUP BY tick."marketId", tick."asset", collection_bounds."firstAt", collection_bounds."lastAt"
      HAVING MIN(tick."marketStartAt") >= collection_bounds."firstAt"
        AND MAX(tick."marketEndAt") <= collection_bounds."lastAt"
    ), boundary_candidates AS (
      SELECT
        tick."marketId" AS "marketId",
        'START' AS "boundary",
        tick."referencePrice" AS "referencePrice",
        ABS(tick."referenceUpdatedAt" - tick."marketStartAt") AS "errorMs",
        tick."capturedAt" AS "capturedAt"
      FROM "RealtimeMarketTick" tick
      INNER JOIN observed ON observed."marketId" = tick."marketId"
      WHERE tick."synchronizationVersion" = ${realtimeSynchronizationVersion}
        AND tick."referenceSource" = 'CHAINLINK'
        AND ABS(tick."referenceUpdatedAt" - tick."marketStartAt") <= ${maximumBoundaryErrorMs}

      UNION ALL

      SELECT
        tick."marketId" AS "marketId",
        'END' AS "boundary",
        tick."referencePrice" AS "referencePrice",
        ABS(tick."referenceUpdatedAt" - tick."marketEndAt") AS "errorMs",
        tick."capturedAt" AS "capturedAt"
      FROM "RealtimeMarketTick" tick
      INNER JOIN observed ON observed."marketId" = tick."marketId"
      WHERE tick."synchronizationVersion" = ${realtimeSynchronizationVersion}
        AND tick."referenceSource" = 'CHAINLINK'
        AND ABS(tick."referenceUpdatedAt" - tick."marketEndAt") <= ${maximumBoundaryErrorMs}

      UNION ALL

      SELECT
        observed."marketId" AS "marketId",
        'START' AS "boundary",
        asset_tick."chainlinkPrice" AS "referencePrice",
        ABS(asset_tick."chainlinkUpdatedAt" - observed."marketStartAt") AS "errorMs",
        asset_tick."capturedAt" AS "capturedAt"
      FROM observed
      INNER JOIN "RealtimeAssetTick" asset_tick
        ON asset_tick."asset" = observed."asset"
      WHERE asset_tick."synchronizationVersion" = ${realtimeAssetSynchronizationVersion}
        AND asset_tick."chainlinkPrice" IS NOT NULL
        AND asset_tick."chainlinkUpdatedAt" IS NOT NULL
        AND asset_tick."capturedAt" BETWEEN observed."marketStartAt" - ${maximumBoundaryErrorMs + 15_000}
          AND observed."marketStartAt" + ${maximumBoundaryErrorMs + 15_000}
        AND ABS(asset_tick."chainlinkUpdatedAt" - observed."marketStartAt") <= ${maximumBoundaryErrorMs}

      UNION ALL

      SELECT
        observed."marketId" AS "marketId",
        'END' AS "boundary",
        asset_tick."chainlinkPrice" AS "referencePrice",
        ABS(asset_tick."chainlinkUpdatedAt" - observed."marketEndAt") AS "errorMs",
        asset_tick."capturedAt" AS "capturedAt"
      FROM observed
      INNER JOIN "RealtimeAssetTick" asset_tick
        ON asset_tick."asset" = observed."asset"
      WHERE asset_tick."synchronizationVersion" = ${realtimeAssetSynchronizationVersion}
        AND asset_tick."chainlinkPrice" IS NOT NULL
        AND asset_tick."chainlinkUpdatedAt" IS NOT NULL
        AND asset_tick."capturedAt" BETWEEN observed."marketEndAt" - ${maximumBoundaryErrorMs + 15_000}
          AND observed."marketEndAt" + ${maximumBoundaryErrorMs + 15_000}
        AND ABS(asset_tick."chainlinkUpdatedAt" - observed."marketEndAt") <= ${maximumBoundaryErrorMs}
    ), ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY "marketId", "boundary"
          ORDER BY "errorMs" ASC, "capturedAt" ASC
        ) AS "boundaryRank"
      FROM boundary_candidates
    )
    SELECT
      market."id" AS "marketId",
      market."asset" AS "asset",
      market."result" AS "officialResult",
      MAX(CASE WHEN ranked."boundary" = 'START' AND ranked."boundaryRank" = 1 THEN ranked."referencePrice" END) AS "startPrice",
      MAX(CASE WHEN ranked."boundary" = 'END' AND ranked."boundaryRank" = 1 THEN ranked."referencePrice" END) AS "endPrice",
      MAX(CASE WHEN ranked."boundary" = 'START' AND ranked."boundaryRank" = 1 THEN ranked."errorMs" END) AS "startErrorMs",
      MAX(CASE WHEN ranked."boundary" = 'END' AND ranked."boundaryRank" = 1 THEN ranked."errorMs" END) AS "endErrorMs"
    FROM observed
    INNER JOIN "PredictionMarket" market
      ON market."id" = observed."marketId"
      AND market."resolved" = 1
      AND market."result" IN (0, 1)
    LEFT JOIN ranked ON ranked."marketId" = market."id"
    GROUP BY market."id", market."asset", market."result"
    ORDER BY market."id" ASC
  `;

  return evaluateReferenceSettlementAudit(rows.map((row) => ({
    marketId: row.marketId,
    asset: row.asset,
    officialResult: finiteNumber(row.officialResult) ?? -1,
    startPrice: finiteNumber(row.startPrice),
    endPrice: finiteNumber(row.endPrice),
    startErrorMs: finiteNumber(row.startErrorMs),
    endErrorMs: finiteNumber(row.endErrorMs),
  })), {
    targetMarkets: options.targetMarkets,
    maximumBoundaryErrorMs,
  });
}

export function evaluateReferenceSettlementAudit(
  rows: ReferenceSettlementBoundary[],
  options: { targetMarkets?: number; maximumBoundaryErrorMs?: number } = {},
) {
  const targetMarkets = positiveInteger(options.targetMarkets, defaultTargetMarkets);
  const maximumBoundaryErrorMs = positiveInteger(
    options.maximumBoundaryErrorMs,
    defaultMaximumBoundaryErrorMs,
  );
  const eligible = rows.filter((row) => row.officialResult === 0 || row.officialResult === 1);
  const complete = eligible.flatMap((row) => {
    if (!positiveNumber(row.startPrice) || !positiveNumber(row.endPrice)) return [];
    if (!nonNegativeNumber(row.startErrorMs) || !nonNegativeNumber(row.endErrorMs)) return [];
    const derivedResult = row.endPrice >= row.startPrice ? 1 : 0;
    return [{
      ...row,
      startPrice: row.startPrice,
      endPrice: row.endPrice,
      startErrorMs: row.startErrorMs,
      endErrorMs: row.endErrorMs,
      derivedResult,
      matched: derivedResult === row.officialResult,
      maximumErrorMs: Math.max(row.startErrorMs, row.endErrorMs),
    }];
  });
  const matchedMarkets = complete.filter((row) => row.matched).length;
  const mismatchedMarkets = complete.length - matchedMarkets;
  const coverage = eligible.length ? complete.length / eligible.length : 0;
  const matchRate = complete.length ? matchedMarkets / complete.length : null;
  const boundaryErrors = complete.flatMap((row) => [row.startErrorMs, row.endErrorMs]);
  const medianBoundaryErrorMs = median(boundaryErrors);
  const maximumObservedBoundaryErrorMs = boundaryErrors.length ? Math.max(...boundaryErrors) : null;
  const byAsset = Array.from(new Set(eligible.map((row) => row.asset))).sort().map((asset) => {
    const assetRows = complete.filter((row) => row.asset === asset);
    return {
      asset,
      completeMarkets: assetRows.length,
      matchedMarkets: assetRows.filter((row) => row.matched).length,
      mismatchedMarkets: assetRows.filter((row) => !row.matched).length,
    };
  });
  const enoughData = complete.length >= targetMarkets;
  const gates = [
    { id: "samples" as const, label: `公式決着${targetMarkets}市場以上`, passed: enoughData },
    { id: "coverage" as const, label: "開始・終了価格の取得率95%以上", passed: enoughData && coverage >= 0.95 },
    { id: "agreement" as const, label: "Chainlink方向と正式決着の不一致0件", passed: enoughData && mismatchedMarkets === 0 },
    {
      id: "timing" as const,
      label: `境界価格の時刻誤差${Math.round(maximumBoundaryErrorMs / 1_000)}秒以内`,
      passed: enoughData
        && maximumObservedBoundaryErrorMs !== null
        && maximumObservedBoundaryErrorMs <= maximumBoundaryErrorMs,
    },
  ];
  const status = !enoughData
    ? "collecting" as const
    : gates.every((gate) => gate.passed)
      ? "healthy" as const
      : "attention" as const;

  return {
    status,
    source: "CHAINLINK" as const,
    rule: "終了価格が開始価格以上ならUp" as const,
    targetMarkets,
    resolvedObservedMarkets: eligible.length,
    completeMarkets: complete.length,
    missingBoundaryMarkets: eligible.length - complete.length,
    matchedMarkets,
    mismatchedMarkets,
    coverage,
    matchRate,
    medianBoundaryErrorMs,
    maximumBoundaryErrorMs: maximumObservedBoundaryErrorMs,
    allowedBoundaryErrorMs: maximumBoundaryErrorMs,
    byAsset,
    passedGates: gates.filter((gate) => gate.passed).length,
    totalGates: gates.length,
    gates,
  };
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function finiteNumber(value: number | bigint | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function positiveNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
