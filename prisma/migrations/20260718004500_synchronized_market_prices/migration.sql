ALTER TABLE "MarketSnapshot" ADD COLUMN "bestBid" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "bestAsk" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "spread" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "clobCapturedAt" DATETIME;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidMidPrice" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidMarkPrice" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidOraclePrice" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidFundingRate" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "hyperliquidCapturedAt" DATETIME;
ALTER TABLE "MarketSnapshot" ADD COLUMN "referencePrice" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "referenceSource" TEXT;
ALTER TABLE "MarketSnapshot" ADD COLUMN "referenceCapturedAt" DATETIME;
ALTER TABLE "MarketSnapshot" ADD COLUMN "priceBasisPct" REAL;
ALTER TABLE "MarketSnapshot" ADD COLUMN "captureSkewMs" INTEGER;

CREATE INDEX "MarketSnapshot_capturedAt_captureSkewMs_idx" ON "MarketSnapshot"("capturedAt", "captureSkewMs");
