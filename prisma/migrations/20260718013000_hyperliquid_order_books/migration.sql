ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidBestBid" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidBestAsk" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidSpread" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidBookUpdatedAt" DATETIME;

ALTER TABLE "HyperliquidSnapshot" ADD COLUMN "bestBid" REAL;
ALTER TABLE "HyperliquidSnapshot" ADD COLUMN "bestAsk" REAL;
ALTER TABLE "HyperliquidSnapshot" ADD COLUMN "spread" REAL;
ALTER TABLE "HyperliquidSnapshot" ADD COLUMN "bookUpdatedAt" DATETIME;
