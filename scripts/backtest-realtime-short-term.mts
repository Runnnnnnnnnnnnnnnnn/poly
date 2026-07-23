import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  buildRealtimeShortTermReplay,
  type RealtimeReplayAssetTick,
  type RealtimeReplayMarketTick,
  type RealtimeReplayOpportunity,
  type RealtimeReplayTrade,
} from "../src/lib/model-evaluation/realtime-short-term-replay";
import {
  realtimeAssetSynchronizationVersion,
  realtimeSynchronizationVersion,
} from "../src/lib/realtime-market-data/collector";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const generatedAt = new Date();
const combinedInput = loadCombinedReplayInput(generatedAt);
const marketTicks = combinedInput?.marketTicks ?? await prisma.realtimeMarketTick.findMany({
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
const assetTicks = combinedInput?.assetTicks ?? await prisma.realtimeAssetTick.findMany({
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
  codeRevision: process.env.POLYMARKET_MODEL_REVISION ?? localCodeRevision(root),
});
const inputProvenance = combinedInput?.provenance ?? sqliteOnlyProvenance(marketTicks, assetTicks, generatedAt);
const tradesCsv = serializeTrades(baseReport.trades);
const opportunitiesCsv = serializeOpportunities(baseReport.opportunities);
const report = {
  ...baseReport,
  inputProvenance,
  reproducibility: {
    ...baseReport.reproducibility,
    inputMode: inputProvenance.mode,
    archivePartitions: inputProvenance.archivePartitions,
    archiveRows: inputProvenance.marketTicks.archiveRows + inputProvenance.assetTicks.archiveRows,
    sqliteRows: inputProvenance.marketTicks.sqliteRows + inputProvenance.assetTicks.sqliteRows,
    tradesCsvSha256: sha256(tradesCsv),
    opportunitiesCsvSha256: sha256(opportunitiesCsv),
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
await writeAtomic(resolve(runDirectory, "opportunities.csv"), opportunitiesCsv);
await writeAtomic(resolve(artifactRoot, "latest.json"), serializedReport);
await writeAtomic(resolve(artifactRoot, "latest-trades.csv"), tradesCsv);
await writeAtomic(resolve(artifactRoot, "latest-opportunities.csv"), opportunitiesCsv);
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
      calibrationExcessReturn: variant.calibration.excessReturnPct,
      holdoutWindows: variant.holdout.independentWindows,
      holdoutReturn: variant.holdout.equalWeightNetReturnPct,
      holdoutBestBenchmark: variant.holdout.bestBenchmarkId,
      holdoutExcessReturn: variant.holdout.excessReturnPct,
      holdoutBrierSkillScore: variant.holdout.brierSkillScore,
      holdoutBrierImprovementLower: variant.holdout.brierImprovementConfidenceInterval95?.[0] ?? null,
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
    holdoutLongWindows: selected?.holdout.longIndependentWindows ?? 0,
    holdoutShortWindows: selected?.holdout.shortIndependentWindows ?? 0,
    holdoutEqualWeightNetReturnPct: selected?.holdout.equalWeightNetReturnPct ?? 0,
    holdoutHyperliquidNetReturnPct: selected?.holdout.hyperliquidNetReturnPct ?? 0,
    holdoutPolymarketNetReturnPct: selected?.holdout.polymarketNetReturnPct ?? 0,
    holdoutBestBenchmarkId: selected?.holdout.bestBenchmarkId ?? null,
    holdoutBestBenchmarkNetReturnPct: selected?.holdout.bestBenchmarkNetReturnPct ?? null,
    holdoutExcessReturnPct: selected?.holdout.excessReturnPct ?? null,
    holdoutExcessConfidenceLowerPct: selected?.holdout.excessConfidenceInterval95?.[0] ?? null,
    holdoutMarketBrierScore: selected?.holdout.marketBrierScore ?? null,
    holdoutModelBrierScore: selected?.holdout.modelBrierScore ?? null,
    holdoutBrierImprovement: selected?.holdout.brierImprovement ?? null,
    holdoutBrierSkillScore: selected?.holdout.brierSkillScore ?? null,
    holdoutBrierImprovementConfidenceLower: selected?.holdout.brierImprovementConfidenceInterval95?.[0] ?? null,
    holdoutMarketLogLoss: selected?.holdout.marketLogLoss ?? null,
    holdoutModelLogLoss: selected?.holdout.modelLogLoss ?? null,
    holdoutLogLossImprovement: selected?.holdout.logLossImprovement ?? null,
    holdoutProbabilityEdgePassed: selected?.holdout.probabilityEdgePassed ?? false,
    profitableFolds: value.walkForwardSelection.profitableFolds,
    benchmarkBeatingFolds: value.walkForwardSelection.benchmarkBeatingFolds,
    totalFolds: value.walkForwardSelection.totalFolds,
    inputMode: value.inputProvenance.mode,
    archivePartitions: value.inputProvenance.archivePartitions,
    archiveRows: value.inputProvenance.marketTicks.archiveRows + value.inputProvenance.assetTicks.archiveRows,
    sqliteRows: value.inputProvenance.marketTicks.sqliteRows + value.inputProvenance.assetTicks.sqliteRows,
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
    "forecastProbability",
    "marketBrierScore",
    "modelBrierScore",
    "marketLogLoss",
    "modelLogLoss",
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
    "polymarketBaselineSide",
    "polymarketBaselineReturnPct",
    "hyperliquidBaselineSide",
    "hyperliquidBaselineReturnPct",
    "equalWeightReturnPct",
    "longEqualWeightReturnPct",
    "shortEqualWeightReturnPct",
  ] as const;
  const header = keys.map(toSnakeCase).join(",");
  const rows = trades.map((trade) => keys.map((key) => csvCell(trade[key])).join(","));
  return `${header}\n${rows.join("\n")}\n`;
}

function serializeOpportunities(opportunities: RealtimeReplayOpportunity[]) {
  const keys = [
    "entryOffsetSeconds",
    "windowAt",
    "marketId",
    "asset",
    "marketProbability",
    "trendLogReturn",
    "longPolymarketReturnPct",
    "shortPolymarketReturnPct",
    "longHyperliquidReturnPct",
    "shortHyperliquidReturnPct",
    "longEqualWeightReturnPct",
    "shortEqualWeightReturnPct",
  ] as const;
  const header = keys.map(toSnakeCase).join(",");
  const rows = opportunities.map((opportunity) => keys.map((key) => csvCell(opportunity[key])).join(","));
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

function localCodeRevision(cwd: string) {
  try {
    const revision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const dirty = execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8" }).trim();
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    return null;
  }
}

function toSnakeCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function loadCombinedReplayInput(now: Date): CombinedReplayInput | null {
  const stateRoot = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
  const archiveRoot = resolve(process.env.COLUMNAR_ARCHIVE_ROOT ?? resolve(stateRoot, "parquet"));
  const database = process.env.DATABASE_URL;
  const archivePresent = existsSync(resolve(archiveRoot, "table=realtime_market_tick"))
    || existsSync(resolve(archiveRoot, "table=realtime_asset_tick"));
  const python = analyticsPython(stateRoot);
  if (!database || (database.startsWith("file:") && !existsSync(sqliteDatabasePath(database) ?? ""))) {
    if (archivePresent) throw new Error("Parquet履歴を統合する運用データベースが見つかりません");
    return null;
  }
  if (!python || !existsSync(python)) {
    if (archivePresent) throw new Error("Parquet履歴を読み込む分析用Pythonが見つかりません");
    return null;
  }

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "polymarket-replay-input-"));
  const output = resolve(temporaryRoot, "input.json");
  const lookbackDays = normalizedLookbackDays(process.env.REALTIME_REPLAY_LOOKBACK_DAYS);
  try {
    execFileSync(python, [
      resolve(root, "scripts/export-realtime-replay-input.py"),
      "--database", database,
      "--archive", archiveRoot,
      "--output", output,
      "--market-sync", realtimeSynchronizationVersion,
      "--asset-sync", realtimeAssetSynchronizationVersion,
      "--lookback-days", String(lookbackDays),
      "--now", now.toISOString(),
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const payload = JSON.parse(readFileSync(output, "utf8")) as SerializedReplayInput;
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.marketTicks) || !Array.isArray(payload.assetTicks)) {
      throw new Error("統合リプレイ入力の形式が不正です");
    }
    return {
      provenance: payload.provenance,
      marketTicks: payload.marketTicks.map(reviveMarketTick),
      assetTicks: payload.assetTicks.map(reviveAssetTick),
    };
  } catch (error) {
    if (archivePresent) throw error;
    console.warn(`統合リプレイ入力を使えないためSQLiteだけで続行します: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function reviveMarketTick(value: Record<string, unknown>): RealtimeReplayMarketTick {
  return {
    ...value,
    marketStartAt: requiredDate(value.marketStartAt, "marketStartAt"),
    marketEndAt: requiredDate(value.marketEndAt, "marketEndAt"),
    polymarketUpdatedAt: requiredDate(value.polymarketUpdatedAt, "polymarketUpdatedAt"),
    negativeUpdatedAt: requiredDate(value.negativeUpdatedAt, "negativeUpdatedAt"),
    hyperliquidUpdatedAt: requiredDate(value.hyperliquidUpdatedAt, "hyperliquidUpdatedAt"),
    chainlinkUpdatedAt: optionalDate(value.chainlinkUpdatedAt, "chainlinkUpdatedAt"),
    referenceUpdatedAt: requiredDate(value.referenceUpdatedAt, "referenceUpdatedAt"),
    capturedAt: requiredDate(value.capturedAt, "capturedAt"),
  } as RealtimeReplayMarketTick;
}

function reviveAssetTick(value: Record<string, unknown>): RealtimeReplayAssetTick {
  return {
    ...value,
    hyperliquidUpdatedAt: requiredDate(value.hyperliquidUpdatedAt, "hyperliquidUpdatedAt"),
    chainlinkUpdatedAt: optionalDate(value.chainlinkUpdatedAt, "chainlinkUpdatedAt"),
    capturedAt: requiredDate(value.capturedAt, "capturedAt"),
  } as RealtimeReplayAssetTick;
}

function requiredDate(value: unknown, field: string) {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error(`統合リプレイ入力の${field}が不正です`);
  return date;
}

function optionalDate(value: unknown, field: string) {
  return value === null || value === undefined ? null : requiredDate(value, field);
}

function sqliteDatabasePath(value: string | undefined) {
  if (!value?.startsWith("file:")) return null;
  return resolve(root, value.slice("file:".length).replace(/^['"]|['"]$/g, ""));
}

function analyticsPython(stateRoot: string) {
  const marker = resolve(stateRoot, "analytics-python-path");
  const candidates = [
    process.env.COLUMNAR_ARCHIVE_PYTHON,
    existsSync(marker) ? readFileSync(marker, "utf8").trim() : null,
    resolve(stateRoot, "analytics-venv/bin/python"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function normalizedLookbackDays(value: string | undefined) {
  const parsed = Number(value ?? 30);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(3_650, Math.max(0, Math.floor(parsed)));
}

function sqliteOnlyProvenance(
  marketTicks: RealtimeReplayMarketTick[],
  assetTicks: RealtimeReplayAssetTick[],
  now: Date,
): ReplayInputProvenance {
  const summary = (ticks: Array<{ capturedAt: Date }>): ReplayInputSource => ({
    archiveRows: 0,
    sqliteRows: ticks.length,
    mergedRows: ticks.length,
    duplicatesRemoved: 0,
    firstCapturedAt: ticks[0]?.capturedAt.toISOString() ?? null,
    latestCapturedAt: ticks.at(-1)?.capturedAt.toISOString() ?? null,
  });
  return {
    mode: "sqlite",
    archivePartitions: 0,
    lookbackDays: 0,
    sinceAt: null,
    beforeAt: now.toISOString(),
    marketTicks: summary(marketTicks),
    assetTicks: summary(assetTicks),
  };
}

type ReplayInputSource = {
  archiveRows: number;
  sqliteRows: number;
  mergedRows: number;
  duplicatesRemoved: number;
  firstCapturedAt: string | null;
  latestCapturedAt: string | null;
};

type ReplayInputProvenance = {
  mode: "sqlite" | "parquet" | "hybrid";
  archivePartitions: number;
  lookbackDays: number;
  sinceAt: string | null;
  beforeAt: string;
  marketTicks: ReplayInputSource;
  assetTicks: ReplayInputSource;
};

type SerializedReplayInput = {
  schemaVersion: number;
  provenance: ReplayInputProvenance;
  marketTicks: Array<Record<string, unknown>>;
  assetTicks: Array<Record<string, unknown>>;
};

type CombinedReplayInput = {
  provenance: ReplayInputProvenance;
  marketTicks: RealtimeReplayMarketTick[];
  assetTicks: RealtimeReplayAssetTick[];
};
