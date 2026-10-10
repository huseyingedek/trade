-- Gerçek (live) ve sanal (paper) hesap değerlerini ayrı izle
ALTER TABLE "RiskSettings" ADD COLUMN "dayStartModes" JSONB;
ALTER TABLE "PortfolioSnapshot" ADD COLUMN "liveUsd" DOUBLE PRECISION;
ALTER TABLE "PortfolioSnapshot" ADD COLUMN "paperUsd" DOUBLE PRECISION;
