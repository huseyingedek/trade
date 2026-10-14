// Backtest motoru birim testleri (veritabanı / internet gerektirmez): npm test
// Senaryolar elle hesaplanabilecek kadar basit tutuldu.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x'
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123'
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

const { runBacktest, normalizeBot } = await import('../src/backtest/engine.js')
const { syntheticCandles } = await import('../src/backtest/data.js')

const H = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
/** kapanış listesinden mum üret (o = önceki kapanış, fitil yok) */
const candlesFrom = (closes, start = closes[0]) => {
  let prev = start
  return closes.map((c, i) => {
    const k = { t: T0 + i * H, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c }
    prev = c
    return k
  })
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)

test('grid: aralıkta gidip gelen fiyatta her turda kâr eder, komisyon düşülür', async () => {
  // aralık 90–110, 10 kademe (adım 2). Fiyat 101 ↔ 99 arasında 10 kez gidip gelir.
  const closes = [101]
  for (let i = 0; i < 10; i++) closes.push(99, 101)
  const bot = normalizeBot({ strategy: 'grid', investment: 1000, config: { lower: 90, upper: 110, grids: 10 } })
  const r = await runBacktest(bot, candlesFrom(closes), { feeRate: 0.001, candleMs: H })
  // 100 seviyesi (k=5): 101→99 düşüşte 100'de değil, mum yolundaki 99'da alır; 101'e çıkınca 102'yi geçmez → satmaz.
  // Bu yüzden 98–102 arası salınım gerekir; burada sadece ilk alım olmalı ve satış olmamalı
  assert.equal(r.sells, 0)
  assert.equal(r.buys, 1)

  const closes2 = [103]
  for (let i = 0; i < 10; i++) closes2.push(99, 103)
  const r2 = await runBacktest(bot, candlesFrom(closes2), { feeRate: 0.001, candleMs: H })
  // her döngü: 100 ve 102 seviyesinde al (99'a inerken), 102 ve 104'te sat (103'e çıkarken: sadece 102 satılır)
  assert.ok(r2.sells >= 9, `satış sayısı ${r2.sells}`)
  assert.equal(r2.winRatePct, 100)
  assert.ok(r2.pnl > 0, 'kâr beklenir')
  // komisyon her işlemde alınır
  near(r2.feesTotal, r2.tradeList.reduce((a, t) => a + t.fee, 0))
  // son değer = nakit + açık pozisyon
  near(r2.finalEquity, r2.investment + r2.pnl)
})

test('grid: fiyat aralık dışındayken işlem yapmaz', async () => {
  const bot = normalizeBot({ strategy: 'grid', investment: 1000, config: { lower: 50, upper: 60, grids: 5 } })
  const r = await runBacktest(bot, candlesFrom([100, 95, 105, 98, 102]), { feeRate: 0.001, candleMs: H })
  assert.equal(r.trades, 0)
  assert.equal(r.inRangePct, 0)
  near(r.finalEquity, 1000)
})

test('trend takip: alır, zirveyi izler, %10 geri çekilmede satar ve durur', async () => {
  // 100'den 150'ye çık, sonra 120'ye düş. İz %10 → 150*0.9 = 135'te satmalı (mum yolunda 135'in altındaki ilk nokta)
  const closes = [100, 110, 130, 150, 140, 134, 120, 160]
  const bot = normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 10 } })
  const r = await runBacktest(bot, candlesFrom(closes, 100), { feeRate: 0.001, candleMs: H })
  assert.equal(r.buys, 1)
  assert.equal(r.sells, 1)
  const sell = r.tradeList.find((t) => t.side === 'sell')
  // canlı bot fiyatı sık izlediği için stop seviyesine (150 × 0,9 = 135) çok yakın satar – mumun dibinden değil
  assert.ok(Math.abs(sell.price - 135) / 135 < 0.002, `satış ${sell.price}`)
  // sonra 160'a çıksa da tekrar almaz (tek seferlik)
  assert.equal(r.openQty, 0)
  // K/Z: ~9,99 adet × (135 − 100) − komisyonlar ≈ %34,6
  assert.ok(r.returnPct > 34 && r.returnPct < 35, `getiri ${r.returnPct}`)
})

