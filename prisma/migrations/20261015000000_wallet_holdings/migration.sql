-- Canlı hesaplarda Spot dışındaki varlıklar (Fonlama, Earn, emirlerde kilitli) – sadece görüntüleme / portföy değeri
CREATE TABLE "WalletHolding" (
    "id" TEXT NOT NULL,
    "exchangeId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(36,12) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletHolding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletHolding_exchangeId_wallet_asset_key" ON "WalletHolding"("exchangeId", "wallet", "asset");

ALTER TABLE "WalletHolding" ADD CONSTRAINT "WalletHolding_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "ExchangeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
