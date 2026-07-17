ALTER TABLE "CombinedShadowPosition" ADD COLUMN "horizonHours" INTEGER;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "priceBasisPct" REAL;

ALTER TABLE "CombinedShadowDecision" ADD COLUMN "horizonHours" INTEGER;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "scannedMarkets" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "structuredMarkets" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "horizonEligibleMarkets" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "groupedEvents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "priceReadyEvents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "marketBestBid" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "marketBestAsk" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "marketSpread" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "polymarketReferencePrice" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "referenceSource" TEXT;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "priceBasisPct" REAL;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "ladderViolations" INTEGER;
ALTER TABLE "CombinedShadowDecision" ADD COLUMN "nextWindowAt" DATETIME;

CREATE INDEX "CombinedShadowDecision_horizonHours_observedAt_idx" ON "CombinedShadowDecision"("horizonHours", "observedAt");
