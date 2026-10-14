// =====================================================================
//  BACKTEST MOTORU – "Bu ayarlarla geçmişte çalışsaydı ne olurdu?"
//  • Botların CANLIDAKİ karar kodu (automation/strategies.js) aynen çalıştırılır.
//  • Her mum için fiyat yolu: açılış → dip → tepe → kapanış (yükselen mumda)
//    ya da açılış → tepe → dip → kapanış (düşen mumda). Grid seviyeleri ve
//    stoplar mum içinde de yakalanır.
//  • Komisyon borsanın taker oranıyla, miktar borsanın adımına yuvarlanarak
//    hesaplanır. Sonuç: getiri, en büyük düşüş, işlem listesi, "al ve tut" ile kıyas.
//  • Emir göndermez, veritabanına yazmaz – tamamen yan etkisiz.
// =====================================================================
import { STEPS } from '../automation/strategies.js'
import { floorTo } from '../lib/num.js'
import { badRequest } from '../lib/errors.js'

/** Bot formuyla aynı kurallar (automation/bots.js → validate) */
export function normalizeBot({ strategy, investment, config: c = {} }) {
  if (!STEPS[strategy]) throw badRequest('Geçersiz strateji')
  const inv = +investment
  if (!(inv > 0 && inv <= 10_000_000)) throw badRequest('Yatırım tutarı gerekli')
  let config
  if (strategy === 'grid') {
    if (!(+c.lower > 0 && +c.upper > +c.lower)) throw badRequest('Grid: üst fiyat alt fiyattan büyük olmalı')
    if (!(+c.grids >= 2 && +c.grids <= 200)) throw badRequest('Grid sayısı 2–200 arasında olmalı')
    config = { lower: +c.lower, upper: +c.upper, grids: Math.round(+c.grids) }
  } else if (strategy === 'dca') {
    if (!(+c.amount > 0 && +c.intervalHours > 0)) throw badRequest('DCA: alım tutarı ve aralığı gerekli')
    if (+c.amount > inv) throw badRequest('Alım tutarı yatırım tutarından büyük olamaz')
    config = { amount: +c.amount, intervalHours: +c.intervalHours, takeProfitPct: +c.takeProfitPct || 0, maxOrders: Math.round(+c.maxOrders) || 10 }
  } else {
    if (!(+c.trailingPct > 0 && +c.trailingPct <= 50)) throw badRequest('İz mesafesi %0–50 arasında olmalı')
    const be = c.breakEvenPct === undefined || c.breakEvenPct === null || c.breakEvenPct === '' ? null : +c.breakEvenPct
    if (be !== null && !(be >= 0 && be <= 50)) throw badRequest('Başa baş koruması %0–50 arasında olmalı')
    config = { trailingPct: +c.trailingPct, takeProfitPct: +c.takeProfitPct || null, breakEvenPct: be || null }
  }
  return { strategy, investment: inv, config }
}

/** Fiyat yolunda en büyük adım: %0,1. Canlı bot fiyata 5 sn'de bir bakar; mumun sadece
 *  açılış/dip/tepe/kapanışına bakmak, alımı seviyeden değil mumun dibinden yapmış gibi
 *  gösterir ve sonucu olduğundan İYİ çıkarır. Ara noktalarla seviyeler yakınından yakalanır. */
const MAX_STEP = 0.001

/** Mum içi fiyat yolu (zaman ofsetleriyle): köşe noktaları arası küçük adımlara bölünür */
export function pathOf(k, ms) {
  const corners = k.c >= k.o
    ? [[k.o, 0], [k.l, ms * 0.25], [k.h, ms * 0.6], [k.c, ms - 1]]
    : [[k.o, 0], [k.h, ms * 0.25], [k.l, ms * 0.6], [k.c, ms - 1]]
  const out = [corners[0]]
  for (let i = 1; i < corners.length; i++) {
    const [p1, t1] = corners[i - 1]
    const [p2, t2] = corners[i]
    const n = Math.min(400, Math.max(1, Math.ceil(Math.abs(Math.log(p2 / p1)) / MAX_STEP)))
    for (let j = 1; j <= n; j++) out.push([p1 + ((p2 - p1) * j) / n, t1 + ((t2 - t1) * j) / n])
  }
  return out
}

/** Grafik için en fazla n nokta */
function downsample(arr, n) {
  if (arr.length <= n) return arr
  const step = arr.length / n
  const out = []
  for (let i = 0; i < n - 1; i++) out.push(arr[Math.floor(i * step)])
  out.push(arr[arr.length - 1])
  return out
}

