import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "@/src/lib/model-evaluation/combined-trading";

const minimumIndependentEvents = 50;
const minimumComparableEvents = 50;
const minimumDeflatedSharpeProbability = 0.95;
const maximumDrawdownPct = 0.05;
const defaultRandomBenchmarkTrials = 200;

export const forwardObservationHorizons = [6, 12, 24, 48] as const;
export type ForwardObservationHorizon = (typeof forwardObservationHorizons)[number];

export function forwardStrategyExperimentKey(horizonHours: ForwardObservationHorizon) {
  return `poly-funding-consensus-forward-v2-h${horizonHours}`;
}

export function forwardControlExperimentKey(horizonHours: ForwardObservationHorizon) {
  return `polymarket-only-forward-control-v2-h${horizonHours}`;
}

export function isForwardStrategyExperimentKey(value: string | null | undefined) {
  return forwardObservationHorizons.some((horizonHours) => value === forwardStrategyExperimentKey(horizonHours));
}

export function isForwardControlExperimentKey(value: string | null | undefined) {
  return forwardObservationHorizons.some((horizonHours) => value === forwardControlExperimentKey(horizonHours));
}

export type ForwardEvaluationPosition = {
  eventId: string;
  asset: string;
  side: string;
  quantity: number;
  entryPrice: number;
  entrySpotPrice: number | null;
  markPrice: number;
  entryFee: number;
  realizedPnl: number | null;
  polymarketSide: string | null;
  entryFunding24h: number | null;
  horizonHours?: number | null;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
};

export type ForwardEvaluationInput = {
  strategyPositions: ForwardEvaluationPosition[];
  controlPositions: ForwardEvaluationPosition[];
  strategyStartedAt: Date;
  controlStartedAt: Date | null;
  initialEquity: number;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
  maxDrawdownPct: number;
  settlementBasisStatus: "collecting" | "healthy" | "attention";
  strategyTrials?: number;
  randomBenchmarkTrials?: number;
};

type BenchmarkLabel = "Polymarket方向のみ" | "常時ロング" | "常時ショート" | "ランダム中央値";

type EventResult = {
  eventId: string;
  strategyReturn: number;
  controlReturn: number;
  alwaysLongReturn: number;
  alwaysShortReturn: number;
};

