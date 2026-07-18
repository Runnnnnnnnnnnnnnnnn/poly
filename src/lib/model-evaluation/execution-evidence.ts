import type { EvaluationSample } from "@/src/lib/model-evaluation/types";

const maximumSignalAgeMs = 5 * 60 * 1_000;
const maximumEntryLagMs = 5 * 60 * 1_000;
const maximumExitLeadMs = 5 * 60 * 1_000;
const maximumSynchronizationSkewMs = 60_000;

export function hasReferenceExecutionPrices(sample: EvaluationSample) {
  return finitePositive(sample.hyperliquidEntryPrice) !== null
    && finitePositive(sample.hyperliquidExitPrice) !== null;
}

export function hasExecutableSynchronizedOrderBook(sample: EvaluationSample) {
  if (sample.executionPriceSource !== "synchronized-1m" || !hasReferenceExecutionPrices(sample)) return false;
  if (!validPolymarketBook(sample) || !validHyperliquidBook(sample)) return false;
  if (!finiteInRange(sample.executionSynchronizationSkewMs, 0, maximumSynchronizationSkewMs)) return false;

  const horizonHours = sample.horizonHours;
  const endAt = Date.parse(sample.endAt);
  const observedAt = Date.parse(sample.observedAt);
  const entryAt = typeof sample.hyperliquidEntryAt === "string" ? Date.parse(sample.hyperliquidEntryAt) : Number.NaN;
  const exitAt = typeof sample.hyperliquidExitAt === "string" ? Date.parse(sample.hyperliquidExitAt) : Number.NaN;
  if (typeof horizonHours !== "number" || !Number.isFinite(horizonHours) || horizonHours <= 0) return false;
  if (![endAt, observedAt, entryAt, exitAt].every(Number.isFinite)) return false;

  const targetAt = endAt - horizonHours * 60 * 60 * 1_000;
  return observedAt <= targetAt
    && targetAt - observedAt <= maximumSignalAgeMs
    && entryAt > targetAt
    && entryAt - targetAt <= maximumEntryLagMs
    && exitAt <= endAt
    && endAt - exitAt <= maximumExitLeadMs
    && entryAt < exitAt;
}

function validPolymarketBook(sample: EvaluationSample) {
  const bid = finiteInRange(sample.marketBestBid, 0, 1) ? sample.marketBestBid as number : null;
  const ask = finiteInRange(sample.marketBestAsk, 0, 1) ? sample.marketBestAsk as number : null;
  return bid !== null
    && ask !== null
    && ask >= bid
    && finiteInRange(sample.marketSpread, 0, 1)
    && finiteInRange(sample.marketProbability, bid, ask);
}

function validHyperliquidBook(sample: EvaluationSample) {
  const entryBid = finitePositive(sample.hyperliquidEntryBestBid);
  const entryAsk = finitePositive(sample.hyperliquidEntryBestAsk);
  const exitBid = finitePositive(sample.hyperliquidExitBestBid);
  const exitAsk = finitePositive(sample.hyperliquidExitBestAsk);
  return entryBid !== null
    && entryAsk !== null
    && entryAsk >= entryBid
    && exitBid !== null
    && exitAsk !== null
    && exitAsk >= exitBid
    && finitePositive(sample.hyperliquidEntryPrice) !== null
    && finitePositive(sample.hyperliquidExitPrice) !== null
    && finiteInRange(sample.hyperliquidEntrySpread, 0, Number.POSITIVE_INFINITY)
    && finiteInRange(sample.hyperliquidExitSpread, 0, Number.POSITIVE_INFINITY);
}

function finitePositive(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteInRange(value: number | null | undefined, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
