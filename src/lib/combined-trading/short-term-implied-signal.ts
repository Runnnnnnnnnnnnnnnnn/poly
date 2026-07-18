import { impliedTerminalMedianForCondition } from "@/src/lib/model-evaluation/combined-trading";

export type ShortTermImpliedSignalInput = {
  marketProbability: number;
  thresholdReferencePrice: number;
  currentReferencePrice: number;
  currentHyperliquidPrice: number;
  volatility24h: number;
  remainingHours: number;
};

export function calculateShortTermImpliedSignal(input: ShortTermImpliedSignalInput) {
  if (
    !probability(input.marketProbability)
    || !positive(input.thresholdReferencePrice)
    || !positive(input.currentReferencePrice)
    || !positive(input.currentHyperliquidPrice)
    || !positive(input.volatility24h)
    || !positive(input.remainingHours)
  ) return null;

  const remainingVolatility = clamp(input.volatility24h, 0.002, 1)
    * Math.sqrt(input.remainingHours / 24);
  if (!positive(remainingVolatility)) return null;
  const impliedReferenceTarget = impliedTerminalMedianForCondition(
    "above",
    input.thresholdReferencePrice,
    null,
    input.marketProbability,
    remainingVolatility,
  );
  if (typeof impliedReferenceTarget !== "number" || !positive(impliedReferenceTarget)) return null;

  const currentBasis = input.currentHyperliquidPrice / input.currentReferencePrice;
  const impliedHyperliquidTarget = impliedReferenceTarget * currentBasis;
  const expectedLogReturn = Math.log(impliedHyperliquidTarget / input.currentHyperliquidPrice);
  const signalZ = expectedLogReturn / remainingVolatility;
  if (!Number.isFinite(signalZ)) return null;

  return {
    side: signalZ >= 0 ? "LONG" as const : "SHORT" as const,
    signalZ,
    expectedReturnPct: Math.exp(expectedLogReturn) - 1,
    impliedReferenceTarget,
    impliedHyperliquidTarget,
    remainingVolatility,
  };
}

function probability(value: number) {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function positive(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
