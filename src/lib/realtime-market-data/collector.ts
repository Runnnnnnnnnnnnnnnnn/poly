import type { Prisma } from "@prisma/client";

import { calculatePriceBasisPct } from "@/src/lib/combined-trading/polymarket-reference";
import { discoverActiveCryptoDirectionMarkets, fetchCurrentBooks, type ActiveCryptoDirectionMarket } from "@/src/lib/backtest/polymarket";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "@/src/lib/monitoring/heartbeat";
import {
  normalizeHyperliquidWebSocketMessage,
  normalizePolymarketWebSocketMessage,
  normalizeRtdsReferenceMessage,
  realtimeReferenceSubscriptions,
  type HyperliquidBookUpdate,
  type HyperliquidContextUpdate,
  type RealtimeBookTop,
  type RealtimeReferenceUpdate,
} from "@/src/lib/realtime-market-data/normalizers";
import { prisma } from "@/src/lib/server/prisma";

const POLYMARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLYMARKET_RTDS_WS = "wss://ws-live-data.polymarket.com";
const HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws";
const supportedAssets = new Set(["BTC", "ETH", "SOL", "XRP"]);
const targetDurationMinutes = 15;
const marketLeadMs = 20 * 60_000;
const marketGraceMs = 60_000;
const maximumPolymarketBookAgeMs = 2 * 60_000;
const maximumHyperliquidBookAgeMs = 15_000;
const maximumReferenceAgeMs = 15_000;
const maximumContextAgeMs = 60_000;
const connectionStaleMs = 30_000;

export const realtimeSynchronizationVersion = "websocket-v3-self-healing";

type ReferenceState = Record<"BINANCE" | "CHAINLINK", RealtimeReferenceUpdate | null>;

export class RealtimeMarketDataCollector {
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly polymarketBooks = new Map<string, RealtimeBookTop>();
  private readonly hyperliquidBooks = new Map<string, HyperliquidBookUpdate>();
  private readonly hyperliquidContexts = new Map<string, HyperliquidContextUpdate>();
  private readonly references = new Map<string, ReferenceState>();
  private markets = new Map<string, ActiveCryptoDirectionMarket>();
  private desiredTokens = new Set<string>();
  private subscribedTokens = new Set<string>();
  private polymarketInitialized = false;
  private startedAt = new Date();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private readonly polymarketSocket = new ManagedWebSocket({
    name: "Polymarket CLOB",
    url: POLYMARKET_WS,
    heartbeatMs: 10_000,
    heartbeatMessage: "PING",
    onOpen: () => this.initializePolymarketSubscriptions(),
    onMessage: (data) => this.handlePolymarketMessage(data),
  });

  private readonly hyperliquidSocket = new ManagedWebSocket({
    name: "Hyperliquid",
    url: HYPERLIQUID_WS,
    heartbeatMs: 30_000,
    heartbeatMessage: JSON.stringify({ method: "ping" }),
    onOpen: () => this.initializeHyperliquidSubscriptions(),
    onMessage: (data) => this.handleHyperliquidMessage(data),
  });

  private readonly referenceSocket = new ManagedWebSocket({
    name: "Polymarket RTDS",
    url: POLYMARKET_RTDS_WS,
    heartbeatMs: 5_000,
    heartbeatMessage: "PING",
    onOpen: () => this.initializeReferenceSubscriptions(),
    onMessage: (data) => this.handleReferenceMessage(data),
  });

  constructor(options: { intervalMs?: number; retentionDays?: number } = {}) {
    this.intervalMs = boundedNumber(options.intervalMs, 5_000, 1_000, 60_000);
    this.retentionDays = boundedNumber(options.retentionDays, 14, 2, 90);
  }

  async start() {
    this.startedAt = new Date();
    await markPipelineAttempt("realtime-market-data", "WebSocket接続を準備中");
    await this.refreshMarkets();
    this.polymarketSocket.start();
    this.hyperliquidSocket.start();
    this.referenceSocket.start();
    this.flushTimer = setInterval(() => void this.flush().catch((error) => this.reportError(error)), this.intervalMs);
    this.refreshTimer = setInterval(() => void this.refreshMarkets().catch((error) => this.reportError(error)), 60_000);
    this.pruneTimer = setInterval(() => void this.prune().catch((error) => this.reportError(error)), 60 * 60_000);
    return this.status();
  }

