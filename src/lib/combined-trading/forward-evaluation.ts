import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "@/src/lib/model-evaluation/combined-trading";

const minimumTrades = 50;
const minimumComparableEvents = 50;
const minimumDeflatedSharpeProbability = 0.95;
const maximumDrawdownPct = 0.05;

export const forwardStrategyExperimentKey = "poly-funding-consensus-v1";
export const forwardControlExperimentKey = "polymarket-only-forward-control-v1";

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
};

type BenchmarkLabel = "Polymarket方向のみ" | "常時ロング" | "常時ショート";

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
    ...strategyPositions.filter((position) => position.status === "OPEN").map((position) => position.eventId),
    ...controlPositions.filter((position) => position.status === "OPEN").map((position) => position.eventId),
  ]);
  const strategyByEvent = positionsByEvent(allStrategyClosed);
  const controlByEvent = positionsByEvent(allControlClosed);
  const eventIds = Array.from(new Set([...strategyByEvent.keys(), ...controlByEvent.keys()]))
    .filter((eventId) => !openEventIds.has(eventId));
  const comparableEventIds = new Set(eventIds);
  const strategyClosed = allStrategyClosed.filter((position) => comparableEventIds.has(position.eventId));
  const controlClosed = allControlClosed.filter((position) => comparableEventIds.has(position.eventId));
  const wins = strategyClosed.filter((position) => position.realizedPnl > 0).length;
  const events = eventIds.map((eventId): EventResult => {
    const strategyPosition = strategyByEvent.get(eventId);
    const controlPosition = controlByEvent.get(eventId);
    const referencePosition = controlPosition ?? strategyPosition;
    return {
      eventId,
      strategyReturn: portfolioContribution(strategyPosition, input.initialEquity),
      controlReturn: portfolioContribution(controlPosition, input.initialEquity),
      alwaysLongReturn: referencePosition
        ? benchmarkPnl(referencePosition, "LONG", input) / input.initialEquity
        : 0,
      alwaysShortReturn: referencePosition
        ? benchmarkPnl(referencePosition, "SHORT", input) / input.initialEquity
        : 0,
    };
  });
  const benchmarkResults = [
    { label: "Polymarket方向のみ" as const, returnPct: sum(events.map((event) => event.controlReturn)), field: "controlReturn" as const },
    { label: "常時ロング" as const, returnPct: sum(events.map((event) => event.alwaysLongReturn)), field: "alwaysLongReturn" as const },
    { label: "常時ショート" as const, returnPct: sum(events.map((event) => event.alwaysShortReturn)), field: "alwaysShortReturn" as const },
  ];
  const bestBenchmark = [...benchmarkResults].sort((left, right) => right.returnPct - left.returnPct)[0];
  const netReturnPct = strategyClosed.length
    ? sum(events.map((event) => event.strategyReturn))
    : null;
  const benchmarkReturnPct = events.length ? bestBenchmark.returnPct : null;
  const excessReturnPct = netReturnPct !== null && benchmarkReturnPct !== null
    ? netReturnPct - benchmarkReturnPct
    : null;
  const excessEventReturns = events.map((event) => event.strategyReturn - event[bestBenchmark.field]);
  const excessConfidenceInterval95 = blockBootstrapMeanConfidenceInterval(excessEventReturns);
  const deflatedSharpe = deflatedSharpeProbability(excessEventReturns, 1);
  const gates = [
    { id: "trades" as const, label: `${minimumTrades}取引以上`, passed: strategyClosed.length >= minimumTrades },
    { id: "control" as const, label: `同期間比較${minimumComparableEvents}件以上`, passed: events.length >= minimumComparableEvents },
    { id: "net-positive" as const, label: "コスト控除後プラス", passed: (netReturnPct ?? 0) > 0 },
    { id: "benchmark" as const, label: "最良の単純戦略を上回る", passed: (excessReturnPct ?? 0) > 0 },
    { id: "significance" as const, label: "平均との差の95%下限がプラス", passed: (excessConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "selection-bias" as const, label: "固定実験の確信度95%以上", passed: (deflatedSharpe ?? 0) >= minimumDeflatedSharpeProbability },
    { id: "drawdown" as const, label: "最大下落5%以内", passed: strategyClosed.length >= minimumTrades && input.maxDrawdownPct <= maximumDrawdownPct },
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
    wins,
    winRate: strategyClosed.length ? wins / strategyClosed.length : null,
    controlTrades: controlClosed.length,
    comparableEvents: events.length,
    minimumTrades,
    minimumComparableEvents,
    progressPct: Math.min(1, strategyClosed.length / minimumTrades),
    comparisonStartedAt: comparisonStartedAt?.toISOString() ?? null,
    netReturnPct,
    benchmarkReturnPct,
    benchmarkLabel: (events.length ? bestBenchmark.label : null) as BenchmarkLabel | null,
    excessReturnPct,
    excessConfidenceInterval95,
    deflatedSharpeProbability: deflatedSharpe,
    maxDrawdownPct: input.maxDrawdownPct,
    passedGates: gates.filter((gate) => gate.passed).length,
    totalGates: gates.length,
    gates,
    benchmarks: {
      polymarketOnlyReturnPct: events.length ? benchmarkResults[0].returnPct : null,
      alwaysLongReturnPct: events.length ? benchmarkResults[1].returnPct : null,
      alwaysShortReturnPct: events.length ? benchmarkResults[2].returnPct : null,
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
  return new Map(positions.map((position) => [position.eventId, position]));
}

function portfolioContribution(position: ForwardEvaluationPosition | undefined, initialEquity: number) {
  return position && typeof position.realizedPnl === "number" ? position.realizedPnl / initialEquity : 0;
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
