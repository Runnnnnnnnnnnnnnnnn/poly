export type RealtimeBookTop = {
  bestBid: number;
  bestAsk: number;
  bidSize: number | null;
  askSize: number | null;
  updatedAt: Date;
};

export type PolymarketBookUpdate = RealtimeBookTop & {
  tokenId: string;
};

export type HyperliquidBookUpdate = RealtimeBookTop & {
  asset: string;
};

export type HyperliquidContextUpdate = {
  asset: string;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number;
  updatedAt: Date;
};

export type RealtimeReferenceUpdate = {
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  source: "BINANCE" | "CHAINLINK";
  price: number;
  updatedAt: Date;
};

const referenceSymbols = {
  BTC: { binance: "btcusdt", chainlink: "btc/usd" },
  ETH: { binance: "ethusdt", chainlink: "eth/usd" },
  SOL: { binance: "solusdt", chainlink: "sol/usd" },
  XRP: { binance: "xrpusdt", chainlink: "xrp/usd" },
} as const;

export function normalizePolymarketWebSocketMessage(input: unknown): PolymarketBookUpdate[] {
  const parsed = parseWireValue(input);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.flatMap((message) => normalizePolymarketMessage(message));
}

export function normalizeHyperliquidWebSocketMessage(input: unknown): HyperliquidBookUpdate | HyperliquidContextUpdate | null {
  const parsed = parseWireValue(input);
  if (!isRecord(parsed) || !isRecord(parsed.data)) return null;
  if (parsed.channel === "l2Book") {
    const asset = stringValue(parsed.data.coin);
    const levels = Array.isArray(parsed.data.levels) ? parsed.data.levels : [];
    const bids = Array.isArray(levels[0]) ? levels[0] : [];
    const asks = Array.isArray(levels[1]) ? levels[1] : [];
    const bid = bestHyperliquidLevel(bids, "bid");
    const ask = bestHyperliquidLevel(asks, "ask");
    const updatedAt = dateValue(parsed.data.time);
    if (!asset || !bid || !ask || !updatedAt || ask.price < bid.price) return null;
    return {
      asset,
      bestBid: bid.price,
      bestAsk: ask.price,
      bidSize: bid.size,
      askSize: ask.size,
      updatedAt,
    };
  }
  if (parsed.channel === "activeAssetCtx" && isRecord(parsed.data.ctx)) {
    const asset = stringValue(parsed.data.coin);
    const markPrice = positiveNumber(parsed.data.ctx.markPx);
    const oraclePrice = positiveNumber(parsed.data.ctx.oraclePx);
    const fundingRate = finiteNumber(parsed.data.ctx.funding);
    if (!asset || markPrice === null || oraclePrice === null || fundingRate === null) return null;
    return {
      asset,
      markPrice,
      oraclePrice,
      fundingRate,
      updatedAt: new Date(),
    };
  }
  return null;
}

export function normalizeRtdsReferenceMessage(input: unknown): RealtimeReferenceUpdate | null {
  const parsed = parseWireValue(input);
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return null;
  if (parsed.topic !== "crypto_prices" && parsed.topic !== "crypto_prices_chainlink") return null;
  const symbol = stringValue(parsed.payload.symbol)?.toLowerCase() ?? "";
  const price = positiveNumber(parsed.payload.value);
  const updatedAt = dateValue(parsed.payload.timestamp);
  if (!symbol || price === null || !updatedAt) return null;
  const asset = (Object.keys(referenceSymbols) as Array<keyof typeof referenceSymbols>).find((candidate) => (
    referenceSymbols[candidate].binance === symbol || referenceSymbols[candidate].chainlink === symbol
  ));
  if (!asset) return null;
  return {
    asset,
    source: symbol.includes("/") ? "CHAINLINK" : "BINANCE",
    price,
    updatedAt,
  };
}

export function realtimeReferenceSubscriptions() {
  return [
    {
      topic: "crypto_prices",
      type: "update",
    },
    {
      topic: "crypto_prices_chainlink",
      type: "*",
      filters: "",
    },
  ];
}

function normalizePolymarketMessage(input: unknown): PolymarketBookUpdate[] {
  if (!isRecord(input)) return [];
  const updatedAt = dateValue(input.timestamp);
  if (!updatedAt) return [];
  if (input.event_type === "book") {
    const tokenId = stringValue(input.asset_id);
    const bid = bestPolymarketLevel(Array.isArray(input.bids) ? input.bids : [], "bid");
    const ask = bestPolymarketLevel(Array.isArray(input.asks) ? input.asks : [], "ask");
    return tokenId && bid && ask && ask.price >= bid.price
      ? [{ tokenId, bestBid: bid.price, bestAsk: ask.price, bidSize: bid.size, askSize: ask.size, updatedAt }]
      : [];
  }
  if (input.event_type === "best_bid_ask") {
    const update = directPolymarketUpdate(input, updatedAt);
    return update ? [update] : [];
  }
  if (input.event_type === "price_change" && Array.isArray(input.price_changes)) {
    return input.price_changes.flatMap((change) => {
      const update = directPolymarketUpdate(change, updatedAt);
      return update ? [update] : [];
    });
  }
  return [];
}

function directPolymarketUpdate(input: unknown, updatedAt: Date): PolymarketBookUpdate | null {
  if (!isRecord(input)) return null;
  const tokenId = stringValue(input.asset_id);
  const bestBid = positiveNumber(input.best_bid);
  const bestAsk = positiveNumber(input.best_ask);
  if (!tokenId || bestBid === null || bestAsk === null || bestAsk < bestBid) return null;
  return { tokenId, bestBid, bestAsk, bidSize: null, askSize: null, updatedAt };
}

function bestPolymarketLevel(levels: unknown[], side: "bid" | "ask") {
  const normalized = levels.flatMap((level) => {
    if (!isRecord(level)) return [];
    const price = positiveNumber(level.price);
    const size = positiveNumber(level.size);
    return price === null ? [] : [{ price, size }];
  });
  return normalized.sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)[0] ?? null;
}

function bestHyperliquidLevel(levels: unknown[], side: "bid" | "ask") {
  const normalized = levels.flatMap((level) => {
    if (!isRecord(level)) return [];
    const price = positiveNumber(level.px);
    const size = positiveNumber(level.sz);
    return price === null ? [] : [{ price, size }];
  });
  return normalized.sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)[0] ?? null;
}

function parseWireValue(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (input === "PONG") return null;
  try { return JSON.parse(input) as unknown; } catch { return null; }
}

function dateValue(value: unknown) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
