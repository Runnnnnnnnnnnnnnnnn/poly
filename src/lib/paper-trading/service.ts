import { prisma } from "@/src/lib/server/prisma";
import { discoverCryptoMarkets, fetchCurrentBook, fetchHistoricalProbability } from "@/src/lib/backtest/polymarket";
import type { CryptoAsset, CryptoMarket, PaperRunMetrics, PaperStrategyConfig } from "@/src/lib/backtest/types";

const DEFAULT_CONFIG: PaperStrategyConfig = {
  initialCash: 10_000,
  entryEdge: 0.03,
  maxPositionPct: 0.1,
  spreadBps: 200,
  slippageBps: 50,
  takerFeeRate: 0.07,
  minTrainingMarkets: 5,
  calibrationPrior: 2,
  maxMarkets: 30,
};

type PaperOptions = {
  accountId?: string;
  accountName?: string;
  asset?: CryptoAsset;
  mode?: "historical" | "live";
  strategy?: "calibrated_consensus";
  config?: Partial<PaperStrategyConfig>;
};

type Dataset = {
  market: CryptoMarket;
  history: Array<{ timestamp: string; probability: number }>;
  settleAt: number;
};

type OpenPosition = {
  positionId: string;
  marketId: string;
  outcome: "YES" | "NO";
  tokenId: string;
  quantity: number;
  costBasis: number;
};

type ForecastPoint = { probability: number; fairProbability: number; result: 0 | 1 };

type EngineState = {
  cash: number;
  open: Map<string, OpenPosition>;
  equity: number[];
  fees: number;
  orders: number;
  filledOrders: number;
  rejectedOrders: number;
  forecasts: ForecastPoint[];
};

export async function createPaperAccount(name = "default", initialCash = DEFAULT_CONFIG.initialCash) {
  const cash = Math.max(1, initialCash);
  return prisma.paperAccount.create({
    data: { id: crypto.randomUUID(), name, initialCash: cash, cashBalance: cash },
  });
}

export async function listPaperAccounts() {
  return prisma.paperAccount.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { runs: true } } } });
}

export async function createPaperRun(options: PaperOptions = {}) {
  const asset = options.asset ?? "BTC";
  const mode = options.mode ?? "historical";
  const strategy = options.strategy ?? "calibrated_consensus";
  const account = options.accountId
    ? await prisma.paperAccount.findUniqueOrThrow({ where: { id: options.accountId } })
    : await createPaperAccount(options.accountName ?? `${asset} paper account`, options.config?.initialCash ?? DEFAULT_CONFIG.initialCash);
  const config = normalizeConfig({ ...options.config, initialCash: options.config?.initialCash ?? account.initialCash });
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  await prisma.paperTradingRun.create({
    data: {
      id: runId,
      accountId: account.id,
      asset,
      mode,
      strategy,
      status: mode === "live" ? "running" : "running",
      initialCash: account.initialCash,
      configJson: JSON.stringify(config),
      startedAt,
    },
  });

  if (mode === "live") {
    await tickPaperRun(runId);
  } else {
    await executeHistoricalRun(runId, account.id, asset, config);
  }
  return getPaperRun(runId);
}

