// =====================================================================
//  Başlangıç verisi (idempotent – tekrar çalıştırmak güvenli)
//  • Abonelik planları  • Enstrümanlar  • Platform/entegrasyon ayarları
//  • Süper admin hesabı (ilk girişte 2FA kurulumu istenir)
//  • SEED_DEMO=true ise: demo yatırımcı + 3 paper hesap (sahte geçmiş YOK)
// =====================================================================
import bcrypt from 'bcryptjs'
import { config, isProd } from '../src/config.js'
import { prisma } from '../src/lib/prisma.js'
import { encrypt } from '../src/lib/crypto.js'
import { PROVIDERS } from '../src/exchanges/providers.js'

const PLANS = [
  { id: 'free', name: 'Ücretsiz', priceMonthly: 0, priceYearly: 0, maxExchanges: 1, maxBots: 1, maxRules: 3, futures: false, apiAccess: false, prioritySupport: false, telegram: false, highlighted: false, sortOrder: 1, description: 'Denemek isteyenler için tek hesap, temel alarmlar.' },
  { id: 'starter', name: 'Başlangıç', priceMonthly: 399, priceYearly: 3990, maxExchanges: 2, maxBots: 5, maxRules: 15, futures: false, apiAccess: false, prioritySupport: false, telegram: true, highlighted: false, sortOrder: 2, description: 'Spot işlem yapan bireysel yatırımcı.' },
  { id: 'pro', name: 'Pro', priceMonthly: 999, priceYearly: 9990, maxExchanges: 5, maxBots: 25, maxRules: 100, futures: true, apiAccess: false, prioritySupport: true, telegram: true, highlighted: true, sortOrder: 3, description: 'Birden fazla borsa, vadeli işlem ve otomasyon.' },
  { id: 'expert', name: 'Uzman', priceMonthly: 2499, priceYearly: 24990, maxExchanges: 15, maxBots: 200, maxRules: -1, futures: true, apiAccess: true, prioritySupport: true, telegram: true, highlighted: false, sortOrder: 4, description: 'Yoğun otomasyon, API erişimi, sınırsız kural.' },
]

// [symbol, name, base, quote, market, tickSize, qtyStep, seedPrice, volatility]
const INSTRUMENTS = [
  ['BTC/USDT', 'Bitcoin', 'BTC', 'USDT', 'crypto', 0.01, 0.0001, 64250, 0.0009],
  ['ETH/USDT', 'Ethereum', 'ETH', 'USDT', 'crypto', 0.01, 0.001, 3120, 0.0011],
  ['SOL/USDT', 'Solana', 'SOL', 'USDT', 'crypto', 0.01, 0.01, 148.2, 0.0014],
  ['BNB/USDT', 'BNB', 'BNB', 'USDT', 'crypto', 0.01, 0.001, 585.4, 0.0009],
  ['XRP/USDT', 'XRP', 'XRP', 'USDT', 'crypto', 0.0001, 1, 0.5432, 0.0013],
  ['AVAX/USDT', 'Avalanche', 'AVAX', 'USDT', 'crypto', 0.01, 0.01, 27.84, 0.0015],
  ['DOGE/USDT', 'Dogecoin', 'DOGE', 'USDT', 'crypto', 0.00001, 1, 0.12541, 0.0016],
  ['ADA/USDT', 'Cardano', 'ADA', 'USDT', 'crypto', 0.0001, 1, 0.3612, 0.0014],
  ['THYAO', 'Türk Hava Yolları', 'THYAO', 'TRY', 'bist', 0.05, 1, 286.5, 0.0006],
  ['ASELS', 'Aselsan', 'ASELS', 'TRY', 'bist', 0.05, 1, 62.4, 0.0007],
  ['GARAN', 'Garanti BBVA', 'GARAN', 'TRY', 'bist', 0.05, 1, 118.9, 0.0007],
  ['BIMAS', 'BİM Mağazalar', 'BIMAS', 'TRY', 'bist', 0.25, 1, 521, 0.0005],
  ['EREGL', 'Ereğli Demir Çelik', 'EREGL', 'TRY', 'bist', 0.01, 1, 47.82, 0.0006],
  ['KCHOL', 'Koç Holding', 'KCHOL', 'TRY', 'bist', 0.1, 1, 189.6, 0.0005],
  ['SISE', 'Şişecam', 'SISE', 'TRY', 'bist', 0.01, 1, 41.22, 0.0006],
  ['AKBNK', 'Akbank', 'AKBNK', 'TRY', 'bist', 0.05, 1, 58.7, 0.0007],
  ['EUR/USD', 'Euro / Dolar', 'EUR', 'USD', 'forex', 0.00001, 1000, 1.0852, 0.00012],
  ['GBP/USD', 'Sterlin / Dolar', 'GBP', 'USD', 'forex', 0.00001, 1000, 1.2731, 0.00014],
  ['USD/TRY', 'Dolar / TL', 'USD', 'TRY', 'forex', 0.0001, 1000, 42.35, 0.00008],
  ['USD/JPY', 'Dolar / Yen', 'USD', 'JPY', 'forex', 0.001, 1000, 149.21, 0.00012],
  ['XAU/USD', 'Altın (ons)', 'XAU', 'USD', 'forex', 0.01, 1, 2652.4, 0.0003],
]

