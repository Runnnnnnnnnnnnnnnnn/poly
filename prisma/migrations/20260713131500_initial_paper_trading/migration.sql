-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "probability" REAL NOT NULL,
    "yesPrice" REAL NOT NULL,
    "noPrice" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "liquidity" REAL NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PredictionMarket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "endDate" DATETIME,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "result" INTEGER,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "threshold" REAL NOT NULL,
    "initialCapital" REAL NOT NULL,
    "marketCount" INTEGER NOT NULL DEFAULT 0,
    "metricsJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "BacktestPoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "predictedProbability" REAL NOT NULL,
    "actualOutcome" INTEGER NOT NULL,
    "brierScore" REAL NOT NULL,
    "logLoss" REAL NOT NULL,
    "position" INTEGER NOT NULL,
    "pnl" REAL NOT NULL,
    CONSTRAINT "BacktestPoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "initialCash" REAL NOT NULL,
    "cashBalance" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PaperTradingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "initialCash" REAL NOT NULL,
    "finalCash" REAL,
    "configJson" TEXT NOT NULL,
    "metricsJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PaperTradingRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PaperAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "requestedPrice" REAL NOT NULL,
    "requestedQuantity" REAL NOT NULL,
    "filledPrice" REAL,
    "filledQuantity" REAL NOT NULL DEFAULT 0,
    "fee" REAL NOT NULL DEFAULT 0,
    "slippage" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" DATETIME,
    CONSTRAINT "PaperOrder_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaperTradingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperFill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "notional" REAL NOT NULL,
    "fee" REAL NOT NULL,
    "slippage" REAL NOT NULL,
    "filledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaperFill_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaperTradingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperFill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaperOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "avgEntryPrice" REAL NOT NULL,
    "costBasis" REAL NOT NULL,
    "feePaid" REAL NOT NULL DEFAULT 0,
    "settlementValue" REAL,
    "realizedPnl" REAL,
    "status" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "PaperPosition_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaperTradingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperEquitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cash" REAL NOT NULL,
    "positionsValue" REAL NOT NULL,
    "equity" REAL NOT NULL,
    "unrealizedPnl" REAL NOT NULL,
    CONSTRAINT "PaperEquitySnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PaperTradingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WatchlistItem_marketId_idx" ON "WatchlistItem"("marketId");
CREATE INDEX "MarketSnapshot_marketId_capturedAt_idx" ON "MarketSnapshot"("marketId", "capturedAt");
CREATE INDEX "PredictionMarket_asset_endDate_idx" ON "PredictionMarket"("asset", "endDate");
CREATE INDEX "PredictionMarket_resolved_endDate_idx" ON "PredictionMarket"("resolved", "endDate");
CREATE INDEX "BacktestPoint_runId_observedAt_idx" ON "BacktestPoint"("runId", "observedAt");
CREATE INDEX "BacktestPoint_marketId_observedAt_idx" ON "BacktestPoint"("marketId", "observedAt");
CREATE INDEX "PaperTradingRun_accountId_startedAt_idx" ON "PaperTradingRun"("accountId", "startedAt");
CREATE INDEX "PaperTradingRun_asset_mode_status_idx" ON "PaperTradingRun"("asset", "mode", "status");
CREATE INDEX "PaperOrder_runId_submittedAt_idx" ON "PaperOrder"("runId", "submittedAt");
CREATE INDEX "PaperOrder_marketId_status_idx" ON "PaperOrder"("marketId", "status");
CREATE INDEX "PaperFill_runId_filledAt_idx" ON "PaperFill"("runId", "filledAt");
CREATE INDEX "PaperFill_marketId_filledAt_idx" ON "PaperFill"("marketId", "filledAt");
CREATE INDEX "PaperPosition_runId_status_idx" ON "PaperPosition"("runId", "status");
CREATE UNIQUE INDEX "PaperPosition_runId_marketId_outcome_key" ON "PaperPosition"("runId", "marketId", "outcome");
CREATE INDEX "PaperEquitySnapshot_runId_capturedAt_idx" ON "PaperEquitySnapshot"("runId", "capturedAt");