  async stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = null;
    this.refreshTimer = null;
    this.pruneTimer = null;
    this.polymarketSocket.stop();
    this.hyperliquidSocket.stop();
    this.referenceSocket.stop();
  }

  async refreshMarkets(now = new Date()) {
    const discovered = await discoverActiveCryptoDirectionMarkets(200);
    const selected = discovered.filter((market) => {
      const startAt = new Date(market.eventStartTime).getTime();
      const endAt = market.endDate ? new Date(market.endDate).getTime() : Number.NaN;
      return supportedAssets.has(market.asset)
        && Boolean(market.noTokenId)
        && Math.abs(market.durationMinutes - targetDurationMinutes) <= 0.5
        && Number.isFinite(startAt)
        && Number.isFinite(endAt)
        && endAt >= now.getTime() - marketGraceMs
        && startAt <= now.getTime() + marketLeadMs;
    });
    this.markets = new Map(selected.map((market) => [market.id, market]));
    this.desiredTokens = new Set(selected.flatMap((market) => [market.tokenId, market.noTokenId as string]));
    const currentBooks = await fetchCurrentBooks(Array.from(this.desiredTokens)).catch(() => new Map());
    for (const [tokenId, book] of currentBooks) {
      const bid = book.bids[0];
      const ask = book.asks[0];
      if (!bid || !ask || ask.price < bid.price) continue;
      this.polymarketBooks.set(tokenId, {
        bestBid: bid.price,
        bestAsk: ask.price,
        bidSize: bid.size,
        askSize: ask.size,
        updatedAt: book.capturedAt,
      });
    }
    for (const market of selected) {
      await prisma.predictionMarket.upsert({
        where: { id: market.id },
        create: {
          id: market.id,
          eventId: market.eventId,
          asset: market.asset,
          tokenId: market.tokenId,
          title: market.title,
          slug: market.slug,
          endDate: market.endDate ? new Date(market.endDate) : null,
          resolved: false,
          result: null,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: {
          eventId: market.eventId,
          asset: market.asset,
          tokenId: market.tokenId,
          title: market.title,
          slug: market.slug,
          endDate: market.endDate ? new Date(market.endDate) : null,
          lastSeenAt: now,
        },
      });
    }
    this.syncPolymarketSubscriptions();
    return { markets: selected.length, tokens: this.desiredTokens.size };
  }

  async flush(now = new Date()) {
    if (this.flushing) return { saved: 0, skipped: true };
    this.flushing = true;
    try {
      await markPipelineAttempt("realtime-market-data", "Up/Down両板・Hyperliquid・判定価格を同期中");
      const activeMarkets = Array.from(this.markets.values()).filter((market) => isRealtimeCaptureWindow(market, now));
      const rows = activeMarkets.flatMap((market) => {
        const row = buildRealtimeMarketTick({
          market,
          positiveBook: this.polymarketBooks.get(market.tokenId) ?? null,
          negativeBook: market.noTokenId ? this.polymarketBooks.get(market.noTokenId) ?? null : null,
          hyperliquidBook: this.hyperliquidBooks.get(market.asset) ?? null,
          hyperliquidContext: this.hyperliquidContexts.get(market.asset) ?? null,
          references: this.references.get(market.asset) ?? { BINANCE: null, CHAINLINK: null },
          now,
          intervalMs: this.intervalMs,
        });
        return row ? [row] : [];
      });
      if (rows.length) await prisma.realtimeMarketTick.createMany({ data: rows });
      const health = this.connectionHealth(now);
      const startupGrace = now.getTime() - this.startedAt.getTime() < connectionStaleMs;
      if (activeMarkets.length && !rows.length && !startupGrace) {
        throw new Error(`秒単位価格が未完成: 市場${activeMarkets.length} / 接続${health.connected}/3`);
      }
      await markPipelineSuccess(
        "realtime-market-data",
        rows.length,
        `5秒板 ${rows.length}/${activeMarkets.length}市場 / 接続${health.connected}/3`,
      );
      return { saved: rows.length, activeMarkets: activeMarkets.length, health };
    } catch (error) {
      await markPipelineError("realtime-market-data", error);
      throw error;
    } finally {
      this.flushing = false;
    }
  }

  status(now = new Date()) {
    return {
      intervalMs: this.intervalMs,
      markets: this.markets.size,
      desiredTokens: this.desiredTokens.size,
      books: this.polymarketBooks.size,
      references: this.references.size,
      health: this.connectionHealth(now),
    };
  }

  private handlePolymarketMessage(data: unknown) {
    let handled = false;
    for (const update of normalizePolymarketWebSocketMessage(data)) {
      if (!this.desiredTokens.has(update.tokenId)) continue;
      this.polymarketBooks.set(update.tokenId, mergeBookTop(this.polymarketBooks.get(update.tokenId), update));
      handled = true;
    }
    return handled;
  }

  private handleHyperliquidMessage(data: unknown) {
    const update = normalizeHyperliquidWebSocketMessage(data);
    if (!update || !supportedAssets.has(update.asset)) return false;
    if ("bestBid" in update) this.hyperliquidBooks.set(update.asset, update);
    else this.hyperliquidContexts.set(update.asset, update);
    return true;
  }

  private handleReferenceMessage(data: unknown) {
    const update = normalizeRtdsReferenceMessage(data);
    if (!update) return false;
    const current = this.references.get(update.asset) ?? { BINANCE: null, CHAINLINK: null };
    this.references.set(update.asset, { ...current, [update.source]: update });
    return true;
  }

  private initializePolymarketSubscriptions() {
    this.polymarketInitialized = false;
    this.subscribedTokens.clear();
    this.syncPolymarketSubscriptions();
  }

  private syncPolymarketSubscriptions() {
    if (!this.polymarketSocket.isOpen()) return;
    if (!this.polymarketInitialized) {
      if (!this.desiredTokens.size) return;
      this.polymarketSocket.send(JSON.stringify({
        assets_ids: Array.from(this.desiredTokens),
        type: "market",
        custom_feature_enabled: true,
      }));
      this.subscribedTokens = new Set(this.desiredTokens);
      this.polymarketInitialized = true;
      return;
    }
    const additions = Array.from(this.desiredTokens).filter((token) => !this.subscribedTokens.has(token));
    const removals = Array.from(this.subscribedTokens).filter((token) => !this.desiredTokens.has(token));
    if (additions.length) this.polymarketSocket.send(JSON.stringify({ operation: "subscribe", assets_ids: additions, custom_feature_enabled: true }));
    if (removals.length) this.polymarketSocket.send(JSON.stringify({ operation: "unsubscribe", assets_ids: removals }));
    for (const token of additions) this.subscribedTokens.add(token);
    for (const token of removals) {
      this.subscribedTokens.delete(token);
      this.polymarketBooks.delete(token);
    }
  }

  private initializeHyperliquidSubscriptions() {
    for (const asset of supportedAssets) {
      this.hyperliquidSocket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: asset } }));
      this.hyperliquidSocket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: asset } }));
    }
  }

  private initializeReferenceSubscriptions() {
    this.referenceSocket.send(JSON.stringify({ action: "subscribe", subscriptions: realtimeReferenceSubscriptions() }));
  }

  private connectionHealth(now: Date) {
    const sockets = [this.polymarketSocket, this.hyperliquidSocket, this.referenceSocket];
    for (const socket of sockets) socket.reconnectIfStale(now, connectionStaleMs);
    const rows = sockets.map((socket) => socket.health(now, connectionStaleMs));
    return { connected: rows.filter((row) => row.healthy).length, sockets: rows };
  }

  private async prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60_000);
    return prisma.realtimeMarketTick.deleteMany({ where: { capturedAt: { lt: cutoff } } });
  }

  private async reportError(error: unknown) {
    console.error(error instanceof Error ? error.message : error);
  }
}

