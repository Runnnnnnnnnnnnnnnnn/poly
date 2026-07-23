import { createHash } from "node:crypto";
import { z } from "zod";

import { fetchWithTimeout } from "@/lib/utils";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "@/src/lib/monitoring/heartbeat";
import { prisma } from "@/src/lib/server/prisma";
import {
  buildWalletConsensusSignals,
  categorizeWalletMarket,
  scoreWalletCategory,
  walletCopyabilityScore,
  walletStyle,
  type ClosedWalletPosition,
  type WalletTradeObservation,
} from "@/src/lib/wallet-intelligence/scoring";

const dataApi = "https://data-api.polymarket.com";
const clobApi = "https://clob.polymarket.com";
const categories = ["CRYPTO", "POLITICS", "SPORTS", "OVERALL"] as const;
const leaderboardSchema = z.array(z.object({
  proxyWallet: z.string(),
  userName: z.string().optional().default(""),
  rank: z.coerce.number(),
  vol: z.coerce.number(),
  pnl: z.coerce.number(),
}).passthrough());
const tradeSchema = z.array(z.object({
  proxyWallet: z.string(),
  side: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: z.coerce.number(),
  price: z.coerce.number(),
  timestamp: z.coerce.number(),
  title: z.string(),
  slug: z.string().optional().default(""),
  eventSlug: z.string().optional().default(""),
  outcome: z.string(),
  transactionHash: z.string().optional().default(""),
}).passthrough());
const closedPositionSchema = z.array(z.object({
  conditionId: z.string(),
  avgPrice: z.coerce.number(),
  totalBought: z.coerce.number(),
  realizedPnl: z.coerce.number(),
  title: z.string(),
  outcome: z.string(),
  curPrice: z.coerce.number().optional().default(0),
  timestamp: z.coerce.number(),
}).passthrough());
const currentPositionSchema = z.array(z.object({
  asset: z.string(),
  conditionId: z.string(),
  size: z.coerce.number(),
  currentValue: z.coerce.number(),
  title: z.string(),
  outcome: z.string(),
}).passthrough());
const activitySchema = z.array(z.object({
  timestamp: z.coerce.number(),
  type: z.string(),
  side: z.string().optional().default(""),
}).passthrough());
const bookSchema = z.object({
  bids: z.array(z.object({ price: z.string(), size: z.string() }).passthrough()).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() }).passthrough()).default([]),
}).passthrough();

export async function collectWalletIntelligence() {
  await markPipelineAttempt("wallet-intelligence", "上位ウォレットを時点内データで採点中");
  try {
    const limit = boundedNumber(process.env.WALLET_LEADERBOARD_LIMIT, 12, 3, 30);
    const leaderboardRows = (await Promise.all(categories.map(async (category) => {
      const response = await fetchWithTimeout(
        `${dataApi}/v1/leaderboard?category=${category}&timePeriod=MONTH&orderBy=PNL&limit=${limit}`,
        { cache: "no-store" },
        20_000,
      );
      if (!response.ok) throw new Error(`Polymarket leaderboard ${category} ${response.status}`);
      return leaderboardSchema.parse(await response.json()).map((row) => ({ ...row, category }));
    }))).flat();
    const candidates = new Map<string, {
      address: string;
      userName: string;
      categories: Set<string>;
    }>();
    for (const row of leaderboardRows) {
      const address = row.proxyWallet.toLowerCase();
      const candidate = candidates.get(address) ?? {
        address,
        userName: row.userName,
        categories: new Set<string>(),
      };
      candidate.categories.add(row.category);
      if (!candidate.userName && row.userName) candidate.userName = row.userName;
      candidates.set(address, candidate);
    }

    const observations = await mapLimit(Array.from(candidates.values()), 4, collectCandidate);
    const now = new Date();
    const storedTrades = observations.flatMap((observation) => observation.trades);
    await resolveWalletSignals(observations.flatMap((observation) => observation.resolutions));
    const qualifiedScores = await prisma.polymarketWalletCategoryScore.findMany({
      where: { qualified: true },
      select: {
        walletAddress: true,
        category: true,
        riskAdjustedScore: true,
        scoredAt: true,
        wallet: { select: { copyabilityScore: true } },
      },
    });
    const signals = buildWalletConsensusSignals({
      trades: storedTrades,
      scores: qualifiedScores.map((score) => ({
        walletAddress: score.walletAddress,
        category: score.category,
        riskAdjustedScore: score.riskAdjustedScore,
        copyabilityScore: score.wallet.copyabilityScore,
        scoredAt: score.scoredAt,
        qualified: true,
      })),
      now,
    });
    for (const signal of signals) await persistSignal(signal, now);
    await refreshDelayedSignalPrices(now);
    const qualifiedWallets = await prisma.polymarketWalletProfile.count({ where: { excluded: false } });
    await markPipelineSuccess(
      "wallet-intelligence",
      storedTrades.length,
      `${candidates.size}口座を確認・追随候補${qualifiedWallets}口座・合意${signals.length}件`,
    );
    return {
      checkedWallets: candidates.size,
      trades: storedTrades.length,
      qualifiedWallets,
      signals: signals.length,
      observedAt: now.toISOString(),
    };
  } catch (error) {
    await markPipelineError("wallet-intelligence", error);
    throw error;
  }
}