export async function tickPaperRun(runId: string) {
  const run = await prisma.paperTradingRun.findUniqueOrThrow({ where: { id: runId }, include: { account: true } });
  if (run.mode !== "live") throw new Error("Only live paper runs can be ticked");
  if (run.status !== "running") throw new Error(`run is ${run.status}`);
  const config = normalizeConfig(JSON.parse(run.configJson) as Partial<PaperStrategyConfig>);
  const state = await loadState(runId, run.account.cashBalance);
  const allMarkets = await discoverCryptoMarkets({ includeResolved: true, asset: run.asset as CryptoAsset, limit: Math.max(100, config.maxMarkets) });
  const marketById = new Map(allMarkets.map((market) => [market.id, market]));

  for (const position of Array.from(state.open.values())) {
    const market = marketById.get(position.marketId);
    if (market?.resolved && market.result !== null) await settlePosition(runId, state, position, market.result);
  }

  const activeMarkets = allMarkets.filter((market) => !market.resolved && market.currentProbability !== null).slice(0, config.maxMarkets);
  const training = await loadTrainingSamples(allMarkets, config.maxMarkets);
  for (const market of activeMarkets) {
    if (state.open.has(market.id)) continue;
    const yesBook = await fetchCurrentBook(market.tokenId).catch(() => null);
    const noBook = market.noTokenId ? await fetchCurrentBook(market.noTokenId).catch(() => null) : null;
    await considerTrade(runId, state, market, market.currentProbability as number, training, config, {
      yesPrice: yesBook?.asks[0]?.price ?? null,
      yesDepth: yesBook?.asks ?? [],
      noPrice: noBook?.asks[0]?.price ?? null,
      noDepth: noBook?.asks ?? [],
      minOrderSize: yesBook?.minOrderSize || market.minOrderSize || 5,
    });
  }
  await saveEquitySnapshot(runId, state, activeMarkets);
  await prisma.paperAccount.update({ where: { id: run.accountId }, data: { cashBalance: state.cash } });
  return getPaperRun(runId);
}

export async function listPaperRuns(accountId?: string) {
  const runs = await prisma.paperTradingRun.findMany({
    where: accountId ? { accountId } : undefined,
    orderBy: { startedAt: "desc" },
    take: 100,
    select: { id: true, accountId: true, asset: true, mode: true, strategy: true, status: true, initialCash: true, finalCash: true, metricsJson: true, startedAt: true, completedAt: true, error: true },
  });
  return runs.map((run) => ({ ...run, metrics: run.metricsJson ? parseJson(run.metricsJson) : null, metricsJson: undefined }));
}

export async function getPaperRun(runId: string) {
  const run = await prisma.paperTradingRun.findUnique({
    where: { id: runId },
    include: {
      orders: { orderBy: { submittedAt: "asc" } },
      fills: { orderBy: { filledAt: "asc" } },
      positions: { orderBy: { openedAt: "asc" } },
      equitySnapshots: { orderBy: { capturedAt: "asc" } },
    },
  });
  if (!run) return null;
  return {
    ...run,
    config: parseJson(run.configJson),
    metrics: run.metricsJson ? parseJson(run.metricsJson) : null,
    configJson: undefined,
    metricsJson: undefined,
  };
}

export async function stopPaperRun(runId: string) {
  const run = await prisma.paperTradingRun.findUniqueOrThrow({ where: { id: runId }, include: { account: true } });
  if (run.status === "running") {
    const config = normalizeConfig(JSON.parse(run.configJson) as Partial<PaperStrategyConfig>);
    const markets = await discoverCryptoMarkets({ includeResolved: true, asset: run.asset as CryptoAsset, limit: Math.max(100, config.maxMarkets) }).catch(() => []);
    const marketById = new Map(markets.map((market) => [market.id, market]));
    const openPositions = await prisma.paperPosition.findMany({ where: { runId, status: "OPEN" } });
    const positionsValue = openPositions.reduce((sum, position) => {
      const market = marketById.get(position.marketId);
      if (!market || market.currentProbability === null) return sum;
      const probability = position.outcome === "YES" ? market.currentProbability : 1 - market.currentProbability;
      return sum + position.quantity * probability;
    }, 0);
    const finalEquity = run.account.cashBalance + positionsValue;
    await prisma.paperEquitySnapshot.create({
      data: {
        id: crypto.randomUUID(),
        runId,
        capturedAt: new Date(),
        cash: run.account.cashBalance,
        positionsValue,
        equity: finalEquity,
        unrealizedPnl: positionsValue - openPositions.reduce((sum, position) => sum + position.costBasis, 0),
      },
    });
    await prisma.paperTradingRun.update({ where: { id: runId }, data: { status: "stopped", finalCash: finalEquity, completedAt: new Date() } });
  }
  return getPaperRun(runId);
}

