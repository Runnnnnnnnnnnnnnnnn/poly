import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  buildRealtimeShortTermReplay,
  type RealtimeReplayTrade,
} from "../src/lib/model-evaluation/realtime-short-term-replay";
import {
  realtimeAssetSynchronizationVersion,
  realtimeSynchronizationVersion,
} from "../src/lib/realtime-market-data/collector";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const generatedAt = new Date();
const marketTicks = await prisma.realtimeMarketTick.findMany({
  where: { synchronizationVersion: realtimeSynchronizationVersion },
  orderBy: { capturedAt: "asc" },
  select: {
    id: true,
    eventId: true,
    marketId: true,
    asset: true,
    marketStartAt: true,
    marketEndAt: true,
    polymarketBestBid: true,
    polymarketBestAsk: true,
    polymarketUpdatedAt: true,
    negativeBestBid: true,
    negativeBestAsk: true,
    negativeUpdatedAt: true,
    hyperliquidBestBid: true,
    hyperliquidBestAsk: true,
    hyperliquidMidPrice: true,
    hyperliquidFundingRate: true,
    hyperliquidUpdatedAt: true,
    chainlinkPrice: true,
    chainlinkUpdatedAt: true,
    referencePrice: true,
    referenceUpdatedAt: true,
    captureSkewMs: true,
    capturedAt: true,
  },
});
const assetTicks = await prisma.realtimeAssetTick.findMany({
  where: { synchronizationVersion: realtimeAssetSynchronizationVersion },
  orderBy: { capturedAt: "asc" },
  select: {
    id: true,
    asset: true,
    hyperliquidBestBid: true,
    hyperliquidBestAsk: true,
    hyperliquidMidPrice: true,
    hyperliquidUpdatedAt: true,
    chainlinkPrice: true,
    chainlinkUpdatedAt: true,
    captureSkewMs: true,
    capturedAt: true,
  },
});
const marketIds = [...new Set(marketTicks.map((tick) => tick.marketId))];
const resolutions = marketIds.length ? await prisma.predictionMarket.findMany({
  where: { id: { in: marketIds }, resolved: true, result: { in: [0, 1] } },
  select: { id: true, result: true },
}) : [];

const baseReport = buildRealtimeShortTermReplay({
  generatedAt,
  marketTicks,
  assetTicks,
  resolutions: resolutions.flatMap((market) => market.result === 0 || market.result === 1
    ? [{ marketId: market.id, result: market.result }]
    : []),
  codeRevision: process.env.POLYMARKET_MODEL_REVISION,
});
const tradesCsv = serializeTrades(baseReport.trades);
const report = {
  ...baseReport,
  reproducibility: {
    ...baseReport.reproducibility,
    tradesCsvSha256: sha256(tradesCsv),
  },
};
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = resolve(
  process.env.REALTIME_SHORT_TERM_OUTPUT ?? resolve(root, "public/realtime-short-term-research.json"),
);
const historyPath = resolve(
  process.env.REALTIME_SHORT_TERM_HISTORY_OUTPUT ?? resolve(root, "public/realtime-short-term-research-history.json"),
);
const artifactRoot = resolve(
  (process.env.REALTIME_SHORT_TERM_ARTIFACT_ROOT ?? `${homedir()}/.polymarket-watch/artifacts/realtime-short-term-backtests`)
    .replace(/^~(?=\/)/, homedir()),
);
const runDirectory = resolve(artifactRoot, report.reproducibility.runId);
await mkdir(runDirectory, { recursive: true });
await writeAtomic(resolve(runDirectory, "report.json"), serializedReport);
await writeAtomic(resolve(runDirectory, "trades.csv"), tradesCsv);
await writeAtomic(resolve(artifactRoot, "latest.json"), serializedReport);
await writeAtomic(resolve(artifactRoot, "latest-trades.csv"), tradesCsv);
await writeAtomic(outputPath, serializedReport);
await updateHistory(historyPath, report);
await prisma.$disconnect();

if (process.env.REALTIME_SHORT_TERM_QUIET !== "1") {
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    coverage: report.coverage,
    selection: report.selection,
    variants: report.variants.map((variant) => ({
      id: variant.id,
      calibrationWindows: variant.calibration.independentWindows,
      calibrationReturn: variant.calibration.equalWeightNetReturnPct,
      holdoutWindows: variant.holdout.independentWindows,
      holdoutReturn: variant.holdout.equalWeightNetReturnPct,
    })),
  }, null, 2));
}

async function updateHistory(path: string, value: typeof report) {
  const current = await readJson<{ items?: unknown[] }>(path).catch(() => null);
  const selected = value.variants.find((variant) => variant.id === value.selection.selectedExploratoryCandidateId);
  const item = {
    runId: value.reproducibility.runId,
    generatedAt: value.generatedAt,
    codeRevision: value.reproducibility.codeRevision,
    datasetSha256: value.reproducibility.datasetSha256,
    specificationSha256: value.reproducibility.specificationSha256,
    status: value.selection.status,
    selectedCandidateId: value.selection.selectedExploratoryCandidateId,
    completeMarkets: value.coverage.completeMarkets,
    replayableMarkets: value.coverage.replayableMarkets,
    independentWindows: value.coverage.independentWindows,
    holdoutWindows: selected?.holdout.independentWindows ?? 0,
    holdoutTrades: selected?.holdout.trades ?? 0,
    holdoutEqualWeightNetReturnPct: selected?.holdout.equalWeightNetReturnPct ?? 0,
    holdoutHyperliquidNetReturnPct: selected?.holdout.hyperliquidNetReturnPct ?? 0,
    holdoutPolymarketNetReturnPct: selected?.holdout.polymarketNetReturnPct ?? 0,
    profitableFolds: selected?.walkForward.profitableFolds ?? 0,
    totalFolds: selected?.walkForward.totalFolds ?? 4,
  };
  const items = [item, ...(current?.items ?? [])]
    .filter((entry, index, all) => (
      typeof entry === "object" && entry !== null
      && all.findIndex((candidate) => (
        typeof candidate === "object" && candidate !== null
        && "runId" in candidate && "runId" in entry
        && candidate.runId === entry.runId
      )) === index
    ))
    .slice(0, 48);
  await writeAtomic(path, `${JSON.stringify({ items }, null, 2)}\n`);
  await writeAtomic(resolve(artifactRoot, "history.json"), `${JSON.stringify({ items }, null, 2)}\n`);
}

function serializeTrades(trades: RealtimeReplayTrade[]) {
  const keys = [
    "variantId",
    "strategy",
    "entryOffsetSeconds",
    "windowAt",
    "marketId",
    "eventId",
    "asset",
    "side",
    "officialResult",
    "correct",
    "observedAt",
    "entryAt",
    "exitAt",
    "entryDelayMs",
    "exitDelayMs",
    "startReferencePrice",
    "entryReferencePrice",
    "endReferencePrice",
    "marketProbability",
    "fairProbability",
    "probabilityEdge",
    "trendLogReturn",
    "volatility24h",
    "signalStrength",
    "polymarketEntryPrice",
    "polymarketFeePct",
    "polymarketReturnPct",
    "hyperliquidEntryPrice",
    "hyperliquidExitPrice",
    "hyperliquidReturnPct",
    "equalWeightReturnPct",
  ] as const;
  const header = keys.map(toSnakeCase).join(",");
  const rows = trades.map((trade) => keys.map((key) => csvCell(trade[key])).join(","));
  return `${header}\n${rows.join("\n")}\n`;
}

async function writeAtomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toSnakeCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