export async function getWalletIntelligenceDashboard() {
  const [profiles, signals, pipeline] = await Promise.all([
    prisma.polymarketWalletProfile.findMany({
      orderBy: [{ excluded: "asc" }, { copyabilityScore: "desc" }],
      take: 50,
      include: {
        scores: {
          orderBy: { riskAdjustedScore: "desc" },
        },
      },
    }),
    prisma.walletSignal.findMany({
      orderBy: { observedAt: "desc" },
      take: 50,
    }),
    prisma.pipelineHeartbeat.findUnique({ where: { id: "wallet-intelligence" } }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      trackedWallets: profiles.length,
      qualifiedWallets: profiles.filter((profile) => !profile.excluded).length,
      readySignals: signals.filter((signal) => signal.status === "READY").length,
      status: pipeline?.status ?? "waiting",
      lastUpdatedAt: pipeline?.lastSuccessAt?.toISOString() ?? null,
    },
    profiles: profiles.map((profile) => ({
      address: profile.address,
      displayName: profile.displayName,
      style: profile.style,
      copyabilityScore: profile.copyabilityScore,
      excluded: profile.excluded,
      exclusionReason: profile.exclusionReason,
      currentPositions: profile.currentPositions,
      currentValue: profile.currentValue,
      activityCount: profile.activityCount,
      latestActivityAt: profile.latestActivityAt?.toISOString() ?? null,
      scoredAt: profile.scoredAt?.toISOString() ?? null,
      scores: profile.scores.map((score) => ({
        category: score.category,
        realizedPnl: score.realizedPnl,
        volume: score.volume,
        independentEvents: score.independentEvents,
        activeDays: score.activeDays,
        winRate: score.winRate,
        riskAdjustedScore: score.riskAdjustedScore,
        consistencyScore: score.consistencyScore,
        twoSidedRatio: score.twoSidedRatio,
        qualified: score.qualified,
      })),
    })),
    signals: signals.map((signal) => ({
      ...signal,
      observedAt: signal.observedAt.toISOString(),
      executableAt: signal.executableAt?.toISOString() ?? null,
      createdAt: signal.createdAt.toISOString(),
      contributors: JSON.parse(signal.contributorJson),
    })),
  };
}

async function collectCandidate(candidate: { address: string; userName: string; categories: Set<string> }) {
  const scoredAt = new Date();
  const existing = await prisma.polymarketWalletProfile.findUnique({
    where: { address: candidate.address },
    select: { scoredAt: true },
  });
  const [trades, closed, currentPositions, activity] = await Promise.all([
    fetchJson(`${dataApi}/trades?user=${candidate.address}&limit=500`, tradeSchema),
    fetchJson(`${dataApi}/closed-positions?user=${candidate.address}&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`, closedPositionSchema),
    fetchJson(`${dataApi}/positions?user=${candidate.address}&sizeThreshold=0&limit=500`, currentPositionSchema),
    fetchJson(`${dataApi}/activity?user=${candidate.address}&limit=500&sortBy=TIMESTAMP&sortDirection=DESC`, activitySchema),
  ]);
  const closedPositions: ClosedWalletPosition[] = closed.map((position) => ({
    conditionId: position.conditionId,
    title: position.title,
    outcome: position.outcome,
    avgPrice: position.avgPrice,
    totalBought: position.totalBought,
    realizedPnl: position.realizedPnl,
    timestamp: position.timestamp,
  }));
  const scoreCategories = new Set([...candidate.categories, ...closedPositions.map((position) => categorizeWalletMarket(position.title))]);
  const scores = Array.from(scoreCategories).map((category) => scoreWalletCategory(closedPositions, category));
  const style = walletStyle(scores);
  const copyabilityScore = walletCopyabilityScore(scores);
  const qualified = scores.some((score) => score.qualified) && style !== "MARKET_MAKER";
  const openTokens = new Set(
    currentPositions
      .filter((position) => position.size > 0.01)
      .map((position) => position.asset),
  );
  const latestActivityAt = activity.length
    ? new Date(Math.max(...activity.map((row) => row.timestamp)) * 1_000)
    : null;
  const storedTrades: WalletTradeObservation[] = trades.map((trade) => ({
    id: tradeId(trade),
    walletAddress: candidate.address,
    marketId: trade.conditionId,
    tokenId: trade.asset,
    title: trade.title,
    category: categorizeWalletMarket(trade.title),
    side: trade.side,
    outcome: trade.outcome,
    price: trade.price,
    notional: trade.price * trade.size,
    tradedAt: new Date(trade.timestamp * 1_000),
  }));

  await prisma.$transaction(async (transaction) => {
    await transaction.polymarketWalletProfile.upsert({
      where: { address: candidate.address },
      create: {
        address: candidate.address,
        displayName: candidate.userName || null,
        style,
        copyabilityScore,
        excluded: !qualified,
        exclusionReason: qualified ? null : exclusionReason(style, scores),
        currentPositions: currentPositions.filter((position) => position.size > 0.01).length,
        currentValue: currentPositions.reduce((total, position) => total + Math.max(0, position.currentValue), 0),
        activityCount: activity.length,
        latestActivityAt,
        scoredAt,
        lastSeenAt: scoredAt,
      },
      update: {
        displayName: candidate.userName || undefined,
        style,
        copyabilityScore,
        excluded: !qualified,
        exclusionReason: qualified ? null : exclusionReason(style, scores),
        currentPositions: currentPositions.filter((position) => position.size > 0.01).length,
        currentValue: currentPositions.reduce((total, position) => total + Math.max(0, position.currentValue), 0),
        activityCount: activity.length,
        latestActivityAt,
        scoredAt,
        lastSeenAt: scoredAt,
      },
    });
    for (const score of scores) {
      await transaction.polymarketWalletCategoryScore.upsert({
        where: {
          walletAddress_category_period: {
            walletAddress: candidate.address,
            category: score.category,
            period: "MONTH",
          },
        },
        create: {
          id: `${candidate.address}:${score.category}:MONTH`,
          walletAddress: candidate.address,
          period: "MONTH",
          scoredAt,
          ...score,
        },
        update: {
          scoredAt,
          ...score,
        },
      });
    }
    if (trades.length) {
      await transaction.polymarketWalletTrade.createMany({
        data: trades.map((trade) => ({
          id: tradeId(trade),
          walletAddress: candidate.address,
          transactionId: trade.transactionHash || null,
          eventId: trade.eventSlug || null,
          marketId: trade.conditionId,
          tokenId: trade.asset,
          title: trade.title,
          slug: trade.slug || null,
          category: categorizeWalletMarket(trade.title),
          side: trade.side.toUpperCase(),
          outcome: trade.outcome,
          price: trade.price,
          size: trade.size,
          notional: trade.price * trade.size,
          tradedAt: new Date(trade.timestamp * 1_000),
        })),
        skipDuplicates: true,
      });
    }
  });
  return {
    trades: storedTrades.filter((trade) => (
      existing?.scoredAt
      && trade.tradedAt >= existing.scoredAt
      && openTokens.has(trade.tokenId)
    )),
    resolutions: closed
      .filter((position) => position.curPrice >= 0.99)
      .map((position) => ({
        marketId: position.conditionId,
        winningOutcome: normalizeSignalOutcome(position.outcome),
      })),
  };
}

async function resolveWalletSignals(resolutions: Array<{ marketId: string; winningOutcome: string }>) {
  const byMarket = new Map(resolutions.map((resolution) => [resolution.marketId, resolution.winningOutcome]));
  for (const [marketId, winningOutcome] of byMarket) {
    const signals = await prisma.walletSignal.findMany({
      where: { marketId, resolvedOutcome: null },
      select: { id: true, direction: true, delayedPrice30: true, delayedPrice60: true, status: true },
    });
    for (const signal of signals) {
      const won = normalizeSignalOutcome(signal.direction) === winningOutcome;
      await prisma.walletSignal.update({
        where: { id: signal.id },
        data: {
          resolvedOutcome: won ? 1 : 0,
          simulatedReturn30: signal.delayedPrice30 ? walletTokenReturn(signal.delayedPrice30, won) : null,
          simulatedReturn60: signal.delayedPrice60 ? walletTokenReturn(signal.delayedPrice60, won) : null,
          status: signal.delayedPrice30 !== null && signal.delayedPrice60 !== null ? "RESOLVED" : signal.status,
          reason: won ? "決済結果を確認・追随方向が的中" : "決済結果を確認・追随方向が外れ",
        },
      });
    }
  }
}

async function persistSignal(
  signal: ReturnType<typeof buildWalletConsensusSignals>[number],
  now: Date,
) {
  const bucket = Math.floor(signal.observedAt.getTime() / (5 * 60_000));
  const id = createHash("sha256")
    .update(`${signal.marketId}:${signal.direction}:${bucket}`)
    .digest("hex");
  const book = await fetchBook(signal.tokenId).catch(() => null);
  await prisma.walletSignal.upsert({
    where: { id },
    create: {
      id,
      eventId: null,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      title: signal.title,
      category: signal.category,
      direction: signal.direction,
      consensusScore: signal.consensusScore,
      walletCount: signal.walletCount,
      netNotional: signal.netNotional,
      marketPrice: book?.bestAsk ?? signal.marketPrice,
      spread: book?.spread ?? null,
      availableLiquidity: book?.askLiquidity ?? null,
      contributorJson: JSON.stringify(signal.contributors),
      status: "COLLECTING",
      reason: "30秒・60秒後の実行価格を収集中",
      observedAt: signal.observedAt,
      executableAt: new Date(signal.observedAt.getTime() + 30_000),
    },
    update: {
      consensusScore: signal.consensusScore,
      walletCount: signal.walletCount,
      netNotional: signal.netNotional,
      contributorJson: JSON.stringify(signal.contributors),
    },
  });
  if (now.getTime() >= signal.observedAt.getTime() + 30_000) await refreshDelayedSignalPrices(now, id);
}

async function refreshDelayedSignalPrices(now: Date, signalId?: string) {
  const rows = await prisma.walletSignal.findMany({
    where: {
      ...(signalId ? { id: signalId } : {}),
      tokenId: { not: null },
      status: { in: ["COLLECTING", "READY"] },
      observedAt: { lte: new Date(now.getTime() - 30_000) },
    },
    orderBy: { observedAt: "asc" },
    take: 100,
  });
  for (const signal of rows) {
    const book = await fetchBook(signal.tokenId as string).catch(() => null);
    if (!book) continue;
    const elapsed = now.getTime() - signal.observedAt.getTime();
    const delayedPrice30 = signal.delayedPrice30 ?? (elapsed >= 30_000 ? book.bestAsk : null);
    const delayedPrice60 = signal.delayedPrice60 ?? (elapsed >= 60_000 ? book.bestAsk : null);
    await prisma.walletSignal.update({
      where: { id: signal.id },
      data: {
        delayedPrice30,
        delayedPrice60,
        spread: book.spread,
        availableLiquidity: book.askLiquidity,
        status: delayedPrice30 !== null && delayedPrice60 !== null ? "READY" : "COLLECTING",
        reason: delayedPrice30 !== null && delayedPrice60 !== null
          ? "遅延・スプレッド・流動性を含む模擬約定価格を記録済み"
          : "60秒後の実行価格を収集中",
      },
    });
  }
}

async function fetchBook(tokenId: string) {
  const response = await fetchWithTimeout(`${clobApi}/book?token_id=${encodeURIComponent(tokenId)}`, { cache: "no-store" }, 15_000);
  if (!response.ok) throw new Error(`Polymarket CLOB book ${response.status}`);
  const book = bookSchema.parse(await response.json());
  const bids = book.bids.map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => right.price - left.price);
  const asks = book.asks.map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => left.price - right.price);
  if (!bids[0] || !asks[0]) throw new Error("Polymarket CLOB book is empty");
  return {
    bestBid: bids[0].price,
    bestAsk: asks[0].price,
    spread: asks[0].price - bids[0].price,
    askLiquidity: asks.slice(0, 5).reduce((total, level) => total + level.price * level.size, 0),
  };
}