test('trend takip: hedef kâra ulaşınca satar', async () => {
  const bot = normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 20, takeProfitPct: 5 } })
  const r = await runBacktest(bot, candlesFrom([100, 103, 106, 110], 100), { feeRate: 0, candleMs: H })
  const sell = r.tradeList.find((t) => t.side === 'sell')
  // hedef: 100 × 1,05 = 105 → hemen o seviyede satar
  assert.ok(Math.abs(sell.price - 105) / 105 < 0.002, `satış ${sell.price}`)
  near(r.pnl, (1000 / 100) * (sell.price - 100), 1e-6)
})

test('DCA: saatte bir alır, alım sınırında durur, hedef kârda tümünü satar', async () => {
  // 6 saat düşüş (her saat alım hakkı), maks 3 alım; sonra %10 yükseliş → TP %5
  const closes = [100, 98, 96, 94, 92, 90, 89, 95, 99, 106] // alımlar 100, 100, 98 → ort. ~99,3 → TP %5 ≈ 104,3
  const bot = normalizeBot({ strategy: 'dca', investment: 1000, config: { amount: 100, intervalHours: 1, takeProfitPct: 5, maxOrders: 3 } })
  const r = await runBacktest(bot, candlesFrom(closes, 100), { feeRate: 0, candleMs: H })
  const chrono = [...r.tradeList].reverse()
  const sellAt = chrono.findIndex((t) => t.side === 'sell')
  assert.equal(sellAt, 3, 'satıştan önce tam 3 alım (maks alım sınırı)')
  assert.deepEqual(chrono.slice(0, 3).map((t) => t.price), [100, 100, 98])
  assert.equal(r.sells, 1)
  // kâr alındıktan sonra bot baştan başlar ve yeniden alım yapar (canlıdaki gibi)
  assert.equal(chrono[4]?.side, 'buy')
  assert.ok(r.pnl > 0)
  // satışa kadar en fazla 3 × 100 kullanıldı; kâr = 300'lük alımın %5+ yükselişi
  const spent = chrono.slice(0, 3).reduce((a, t) => a + t.qty * t.price, 0)
  assert.ok(spent <= 300 + 1e-9)
})

test('mum içi yol küçük adımlara bölünür (seviyeler mumun dibinden değil yakınından yakalanır)', async () => {
  const { pathOf } = await import('../src/backtest/engine.js')
  const p = pathOf({ t: 0, o: 100, h: 102, l: 95, c: 101 }, H)
  for (let i = 1; i < p.length; i++) assert.ok(Math.abs(p[i][0] / p[i - 1][0] - 1) <= 0.0011)
  assert.equal(p[0][0], 100)
  assert.equal(p[p.length - 1][0], 101)
  assert.ok(p.some((x) => x[0] === 95) && p.some((x) => x[0] === 102))
})

test('grid: fiyat bir kademeyi sert düşüşle geçse de alım kademe fiyatına yakın olur', async () => {
  const bot = normalizeBot({ strategy: 'grid', investment: 1000, config: { lower: 90, upper: 110, grids: 10 } })
  // tek mumda 101 → 92 düşüş: 100, 98, 96, 94, 92 seviyelerinde alım
  const r = await runBacktest(bot, candlesFrom([92], 101), { feeRate: 0, candleMs: H })
  const buys = r.tradeList.filter((t) => t.side === 'buy').map((t) => t.price).sort((a, b) => b - a)
  assert.deepEqual(buys.map((x) => Math.round(x)), [100, 98, 96, 94, 92])
  for (const [i, lvl] of [100, 98, 96, 94, 92].entries()) assert.ok(Math.abs(buys[i] - lvl) / lvl < 0.0011)
})

test('al-ve-tut karşılaştırması ve en büyük düşüş doğru hesaplanır', async () => {
  const bot = normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 50 } })
  const r = await runBacktest(bot, candlesFrom([100, 120, 60, 90], 100), { feeRate: 0, candleMs: H })
  near(r.buyHoldReturnPct, -10)
  // zirve 1200 → dip 600 = %50 düşüş (iz %50: tam sınırda satar)
  assert.ok(r.maxDrawdownPct >= 49.9 && r.maxDrawdownPct <= 50.1, `dd ${r.maxDrawdownPct}`)
})

