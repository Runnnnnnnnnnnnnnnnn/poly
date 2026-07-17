export type ProbabilityLadderInput = {
  id: string;
  kind: "above" | "below";
  threshold: number;
  probability: number;
  weight?: number;
};

export type ProbabilityLadderPoint = ProbabilityLadderInput & {
  correctedProbability: number;
};

export type ProbabilityLadderFit = {
  points: ProbabilityLadderPoint[];
  violations: number;
  adjustmentRms: number;
};

type ThresholdGroup = {
  threshold: number;
  weight: number;
  weightedCdf: number;
  ids: string[];
};

/** Enforces that the implied terminal-price CDF cannot fall as the strike rises. */
export function fitMonotonicProbabilityLadder(input: ProbabilityLadderInput[]): ProbabilityLadderFit {
  const usable = input
    .filter((point) => Number.isFinite(point.threshold) && point.threshold > 0 && Number.isFinite(point.probability))
    .map((point) => ({
      ...point,
      probability: clamp(point.probability, 0.001, 0.999),
      weight: Math.max(1e-6, point.weight ?? point.probability * (1 - point.probability)),
    }));
  if (!usable.length) return { points: [], violations: 0, adjustmentRms: 0 };

  const grouped = new Map<number, ThresholdGroup>();
  for (const point of usable) {
    const cdf = point.kind === "above" ? 1 - point.probability : point.probability;
    const group = grouped.get(point.threshold) ?? { threshold: point.threshold, weight: 0, weightedCdf: 0, ids: [] };
    group.weight += point.weight;
    group.weightedCdf += point.weight * cdf;
    group.ids.push(point.id);
    grouped.set(point.threshold, group);
  }
  const ordered = Array.from(grouped.values()).sort((left, right) => left.threshold - right.threshold);
  const rawCdfs = ordered.map((group) => group.weightedCdf / group.weight);
  const violations = rawCdfs.slice(1).filter((cdf, index) => cdf + 1e-9 < rawCdfs[index]).length;

  const blocks: Array<{ start: number; end: number; weight: number; weightedCdf: number }> = [];
  for (let index = 0; index < ordered.length; index += 1) {
    blocks.push({ start: index, end: index, weight: ordered[index].weight, weightedCdf: ordered[index].weightedCdf });
    while (blocks.length >= 2) {
      const current = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.weightedCdf / previous.weight <= current.weightedCdf / current.weight + 1e-12) break;
      blocks.splice(blocks.length - 2, 2, {
        start: previous.start,
        end: current.end,
        weight: previous.weight + current.weight,
        weightedCdf: previous.weightedCdf + current.weightedCdf,
      });
    }
  }

  const correctedByThreshold = new Map<number, number>();
  for (const block of blocks) {
    const corrected = clamp(block.weightedCdf / block.weight, 0.001, 0.999);
    for (let index = block.start; index <= block.end; index += 1) correctedByThreshold.set(ordered[index].threshold, corrected);
  }

  const points = usable.map((point) => {
    const correctedCdf = correctedByThreshold.get(point.threshold) ?? (point.kind === "above" ? 1 - point.probability : point.probability);
    return {
      ...point,
      correctedProbability: point.kind === "above" ? 1 - correctedCdf : correctedCdf,
    };
  });
  const adjustmentRms = Math.sqrt(points.reduce((sum, point) => sum + (point.correctedProbability - point.probability) ** 2, 0) / points.length);
  return { points, violations, adjustmentRms };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
