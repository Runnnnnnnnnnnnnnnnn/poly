ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entryReferencePrice" REAL;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entryReferenceSource" TEXT;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "entryReferenceCapturedAt" DATETIME;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "exitReferencePrice" REAL;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "exitReferenceSource" TEXT;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "exitReferenceCapturedAt" DATETIME;
ALTER TABLE "CombinedShadowPosition" ADD COLUMN "exitPriceBasisPct" REAL;

ALTER TABLE "CombinedShadowDecision" ADD COLUMN "referenceCapturedAt" DATETIME;