async function executeHistoricalRun(runId: string, accountId: string, asset: CryptoAsset, config: PaperStrategyConfig) {
  const markets = await discoverCryptoMarkets({ includeResolved: true, asset, limit: config.maxMarkets });
  const resolved = markets.filter((market) => market.resolved && market.result !== null);
  const datasets = (await Promise.all(resolved.map(async (market) => {
    try {
      const history = await fetchHistoricalProbability(market.tokenId);
      const endMs = market.endDate ? new Date(market.endDate).getTime() : Number.POSITIVE_INFINITY;
      return { market, history: history.filter((point) => new Date(point.timestamp).getTime() <= endMs), settleAt: endMs } satisfies Dataset;
    } catch {
      return null;
    }
  }))).filter((dataset): dataset is Dataset => Boolean(dataset && dataset.history.length > 0));
  const state: EngineState = { cash: config.initialCash, open: new Map(), equity: [config.initialCash], fees: 0, orders: 0, filledOrders: 0, rejectedOrders: 0, forecasts: [] };
  const events = datasets.flatMap((dataset) => dataset.history.map((point) => ({ dataset, point, at: new Date(point.timestamp).getTime() }))).sort((a, b) => a.at - b.at);
  const settled = new Set<string>();
  const training = datasets;
  const historicalProbabilities = new Map<string, number>();

  for (const [eventIndex, event] of events.entries()) {
    historicalProbabilities.set(event.dataset.market.id, event.point.probability);
    const eventTimestamp = new Date(event.at + eventIndex);
    for (const dataset of datasets) {
      if (!settled.has(dataset.market.id) && dataset.settleAt <= event.at) {
        settled.add(dataset.market.id);
        if (state.open.has(dataset.market.id) && dataset.market.result !== null) {
          await settlePosition(runId, state, state.open.get(dataset.market.id) as OpenPosition, dataset.market.result, eventTimestamp);
        }
      }
    }
    const priorTraining = training.filter((dataset) => dataset.settleAt < event.at);
    if (!settled.has(event.dataset.market.id) && !state.open.has(event.dataset.market.id)) {
      await considerTrade(runId, state, event.dataset.market, event.point.probability, priorTraining, config, {
        yesPrice: null,
        yesDepth: [],
        noPrice: null,
        noDepth: [],
        minOrderSize: event.dataset.market.minOrderSize || 5,
      }, eventTimestamp);
    }
    const fair = calibratedProbability(event.point.probability, priorTraining, config);
    state.forecasts.push({ probability: event.point.probability, fairProbability: fair.probability, result: event.dataset.market.result as 0 | 1 });
    await saveEquitySnapshot(runId, state, datasets.map((dataset) => dataset.market), eventTimestamp, historicalProbabilities);
  }
  for (const dataset of datasets) {
    if (state.open.has(dataset.market.id) && dataset.market.result !== null) {
      const settlementTime = Number.isFinite(dataset.settleAt) ? new Date(dataset.settleAt) : new Date();
      await settlePosition(runId, state, state.open.get(dataset.market.id) as OpenPosition, dataset.market.result, settlementTime);
    }
  }
  await saveEquitySnapshot(runId, state, datasets.map((dataset) => dataset.market), new Date((events.at(-1)?.at ?? Date.now()) + events.length), historicalProbabilities);
  await finalizeRun(runId, accountId, state, config, datasets.length);
}