async function fetchJson<T extends z.ZodTypeAny>(url: string, schema: T): Promise<z.infer<T>> {
  const response = await fetchWithTimeout(url, { cache: "no-store" }, 20_000);
  if (!response.ok) throw new Error(`Polymarket Data API ${response.status}`);
  return schema.parse(await response.json());
}

async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

function tradeId(trade: z.infer<typeof tradeSchema>[number]) {
  return createHash("sha256")
    .update(`${trade.transactionHash}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}:${trade.timestamp}`)
    .digest("hex");
}

function normalizeSignalOutcome(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "UP" || normalized === "YES") return "YES";
  if (normalized === "DOWN" || normalized === "NO") return "NO";
  return normalized;
}

function walletTokenReturn(price: number, won: boolean) {
  const fee = 0.07 * price * (1 - price);
  return ((won ? 1 : 0) - price - fee) / price;
}

function exclusionReason(style: string, scores: ReturnType<typeof scoreWalletCategory>[]) {
  if (style === "MARKET_MAKER") return "両建て・裁定型のため追随対象外";
  if (!scores.some((score) => score.independentEvents >= 10)) return "独立イベント数が不足";
  if (!scores.some((score) => score.activeDays >= 2)) return "観察日数が不足";
  return "リスク調整後の再現性が基準未達";
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}
