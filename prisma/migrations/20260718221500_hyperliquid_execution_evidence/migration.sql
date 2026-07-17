ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "exchangeOrderId" TEXT;
ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "exchangeStatus" TEXT;
ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "filledQuantity" REAL NOT NULL DEFAULT 0;
ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "averageFillPrice" REAL;
ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "feePaid" REAL NOT NULL DEFAULT 0;
ALTER TABLE "CombinedExecutionOrder" ADD COLUMN "lastReconciledAt" DATETIME;
