ALTER TABLE "CombinedShadowPosition" ADD COLUMN "polymarketSide" TEXT;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entrySpotPrice" REAL;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entryTrendZ6h" REAL;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entryFunding24h" REAL;

ALTER TABLE "CombinedShadowDecision" ADD COLUMN "polymarketSide" TEXT;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "strategySide" TEXT;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "trendZ6h" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "hyperliquidFunding24h" REAL;
