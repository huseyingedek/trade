// =====================================================================
//  BOTLAR – DCA, Grid, Trend takip (iz süren stop)
//  Botlar gerçek emir servisini kullanır: paper hesapta sanal, live hesapta
//  borsada işlem yapar. Tüm kontroller (risk, plan, durdurma) geçerlidir.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { feed } from '../market/feed.js'
import { toApi, num } from '../lib/serialize.js'
import { badRequest, conflict, forbidden, locked, notFound, unprocessable } from '../lib/errors.js'
import { floorTo } from '../lib/num.js'
import { hub } from '../realtime/hub.js'
import { logActivity } from '../services/activity.js'
import { placeOrder } from '../trading/orders.js'
import { getPlatform } from '../services/platform.js'
import { ACCOUNT_CCY, providerById } from '../exchanges/providers.js'
import { log } from '../lib/logger.js'

const STATUS_TR = { running: 'başlatıldı', paused: 'duraklatıldı', stopped: 'durduruldu' }

export const botToApi = (b) => {
  const { state, userId, pausedByKillSwitch, updatedAt, ...rest } = b
  void state, void userId, void pausedByKillSwitch, void updatedAt
  return toApi(rest)
}

async function validate(userId, body) {
  if (!body.name?.trim()) throw badRequest('Bot adı gerekli')
  if (!['dca', 'grid', 'trailing'].includes(body.strategy)) throw badRequest('Geçersiz strateji')
  const conn = await prisma.exchangeAccount.findFirst({ where: { id: body.exchangeId, userId } })
  if (!conn) throw badRequest('Borsa hesabı bulunamadı')
  const ins = feed.instrument(body.symbol)
  if (!ins || ins.market !== conn.market) throw badRequest('Seçilen hesap bu sembolü desteklemiyor')
  const inv = +body.investment
  if (!(inv > 0)) throw badRequest('Yatırım tutarı gerekli')
  const c = body.config || {}
  let config
  if (body.strategy === 'grid') {
    if (!(+c.lower > 0 && +c.upper > +c.lower)) throw badRequest('Grid: üst fiyat alt fiyattan büyük olmalı')
    if (!(+c.grids >= 2 && +c.grids <= 200)) throw badRequest('Grid sayısı 2–200 arasında olmalı')
    config = { lower: +c.lower, upper: +c.upper, grids: Math.round(+c.grids) }
  } else if (body.strategy === 'dca') {
    if (!(+c.amount > 0 && +c.intervalHours > 0)) throw badRequest('DCA: alım tutarı ve aralığı gerekli')
    if (+c.amount > inv) throw badRequest('Alım tutarı yatırım tutarından büyük olamaz')
    config = { amount: +c.amount, intervalHours: +c.intervalHours, takeProfitPct: +c.takeProfitPct || 0, maxOrders: Math.round(+c.maxOrders) || 10 }
  } else {
    if (!(+c.trailingPct > 0 && +c.trailingPct <= 50)) throw badRequest('İz mesafesi %0–50 arasında olmalı')
    config = { trailingPct: +c.trailingPct, takeProfitPct: +c.takeProfitPct || null }
  }
  // Emir başına tutar borsanın en küçük miktar adımından küçükse bot hiç işlem yapamaz
  const perOrder = body.strategy === 'grid' ? inv / config.grids : body.strategy === 'dca' ? config.amount : inv
  let price = 0
  try {
    price = feed.last(ins.symbol)
  } catch {
    /* fiyat yoksa kontrol atlanır */
  }
  if (price && floorTo(perOrder / price, ins.qtyStep) <= 0) {
    const minAmt = Math.ceil(ins.qtyStep * price * 1.05 * 100) / 100
    const hint = body.strategy === 'grid' ? `Kademe başına tutar en az ~${minAmt} ${ins.quote} olmalı (şu an ${(perOrder).toFixed(2)}). Toplam tutarı en az ~${Math.ceil(minAmt * config.grids)} ${ins.quote} yapın veya kademe sayısını azaltın.` : `Emir başına tutar en az ~${minAmt} ${ins.quote} olmalı.`
    throw badRequest(`Tutar çok düşük: ${ins.symbol} için en küçük işlem miktarı ${ins.qtyStep} ${ins.base}. ${hint}`)
  }
  if (conn.mode === 'paper') {
    const bal = await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId: conn.id, asset: ACCOUNT_CCY[conn.market] } } })
    if (feed.convert(inv, ins.quote, ACCOUNT_CCY[conn.market]) > num(bal?.free ?? 0)) throw unprocessable('Bot için yetersiz bakiye', 'INSUFFICIENT_FUNDS')
  } else {
    // canlı: borsanın minimum emir tutarı ve borsadaki gerçek bakiye
    const minCost = providerById[conn.provider]?.minOrderQuote
    if (minCost && perOrder < minCost) throw badRequest(`Borsa emir başına en az ~${minCost} ${ins.quote} kabul ediyor; bu ayarla emir başına ${perOrder.toFixed(2)} ${ins.quote} düşüyor.${body.strategy === 'grid' ? ` Toplam tutarı en az ${Math.ceil(minCost * config.grids)} ${ins.quote} yapın veya kademe sayısını azaltın.` : ''}`, 'MIN_NOTIONAL')
    const bal = await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId: conn.id, asset: ins.quote } } })
    if (inv > num(bal?.free ?? 0) * 1.0001) throw unprocessable(`Bot için yetersiz bakiye: borsa hesabınızda ${num(bal?.free ?? 0).toFixed(2)} ${ins.quote} var`, 'INSUFFICIENT_FUNDS')
  }
  return { name: body.name.trim(), strategy: body.strategy, exchangeId: conn.id, symbol: ins.symbol, investment: inv, config }
}