export function buildRealtimeMarketTick(input: {
  market: ActiveCryptoDirectionMarket;
  positiveBook: RealtimeBookTop | null;
  negativeBook: RealtimeBookTop | null;
  hyperliquidBook: HyperliquidBookUpdate | null;
  hyperliquidContext: HyperliquidContextUpdate | null;
  references: ReferenceState;
  now: Date;
  intervalMs?: number;
}): Prisma.RealtimeMarketTickCreateManyInput | null {
  const { market, positiveBook, negativeBook, hyperliquidBook, hyperliquidContext, references, now } = input;
  if (!market.noTokenId || !market.endDate || !isRealtimeCaptureWindow(market, now)) return null;
  if (!positiveBook || !negativeBook || !hyperliquidBook) return null;
  if (!isFresh(positiveBook.updatedAt, now, maximumPolymarketBookAgeMs)
    || !isFresh(negativeBook.updatedAt, now, maximumPolymarketBookAgeMs)
    || !isFresh(hyperliquidBook.updatedAt, now, maximumHyperliquidBookAgeMs)) return null;
  const chainlink = references.CHAINLINK && isFresh(references.CHAINLINK.updatedAt, now, maximumReferenceAgeMs)
    ? references.CHAINLINK
    : null;
  const binance = references.BINANCE && isFresh(references.BINANCE.updatedAt, now, maximumReferenceAgeMs)
    ? references.BINANCE
    : null;
  const preferredReference = market.referenceSource === "BINANCE"
    ? binance
    : market.referenceSource === "CHAINLINK"
      ? chainlink
      : chainlink ?? binance;
  if (!preferredReference) return null;
  const context = hyperliquidContext && isFresh(hyperliquidContext.updatedAt, now, maximumContextAgeMs)
    ? hyperliquidContext
    : null;
  const marketStartAt = new Date(market.eventStartTime);
  const marketEndAt = new Date(market.endDate);
  const timestamps = [positiveBook.updatedAt, negativeBook.updatedAt, hyperliquidBook.updatedAt, preferredReference.updatedAt];
  const captureSkewMs = Math.max(...timestamps.map((date) => date.getTime())) - Math.min(...timestamps.map((date) => date.getTime()));
  const hyperliquidMidPrice = (hyperliquidBook.bestBid + hyperliquidBook.bestAsk) / 2;
  const probability = clamp((positiveBook.bestBid + positiveBook.bestAsk) / 2, 0.0001, 0.9999);
  const complementBidSum = positiveBook.bestBid + negativeBook.bestBid;
  const complementAskSum = positiveBook.bestAsk + negativeBook.bestAsk;
  const priceBasisPct = calculatePriceBasisPct(hyperliquidMidPrice, preferredReference.price);
  if (priceBasisPct === null) return null;
  const intervalMs = boundedNumber(input.intervalMs, 5_000, 1_000, 60_000);
  return {
    id: `${market.id}:${Math.floor(now.getTime() / intervalMs)}`,
    eventId: market.eventId,
    marketId: market.id,
    positiveTokenId: market.tokenId,
    negativeTokenId: market.noTokenId,
    asset: market.asset,
    marketStartAt,
    marketEndAt,
    marketPhase: now < marketStartAt ? "PRE_OPEN" : now >= marketEndAt ? "POST_CLOSE" : "OPEN",
    probability,
    polymarketBestBid: positiveBook.bestBid,
    polymarketBestAsk: positiveBook.bestAsk,
    polymarketBidSize: positiveBook.bidSize,
    polymarketAskSize: positiveBook.askSize,
    polymarketSpread: positiveBook.bestAsk - positiveBook.bestBid,
    polymarketUpdatedAt: positiveBook.updatedAt,
    negativeBestBid: negativeBook.bestBid,
    negativeBestAsk: negativeBook.bestAsk,
    negativeBidSize: negativeBook.bidSize,
    negativeAskSize: negativeBook.askSize,
    negativeSpread: negativeBook.bestAsk - negativeBook.bestBid,
    negativeUpdatedAt: negativeBook.updatedAt,
    hyperliquidBestBid: hyperliquidBook.bestBid,
    hyperliquidBestAsk: hyperliquidBook.bestAsk,
    hyperliquidBidSize: hyperliquidBook.bidSize,
    hyperliquidAskSize: hyperliquidBook.askSize,
    hyperliquidSpread: hyperliquidBook.bestAsk - hyperliquidBook.bestBid,
    hyperliquidMidPrice,
    hyperliquidMarkPrice: context?.markPrice ?? null,
    hyperliquidOraclePrice: context?.oraclePrice ?? null,
    hyperliquidFundingRate: context?.fundingRate ?? null,
    hyperliquidUpdatedAt: hyperliquidBook.updatedAt,
    chainlinkPrice: chainlink?.price ?? null,
    chainlinkUpdatedAt: chainlink?.updatedAt ?? null,
    binancePrice: binance?.price ?? null,
    binanceUpdatedAt: binance?.updatedAt ?? null,
    referencePrice: preferredReference.price,
    referenceSource: preferredReference.source,
    referenceUpdatedAt: preferredReference.updatedAt,
    priceBasisPct,
    complementBidSum,
    complementAskSum,
    arbitrageViolation: complementAskSum < 0.999 || complementBidSum > 1.001,
    captureSkewMs,
    synchronizationVersion: realtimeSynchronizationVersion,
    capturedAt: now,
  };
}

