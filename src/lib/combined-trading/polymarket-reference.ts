import type { CryptoMarket } from "@/src/lib/backtest/types";
import { fetchWithTimeout } from "@/lib/utils";

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const symbols = {
  BTC: { binance: "btcusdt", chainlink: "btc/usd" },
  ETH: { binance: "ethusdt", chainlink: "eth/usd" },
  SOL: { binance: "solusdt", chainlink: "sol/usd" },
  XRP: { binance: "xrpusdt", chainlink: "xrp/usd" },
} as const;

export type SupportedReferenceAsset = keyof typeof symbols;

export type PolymarketReferencePrice = {
  asset: SupportedReferenceAsset;
  source: "BINANCE" | "CHAINLINK";
  price: number;
  capturedAt: string;
};

export async function fetchPolymarketReferencePrices(
  assets: SupportedReferenceAsset[],
  timeoutMs = 2_500,
): Promise<PolymarketReferencePrice[]> {
  const streamed = await fetchRtdsReferencePrices(assets, timeoutMs);
  const missingBinance = assets.filter((asset) => !streamed.some((price) => price.asset === asset && price.source === "BINANCE"));
  const fallback = await Promise.all(missingBinance.map(fetchBinanceReferencePrice));
  return [...streamed, ...fallback.filter((price): price is PolymarketReferencePrice => price !== null)];
}

async function fetchRtdsReferencePrices(
  assets: SupportedReferenceAsset[],
  timeoutMs: number,
): Promise<PolymarketReferencePrice[]> {
  if (typeof WebSocket === "undefined" || !assets.length) return [];
  const uniqueAssets = Array.from(new Set(assets));

  return new Promise((resolve) => {
    const collected = new Map<string, PolymarketReferencePrice>();
    const socket = new WebSocket(RTDS_URL);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch { /* best effort */ }
      resolve(Array.from(collected.values()));
    };
    const timeout = setTimeout(finish, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices",
            type: "update",
            filters: uniqueAssets.map((asset) => symbols[asset].binance).join(","),
          },
          ...uniqueAssets.map((asset) => ({
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: symbols[asset].chainlink }),
          })),
        ],
      }));
    });
    socket.addEventListener("message", (event) => {
      const parsed = parseMessage(event.data);
      if (!parsed) return;
      const asset = uniqueAssets.find((candidate) => (
        parsed.symbol === symbols[candidate].binance || parsed.symbol === symbols[candidate].chainlink
      ));
      if (!asset) return;
      const source = parsed.symbol.includes("/") ? "CHAINLINK" as const : "BINANCE" as const;
      collected.set(`${asset}:${source}`, {
        asset,
        source,
        price: parsed.value,
        capturedAt: new Date(parsed.timestamp).toISOString(),
      });
      if (uniqueAssets.every((candidate) => collected.has(`${candidate}:BINANCE`))) finish();
    });
    socket.addEventListener("error", finish);
  });
}

async function fetchBinanceReferencePrice(asset: SupportedReferenceAsset): Promise<PolymarketReferencePrice | null> {
  const response = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${symbols[asset].binance.toUpperCase()}`, {
    cache: "no-store",
  }, 5_000).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json() as { price?: unknown };
  const price = Number(body.price);
  return Number.isFinite(price) && price > 0
    ? { asset, source: "BINANCE", price, capturedAt: new Date().toISOString() }
    : null;
}

export function selectReferencePrice(
  prices: PolymarketReferencePrice[],
  asset: SupportedReferenceAsset,
  preferredSource: CryptoMarket["referenceSource"],
) {
  const matching = prices.filter((price) => price.asset === asset);
  if (preferredSource !== "UNKNOWN") {
    const preferred = matching.find((price) => price.source === preferredSource);
    if (preferred) return preferred;
  }
  return matching.find((price) => price.source === "BINANCE") ?? matching[0] ?? null;
}

function parseMessage(data: unknown) {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as {
      topic?: unknown;
      payload?: { symbol?: unknown; value?: unknown; timestamp?: unknown };
    };
    if (value.topic !== "crypto_prices" && value.topic !== "crypto_prices_chainlink") return null;
    const symbol = typeof value.payload?.symbol === "string" ? value.payload.symbol.toLowerCase() : "";
    const price = Number(value.payload?.value);
    const timestamp = Number(value.payload?.timestamp);
    if (!symbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) return null;
    return { symbol, value: price, timestamp };
  } catch {
    return null;
  }
}
