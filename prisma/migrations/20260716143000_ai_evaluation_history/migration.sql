CREATE TABLE "AiEvaluationSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "tabId" TEXT NOT NULL,
    "tabLabel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "marketProbability" REAL NOT NULL,
    "aiProbability" REAL NOT NULL,
    "expectedReturnYes" REAL,
    "expectedReturnNo" REAL,
    "rating" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonsJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evaluatedAt" DATETIME NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedOutcome" INTEGER,
    "brierScore" REAL
);

CREATE INDEX "AiEvaluationSnapshot_marketId_recordedAt_idx" ON "AiEvaluationSnapshot"("marketId", "recordedAt");
CREATE INDEX "AiEvaluationSnapshot_evaluatedAt_idx" ON "AiEvaluationSnapshot"("evaluatedAt");
CREATE INDEX "AiEvaluationSnapshot_status_recordedAt_idx" ON "AiEvaluationSnapshot"("status", "recordedAt");