export function isRealtimeCaptureWindow(market: Pick<ActiveCryptoDirectionMarket, "eventStartTime" | "endDate">, now: Date) {
  if (!market.endDate) return false;
  const startAt = new Date(market.eventStartTime).getTime();
  const endAt = new Date(market.endDate).getTime();
  return Number.isFinite(startAt)
    && Number.isFinite(endAt)
    && now.getTime() >= startAt - marketGraceMs
    && now.getTime() <= endAt + marketGraceMs;
}

function mergeBookTop(previous: RealtimeBookTop | undefined, next: RealtimeBookTop): RealtimeBookTop {
  return {
    ...next,
    bidSize: next.bidSize ?? (previous?.bestBid === next.bestBid ? previous.bidSize : null),
    askSize: next.askSize ?? (previous?.bestAsk === next.bestAsk ? previous.askSize : null),
  };
}

type ManagedWebSocketOptions = {
  name: string;
  url: string;
  heartbeatMs: number;
  heartbeatMessage: string;
  onOpen: () => void;
  onMessage: (data: unknown) => boolean;
};

class ManagedWebSocket {
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private openedAt: Date | null = null;
  private lastMessageAt: Date | null = null;

  constructor(private readonly options: ManagedWebSocketOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch { /* best effort */ }
    this.socket = null;
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: string) {
    if (!this.isOpen()) return false;
    this.socket?.send(message);
    return true;
  }