export function evaluateForwardExperiment(input: ForwardEvaluationInput) {
  const comparisonStartedAt = input.controlStartedAt
    ? new Date(Math.max(input.strategyStartedAt.getTime(), input.controlStartedAt.getTime()))
    : null;
  const strategyPositions = comparisonStartedAt
    ? input.strategyPositions.filter((position) => position.openedAt >= comparisonStartedAt)
    : [];
  const controlPositions = comparisonStartedAt
    ? input.controlPositions.filter((position) => position.openedAt >= comparisonStartedAt)
    : [];
  const allStrategyClosed = strategyPositions.filter(isClosedPosition);
  const allControlClosed = controlPositions.filter(isClosedPosition);
  const openEventIds = new Set([
    ...strategyPositions.filter((position) => position.status === "OPEN").map(positionEventKey),
    ...controlPositions.filter((position) => position.status === "OPEN").map(positionEventKey),
  ]);
  const strategyByEvent = positionsByEvent(allStrategyClosed);
  const controlByEvent = positionsByEvent(allControlClosed);
  const eventIds = Array.from(new Set([...strategyByEvent.keys(), ...controlByEvent.keys()]))
    .filter((eventId) => !openEventIds.has(eventId));
  const comparableEventIds = new Set(eventIds);
  const strategyClosed = allStrategyClosed.filter((position) => comparableEventIds.has(positionEventKey(position)));
  const controlClosed = allControlClosed.filter((position) => comparableEventIds.has(positionEventKey(position)));
  const wins = strategyClosed.filter((position) => position.realizedPnl > 0).length;
  const events = eventIds.map((eventId): EventResult => {
    const strategyEventPositions = strategyByEvent.get(eventId) ?? [];
    const controlEventPositions = controlByEvent.get(eventId) ?? [];
    const referencePositions = controlEventPositions.length ? controlEventPositions : strategyEventPositions;
    return {
      eventId,
      strategyReturn: portfolioContribution(strategyEventPositions, input.initialEquity),
      controlReturn: portfolioContribution(controlEventPositions, input.initialEquity),
      alwaysLongReturn: sum(referencePositions.map((position) => benchmarkPnl(position, "LONG", input))) / input.initialEquity,
      alwaysShortReturn: sum(referencePositions.map((position) => benchmarkPnl(position, "SHORT", input))) / input.initialEquity,
    };
  });
  const randomBenchmarkTrials = Math.max(1, Math.floor(input.randomBenchmarkTrials ?? defaultRandomBenchmarkTrials));
  const randomTrials = Array.from({ length: randomBenchmarkTrials }, (_, trial) => {
    const random = createSeededRandom(trial + 1);
    return events.map((event) => random() < 0.5 ? event.alwaysLongReturn : event.alwaysShortReturn);
  });
  const randomMedianReturns = medianTrial(randomTrials);
  const benchmarkResults = [
    { label: "Polymarket方向のみ" as const, returnPct: sum(events.map((event) => event.controlReturn)), field: "controlReturn" as const },
    { label: "常時ロング" as const, returnPct: sum(events.map((event) => event.alwaysLongReturn)), field: "alwaysLongReturn" as const },
    { label: "常時ショート" as const, returnPct: sum(events.map((event) => event.alwaysShortReturn)), field: "alwaysShortReturn" as const },
    { label: "ランダム中央値" as const, returnPct: sum(randomMedianReturns), field: "randomMedianReturn" as const },
  ];
  const bestBenchmark = [...benchmarkResults].sort((left, right) => right.returnPct - left.returnPct)[0];
  const netReturnPct = strategyClosed.length
    ? sum(events.map((event) => event.strategyReturn))
    : null;
  const benchmarkReturnPct = events.length ? bestBenchmark.returnPct : null;
  const excessReturnPct = netReturnPct !== null && benchmarkReturnPct !== null
    ? netReturnPct - benchmarkReturnPct
    : null;
  const excessEventReturns = events.map((event, index) => (
    event.strategyReturn - (bestBenchmark.field === "randomMedianReturn" ? randomMedianReturns[index] : event[bestBenchmark.field])
  ));
  const excessConfidenceInterval95 = blockBootstrapMeanConfidenceInterval(excessEventReturns);
  const deflatedSharpe = deflatedSharpeProbability(excessEventReturns, Math.max(1, input.strategyTrials ?? 1));
  const independentEvents = new Set(strategyClosed.map(positionEventKey)).size;
  const gates = [
    { id: "trades" as const, label: `${minimumIndependentEvents}独立イベント以上`, passed: independentEvents >= minimumIndependentEvents },
    { id: "control" as const, label: `同期間比較${minimumComparableEvents}件以上`, passed: events.length >= minimumComparableEvents },
    { id: "net-positive" as const, label: "コスト控除後プラス", passed: (netReturnPct ?? 0) > 0 },
    { id: "benchmark" as const, label: "最良の単純戦略を上回る", passed: (excessReturnPct ?? 0) > 0 },
    { id: "significance" as const, label: "平均との差の95%下限がプラス", passed: (excessConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "selection-bias" as const, label: "固定実験の確信度95%以上", passed: (deflatedSharpe ?? 0) >= minimumDeflatedSharpeProbability },
    { id: "drawdown" as const, label: "最大下落5%以内", passed: independentEvents >= minimumIndependentEvents && input.maxDrawdownPct <= maximumDrawdownPct },
    { id: "settlement" as const, label: "判定価格の整合性を確認", passed: input.settlementBasisStatus === "healthy" },
  ];
  const enoughData = gates[0].passed && gates[1].passed;
  const status = !enoughData
    ? "collecting" as const
    : gates.every((gate) => gate.passed)
      ? "promising" as const
      : "underperforming" as const;

  return {
    status,
    trades: strategyClosed.length,
    independentEvents,
    wins,
    winRate: strategyClosed.length ? wins / strategyClosed.length : null,
    controlTrades: controlClosed.length,
    comparableEvents: events.length,
    minimumTrades: minimumIndependentEvents,
    minimumIndependentEvents,
    minimumComparableEvents,
    progressPct: Math.min(1, independentEvents / minimumIndependentEvents),
    comparisonStartedAt: comparisonStartedAt?.toISOString() ?? null,
    netReturnPct,
    benchmarkReturnPct,
    benchmarkLabel: (events.length ? bestBenchmark.label : null) as BenchmarkLabel | null,
    excessReturnPct,
    excessConfidenceInterval95,
    deflatedSharpeProbability: deflatedSharpe,
    randomBenchmarkTrials,
    maxDrawdownPct: input.maxDrawdownPct,
    passedGates: gates.filter((gate) => gate.passed).length,
    totalGates: gates.length,
    gates,
    benchmarks: {
      polymarketOnlyReturnPct: events.length ? benchmarkResults[0].returnPct : null,
      alwaysLongReturnPct: events.length ? benchmarkResults[1].returnPct : null,
      alwaysShortReturnPct: events.length ? benchmarkResults[2].returnPct : null,
      randomMedianReturnPct: events.length ? benchmarkResults[3].returnPct : null,
    },
    attribution: {
      byAsset: summarizeByAsset(strategyClosed, input.initialEquity),
    },
  };
}

function isClosedPosition(position: ForwardEvaluationPosition): position is ForwardEvaluationPosition & { realizedPnl: number; closedAt: Date } {
  return position.status === "CLOSED"
    && typeof position.realizedPnl === "number"
    && Number.isFinite(position.realizedPnl)
    && position.closedAt instanceof Date;
}

function positionsByEvent(positions: ForwardEvaluationPosition[]) {
  const grouped = new Map<string, ForwardEvaluationPosition[]>();
  for (const position of positions) {
    const key = positionEventKey(position);
    grouped.set(key, [...(grouped.get(key) ?? []), position]);
  }
  return grouped;
}

function positionEventKey(position: ForwardEvaluationPosition) {
  return `${position.eventId}:${position.horizonHours ?? "legacy"}`;
}

function portfolioContribution(positions: ForwardEvaluationPosition[], initialEquity: number) {
  return sum(positions.map((position) => position.realizedPnl ?? 0)) / initialEquity;
}

function benchmarkPnl(
  position: ForwardEvaluationPosition,
  side: "LONG" | "SHORT",
  input: Pick<ForwardEvaluationInput, "takerFeePerSide" | "slippagePerSide" | "fundingPer24h">,
) {
  const sideMultiplier = side === "LONG" ? 1 : -1;
  const actualSideMultiplier = position.side === "LONG" ? 1 : -1;
  const rawEntryPrice = positiveNumber(position.entrySpotPrice)
    ?? position.entryPrice / (1 + actualSideMultiplier * input.slippagePerSide);
  const notional = position.quantity * position.entryPrice;
  const entryPrice = rawEntryPrice * (1 + sideMultiplier * input.slippagePerSide);
  const quantity = notional / entryPrice;
  const exitPrice = position.markPrice * (1 - sideMultiplier * input.slippagePerSide);
  const grossPnl = sideMultiplier * quantity * (exitPrice - entryPrice);
  const entryFee = notional * input.takerFeePerSide;
  const exitFee = quantity * exitPrice * input.takerFeePerSide;
  const holdingDays = position.closedAt
    ? Math.max(0, position.closedAt.getTime() - position.openedAt.getTime()) / (24 * 60 * 60 * 1_000)
    : 0;
  const fundingRate = typeof position.entryFunding24h === "number" && Number.isFinite(position.entryFunding24h)
    ? sideMultiplier * position.entryFunding24h
    : input.fundingPer24h;
  const funding = notional * fundingRate * holdingDays;
  return grossPnl - entryFee - exitFee - funding;
}

function summarizeByAsset(positions: ForwardEvaluationPosition[], initialEquity: number) {
  const groups = new Map<string, ForwardEvaluationPosition[]>();
  for (const position of positions) groups.set(position.asset, [...(groups.get(position.asset) ?? []), position]);
  return Array.from(groups, ([asset, rows]) => {
    const pnl = sum(rows.map((position) => position.realizedPnl ?? 0));
    const tradeReturns = rows.map((position) => {
      const notional = position.quantity * position.entryPrice;
      return notional > 0 ? (position.realizedPnl ?? 0) / notional : 0;
    });
    return {
      asset,
      trades: rows.length,
      wins: rows.filter((position) => (position.realizedPnl ?? 0) > 0).length,
      returnContributionPct: initialEquity > 0 ? pnl / initialEquity : 0,
      averageTradeReturnPct: tradeReturns.length ? sum(tradeReturns) / tradeReturns.length : null,
    };
  }).sort((left, right) => right.trades - left.trades || left.asset.localeCompare(right.asset));
}

function positiveNumber(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function medianTrial(trials: number[][]) {
  if (!trials.length) return [];
  return [...trials].sort((left, right) => sum(left) - sum(right))[Math.floor(trials.length / 2)];
}

function createSeededRandom(initialSeed: number) {
  let seed = Math.imul(initialSeed, 0x9e3779b9) >>> 0;
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}
