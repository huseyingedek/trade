// =====================================================================
//  BOT STRATEJİLERİ – DCA, Grid, Trend takip (iz süren stop)
//  Saf karar mantığı: emir göndermez, sadece ctx.trade() çağırır.
//  Aynı kod hem canlı/sanal botlarda (automation/bots.js) hem de geçmiş
//  veri testinde (backtest/engine.js) çalışır → test sonucu = bot davranışı.
//
//  ctx = {
//    trade(side, qty) → Promise<{ qty, price } | null>   // emri uygula (komisyon ctx tarafında)
//    now: number                                       // şimdiki zaman (ms) – testte mum zamanı
//  }
//  s = botun kalıcı durumu (state); fonksiyonlar s'yi yerinde günceller ve
//  gerçekleşen işlem için kısa bir açıklama (veya null) döndürür.
// =====================================================================
import { num } from '../lib/serialize.js'

export async function stepDca(b, s, price, ctx) {
  const c = b.config
  s.qty ??= 0
  s.cost ??= 0
  s.buys ??= 0
  s.realized ??= 0
  const avg = s.qty ? s.cost / s.qty : 0
  if (s.qty > 0 && c.takeProfitPct && price >= avg * (1 + c.takeProfitPct / 100)) {
    const f = await ctx.trade('sell', s.qty)
    if (f) {
      s.realized += f.qty * f.price - s.cost
      Object.assign(s, { qty: 0, cost: 0, buys: 0 })
      return `Kâr alındı: ${f.qty} @ ${f.price}`
    }
  }
  const due = !s.lastBuyAt || ctx.now - s.lastBuyAt >= c.intervalHours * 3_600_000
  if (due && s.buys < c.maxOrders && s.cost + c.amount <= num(b.investment) + 1e-9) {
    const f = await ctx.trade('buy', c.amount / price)
    if (f) {
      s.qty += f.qty
      s.cost += f.qty * f.price
      s.buys++
      s.lastBuyAt = ctx.now
      return `Alım: ${f.qty} @ ${f.price}`
    }
  }
  return null
}

export async function stepGrid(b, s, price, ctx) {
  const { lower, upper, grids } = b.config
  const step = (upper - lower) / grids
  s.holdings ??= {}
  s.realized ??= 0
  const prev = s.lastPrice ?? price
  s.lastPrice = price
  if (price < lower || price > upper) return null
  const perGrid = num(b.investment) / grids
  let msg = null
  for (let k = 0; k < grids; k++) {
    const buyLevel = lower + k * step
    const sellLevel = buyLevel + step
    if (!s.holdings[k] && prev > buyLevel && price <= buyLevel) {
      const f = await ctx.trade('buy', perGrid / price)
      if (f) {
        s.holdings[k] = { qty: f.qty, price: f.price }
        msg = `Grid alım (seviye ${k + 1}): ${f.qty} @ ${f.price}`
      }
    } else if (s.holdings[k] && prev < sellLevel && price >= sellLevel) {
      const h = s.holdings[k]
      const f = await ctx.trade('sell', h.qty)
      if (f) {
        s.realized += (f.price - h.price) * f.qty
        delete s.holdings[k]
        msg = `Grid satış (seviye ${k + 1}): ${f.qty} @ ${f.price}`
      }
    }
  }
  return msg
}

/** Başa baş korumasında stop'un alış fiyatının ne kadar üstüne çekileceği: alış + satış komisyonunu (~%0,2) karşılar */
export const BREAK_EVEN_BUFFER = 0.003

/**
 * İz süren stop seviyesi. Başa baş koruması (config.breakEvenPct) açıksa ve fiyat bir kez
 * alıştan o kadar yükseldiyse (s.beArmed), stop alış fiyatı + komisyonun altına inmez:
 * "kârdayken zararla satma" durumu önlenir.
 */
export function trailingStop(c, s) {
  if (!s.peak) return null
  const trail = s.peak * (1 - c.trailingPct / 100)
  return s.beArmed && s.entry ? Math.max(trail, s.entry * (1 + BREAK_EVEN_BUFFER)) : trail
}

export async function stepTrailing(b, s, price, ctx) {
  const c = b.config
  s.realized ??= 0
  if (!s.qty && !s.done) {
    const f = await ctx.trade('buy', num(b.investment) / price)
    if (f) Object.assign(s, { qty: f.qty, entry: f.price, peak: f.price })
    return f ? `Pozisyon açıldı: ${f.qty} @ ${f.price}` : null
  }
  if (!s.qty) return null
  s.peak = Math.max(s.peak, price)
  if (c.breakEvenPct && !s.beArmed && s.peak >= s.entry * (1 + c.breakEvenPct / 100)) s.beArmed = true
  const hitTp = c.takeProfitPct && price >= s.entry * (1 + c.takeProfitPct / 100)
  if (price <= trailingStop(c, s) || hitTp) {
    const f = await ctx.trade('sell', s.qty)
    if (f) {
      s.realized += (f.price - s.entry) * f.qty
      const why = hitTp ? 'Hedef kâr' : s.beArmed && trailingStop(c, s) > s.peak * (1 - c.trailingPct / 100) ? 'Başa baş koruması' : 'İz süren stop'
      Object.assign(s, { qty: 0, done: true })
      return `${why} ile kapatıldı @ ${f.price}`
    }
  }
  return null
}

export function unrealized(b, s, price) {
  if (b.strategy === 'dca') return (s.qty || 0) * price - (s.cost || 0)
  if (b.strategy === 'grid') return Object.values(s.holdings || {}).reduce((a, h) => a + (price - h.price) * h.qty, 0)
  return s.qty ? (price - s.entry) * s.qty : 0
}


export const STEPS = { dca: stepDca, grid: stepGrid, trailing: stepTrailing }
