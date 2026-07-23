import { createHash } from "node:crypto";

export type WalletBacktestSignal = {
  id: string;
  marketId: string;
  direction: string;
  observedAt: Date;
  marketPrice: number | null;
  delayedPrice30: number | null;
  delayedPrice60: number | null;
  resolvedOutcome: number | null;
};

export function evaluateWalletCopyBacktest(input: {
  signals: WalletBacktestSignal[];
  latencySeconds: 30 | 60;
  strategyTrials?: number;
}) {
  const priceKey = input.latencySeconds === 30 ? "delayedPrice30" : "delayedPrice60";
  const eligible = input.signals
    .filter((signal) => signal.resolvedOutcome === 0 || signal.resolvedOutcome === 1)
    .flatMap((signal) => {
      const entryPrice = signal[priceKey];
      if (entryPrice === null || entryPrice <= 0.01 || entryPrice >= 0.99) return [];
      const won = signal.resolvedOutcome === 1;
      const returnPct = tokenReturn(entryPrice, won);
      const majorityFollowsSignal = entryPrice >= 0.5;
      const benchmarkPrice = majorityFollowsSignal ? entryPrice : 1 - entryPrice;
      const benchmarkWon = majorityFollowsSignal ? won : !won;
      const benchmarkReturnPct = tokenReturn(benchmarkPrice, benchmarkWon);
      return [{
        ...signal,
        entryPrice,
        won,
        returnPct,
        benchmarkReturnPct,
        excessReturnPct: returnPct - benchmarkReturnPct,
      }];
    })
    .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  const returns = eligible.map((row) => row.returnPct);
  const excessReturns = eligible.map((row) => row.excessReturnPct);
  const meanReturnPct = mean(returns);
  const benchmarkReturnPct = mean(eligible.map((row) => row.benchmarkReturnPct));
  const excessReturnPct = mean(excessReturns);
  const excessConfidenceInterval95 = bootstrapMeanConfidenceInterval(excessReturns, 1_000);
  const deflatedSharpeProbability = deflatedSharpe(excessReturns, input.strategyTrials ?? 4);
  const maxDrawdownPct = maximumDrawdown(returns);
  const independentEvents = new Set(eligible.map((row) => row.marketId)).size;
  const yesEvents = new Set(eligible.filter((row) => row.direction === "YES").map((row) => row.marketId)).size;
  const noEvents = new Set(eligible.filter((row) => row.direction === "NO").map((row) => row.marketId)).size;
  const gates = [
    gate("events", "独立イベント50件", independentEvents >= 50, independentEvents, 50),
    gate("both-sides", "YES/NO各5件", yesEvents >= 5 && noEvents >= 5, Math.min(yesEvents, noEvents), 5),
    gate("profit", "手数料後プラス", meanReturnPct > 0, meanReturnPct, 0),
    gate("benchmark", "市場基準を上回る", excessReturnPct > 0, excessReturnPct, 0),
    gate("significance", "超過収益95%下限がプラス", (excessConfidenceInterval95?.[0] ?? -1) > 0, excessConfidenceInterval95?.[0] ?? null, 0),
    gate("selection-bias", "選択バイアス補正95%以上", (deflatedSharpeProbability ?? 0) >= 0.95, deflatedSharpeProbability, 0.95),
    gate("drawdown", "最大下落5%以内", maxDrawdownPct <= 0.05, maxDrawdownPct, 0.05),
  ];
  const passed = gates.every((item) => item.passed);
  return {
    methodology: `point-in-time-wallet-consensus-${input.latencySeconds}s`,
    status: independentEvents < 50 ? "collecting" as const : passed ? "promising" as const : "rejected" as const,
    edgeConfirmed: passed,
    reason: passed
      ? "全合格条件を満たしました"
      : independentEvents < 50
        ? `独立イベントを収集中（${independentEvents}/50）`
        : "市場基準または統計基準を満たしていません",
    latencySeconds: input.latencySeconds,
    signals: eligible.length,
    independentEvents,
    yesEvents,
    noEvents,
    winRate: eligible.length ? eligible.filter((row) => row.won).length / eligible.length : null,
    meanReturnPct,
    benchmarkReturnPct,
    excessReturnPct,
    excessConfidenceInterval95,
    deflatedSharpeProbability,
    maxDrawdownPct,
    gates,
    datasetHash: createHash("sha256")
      .update(JSON.stringify(eligible.map((row) => [row.id, row.entryPrice, row.resolvedOutcome])))
      .digest("hex"),
    points: eligible.map((row) => ({
      signalId: row.id,
      marketId: row.marketId,
      observedAt: row.observedAt.toISOString(),
      direction: row.direction,
      entryPrice: row.entryPrice,
      won: row.won,
      returnPct: row.returnPct,
      benchmarkReturnPct: row.benchmarkReturnPct,
      excessReturnPct: row.excessReturnPct,
    })),
  };
}

function tokenReturn(price: number, won: boolean) {
  const fee = 0.07 * price * (1 - price);
  return ((won ? 1 : 0) - price - fee) / price;
}

function bootstrapMeanConfidenceInterval(values: number[], trials: number): [number, number] | null {
  if (values.length < 5) return null;
  let seed = 0x5f3759df;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const means = Array.from({ length: trials }, () => mean(Array.from(
    { length: values.length },
    () => values[Math.floor(next() * values.length)],
  ))).sort((left, right) => left - right);
  return [means[Math.floor(trials * 0.025)], means[Math.floor(trials * 0.975)]];
}

function deflatedSharpe(values: number[], strategyTrials: number) {
  if (values.length < 10) return null;
  const average = mean(values);
  const deviation = standardDeviation(values);
  if (deviation <= 0) return average > 0 ? 1 : 0;
  const tStatistic = average / (deviation / Math.sqrt(values.length));
  const adjusted = tStatistic - Math.sqrt(2 * Math.log(Math.max(1, strategyTrials)));
  return normalCdf(adjusted);
}

function maximumDrawdown(returns: number[]) {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity *= Math.max(0, 1 + value / Math.max(1, returns.length));
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return drawdown;
}

function gate(id: string, label: string, passed: boolean, value: number | null, threshold: number) {
  return { id, label, passed, value, threshold };
}

function mean(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}