test('miktar borsa adımına aşağı yuvarlanır, bütçe aşılmaz', async () => {
  const bot = normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 10 } })
  const r = await runBacktest(bot, candlesFrom([333, 333]), { feeRate: 0.001, qtyStep: 0.01, candleMs: H })
  const buy = r.tradeList[r.tradeList.length - 1]
  assert.equal(buy.qty, 3) // 1000/333 = 3.003 → 3.00
  assert.ok(buy.qty * buy.price + buy.fee <= 1000 * 1.01)
})

test('geçersiz ayarlar reddedilir', () => {
  assert.throws(() => normalizeBot({ strategy: 'grid', investment: 1000, config: { lower: 10, upper: 5, grids: 5 } }), /üst fiyat/)
  assert.throws(() => normalizeBot({ strategy: 'dca', investment: 100, config: { amount: 500, intervalHours: 1 } }), /büyük olamaz/)
  assert.throws(() => normalizeBot({ strategy: 'xyz', investment: 100 }), /Geçersiz strateji/)
  assert.throws(() => normalizeBot({ strategy: 'trailing', investment: 0, config: { trailingPct: 5 } }), /Yatırım/)
})

test('simülasyon serisi tekrarlanabilir ve son fiyat güncel fiyata eşit', () => {
  const a = syntheticCandles('ETH/USDT', 2500, T0, T0 + 30 * 24 * H, H)
  const b = syntheticCandles('ETH/USDT', 2500, T0, T0 + 30 * 24 * H, H)
  assert.deepEqual(a, b)
  near(a[a.length - 1].c, 2500, 1e-6)
  assert.equal(a.length, 30 * 24)
  for (const k of a) assert.ok(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c))
})

test('başa baş koruması: kâra geçen pozisyon zarara dönmeden kapanır (SOL senaryosu)', async () => {
  // Gerçek test senaryosu: alış 110,38 → zirve 113,39 (+%2,7) → 108,18. İz %3, komisyon %0,1
  const path = [110.38, 111.5, 112.6, 113.39, 112, 110.8, 109.5, 108.18]
  const plain = await runBacktest(normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 3, takeProfitPct: 6 } }), candlesFrom(path, 110.38), { feeRate: 0.001, candleMs: H })
  const be = await runBacktest(normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 3, takeProfitPct: 6, breakEvenPct: 1.5 } }), candlesFrom(path, 110.38), { feeRate: 0.001, candleMs: H })
  const sellPlain = plain.tradeList.find((t) => t.side === 'sell')
  const sellBe = be.tradeList.find((t) => t.side === 'sell')
  // korumasız: zirvenin %3 altında (≈109,99) – alış fiyatının ALTINDA → zarar
  assert.ok(Math.abs(sellPlain.price - 113.39 * 0.97) / 109.99 < 0.002, `korumasız satış ${sellPlain.price}`)
  assert.ok(plain.pnl < 0)
  // korumalı: alış + %0,3 (≈110,71) seviyesinde – komisyonlar dahil zarar yok
  assert.ok(Math.abs(sellBe.price - 110.38 * 1.003) / 110.71 < 0.002, `korumalı satış ${sellBe.price}`)
  assert.ok(be.pnl >= 0, `korumalı K/Z ${be.pnl}`)
  assert.match(sellBe.note || '', /Başa baş/)
})

test('başa baş koruması: fiyat eşiğe hiç ulaşmazsa normal iz süren stop gibi davranır', async () => {
  const path = [100, 101, 100.5, 97, 95]
  const a = await runBacktest(normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 3 } }), candlesFrom(path, 100), { feeRate: 0.001, candleMs: H })
  const b = await runBacktest(normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 3, breakEvenPct: 2 } }), candlesFrom(path, 100), { feeRate: 0.001, candleMs: H })
  assert.deepEqual(a.tradeList.map((t) => [t.side, t.price]), b.tradeList.map((t) => [t.side, t.price]))
  assert.throws(() => normalizeBot({ strategy: 'trailing', investment: 1000, config: { trailingPct: 3, breakEvenPct: 80 } }), /Başa baş/)
})
