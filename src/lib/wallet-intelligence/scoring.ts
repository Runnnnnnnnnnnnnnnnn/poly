export type ClosedWalletPosition = {
  conditionId: string;
  title: string;
  outcome: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  timestamp: number;
};

export type WalletTradeObservation = {
  id: string;
  walletAddress: string;
  marketId: string;
  tokenId: string;
  title: string;
  category: string;
  side: string;
  outcome: string;
  price: number;
  notional: number;
  tradedAt: Date;
};

export type WalletCategoryScore = {
  category: string;
  realizedPnl: number;
  volume: number;
  trades: number;
  activeDays: number;
  independentEvents: number;
  winRate: number | null;
  returnOnVolume: number | null;
  riskAdjustedScore: number;
  consistencyScore: number;
  twoSidedRatio: number;
  qualified: boolean;
};

export type ConsensusWalletScore = {
  walletAddress: string;
  category: string;
  riskAdjustedScore: number;
  copyabilityScore: number;
  scoredAt: Date;
  qualified: boolean;
};

export type WalletConsensusSignal = {
  marketId: string;
  tokenId: string;
  title: string;
  category: string;
  direction: string;
  consensusScore: number;
  walletCount: number;
  netNotional: number;
  marketPrice: number;
  observedAt: Date;
  contributors: Array<{ address: string; score: number; notional: number }>;
};

const cryptoPattern = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|bnb|crypto|doge|hype)\b/i;
const sportsPattern = /\b(win|match|game|league|cup|nba|nfl|mlb|nhl|fifa|ufc|tennis|soccer|football|basketball)\b/i;
const politicsPattern = /\b(election|president|prime minister|congress|senate|parliament|政権|選挙)\b/i;

export function categorizeWalletMarket(title: string) {
  if (cryptoPattern.test(title)) return "CRYPTO";
  if (sportsPattern.test(title)) return "SPORTS";
  if (politicsPattern.test(title)) return "POLITICS";
  return "OVERALL";
}

export function scoreWalletCategory(
  positions: ClosedWalletPosition[],
  category: string,
): WalletCategoryScore {
  const selected = positions.filter((position) => categorizeWalletMarket(position.title) === category);
  const volume = sum(selected.map((position) => Math.max(0, position.avgPrice * position.totalBought)));
  const realizedPnl = sum(selected.map((position) => position.realizedPnl));
  const events = new Map<string, Set<string>>();
  const activeDays = new Set<string>();
  const returns: number[] = [];
  for (const position of selected) {
    const outcomes = events.get(position.conditionId) ?? new Set<string>();
    outcomes.add(normalizeOutcome(position.outcome));
    events.set(position.conditionId, outcomes);
    activeDays.add(new Date(position.timestamp * 1_000).toISOString().slice(0, 10));
    const deployed = Math.max(1, position.avgPrice * position.totalBought);
    returns.push(position.realizedPnl / deployed);
  }
  const twoSidedEvents = Array.from(events.values()).filter((outcomes) => outcomes.size > 1).length;
  const twoSidedRatio = events.size ? twoSidedEvents / events.size : 0;
  const profitable = selected.filter((position) => position.realizedPnl > 0).length;
  const meanReturn = mean(returns);
  const volatility = standardDeviation(returns);
  const shrinkage = Math.sqrt(events.size / (events.size + 20));
  const riskAdjustedScore = clamp(50 + 30 * Math.tanh(meanReturn / Math.max(0.1, volatility)) * shrinkage, 0, 100);
  const rawConsistency = selected.length ? profitable / selected.length : 0;
  const consistencyScore = clamp(rawConsistency * 100 * shrinkage, 0, 100);
  const returnOnVolume = volume > 0 ? realizedPnl / volume : null;
  const qualified = events.size >= 10
    && activeDays.size >= 2
    && volume >= 1_000
    && realizedPnl > 0
    && riskAdjustedScore >= 55
    && consistencyScore >= 45
    && twoSidedRatio < 0.3;
  return {
    category,
    realizedPnl,
    volume,
    trades: selected.length,
    activeDays: activeDays.size,
    independentEvents: events.size,
    winRate: selected.length ? profitable / selected.length : null,
    returnOnVolume,
    riskAdjustedScore,
    consistencyScore,
    twoSidedRatio,
    qualified,
  };
}