  health(now: Date, staleMs: number) {
    const ageMs = this.lastMessageAt ? now.getTime() - this.lastMessageAt.getTime() : null;
    return {
      name: this.options.name,
      open: this.isOpen(),
      openedAt: this.openedAt?.toISOString() ?? null,
      lastMessageAt: this.lastMessageAt?.toISOString() ?? null,
      ageMs,
      healthy: this.isOpen() && ageMs !== null && ageMs <= staleMs,
    };
  }

  reconnectIfStale(now: Date, staleMs: number) {
    if (!shouldReconnectManagedSocket({
      open: this.isOpen(),
      openedAt: this.openedAt,
      lastMessageAt: this.lastMessageAt,
      now,
      staleMs,
    })) return false;
    const staleSocket = this.socket;
    this.socket = null;
    this.openedAt = null;
    this.lastMessageAt = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try { staleSocket?.close(); } catch { /* reconnect below */ }
    this.scheduleReconnect();
    return true;
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.lastMessageAt = null;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      this.reconnectAttempts = 0;
      this.openedAt = new Date();
      this.options.onOpen();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.send(this.options.heartbeatMessage), this.options.heartbeatMs);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      if (this.options.onMessage(event.data)) this.lastMessageAt = new Date();
    });
    socket.addEventListener("error", () => {
      try { socket.close(); } catch { /* best effort */ }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.openedAt = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}

export function shouldReconnectManagedSocket(input: {
  open: boolean;
  openedAt: Date | null;
  lastMessageAt: Date | null;
  now: Date;
  staleMs: number;
}) {
  if (!input.open) return false;
  const lastActivityAt = input.lastMessageAt ?? input.openedAt;
  return Boolean(lastActivityAt && input.now.getTime() - lastActivityAt.getTime() > input.staleMs);
}

function isFresh(value: Date, now: Date, maximumAgeMs: number) {
  const ageMs = now.getTime() - value.getTime();
  return ageMs >= -5_000 && ageMs <= maximumAgeMs;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