async function considerTrade(
  runId: string,
  state: EngineState,
  market: CryptoMarket,
  probability: number,
  training: Dataset[],
  config: PaperStrategyConfig,
  book: { yesPrice: number | null; yesDepth: Array<{ price: number; size: number }>; noPrice: number | null; noDepth: Array<{ price: number; size: number }>; minOrderSize: number },
  timestamp = new Date(),
) {
  const feeConfig = market.feesEnabled ? config : { ...config, takerFeeRate: 0 };
  const fair = calibratedProbability(probability, training, config);
  if (fair.count < config.minTrainingMarkets) return;
  const candidates = [
    {
      outcome: "YES" as const,
      tokenId: market.tokenId,
      edge: fair.probability - effectivePrice(probability, book.yesPrice, config, true) - feePerShare(effectivePrice(probability, book.yesPrice, config, true), feeConfig),
      price: effectivePrice(probability, book.yesPrice, config, true),
      depth: book.yesDepth,
      fairProbability: fair.probability,
    },
    {
      outcome: "NO" as const,
      tokenId: market.noTokenId,
      edge: (1 - fair.probability) - effectivePrice(1 - probability, book.noPrice, config, true) - feePerShare(effectivePrice(1 - probability, book.noPrice, config, true), feeConfig),
      price: effectivePrice(1 - probability, book.noPrice, config, true),
      depth: book.noDepth,
      fairProbability: 1 - fair.probability,
    },
  ].filter((candidate) => candidate.tokenId && candidate.price > 0 && candidate.price < 1).sort((a, b) => b.edge - a.edge);
  const selected = candidates[0];
  if (!selected || selected.edge < config.entryEdge) return;
  const budget = state.cash * config.maxPositionPct;
  const requestedQuantity = budget / selected.price;
  const availableQuantity = selected.depth.length ? consumeDepth(selected.depth, requestedQuantity).quantity : requestedQuantity;
  const quantity = Math.max(0, availableQuantity);
  if (quantity < Math.max(book.minOrderSize, 0.0001)) return;
  const fillPrice = selected.depth.length ? consumeDepth(selected.depth, quantity).price : selected.price;
  const fee = quantity * feePerShare(fillPrice, feeConfig);
  const totalCost = quantity * fillPrice + fee;
  if (totalCost > state.cash || quantity <= 0) return;
  state.orders += 1;
  const orderId = crypto.randomUUID();
  await prisma.paperOrder.create({
    data: {
      id: orderId,
      runId,
      marketId: market.id,
      tokenId: selected.tokenId as string,
      outcome: selected.outcome,
      side: "BUY",
      orderType: "FAK",
      requestedPrice: selected.price,
      requestedQuantity,
      filledPrice: fillPrice,
      filledQuantity: quantity,
      fee,
      slippage: Math.max(0, fillPrice - (selected.outcome === "YES" ? probability : 1 - probability)),
      status: "filled",
      reason: `calibrated fair=${selected.fairProbability.toFixed(4)} edge=${selected.edge.toFixed(4)}`,
      submittedAt: timestamp,
      filledAt: timestamp,
    },
  });
  await prisma.paperFill.create({ data: { id: crypto.randomUUID(), runId, orderId, marketId: market.id, tokenId: selected.tokenId as string, outcome: selected.outcome, side: "BUY", price: fillPrice, quantity, notional: quantity * fillPrice, fee, slippage: Math.max(0, fillPrice - (selected.outcome === "YES" ? probability : 1 - probability)), filledAt: timestamp } });
  const positionId = crypto.randomUUID();
  await prisma.paperPosition.create({ data: { id: positionId, runId, marketId: market.id, tokenId: selected.tokenId as string, outcome: selected.outcome, quantity, avgEntryPrice: fillPrice, costBasis: totalCost, feePaid: fee, status: "OPEN", openedAt: timestamp } });
  state.cash -= totalCost;
  state.fees += fee;
  state.filledOrders += 1;
  state.open.set(market.id, { positionId, marketId: market.id, outcome: selected.outcome, tokenId: selected.tokenId as string, quantity, costBasis: totalCost });
}

async function settlePosition(runId: string, state: EngineState, position: OpenPosition, result: 0 | 1, closedAt = new Date()) {
  const won = (position.outcome === "YES" && result === 1) || (position.outcome === "NO" && result === 0);
  const settlementValue = won ? position.quantity : 0;
  state.cash += settlementValue;
  await prisma.paperPosition.update({ where: { id: position.positionId }, data: { settlementValue, realizedPnl: settlementValue - position.costBasis, status: "CLOSED", closedAt } });
  state.open.delete(position.marketId);
}

