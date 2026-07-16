import type { BacktestMetrics } from "@/src/lib/backtest/types";

export type BacktestMetricPoint = {
  marketId: string;
  predictedProbability: number;
  actualOutcome: number;
  brierScore: number;
  logLoss: number;
  position: number;
  pnl: number;
};

export function calculateBacktestMetrics(points: BacktestMetricPoint[], initialCapital: number, marketCount: number): BacktestMetrics {
  if (points.length === 0) {
    return { markets: marketCount, observations: 0, accuracy: null, brierScore: null, logLoss: null, calibration: [], tradedMarkets: 0, totalPnl: 0, returnPct: 0 };
  }

  const calibration = Array.from({ length: 10 }, (_, index) => {
    const bucket = points.filter((point) => Math.min(9, Math.floor(point.predictedProbability * 10)) === index);
    return {
      bucket: `${index * 10}-${index === 9 ? 100 : (index + 1) * 10}%`,
      predicted: average(bucket.map((point) => point.predictedProbability)),
      actual: average(bucket.map((point) => point.actualOutcome)),
      count: bucket.length,
    };
  }).filter((bucket) => bucket.count > 0);

  const tradedMarkets = new Set(points.filter((point) => point.position !== 0).map((point) => point.marketId));
  const totalPnl = points.reduce((sum, point) => sum + point.pnl, 0);
  return {
    markets: marketCount,
    observations: points.length,
    accuracy: average(points.map((point) => (point.predictedProbability >= 0.5 ? 1 : 0) === point.actualOutcome ? 1 : 0)),
    brierScore: average(points.map((point) => point.brierScore)),
    logLoss: average(points.map((point) => point.logLoss)),
    calibration,
    tradedMarkets: tradedMarkets.size,
    totalPnl,
    returnPct: totalPnl / initialCapital,
  };
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