async function main() {
  console.log('🌱 Seed başlıyor…')

  for (const p of PLANS) await prisma.plan.upsert({ where: { id: p.id }, update: {}, create: { ...p, currency: 'TRY' } })
  console.log(`  ✓ ${PLANS.length} plan`)

  for (const [i, [symbol, name, base, quote, market, tickSize, qtyStep, seedPrice, volatility]] of INSTRUMENTS.entries()) {
    const dataSource = market === 'crypto' ? 'binance' : 'sim'
    await prisma.instrument.upsert({
      where: { symbol },
      update: {},
      create: { symbol, name, base, quote, market, tickSize, qtyStep, seedPrice, volatility, dataSource, sourceSymbol: market === 'crypto' ? symbol : null, sortOrder: i },
    })
  }
  console.log(`  ✓ ${INSTRUMENTS.length} enstrüman (kripto: Binance gerçek fiyat · BIST/forex: simülasyon)`)

  for (const p of PROVIDERS) await prisma.providerSetting.upsert({ where: { id: p.id }, update: {}, create: { id: p.id } })
  await prisma.platformSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  console.log('  ✓ platform & entegrasyon ayarları')

  const email = config.SEED_ADMIN_EMAIL.toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (!existing) {
    await prisma.user.create({
      data: { email, name: config.SEED_ADMIN_NAME, role: 'super_admin', status: 'active', emailVerifiedAt: new Date(), planId: 'free', passwordHash: await bcrypt.hash(config.SEED_ADMIN_PASSWORD, 12) },
    })
    console.log(`  ✓ süper admin: ${email}${isProd ? '' : ` / ${config.SEED_ADMIN_PASSWORD}`}  (ilk girişte 2FA kurulumu istenir, şifreyi değiştirin!)`)
  } else console.log(`  • süper admin zaten var: ${email}`)

  if (config.SEED_DEMO) {
    const demoEmail = 'demo@tradepilo.com'
    let demo = await prisma.user.findUnique({ where: { email: demoEmail } })
    if (!demo) {
      demo = await prisma.user.create({
        data: { email: demoEmail, name: 'Demo Yatırımcı', role: 'user', status: 'active', emailVerifiedAt: new Date(), planId: 'pro', city: 'İstanbul', passwordHash: await bcrypt.hash('Demo12345!', 12) },
      })
      await prisma.riskSettings.create({ data: { userId: demo.id } })
      const accounts = [
        { provider: 'binance', label: 'Binance (paper)', market: 'crypto', asset: 'USDT', amount: 10000 },
        { provider: 'bist_broker', label: 'BIST Hesabı (paper)', market: 'bist', asset: 'TRY', amount: 400000 },
        { provider: 'oanda', label: 'Forex (paper)', market: 'forex', asset: 'USD', amount: 10000 },
      ]
      for (const a of accounts) {
        await prisma.exchangeAccount.create({
          data: {
            userId: demo.id, provider: a.provider, label: a.label, market: a.market, mode: 'paper', credentialsEnc: encrypt({}), apiKeyMasked: 'anahtarsız (sanal)',
            permissions: ['read', 'spot', ...(a.provider === 'binance' ? ['futures'] : [])], lastSyncAt: new Date(),
            balances: { create: { asset: a.asset, free: a.amount } },
          },
        })
      }
      await prisma.activity.create({ data: { userId: demo.id, level: 'success', message: 'Demo hesabı oluşturuldu – 3 paper (sanal) hesap hazır' } })
      console.log(`  ✓ demo yatırımcı: ${demoEmail} / Demo12345!  (3 paper hesap, geçmiş veri yok)`)
    } else console.log(`  • demo yatırımcı zaten var: ${demoEmail}`)
  }
  console.log('✅ Seed tamam')
}

main()
  .catch((e) => {
    console.error('❌ Seed hatası:', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