async function saveEquitySnapshot(runId: string, state: EngineState, markets: CryptoMarket[], capturedAt = new Date(), probabilities?: Map<string, number>) {
  const values = markets.map((market) => {
    const position = state.open.get(market.id);
    const probability = probabilities ? probabilities.get(market.id) ?? null : market.currentProbability;
    if (!position || probability === null || probability === undefined) return 0;
    return position.quantity * (position.outcome === "YES" ? probability : 1 - probability);
  });
  const positionsValue = values.reduce((sum, value) => sum + value, 0);
  const equity = state.cash + positionsValue;
  state.equity.push(equity);
  const costBasis = Array.from(state.open.values()).reduce((sum, position) => sum + position.costBasis, 0);
  await prisma.paperEquitySnapshot.create({ data: { id: crypto.randomUUID(), runId, capturedAt, cash: state.cash, positionsValue, equity, unrealizedPnl: positionsValue - costBasis } });
}

async function finalizeRun(runId: string, accountId: string, state: EngineState, config: PaperStrategyConfig, settledMarkets: number) {
  const metrics = await calculateMetrics(runId, state, config, settledMarkets);
  await prisma.paperTradingRun.update({ where: { id: runId }, data: { status: "completed", finalCash: state.cash, metricsJson: JSON.stringify(metrics), completedAt: new Date() } });
  await prisma.paperAccount.update({ where: { id: accountId }, data: { cashBalance: state.cash } });
}

async function calculateMetrics(runId: string, state: EngineState, config: PaperStrategyConfig, settledMarkets: number): Promise<PaperRunMetrics> {
  const positions = await prisma.paperPosition.findMany({ where: { runId } });
  const snapshots = await prisma.paperEquitySnapshot.findMany({ where: { runId }, orderBy: { capturedAt: "asc" } });
  const wins = positions.filter((position) => (position.realizedPnl ?? 0) > 0).length;
  const losses = positions.filter((position) => (position.realizedPnl ?? 0) <= 0).length;
  let peak = config.initialCash;
  let maxDrawdown = 0;
  for (const snapshot of snapshots) {
    peak = Math.max(peak, snapshot.equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - snapshot.equity) / peak : 0);
  }
  const returns = snapshots.slice(1).map((snapshot, index) => {
    const previous = snapshots[index]?.equity ?? config.initialCash;
    return previous > 0 ? snapshot.equity / previous - 1 : 0;
  });
  const mean = average(returns);
  const std = Math.sqrt(average(returns.map((value) => (value - mean) ** 2)));
  const forecasts = state.forecasts;
  return {
    startingCash: config.initialCash,
    endingCash: state.cash,
    totalReturn: state.cash - config.initialCash,
    totalReturnPct: (state.cash - config.initialCash) / config.initialCash,
    orders: state.orders,
    filledOrders: state.filledOrders,
    rejectedOrders: state.rejectedOrders,
    settledMarkets,
    winningMarkets: wins,
    losingMarkets: losses,
    winRate: positions.length ? wins / positions.length : null,
    totalFees: state.fees,
    maxDrawdownPct: maxDrawdown,
    sharpeLike: std > 0 ? (mean / std) * Math.sqrt(Math.max(1, returns.length)) : null,
    brierScore: forecasts.length ? average(forecasts.map((point) => (point.fairProbability - point.result) ** 2)) : null,
    logLoss: forecasts.length ? average(forecasts.map((point) => -(point.result * Math.log(clamp(point.fairProbability, 0.0001, 0.9999)) + (1 - point.result) * Math.log(1 - clamp(point.fairProbability, 0.0001, 0.9999))))) : null,
  };
}

