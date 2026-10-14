// Piyasa durumu birim testleri – gerçek API yanıt biçimleriyle (dokümantasyondaki örnekler), internet gerektirmez
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x'
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123'
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

const { parseFng, fngLabel, parseDerivatives, marketNotes, marketStatus } = await import('../src/analysis/market.js')

// alternative.me dokümantasyonundaki örnek yanıt
const FNG = { name: 'Fear and Greed Index', data: [{ value: '40', value_classification: 'Fear', timestamp: '1551157200', time_until_update: '68499' }, { value: '47', value_classification: 'Neutral', timestamp: '1551070800' }], metadata: { error: null } }
// Binance dokümantasyonundaki örnek yanıtlar
const PREMIUM = { symbol: 'BTCUSDT', markPrice: '11793.63104562', indexPrice: '11781.80495970', estimatedSettlePrice: '11781.16138815', lastFundingRate: '0.00038246', interestRate: '0.00010000', nextFundingTime: 1597392000000, time: 1597370495002 }
const day = 86_400_000
const OI = Array.from({ length: 8 }, (_, i) => ({ symbol: 'BTCUSDT', sumOpenInterest: '1', sumOpenInterestValue: String(100 + i * 3), CMCCirculatingSupply: '1', timestamp: 1_700_000_000_000 + i * day }))
const LS = [{ symbol: 'BTCUSDT', longShortRatio: '2.9600', longAccount: '0.7475', shortAccount: '0.2525', timestamp: 1591261042378 }]

test('Korku ve Hırs: yanıt çözülür, en yeni değer seçilir, etiketler doğru', () => {
  const f = parseFng(FNG)
  assert.equal(f.value, 40)
  assert.equal(f.label, 'fear')
  assert.equal(f.ts, 1551157200 * 1000)
  assert.deepEqual(f.history.map((h) => h[1]), [47, 40]) // eski → yeni
  assert.equal(parseFng({ data: [] }), null)
  assert.equal(parseFng(null), null)
  assert.deepEqual([0, 25, 26, 45, 46, 54, 55, 74, 75, 100].map(fngLabel), ['extreme_fear', 'extreme_fear', 'fear', 'fear', 'neutral', 'neutral', 'greed', 'greed', 'extreme_greed', 'extreme_greed'])
})

test('Binance vadeli: fonlama yüzdeye, açık pozisyon değişimi ve long oranı doğru', () => {
  const d = parseDerivatives(PREMIUM, OI, LS)
  assert.ok(Math.abs(d.fundingPct - 0.038246) < 1e-9)
  assert.equal(d.openInterestUsd, 121)
  assert.ok(Math.abs(d.oiChange1dPct - (3 / 118) * 100) < 1e-9)
  assert.ok(Math.abs(d.oiChange7dPct - 21) < 1e-9)
  assert.equal(d.longShortRatio, 2.96)
  assert.ok(Math.abs(d.longPct - 74.75) < 1e-9)
  // eksik veri
  const e = parseDerivatives(null, [], [])
  assert.equal(e.fundingPct, null)
  assert.equal(e.oiChange7dPct, null)
})

test('durum notları: aşırı hırs, kalabalık long, kaldıraç birikimi uyarı verir', () => {
  const deriv = { BTC: parseDerivatives({ ...PREMIUM, lastFundingRate: '0.0008' }, OI, LS) }
  const notes = marketNotes({ fng: { value: 82, weekAgo: 60 }, deriv, btc: null })
  const texts = notes.map((n) => n.text)
  assert.ok(texts.some((x) => x.startsWith('Piyasada aşırı hırs')))
  assert.ok(texts.some((x) => x.startsWith('Korku ve Hırs Endeksi bir haftada')))
  assert.ok(texts.some((x) => x.startsWith('BTC fonlama oranı yüksek')))
  assert.ok(texts.some((x) => x.startsWith('Hesapların %{0} kadarı long')))
  assert.ok(texts.some((x) => x.startsWith('BTC vadeli açık pozisyonları 7 günde %{0} arttı')))
  // sakin piyasa → not yok
  const calm = marketNotes({ fng: { value: 50, weekAgo: 48 }, deriv: { BTC: parseDerivatives({ lastFundingRate: '0.0001' }, OI.map((o) => ({ ...o, sumOpenInterestValue: '100' })), [{ longShortRatio: '1.2', longAccount: '0.55', timestamp: 1 }]) }, btc: null })
  assert.equal(calm.length, 0)
})

test('kaynak düşerse diğerleri yine gösterilir; hepsi düşerse boş döner', async () => {
  const getJson = async (url) => {
    if (url.includes('alternative.me')) throw new Error('kapalı')
    if (url.includes('premiumIndex')) return PREMIUM
    if (url.includes('openInterestHist')) return OI
    if (url.includes('LongShort')) return LS
    throw new Error('bilinmeyen ' + url)
  }
  const r = await marketStatus({ fresh: true, getJson })
  assert.equal(r.fearGreed, null)
  assert.ok(r.derivatives.BTC.fundingPct > 0)
  assert.ok(r.derivatives.ETH)
  const none = await marketStatus({ fresh: true, getJson: async () => { throw new Error('ağ yok') } })
  assert.equal(none.fearGreed, null)
  assert.equal(none.derivatives, null)
  assert.deepEqual(none.notes, [])
})

test('haftalık mumlar pazartesi 00:00 UTC\'ye hizalanır (Binance ile aynı)', async () => {
  const { bucketStart } = await import('../src/market/depth.js')
  const W = 604800
  // 2026-10-14 çarşamba 15:30 UTC → 2026-10-12 pazartesi 00:00
  const t = Date.UTC(2026, 9, 14, 15, 30) / 1000
  assert.equal(bucketStart(t, W), Date.UTC(2026, 9, 12) / 1000)
  assert.equal(new Date(bucketStart(t, W) * 1000).getUTCDay(), 1)
  // pazartesi tam 00:00 kendi haftasıdır
  assert.equal(bucketStart(Date.UTC(2026, 9, 12) / 1000, W), Date.UTC(2026, 9, 12) / 1000)
  // diğer aralıklar değişmedi
  assert.equal(bucketStart(t, 3600), Math.floor(t / 3600) * 3600)
})

test('çok küçük (toz) bakiyede günlük yüzde anlamsız büyümez', async () => {
  const { dayPct, MIN_PCT_BASE_USD } = await import('../src/trading/portfolio.js')
  // gerçek vaka: gün başı 0,00000713 $ → 0,00100713 $ = %14.025 görünüyordu
  assert.equal(dayPct(0.00100713, 0.00000713), 0)
  assert.equal(dayPct(0.0009, 0.001), 0) // zarar limiti de tetiklenmez
  assert.equal(MIN_PCT_BASE_USD, 10)
  assert.ok(Math.abs(dayPct(90, 100) - -10) < 1e-9)
  assert.equal(dayPct(10, 0), 0)
})
