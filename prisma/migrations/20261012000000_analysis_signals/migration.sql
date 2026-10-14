-- Analiz merkezi: teknik görünüm kayıtları ve sonradan ölçülen getiriler ("karne")
CREATE TABLE "AnalysisSignal" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ret1d" DOUBLE PRECISION,
    "ret7d" DOUBLE PRECISION,
    "ret30d" DOUBLE PRECISION,

    CONSTRAINT "AnalysisSignal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalysisSignal_symbol_horizon_day_key" ON "AnalysisSignal"("symbol", "horizon", "day");
CREATE INDEX "AnalysisSignal_createdAt_idx" ON "AnalysisSignal"("createdAt");
