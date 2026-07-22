ALTER TABLE "PredictionMarket" ADD COLUMN "startDate" DATETIME;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementOpenPrice" REAL;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementClosePrice" REAL;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementReferenceSource" TEXT;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementReferenceStatus" TEXT;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementReferenceError" TEXT;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementReferenceAt" DATETIME;
ALTER TABLE "PredictionMarket" ADD COLUMN "settlementReferenceCheckedAt" DATETIME;

CREATE INDEX "PredictionMarket_settlementReferenceStatus_endDate_idx"
ON "PredictionMarket"("settlementReferenceStatus", "endDate");
