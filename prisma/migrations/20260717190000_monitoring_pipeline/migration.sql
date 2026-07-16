CREATE TABLE "HyperliquidSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "midPrice" REAL NOT NULL,
    "markPrice" REAL NOT NULL,
    "oraclePrice" REAL NOT NULL,
    "previousDayPrice" REAL NOT NULL,
    "dayVolume" REAL NOT NULL,
    "openInterest" REAL NOT NULL,
    "fundingRate" REAL NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PipelineHeartbeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "records" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "lastAttemptAt" DATETIME NOT NULL,
    "lastSuccessAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "HyperliquidSnapshot_asset_capturedAt_idx" ON "HyperliquidSnapshot"("asset", "capturedAt");
CREATE INDEX "HyperliquidSnapshot_capturedAt_idx" ON "HyperliquidSnapshot"("capturedAt");
