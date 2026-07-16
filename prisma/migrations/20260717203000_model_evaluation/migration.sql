CREATE TABLE "ModelEvaluationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "datasetHash" TEXT,
    "configJson" TEXT NOT NULL,
    "metricsJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

CREATE INDEX "ModelEvaluationRun_status_completedAt_idx" ON "ModelEvaluationRun"("status", "completedAt");