/**
 * @param bot     normalizeBot() çıktısı
 * @param candles [{t,o,h,l,c}] zaman sıralı
 * @param opts    { feeRate, qtyStep, candleMs }
 */
export async function runBacktest(bot, candles, { feeRate = 0.001, qtyStep = 0, candleMs = 3_600_000 } = {}) {
  if (!candles?.length) throw badRequest('Test için fiyat verisi yok')
  const b = { ...bot } // strateji kodu b.config / b.investment / b.strategy okur
  const step = STEPS[b.strategy]
  const s = {}
  let cash = b.investment
  let pos = 0
  let basis = 0 // açık pozisyonun toplam maliyeti (komisyon dahil) – kazanan/kaybeden işlem için
  const trades = []
  let sells = 0
  let wins = 0
  let feesTotal = 0
  let now = candles[0].t
  const overdraft = b.investment * 0.01 // komisyon için küçük tolerans (canlıda hesapta zaten fazladan nakit olur)

  const trade = async (side, qty, price) => {
    qty = qtyStep ? floorTo(qty, qtyStep) : qty
    if (side === 'buy') {
      // bütçeyi aşacaksa miktarı sığdır
      const maxQty = (cash + overdraft) / (price * (1 + feeRate))
      if (qty > maxQty) qty = qtyStep ? floorTo(maxQty, qtyStep) : maxQty
      if (!(qty > 0)) return null
      const fee = qty * price * feeRate
      cash -= qty * price + fee
      pos += qty
      basis += qty * price + fee
      feesTotal += fee
      s.fees = (s.fees || 0) + fee
      trades.push({ t: now, side, qty, price, fee })
    } else {
      qty = Math.min(qty, pos)
      if (!(qty > 0)) return null
      const fee = qty * price * feeRate
      const avg = pos ? basis / pos : 0
      const pnl = qty * price - fee - avg * qty
      cash += qty * price - fee
      basis -= avg * qty
      pos -= qty
      if (pos < 1e-12) {
        pos = 0
        basis = 0
      }
      feesTotal += fee
      s.fees = (s.fees || 0) + fee
      sells++
      if (pnl > 0) wins++
      trades.push({ t: now, side, qty, price, fee, pnl })
    }
    return { qty, price }
  }

  const equity = []
  const firstPrice = candles[0].o
  const bhQty = (b.investment * (1 - feeRate)) / firstPrice
  let peak = b.investment
  let maxDd = 0
  let inPosCandles = 0
  let inRangeCandles = 0

  for (const k of candles) {
    for (const [price, off] of pathOf(k, candleMs)) {
      now = k.t + off
      if (b.strategy === 'trailing' && s.done) break
      const note = await step(b, s, price, { trade: (side, qty) => trade(side, qty, price), now })
      if (note && trades.length && trades[trades.length - 1].t === now) trades[trades.length - 1].note = note
    }
    const eq = cash + pos * k.c
    equity.push([k.t, eq, bhQty * k.c])
    if (eq > peak) peak = eq
    const dd = peak ? ((peak - eq) / peak) * 100 : 0
    if (dd > maxDd) maxDd = dd
    if (pos > 0) inPosCandles++
    if (b.strategy === 'grid' && k.c >= b.config.lower && k.c <= b.config.upper) inRangeCandles++
  }

  const last = candles[candles.length - 1]
  const finalEquity = cash + pos * last.c
  const bhFinal = bhQty * last.c
  return {
    strategy: b.strategy,
    investment: b.investment,
    from: candles[0].t,
    to: last.t + candleMs,
    firstPrice,
    lastPrice: last.c,
    finalEquity,
    pnl: finalEquity - b.investment,
    returnPct: ((finalEquity - b.investment) / b.investment) * 100,
    buyHoldPnl: bhFinal - b.investment,
    buyHoldReturnPct: ((bhFinal - b.investment) / b.investment) * 100,
    maxDrawdownPct: maxDd,
    trades: trades.length,
    buys: trades.length - sells,
    sells,
    winRatePct: sells ? (wins / sells) * 100 : null,
    feesTotal,
    exposurePct: (inPosCandles / candles.length) * 100,
    inRangePct: b.strategy === 'grid' ? (inRangeCandles / candles.length) * 100 : null,
    openQty: pos,
    openValue: pos * last.c,
    equity: downsample(equity, 400),
    tradeList: trades.slice(-300).reverse(),
  }
}