export async function listBots(userId) {
  return (await prisma.bot.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })).map(botToApi)
}

export async function createBot(userId, body) {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { plan: true } })
  const used = await prisma.bot.count({ where: { userId } })
  if (u.plan.maxBots !== -1 && used >= u.plan.maxBots) throw forbidden(`${u.plan.name} planı en fazla ${u.plan.maxBots} bot oluşturmaya izin veriyor`, 'PLAN_LIMIT')
  const data = await validate(userId, body)
  let b = await prisma.bot.create({ data: { userId, ...data, pnlHistory: [0] } })
  await logActivity(userId, { message: `Yeni bot oluşturuldu: ${b.name}`, symbol: b.symbol, exchangeId: b.exchangeId, botId: b.id })
  if (body.autoStart) b = await setStatus(userId, b.id, 'running')
  hub.toUser(userId, 'bots')
  return botToApi(b)
}

export async function setStatus(userId, id, status) {
  const b = await prisma.bot.findFirst({ where: { id, userId }, include: { exchange: true } })
  if (!b) throw notFound('Bot bulunamadı')
  if (status === 'running') {
    const [platform, risk, user] = await Promise.all([getPlatform(), prisma.riskSettings.findUnique({ where: { userId } }), prisma.user.findUnique({ where: { id: userId } })])
    if (platform.killSwitchActive) throw locked('Platform genelinde işlemler durduruldu', 'PLATFORM_HALT')
    if (user.status !== 'active') throw locked('Hesabınızda işlemler durdurulmuş', 'USER_HALT')
    if (risk?.killSwitchActive) throw locked('Acil durdurma aktifken bot başlatılamaz', 'KILL_SWITCH')
    if (b.exchange.status !== 'connected' || b.exchange.paused) throw conflict(`${b.exchange.label} hesabı aktif değil`)
  }
  const data = { status, pausedByKillSwitch: false }
  if (status === 'running' && !b.startedAt) data.startedAt = new Date()
  if (status === 'stopped') data.state = { ...(b.state || {}), stoppedAt: Date.now() }
  const u = await prisma.bot.update({ where: { id }, data })
  await logActivity(userId, { level: status === 'running' ? 'success' : 'warning', source: 'bot', botId: id, symbol: b.symbol, exchangeId: b.exchangeId, message: `${b.name} ${STATUS_TR[status]}` })
  hub.toUser(userId, 'bots')
  return botToApi(u)
}

export async function deleteBot(userId, id) {
  const b = await prisma.bot.findFirst({ where: { id, userId } })
  if (!b) throw notFound('Bot bulunamadı')
  if (b.status === 'running') throw conflict('Çalışan bot silinemez, önce durdurun')
  await prisma.bot.delete({ where: { id } })
  hub.toUser(userId, 'bots')
  return { ok: true }
}

// ------------------------------------------------------------------ strateji motoru
/** Botun piyasa emri. Komisyon s.fees'e, işlem sayısı s.tradesThisStep'e eklenir. */
async function trade(b, s, side, qty) {
  const ins = feed.instrument(b.symbol)
  qty = floorTo(qty, ins.qtyStep)
  if (!(qty > 0)) return null
  const o = await placeOrder(b.userId, { exchangeId: b.exchangeId, symbol: b.symbol, side, type: 'market', qty }, { source: 'bot', botId: b.id, silent: true })
  s.fees = (s.fees || 0) + (o.fee || 0)
  s.tradesThisStep = (s.tradesThisStep || 0) + 1
  return { qty: o.filledQty || qty, price: o.avgPrice || feed.last(b.symbol) }
}

async function stepDca(b, s, price) {
  const c = b.config
  s.qty ??= 0
  s.cost ??= 0
  s.buys ??= 0
  s.realized ??= 0
  const avg = s.qty ? s.cost / s.qty : 0
  if (s.qty > 0 && c.takeProfitPct && price >= avg * (1 + c.takeProfitPct / 100)) {
    const f = await trade(b, s, 'sell', s.qty)
    if (f) {
      s.realized += f.qty * f.price - s.cost
      Object.assign(s, { qty: 0, cost: 0, buys: 0 })
      return `Kâr alındı: ${f.qty} @ ${f.price}`
    }
  }
  const due = !s.lastBuyAt || Date.now() - s.lastBuyAt >= c.intervalHours * 3_600_000
  if (due && s.buys < c.maxOrders && s.cost + c.amount <= num(b.investment) + 1e-9) {
    const f = await trade(b, s, 'buy', c.amount / price)
    if (f) {
      s.qty += f.qty
      s.cost += f.qty * f.price
      s.buys++
      s.lastBuyAt = Date.now()
      return `Alım: ${f.qty} @ ${f.price}`
    }
  }
  return null
}

