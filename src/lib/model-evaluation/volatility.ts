const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export function annualizeRealizedVolatility(logReturns: number[], candleMilliseconds: number) {
  const finiteReturns = logReturns.filter(Number.isFinite);
  if (!finiteReturns.length || !Number.isFinite(candleMilliseconds) || candleMilliseconds <= 0) return null;
  const meanSquaredReturn = finiteReturns.reduce((sum, value) => sum + value ** 2, 0) / finiteReturns.length;
  return Math.sqrt(meanSquaredReturn * (millisecondsPerDay / candleMilliseconds));
}
