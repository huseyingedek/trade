// Analiz merkezi birim testleri (veritabanı / internet gerektirmez): npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x'
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123'
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

const { sma, ema, rsi, macd, atr, changePct, levels } = await import('../src/analysis/indicators.js')
const { scoreCandles, labelOf } = await import('../src/analysis/score.js')

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)
const candles = (closes, vol = 100) => closes.map((c, i) => ({ t: i, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * 1.002, l: Math.min(c, i ? closes[i - 1] : c) * 0.998, c, v: vol }))

test('SMA ve EMA bilinen değerleri verir', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  // EMA(3): k=0.5, ilk değer SMA(1,2,3)=2 → 4: 3, 5: 4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  const e = ema([10, 10, 10, 10, 10, 10], 3)
  near(e.at(-1), 10)
  assert.deepEqual(ema([1, 2], 3), [null, null])
})

test('RSI: sürekli yükselişte 100, sürekli düşüşte 0, eşit iniş-çıkışta 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i)
  const down = Array.from({ length: 30 }, (_, i) => 100 - i)
  const flat = Array.from({ length: 31 }, (_, i) => (i % 2 ? 101 : 100))
  near(rsi(up).at(-1), 100)
  near(rsi(down).at(-1), 0)
  assert.ok(Math.abs(rsi(flat).at(-1) - 50) < 5)
  assert.equal(rsi(up)[13], null)
})

test('MACD sabit fiyatta sıfır, yükselişte pozitif', () => {
  const flat = new Array(60).fill(50)
  near(macd(flat).hist.at(-1), 0)
  const up = Array.from({ length: 60 }, (_, i) => 50 * 1.01 ** i)
  assert.ok(macd(up).macd.at(-1) > 0)
})

test('ATR sabit aralıkta aralığa eşit', () => {
  const cs = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 102, l: 98, c: 100 }))
  near(atr(cs).at(-1), 4)
})

test('yüzde değişim ve destek/direnç seviyeleri', () => {
  near(changePct([100, 105, 110], 2), 10)
  // 100 civarında iki dip, 120 civarında iki tepe, fiyat 110
  const path = [110, 105, 100, 105, 110, 115, 120, 115, 110, 105, 100.5, 105, 110, 115, 119.5, 115, 110]
  const cs = path.map((c, i) => ({ t: i, o: c, h: c, l: c, c }))
  const { supports, resistances } = levels(cs, { wing: 2 })
  assert.equal(supports.length, 1)
  assert.ok(Math.abs(supports[0].price - 100.25) < 0.01 && supports[0].touches === 2)
  assert.ok(Math.abs(resistances[0].price - 119.75) < 0.01 && resistances[0].touches === 2)
})

test('puan etiketleri sınırları', () => {
  assert.equal(labelOf(50), 'strong_positive')
  assert.equal(labelOf(49), 'positive')
  assert.equal(labelOf(15), 'positive')
  assert.equal(labelOf(14), 'neutral')
  assert.equal(labelOf(-14), 'neutral')
  assert.equal(labelOf(-15), 'negative')
  assert.equal(labelOf(-50), 'strong_negative')
})

test('istikrarlı yükseliş olumlu, istikrarlı düşüş olumsuz puan alır', () => {
  // dalgalı ama net yükselen / düşen seriler (400 mum)
  const upC = Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i * (1 + 0.01 * Math.sin(i / 3)))
  const downC = Array.from({ length: 400 }, (_, i) => 100 * 0.997 ** i * (1 + 0.01 * Math.sin(i / 3)))
  const up = scoreCandles(candles(upC), 'long')
  const down = scoreCandles(candles(downC), 'long')
  assert.ok(up.score >= 15, `yükseliş puanı ${up.score}`)
  assert.ok(down.score <= -15, `düşüş puanı ${down.score}`)
  assert.ok(up.signals.find((s) => s.key === 'trend').impact > 0)
  assert.ok(down.signals.find((s) => s.key === 'trend').impact < 0)
  // puan −100…100 aralığında ve her sinyalin metni var
  for (const r of [up, down]) {
    assert.ok(r.score >= -100 && r.score <= 100)
    for (const s of r.signals) assert.ok(typeof s.text === 'string' && s.text.length > 5 && s.impact >= -1 && s.impact <= 1)
  }
})

test('yatay piyasa nötre yakın puan alır', () => {
  // dalganın tek bir anı (iniş/çıkış) kısa vadede olumlu/olumsuz görünebilir; dalga boyunca ortalama nötr olmalı
  const flatC = Array.from({ length: 440 }, (_, i) => 100 * (1 + 0.02 * Math.sin(i / 5)))
  const scores = []
  for (let end = 400; end < 440; end++) scores.push(scoreCandles(candles(flatC.slice(0, end)), 'short').score)
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  assert.ok(Math.abs(avg) < 15, `ortalama puan ${avg}`)
  // uzun vade (trend yok) tek noktada da nötre yakın
  assert.ok(Math.abs(scoreCandles(candles(flatC), 'long').score) < 40)
})

test('kısa geçmişte (200 mumdan az) uzun ortalama olmadan da çalışır', () => {
  const c = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5)
  const r = scoreCandles(candles(c), 'long')
  assert.ok(r.score > 0)
  assert.equal(r.emaSlow, null)
})

test('aynı veri → aynı sonuç (tekrarlanabilir)', () => {
  const c = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i * 0.05)
  assert.deepEqual(scoreCandles(candles(c), 'short'), scoreCandles(candles(c), 'short'))
})