async function stepGrid(b, s, price) {
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
      const f = await trade(b, s, 'buy', perGrid / price)
      if (f) {
        s.holdings[k] = { qty: f.qty, price: f.price }
        msg = `Grid alım (seviye ${k + 1}): ${f.qty} @ ${f.price}`
      }
    } else if (s.holdings[k] && prev < sellLevel && price >= sellLevel) {
      const h = s.holdings[k]
      const f = await trade(b, s, 'sell', h.qty)
      if (f) {
        s.realized += (f.price - h.price) * f.qty
        delete s.holdings[k]
        msg = `Grid satış (seviye ${k + 1}): ${f.qty} @ ${f.price}`
      }
    }
  }
  return msg
}

async function stepTrailing(b, s, price) {
  const c = b.config
  s.realized ??= 0
  if (!s.qty && !s.done) {
    const f = await trade(b, s, 'buy', num(b.investment) / price)
    if (f) Object.assign(s, { qty: f.qty, entry: f.price, peak: f.price })
    return f ? `Pozisyon açıldı: ${f.qty} @ ${f.price}` : null
  }
  if (!s.qty) return null
  s.peak = Math.max(s.peak, price)
  const hitTp = c.takeProfitPct && price >= s.entry * (1 + c.takeProfitPct / 100)
  if (price <= s.peak * (1 - c.trailingPct / 100) || hitTp) {
    const f = await trade(b, s, 'sell', s.qty)
    if (f) {
      s.realized += (f.price - s.entry) * f.qty
      Object.assign(s, { qty: 0, done: true })
      return `${hitTp ? 'Hedef kâr' : 'İz süren stop'} ile kapatıldı @ ${f.price}`
    }
  }
  return null
}

function unrealized(b, s, price) {
  if (b.strategy === 'dca') return (s.qty || 0) * price - (s.cost || 0)
  if (b.strategy === 'grid') return Object.values(s.holdings || {}).reduce((a, h) => a + (price - h.price) * h.qty, 0)
  return s.qty ? (price - s.entry) * s.qty : 0
}

let busy = false
export async function processBots() {
  if (busy) return
  busy = true
  try {
    const bots = await prisma.bot.findMany({ where: { status: 'running' } })
    for (const b of bots) {
      let price
      try {
        price = feed.last(b.symbol)
      } catch {
        continue
      }
      const s = { ...(b.state || {}), tradesThisStep: 0 }
      let msg = null
      let status = b.status
      try {
        if (b.strategy === 'dca') msg = await stepDca(b, s, price)
        else if (b.strategy === 'grid') msg = await stepGrid(b, s, price)
        else msg = await stepTrailing(b, s, price)
        s.failures = 0
        if (b.strategy === 'trailing' && s.done) status = 'stopped'
      } catch (e) {
        s.failures = (s.failures || 0) + 1
        if (s.failures === 1 || s.failures >= 3) {
          await logActivity(b.userId, { level: 'danger', source: 'bot', notify: s.failures >= 3, botId: b.id, symbol: b.symbol, message: `${b.name}: işlem yapılamadı – ${e.message}${s.failures >= 3 ? ' (bot duraklatıldı)' : ''}` })
        }
        if (s.failures >= 3) status = 'paused'
      }
      // K/Z = gerçekleşen + açık – ödenen komisyonlar
      const pnl = (s.realized || 0) + unrealized(b, s, price) - (s.fees || 0)
      const n = s.tradesThisStep || 0
      delete s.tradesThisStep
      const data = { state: s, pnl: Math.round(pnl * 100) / 100 }
      if (n) data.trades = { increment: n }
      if (msg) await logActivity(b.userId, { source: 'bot', botId: b.id, symbol: b.symbol, exchangeId: b.exchangeId, message: `${b.name}: ${msg}` })
      if (!s.lastHistAt || Date.now() - s.lastHistAt > 5 * 60_000) {
        s.lastHistAt = Date.now()
        data.pnlHistory = [...(b.pnlHistory || []), data.pnl].slice(-60)
      }
      // Kullanıcı bu sırada botu durdurduysa/duraklattıysa durumu ezme: sadece hâlâ "running" ise güncelle
      if (status !== b.status) data.status = status
      const r = await prisma.bot.updateMany({ where: { id: b.id, status: 'running' }, data })
      if (!r.count) {
        // bot bu adım sırasında durduruldu → sadece işlem durumunu (state, K/Z, sayaç) kaydet
        const { status: _ignored, ...rest } = data
        void _ignored
        await prisma.bot.update({ where: { id: b.id }, data: rest }).catch(() => {})
      }
      hub.toUser(b.userId, 'bots')
    }
  } catch (e) {
    log.error({ err: e }, 'bot motoru hatası')
  } finally {
    busy = false
  }
}
