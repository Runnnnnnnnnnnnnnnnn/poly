ALTER TABLE "MarketSnapshot" ADD COLUMN "clobUpdatedAt" DATETIME;
ALTER TABLE "MarketSnapshot" ADD COLUMN "synchronizationVersion" TEXT;

UPDATE "MarketSnapshot"
SET
  "clobUpdatedAt" = "clobCapturedAt",
  "clobCapturedAt" = "capturedAt",
  "captureSkewMs" = MAX("capturedAt", "hyperliquidCapturedAt", "referenceCapturedAt")
    - MIN("capturedAt", "hyperliquidCapturedAt", "referenceCapturedAt"),
  "synchronizationVersion" = 'fetch-time-v2'
WHERE "clobCapturedAt" IS NOT NULL
  AND "hyperliquidCapturedAt" IS NOT NULL
  AND "referenceCapturedAt" IS NOT NULL;

CREATE INDEX "MarketSnapshot_synchronizationVersion_capturedAt_captureSkewMs_idx"
ON "MarketSnapshot"("synchronizationVersion", "capturedAt", "captureSkewMs");