async function loadState(runId: string, cash: number): Promise<EngineState> {
  const positions = await prisma.paperPosition.findMany({ where: { runId, status: "OPEN" } });
  return { cash, open: new Map(positions.map((position) => [position.marketId, { positionId: position.id, marketId: position.marketId, outcome: position.outcome as "YES" | "NO", tokenId: position.tokenId, quantity: position.quantity, costBasis: position.costBasis }])), equity: [], fees: 0, orders: 0, filledOrders: 0, rejectedOrders: 0, forecasts: [] };
}

async function loadTrainingSamples(markets: CryptoMarket[], limit: number) {
  const datasets: Dataset[] = [];
  for (const market of markets.filter((item) => item.resolved && item.result !== null).slice(0, limit)) {
    try {
      const history = await fetchHistoricalProbability(market.tokenId);
      if (history.length) datasets.push({ market, history, settleAt: market.endDate ? new Date(market.endDate).getTime() : Number.POSITIVE_INFINITY });
    } catch {
      // Keep the live tick usable when one historical token is unavailable.
    }
  }
  return datasets;
}

function calibratedProbability(probability: number, training: Dataset[], config: PaperStrategyConfig) {
  const bin = Math.min(9, Math.floor(clamp(probability, 0, 0.999999) * 10));
  const samples = training.flatMap((dataset) => {
    const last = dataset.history.at(-1);
    if (!last || dataset.market.result === null || Math.min(9, Math.floor(last.probability * 10)) !== bin) return [];
    return [{ probability: last.probability, result: dataset.market.result as 0 | 1 }];
  });
  const successes = samples.reduce((sum, sample) => sum + sample.result, 0);
  const prior = config.calibrationPrior;
  return { probability: samples.length ? (successes + prior * clamp(probability, 0.001, 0.999)) / (samples.length + prior) : probability, count: samples.length };
}

function effectivePrice(midpoint: number, bookPrice: number | null, config: PaperStrategyConfig, buy: boolean) {
  if (bookPrice !== null) return clamp(bookPrice + (config.slippageBps / 10_000), 0.0001, 0.9999);
  return clamp(midpoint + (config.spreadBps / 20_000) + (buy ? config.slippageBps / 10_000 : 0), 0.0001, 0.9999);
}

function feePerShare(price: number, config: PaperStrategyConfig) { return config.takerFeeRate * price * (1 - price); }

function consumeDepth(levels: Array<{ price: number; size: number }>, quantity: number) {
  let remaining = quantity;
  let notional = 0;
  let filled = 0;
  for (const level of levels) {
    const take = Math.min(remaining, level.size);
    filled += take;
    notional += take * level.price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  return { quantity: filled, price: filled > 0 ? notional / filled : 0 };
}

function normalizeConfig(config: Partial<PaperStrategyConfig> = {}): PaperStrategyConfig {
  return {
    initialCash: Math.max(1, config.initialCash ?? DEFAULT_CONFIG.initialCash),
    entryEdge: clamp(config.entryEdge ?? DEFAULT_CONFIG.entryEdge, 0, 0.5),
    maxPositionPct: clamp(config.maxPositionPct ?? DEFAULT_CONFIG.maxPositionPct, 0.001, 1),
    spreadBps: Math.max(0, config.spreadBps ?? DEFAULT_CONFIG.spreadBps),
    slippageBps: Math.max(0, config.slippageBps ?? DEFAULT_CONFIG.slippageBps),
    takerFeeRate: Math.max(0, config.takerFeeRate ?? DEFAULT_CONFIG.takerFeeRate),
    minTrainingMarkets: Math.max(0, Math.floor(config.minTrainingMarkets ?? DEFAULT_CONFIG.minTrainingMarkets)),
    calibrationPrior: Math.max(0, config.calibrationPrior ?? DEFAULT_CONFIG.calibrationPrior),
    maxMarkets: Math.min(100, Math.max(1, Math.floor(config.maxMarkets ?? DEFAULT_CONFIG.maxMarkets))),
  };
}

function parseJson(value: string) { try { return JSON.parse(value); } catch { return null; } }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
