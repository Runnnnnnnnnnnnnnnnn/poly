CREATE TABLE "CombinedShadowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "initialEquity" REAL NOT NULL,
    "cash" REAL NOT NULL,
    "equity" REAL NOT NULL,
    "peakEquity" REAL NOT NULL,
    "maxDrawdownPct" REAL NOT NULL DEFAULT 0,
    "realizedPnl" REAL NOT NULL DEFAULT 0,
    "riskStatus" TEXT NOT NULL DEFAULT 'NORMAL',
    "emergencyStopped" BOOLEAN NOT NULL DEFAULT false,
    "configJson" TEXT NOT NULL,
    "lastDecisionJson" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "stoppedAt" DATETIME
);

CREATE TABLE "CombinedShadowPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "markPrice" REAL NOT NULL,
    "impliedTarget" REAL NOT NULL,
    "signalZ" REAL NOT NULL,
    "entryFee" REAL NOT NULL,
    "accruedFunding" REAL NOT NULL DEFAULT 0,
    "realizedPnl" REAL,
    "status" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "closeReason" TEXT,
    CONSTRAINT "CombinedShadowPosition_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CombinedShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CombinedShadowDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "eventId" TEXT,
    "marketId" TEXT,
    "asset" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "probability" REAL,
    "spotPrice" REAL,
    "targetPrice" REAL,
    "signalZ" REAL,
    "threshold" REAL NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CombinedShadowDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CombinedShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CombinedShadowEquitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "cash" REAL NOT NULL,
    "positionsPnl" REAL NOT NULL,
    "equity" REAL NOT NULL,
    "drawdownPct" REAL NOT NULL,
    "dailyReturnPct" REAL NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CombinedShadowEquitySnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CombinedShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CombinedExecutionOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "positionId" TEXT,
    "environment" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "referencePrice" REAL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "responseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CombinedExecutionOrder_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CombinedShadowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CombinedExecutionOrder_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "CombinedShadowPosition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CombinedShadowRun_status_startedAt_idx" ON "CombinedShadowRun"("status", "startedAt");
CREATE INDEX "CombinedShadowPosition_runId_status_idx" ON "CombinedShadowPosition"("runId", "status");
CREATE INDEX "CombinedShadowPosition_eventId_asset_idx" ON "CombinedShadowPosition"("eventId", "asset");
CREATE INDEX "CombinedShadowDecision_runId_observedAt_idx" ON "CombinedShadowDecision"("runId", "observedAt");
CREATE INDEX "CombinedShadowDecision_action_observedAt_idx" ON "CombinedShadowDecision"("action", "observedAt");
CREATE INDEX "CombinedShadowEquitySnapshot_runId_capturedAt_idx" ON "CombinedShadowEquitySnapshot"("runId", "capturedAt");
CREATE UNIQUE INDEX "CombinedExecutionOrder_clientOrderId_key" ON "CombinedExecutionOrder"("clientOrderId");
CREATE INDEX "CombinedExecutionOrder_runId_createdAt_idx" ON "CombinedExecutionOrder"("runId", "createdAt");
CREATE INDEX "CombinedExecutionOrder_environment_status_idx" ON "CombinedExecutionOrder"("environment", "status");
