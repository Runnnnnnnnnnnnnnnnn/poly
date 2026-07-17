ALTER TABLE "PredictionMarket" ADD COLUMN "eventId" TEXT;

CREATE INDEX "PredictionMarket_eventId_endDate_idx" ON "PredictionMarket"("eventId", "endDate");