export function walletStyle(scores: WalletCategoryScore[]) {
  const maximumTwoSidedRatio = Math.max(0, ...scores.map((score) => score.twoSidedRatio));
  if (maximumTwoSidedRatio >= 0.3) return "MARKET_MAKER";
  if (scores.some((score) => score.qualified)) return "DIRECTIONAL";
  return "UNCLASSIFIED";
}

export function walletCopyabilityScore(scores: WalletCategoryScore[]) {
  const eligible = scores.filter((score) => score.twoSidedRatio < 0.3);
  if (!eligible.length) return 0;
  return Math.max(...eligible.map((score) => clamp(
    score.riskAdjustedScore * 0.65 + score.consistencyScore * 0.35 - score.twoSidedRatio * 50,
    0,
    100,
  )));
}

export function buildWalletConsensusSignals(input: {
  trades: WalletTradeObservation[];
  scores: ConsensusWalletScore[];
  now: Date;
  windowMs?: number;
  minimumWallets?: number;
  minimumConsensusScore?: number;
}) {
  const windowMs = input.windowMs ?? 5 * 60_000;
  const minimumWallets = input.minimumWallets ?? 2;
  const minimumConsensusScore = input.minimumConsensusScore ?? 55;
  const scores = new Map(
    input.scores
      .filter((score) => score.qualified)
      .map((score) => [`${score.walletAddress.toLowerCase()}:${score.category}`, score]),
  );
  const recent = input.trades.filter((trade) => (
    trade.side.toUpperCase() === "BUY"
    && input.now.getTime() - trade.tradedAt.getTime() <= windowMs
    && input.now.getTime() >= trade.tradedAt.getTime()
  ));
  const byMarket = new Map<string, WalletTradeObservation[]>();
  for (const trade of recent) {
    const score = scores.get(`${trade.walletAddress.toLowerCase()}:${trade.category}`);
    if (!score || trade.tradedAt < score.scoredAt) continue;
    const key = `${trade.marketId}:${normalizeOutcome(trade.outcome)}`;
    byMarket.set(key, [...(byMarket.get(key) ?? []), trade]);
  }

  const signals: WalletConsensusSignal[] = [];
  for (const trades of byMarket.values()) {
    const contributors = new Map<string, { address: string; score: number; notional: number }>();
    for (const trade of trades) {
      const score = scores.get(`${trade.walletAddress.toLowerCase()}:${trade.category}`);
      if (!score) continue;
      const current = contributors.get(trade.walletAddress.toLowerCase()) ?? {
        address: trade.walletAddress.toLowerCase(),
        score: Math.min(score.riskAdjustedScore, score.copyabilityScore),
        notional: 0,
      };
      current.notional += trade.notional;
      contributors.set(current.address, current);
    }
    const rows = Array.from(contributors.values());
    const totalNotional = sum(rows.map((row) => row.notional));
    const consensusScore = totalNotional > 0
      ? sum(rows.map((row) => row.score * row.notional)) / totalNotional
      : 0;
    if (rows.length < minimumWallets || consensusScore < minimumConsensusScore) continue;
    const latest = [...trades].sort((left, right) => right.tradedAt.getTime() - left.tradedAt.getTime())[0];
    signals.push({
      marketId: latest.marketId,
      tokenId: latest.tokenId,
      title: latest.title,
      category: latest.category,
      direction: normalizeOutcome(latest.outcome),
      consensusScore,
      walletCount: rows.length,
      netNotional: totalNotional,
      marketPrice: totalNotional > 0
        ? sum(trades.map((trade) => trade.price * trade.notional)) / sum(trades.map((trade) => trade.notional))
        : latest.price,
      observedAt: latest.tradedAt,
      contributors: rows.sort((left, right) => right.notional - left.notional),
    });
  }
  return signals.sort((left, right) => right.consensusScore - left.consensusScore);
}

function normalizeOutcome(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "UP" || normalized === "YES") return "YES";
  if (normalized === "DOWN" || normalized === "NO") return "NO";
  return normalized;
}

function mean(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(sum(values.map((value) => (value - average) ** 2)) / (values.length - 1));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
