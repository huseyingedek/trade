// =====================================================================
//  EMİR SERVİSİ
//  Doğrulama → risk/plan/platform kontrolleri → kayıt → yürütme
//  Yürütme: paper (sanal defter, gerçek fiyatlarla) veya live (ccxt ile borsa)
//  Koşullu emir tipleri (stop, stop-limit, iz süren, OCO) platform motorunda
//  izlenir ve tetiklenince yürütülür – hem paper hem live için aynı mantık.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { feed } from '../market/feed.js'
import { hub } from '../realtime/hub.js'
import { withLock } from '../lib/mutex.js'
import { roundTo } from '../lib/num.js'
import { num, toApi } from '../lib/serialize.js'
import { badRequest, conflict, forbidden, locked, notFound, unavailable, unprocessable } from '../lib/errors.js'
import { providerById, ACCOUNT_CCY } from '../exchanges/providers.js'
import { callAdapter } from '../exchanges/index.js'
import { decrypt } from '../lib/crypto.js'
import { getPlatform, getProviderSettings } from '../services/platform.js'
import { logActivity } from '../services/activity.js'
import { totalValueUsd } from './portfolio.js'
import { log } from '../lib/logger.js'

export const TYPE_TR = { market: 'piyasa', limit: 'limit', stop_market: 'stop-piyasa', stop_limit: 'stop-limit', trailing_stop: 'iz süren stop', oco: 'OCO' }
const SIDE_TR = { buy: 'alış', sell: 'satış' }
const fmt = (v) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : 8 }).format(v)

export const orderToApi = (o) => toApi(o)

export const emitTrading = (userId, ...channels) => channels.forEach((ch) => hub.toUser(userId, ch, null))

async function riskOf(userId) {
  return prisma.riskSettings.upsert({ where: { userId }, update: {}, create: { userId } })
}

/**
 * Emir gönder.
 * @param {object} user  req.user
 * @param {object} body  { exchangeId, symbol, side, type, qty, price?, stopPrice?, trailingPct?, leverage?, takeProfit?, stopLoss? }
 * @param {{source?: string, internal?: boolean, ruleId?: string, botId?: string, silent?: boolean}} opts
 *   internal: pozisyon kapatma / SL-TP gibi koruma işlemleri – durdurma kontrollerini atlar
 */
export function placeOrder(userId, body, opts = {}) {
  return withLock(`u:${userId}`, () => placeOrderUnlocked(userId, body, opts))
}

async function placeOrderUnlocked(userId, body, { source = 'manual', internal = false, ruleId = null, botId = null, silent = false } = {}) {
  const { exchangeId, symbol, side, type = 'market' } = body
  const conn = await prisma.exchangeAccount.findFirst({ where: { id: exchangeId, userId } })
  if (!conn) throw notFound('Borsa hesabı bulunamadı')
  const prov = providerById[conn.provider]
  const ins = feed.instrument(symbol)
  if (!ins) throw badRequest(`Bilinmeyen sembol: ${symbol}`)
  if (!['buy', 'sell'].includes(side)) throw badRequest('Geçersiz yön')
  if (!TYPE_TR[type]) throw badRequest('Desteklenmeyen emir tipi')

  const [user, platform, provSettings, risk] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, include: { plan: true } }),
    getPlatform(),
    getProviderSettings(),
    riskOf(userId),
  ])
  const last = feed.last(symbol)

  // ---- durdurma kontrolleri (koruma emirleri hariç)
  if (!internal) {
    if (platform.killSwitchActive) throw locked(`Platform genelinde işlemler durduruldu: ${platform.killReason}`, 'PLATFORM_HALT')
    if (platform.maintenanceActive) throw unavailable('Platform bakımda, emir girişi geçici olarak kapalı', 'MAINTENANCE')
    if (user.status === 'trading_halted') throw locked('Hesabınızda işlemler yönetici tarafından durduruldu', 'USER_HALT')
    if (risk.killSwitchActive) throw locked('Acil durdurma aktif: yeni emir girilemez', 'KILL_SWITCH')
    if (conn.paused) throw conflict(`${conn.label} hesabında işlemler duraklatıldı`, 'EXCHANGE_PAUSED')
    if (provSettings[prov.id]?.tradingHalted) throw locked(`${prov.name} üzerinde işlemler geçici olarak durduruldu`, 'PROVIDER_HALT')
    if (platform.blockedSymbols.includes(symbol)) throw forbidden(`${symbol} platformda işleme kapalı`, 'SYMBOL_BLOCKED')
  }
  if (conn.status !== 'connected') throw conflict(`${conn.label} bağlantısı aktif değil`, 'EXCHANGE_DOWN')
  if (conn.market !== ins.market && conn.provider !== 'custom_rest') throw badRequest(`${prov.name} bu piyasayı (${symbol}) desteklemiyor`)
  if (conn.mode === 'live' && !config.LIVE_TRADING_ENABLED) throw forbidden('Canlı işlem sunucuda kapalı (LIVE_TRADING_ENABLED=false)', 'LIVE_DISABLED')

  const qty = roundTo(+body.qty, ins.qtyStep)
  if (!(qty > 0)) throw badRequest(`Miktar en az ${ins.qtyStep} olmalı`)
  const n = (v) => (v === null || v === undefined || v === '' ? null : +v)
  const price = n(body.price)
  const stopPrice = n(body.stopPrice)
  const trailingPct = n(body.trailingPct)

  // kaldıraç: sağlayıcı + hesap izni + plan
  const futuresOk = prov.features.futures && conn.permissions.includes('futures') && user.plan.futures
  let leverage = Math.round(n(body.leverage) || 1)
  if (leverage > 1 && !futuresOk) throw forbidden(user.plan.futures ? 'Bu hesapta vadeli/kaldıraç izni yok' : `${user.plan.name} planında vadeli/kaldıraçlı işlem yok`, 'PLAN_LIMIT')
  if (leverage > platform.maxLeverage) throw unprocessable(`Maksimum kaldıraç ${platform.maxLeverage}x`, 'LEVERAGE_LIMIT')
  leverage = Math.max(1, leverage)
  const canShort = prov.features.short && (futuresOk || conn.market === 'forex')

  switch (type) {
    case 'limit':
      if (!(price > 0)) throw badRequest('Limit fiyatı gerekli')
      break
    case 'stop_market':
      if (!(stopPrice > 0)) throw badRequest('Stop fiyatı gerekli')
      if (side === 'sell' ? stopPrice >= last : stopPrice <= last) throw badRequest(side === 'sell' ? 'Satış stop fiyatı güncel fiyatın altında olmalı' : 'Alış stop fiyatı güncel fiyatın üstünde olmalı')
      break
    case 'stop_limit':
      if (!(price > 0 && stopPrice > 0)) throw badRequest('Stop ve limit fiyatları gerekli')
      break
    case 'trailing_stop':
      if (!prov.features.trailing) throw badRequest(`${prov.name} iz süren stop desteklemiyor`)
      if (!(trailingPct >= 0.1 && trailingPct <= 50)) throw badRequest('İz mesafesi %0,1 – %50 arasında olmalı')
      break
    case 'oco':
      if (!prov.features.oco) throw badRequest(`${prov.name} OCO emri desteklemiyor`)
      if (!(price > 0 && stopPrice > 0)) throw badRequest('OCO için kâr-al ve stop fiyatları gerekli')
      if (side === 'sell' && !(price > last && stopPrice < last)) throw badRequest('Satış OCO: kâr-al > güncel fiyat > stop olmalı')
      if (side === 'buy' && !(price < last && stopPrice > last)) throw badRequest('Alış OCO: limit < güncel fiyat < stop olmalı')
      break
    default:
      break
  }

  const pos = await prisma.position.findUnique({ where: { exchangeId_symbol: { exchangeId, symbol } } })
  const refPrice = price || stopPrice || last
  const orderUsd = feed.toUsd(qty * refPrice, ins.quote)
  const reducing = !!pos && ((pos.side === 'long' && side === 'sell') || (pos.side === 'short' && side === 'buy'))
  const openingQty = reducing ? Math.max(0, roundTo(qty - num(pos.qty), ins.qtyStep)) : qty

  // Canlı bağlantı yalnızca SPOT emir gönderir: kaldıraç ve açığa satış desteklenmez
  if (conn.mode === 'live') {
    if (leverage > 1) throw badRequest('Canlı hesaplarda şimdilik sadece kaldıraçsız (spot) işlem yapılabilir', 'LIVE_SPOT_ONLY')
    if (side === 'sell' && openingQty > 0) throw badRequest('Canlı hesaplarda açığa satış desteklenmiyor; sadece sahip olduğunuz miktarı satabilirsiniz', 'LIVE_SPOT_ONLY')
  }
  // Aynı yöndeki mevcut pozisyona farklı kaldıraçla eklenemez (teminat hesabı bozulur)
  if (pos && !reducing && pos.leverage !== leverage) throw badRequest(`Mevcut ${symbol} pozisyonunuz ${pos.leverage}x; ekleme aynı kaldıraçla yapılmalı`, 'LEVERAGE_MISMATCH')
  // Açığa satış yapılamayan hesaplarda bekleyen satış emirleri pozisyondan fazla olamaz
  if (side === 'sell' && !canShort && type !== 'market') {
    const pending = await prisma.order.aggregate({ where: { exchangeId, symbol, side: 'sell', status: 'open' }, _sum: { qty: true } })
    const avail = (pos?.side === 'long' ? num(pos.qty) : 0) - num(pending._sum.qty || 0)
    if (qty > avail + 1e-12) throw badRequest(`Satılabilir miktar ${Math.max(0, roundTo(avail, ins.qtyStep))} ${ins.base} (bekleyen satış emirleri düşüldü)`, 'INSUFFICIENT_POSITION')
  }

  if (!internal) {
    if (orderUsd > platform.maxOrderUsd) throw unprocessable(`Platform limiti: tek emir en fazla $${platform.maxOrderUsd.toLocaleString('tr-TR')}`, 'PLATFORM_LIMIT')
    const openCount = await prisma.order.count({ where: { userId, status: 'open' } })
    if (type !== 'market' && openCount >= risk.maxOpenOrders) throw unprocessable(`Açık emir limiti (${risk.maxOpenOrders}) doldu`, 'RISK_LIMIT')

    if (openingQty > 0) {
      if (side === 'sell' && !canShort) throw badRequest('Satılacak yeterli pozisyon yok (bu hesap açığa satışı desteklemiyor)')
      const marginQuote = (openingQty * refPrice) / leverage
      // 1) önce bakiye (kullanıcıya en anlaşılır hata)
      if (conn.mode === 'paper') {
        const acct = ACCOUNT_CCY[conn.market]
        const cash = await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId, asset: acct } } })
        const lockedAmt = await lockedCash(conn)
        if (feed.convert(marginQuote * (1 + config.TRADING_FEE_RATE), ins.quote, acct) > num(cash?.free ?? 0) - lockedAmt + 1e-9)
          throw unprocessable('Yetersiz bakiye', 'INSUFFICIENT_FUNDS')
      } else {
        // Canlı (spot) hesap: borsadan senkronlanan serbest bakiye (borsadaki açık emirler zaten düşülmüş)
        const need = openingQty * refPrice * (1 + config.TRADING_FEE_RATE)
        const minCost = LIVE_MIN_ORDER_QUOTE[conn.provider]
        if (minCost && openingQty * refPrice < minCost)
          throw badRequest(`Borsanın minimum emir tutarı yaklaşık ${minCost} ${ins.quote}. Bu emir ${roundTo(openingQty * refPrice, 0.01)} ${ins.quote}.`, 'MIN_NOTIONAL')
        const bal = await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId, asset: ins.quote } } })
        const free = num(bal?.free ?? 0)
        if (need > free + 1e-9)
          throw unprocessable(`Yetersiz bakiye: borsa hesabınızda ${roundTo(free, 0.01)} ${ins.quote} var, bu emir için yaklaşık ${roundTo(need, 0.01)} ${ins.quote} gerekiyor`, 'INSUFFICIENT_FUNDS')
      }
      // 2) sonra pozisyon büyüklüğü limiti (bu emirden sonra pozisyonun toplam teminatı)
      const total = await totalValueUsd(userId)
      const existingMargin = pos && !reducing ? num(pos.margin) : 0
      if (feed.toUsd(marginQuote + existingMargin, ins.quote) > (total * risk.maxPositionPct) / 100)
        throw unprocessable(`Risk limiti: bu pozisyon portföyünüzün %${risk.maxPositionPct} sınırını aşıyor`, 'RISK_LIMIT')
    }
    // olağandışı büyük emir → risk işareti
    if (orderUsd > platform.maxOrderUsd * 0.5 && !user.riskFlags.includes('Olağandışı büyük emir'))
      await prisma.user.update({ where: { id: userId }, data: { riskFlags: { push: 'Olağandışı büyük emir' } } })
  }

  let order = await prisma.order.create({
    data: {
      userId, exchangeId, symbol, side, type, qty, price, stopPrice, trailingPct, leverage,
      takeProfit: n(body.takeProfit), stopLoss: n(body.stopLoss),
      source, ruleId, botId, refPrice: type === 'trailing_stop' ? last : null,
    },
    include: { exchange: true },
  })

  if (type === 'market') {
    order = await execute(order, last * (1 + (side === 'buy' ? 1 : -1) * 0.0002), { silent: true })
  } else if (type === 'limit' && conn.mode === 'live') {
    order = await sendLiveLimit(order)
  } else if (type === 'limit' && (side === 'buy' ? last <= price : last >= price)) {
    order = await execute(order, last, { silent: true })
  } else if (!silent) {
    await logActivity(userId, {
      source,
      exchangeId, symbol, ruleId, botId,
      message: `${symbol} ${fmt(qty)} ${TYPE_TR[type]} ${SIDE_TR[side]} emri girildi${price ? ` @ ${fmt(price)}` : ''}${stopPrice ? ` (stop ${fmt(stopPrice)})` : ''}${trailingPct ? ` (%${trailingPct})` : ''}`,
    })
  }
  if (order.status === 'rejected') throw unprocessable(order.reason || 'Emir reddedildi', 'ORDER_REJECTED')
  emitTrading(userId, 'orders', 'balances')
  return orderToApi(stripRel(order))
}

const stripRel = ({ exchange, ...o }) => (void exchange, o)

/** Bekleyen alış emirlerinin kilitlediği nakit (paper) */
/** Canlı spot emirlerde borsaların yaklaşık minimum emir tutarı (quote para birimi cinsinden) */
const LIVE_MIN_ORDER_QUOTE = { binance: 5 }

export async function lockedCash(conn) {
  const open = await prisma.order.findMany({ where: { exchangeId: conn.id, status: 'open', side: 'buy' } })
  const acct = ACCOUNT_CCY[conn.market]
  let sum = 0
  for (const o of open) {
    const ins = feed.instrument(o.symbol)
    if (!ins) continue
    const px = num(o.price) || num(o.stopPrice) || feed.last(o.symbol)
    sum += feed.convert((num(o.qty) * px) / (o.leverage || 1), ins.quote, acct)
  }
  return sum
}

// =====================================================================
//  YÜRÜTME
// =====================================================================

/**
 * Emri px fiyatından gerçekleştirir.
 * paper: tamamen platform defterinde. live: önce borsaya piyasa emri, sonra defter.
 */
export async function execute(order, px, { silent = false } = {}) {
  const conn = order.exchange ?? (await prisma.exchangeAccount.findUnique({ where: { id: order.exchangeId } }))
  if (conn.mode === 'live') {
    try {
      const creds = decrypt(conn.credentialsEnc)
      const res = await callAdapter(conn.provider, 'createOrder', creds, conn.testnet, { symbol: order.symbol, side: order.side, type: 'market', qty: num(order.qty) })
      px = res.average || px
      await prisma.order.update({ where: { id: order.id }, data: { externalId: res.externalId } })
      syncLiveBalances(conn).catch(() => {})
    } catch (e) {
      return reject(order, e.message, silent)
    }
  }
  return applyFill(order, conn, px, silent)
}

async function sendLiveLimit(order) {
  const conn = order.exchange
  try {
    const creds = decrypt(conn.credentialsEnc)
    const res = await callAdapter(conn.provider, 'createOrder', creds, conn.testnet, { symbol: order.symbol, side: order.side, type: 'limit', qty: num(order.qty), price: num(order.price) })
    return prisma.order.update({ where: { id: order.id }, data: { externalId: res.externalId }, include: { exchange: true } })
  } catch (e) {
    return reject(order, e.message, false)
  }
}

export async function reject(order, reason, silent) {
  const o = await prisma.order.update({ where: { id: order.id }, data: { status: 'rejected', reason }, include: { exchange: true } })
  await logActivity(order.userId, { level: 'danger', source: order.source, exchangeId: order.exchangeId, symbol: order.symbol, notify: !silent, message: `${order.symbol} ${SIDE_TR[order.side]} emri reddedildi: ${reason}` })
  emitTrading(order.userId, 'orders')
  return o
}

/** Pozisyon / bakiye defterini güncelle (tek transaction) */
async function applyFill(order, conn, px, silent) {
  const prov = providerById[conn.provider]
  const ins = feed.instrument(order.symbol)
  const acct = ACCOUNT_CCY[conn.market]
  px = roundTo(px, ins.tickSize)
  const dir = order.side === 'buy' ? 1 : -1
  const futuresOk = prov.features.futures && conn.permissions.includes('futures')
  const canShort = prov.features.short && (futuresOk || conn.market === 'forex')

  try {
    const result = await prisma.$transaction(async (tx) => {
      let qtyLeft = num(order.qty)
      let filledQty = qtyLeft
      let cashDeltaQuote = 0
      let realized = 0
      let pos = await tx.position.findUnique({ where: { exchangeId_symbol: { exchangeId: conn.id, symbol: order.symbol } } })

      // 1) ters yöndeki pozisyonu azalt / kapat
      if (pos && ((pos.side === 'long' && dir === -1) || (pos.side === 'short' && dir === 1))) {
        const pQty = num(pos.qty)
        const closeQty = Math.min(pQty, qtyLeft)
        const posDir = pos.side === 'long' ? 1 : -1
        const released = (num(pos.margin) * closeQty) / pQty
        // Zarar yatırılan teminatı aşamaz (bakiye eksiye düşmez – tasfiye mantığı)
        const pnl = Math.max((px - num(pos.entryPrice)) * closeQty * posDir, -released)
        cashDeltaQuote += released + pnl
        realized += pnl
        qtyLeft = roundTo(qtyLeft - closeQty, ins.qtyStep)
        const remain = roundTo(pQty - closeQty, ins.qtyStep)
        if (remain <= 0) {
          await tx.position.delete({ where: { id: pos.id } })
          pos = null
        } else {
          pos = await tx.position.update({ where: { id: pos.id }, data: { qty: remain, margin: num(pos.margin) - released } })
        }
      }

      // 2) kalan miktarla pozisyon aç / büyüt
      if (qtyLeft > 0) {
        if (dir === -1 && !canShort) {
          if (realized === 0 && cashDeltaQuote === 0) throw new Error('Satılacak yeterli pozisyon yok')
          filledQty = roundTo(filledQty - qtyLeft, ins.qtyStep)
          qtyLeft = 0
        } else {
          const lev = order.leverage || 1
          const margin = (qtyLeft * px) / lev
          if (conn.mode === 'paper') {
            const cash = await tx.balance.findUnique({ where: { exchangeId_asset: { exchangeId: conn.id, asset: acct } } })
            const estFee = num(order.qty) * px * config.TRADING_FEE_RATE
            const available = num(cash?.free ?? 0) + feed.convert(cashDeltaQuote - estFee, ins.quote, acct)
            if (feed.convert(margin, ins.quote, acct) > available + 1e-9) throw new Error('Yetersiz bakiye')
          }
          if (pos) {
            const pQty = num(pos.qty)
            pos = await tx.position.update({
              where: { id: pos.id },
              data: { entryPrice: (num(pos.entryPrice) * pQty + px * qtyLeft) / (pQty + qtyLeft), qty: roundTo(pQty + qtyLeft, ins.qtyStep), margin: num(pos.margin) + margin },
            })
          } else {
            pos = await tx.position.create({
              data: { userId: order.userId, exchangeId: conn.id, symbol: order.symbol, side: dir === 1 ? 'long' : 'short', qty: qtyLeft, entryPrice: px, leverage: lev, margin },
            })
          }
          cashDeltaQuote -= margin
        }
      }
      // komisyon gerçekleşen miktar üzerinden
      const fee = filledQty * px * config.TRADING_FEE_RATE
      cashDeltaQuote -= fee

      // 3) nakit (paper modda; canlıda borsadan senkronize edilir)
      if (conn.mode === 'paper') {
        const delta = feed.convert(cashDeltaQuote, ins.quote, acct)
        await tx.balance.upsert({
          where: { exchangeId_asset: { exchangeId: conn.id, asset: acct } },
          update: { free: { increment: delta } },
          create: { exchangeId: conn.id, asset: acct, free: delta },
        })
      }
      if (pos && (order.takeProfit || order.stopLoss)) {
        pos = await tx.position.update({ where: { id: pos.id }, data: { takeProfit: order.takeProfit ?? pos.takeProfit, stopLoss: order.stopLoss ?? pos.stopLoss } })
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: 'filled', qty: filledQty, filledQty, avgPrice: px, fee, realizedPnl: realized || null, filledAt: new Date() },
        include: { exchange: true },
      })
      return { updated, realized, fee }
    })

    const { updated, realized } = result
    const pnlTxt = realized ? ` · K/Z ${realized > 0 ? '+' : ''}${fmt(realized)} ${ins.quote}` : ''
    await logActivity(order.userId, {
      level: order.source === 'manual' && order.type === 'market' ? 'info' : 'success',
      source: order.source,
      exchangeId: order.exchangeId, symbol: order.symbol, ruleId: order.ruleId, botId: order.botId,
      notify: !silent,
      message: `${order.symbol} ${fmt(num(updated.qty))} ${SIDE_TR[order.side]} gerçekleşti @ ${fmt(px)}${pnlTxt}`,
    })
    emitTrading(order.userId, 'orders', 'positions', 'balances')
    return updated
  } catch (e) {
    if (e.message === 'Yetersiz bakiye' || e.message === 'Satılacak yeterli pozisyon yok') return reject(order, e.message, silent)
    log.error({ err: e }, 'fill hatası')
    return reject(order, 'Emir işlenirken hata oluştu', silent)
  }
}

// =====================================================================
//  İPTAL / KAPATMA / KORUMA
// =====================================================================
export function cancelOrder(userId, id, source = 'manual') {
  return withLock(`u:${userId}`, async () => {
    const o = await prisma.order.findFirst({ where: { id, userId }, include: { exchange: true } })
    if (!o) throw notFound('Emir bulunamadı')
    if (o.status !== 'open') throw conflict('Sadece açık emirler iptal edilebilir')
    if (o.exchange.mode === 'live' && o.externalId) {
      try {
        await callAdapter(o.exchange.provider, 'cancelOrder', decrypt(o.exchange.credentialsEnc), o.exchange.testnet, o.externalId, o.symbol)
      } catch (e) {
        throw unprocessable(`Borsada iptal edilemedi: ${e.message}`)
      }
    }
    const u = await prisma.order.update({ where: { id }, data: { status: 'canceled', canceledAt: new Date() } })
    await logActivity(userId, { source, exchangeId: o.exchangeId, symbol: o.symbol, message: `${o.symbol} ${SIDE_TR[o.side]} emri iptal edildi` })
    emitTrading(userId, 'orders', 'balances')
    return orderToApi(u)
  })
}

export async function cancelAll(userId, { exchangeId, symbol } = {}, source = 'manual') {
  const list = await prisma.order.findMany({ where: { userId, status: 'open', ...(exchangeId ? { exchangeId } : {}), ...(symbol ? { symbol } : {}) }, select: { id: true } })
  let canceled = 0
  for (const o of list) {
    try {
      await cancelOrder(userId, o.id, source)
      canceled++
    } catch {
      /* tek tek hatalar toplu iptali durdurmaz */
    }
  }
  if (canceled) await logActivity(userId, { level: 'warning', source, message: `${canceled} açık emir toplu iptal edildi` })
  return { canceled }
}

export async function closePosition(userId, id, percent = 100, source = 'manual') {
  const pos = await prisma.position.findFirst({ where: { id, userId } })
  if (!pos) throw notFound('Pozisyon bulunamadı')
  const ins = feed.instrument(pos.symbol)
  const pct = Math.min(Math.max(+percent || 100, 1), 100)
  const qty = pct === 100 ? num(pos.qty) : roundTo((num(pos.qty) * pct) / 100, ins.qtyStep)
  if (!(qty > 0)) throw badRequest('Kapatılacak miktar çok küçük')
  return placeOrder(userId, { exchangeId: pos.exchangeId, symbol: pos.symbol, side: pos.side === 'long' ? 'sell' : 'buy', type: 'market', qty }, { internal: true, source })
}

export async function updatePosition(userId, id, { stopLoss, takeProfit }) {
  const pos = await prisma.position.findFirst({ where: { id, userId } })
  if (!pos) throw notFound('Pozisyon bulunamadı')
  const last = feed.last(pos.symbol)
  const v = (x) => (x === '' || x === undefined || x === null ? null : +x)
  const sl = v(stopLoss)
  const tp = v(takeProfit)
  const long = pos.side === 'long'
  if (sl !== null && (long ? sl >= last : sl <= last)) throw badRequest(long ? 'Zarar-kes fiyatı güncel fiyatın altında olmalı' : 'Zarar-kes fiyatı güncel fiyatın üstünde olmalı')
  if (tp !== null && (long ? tp <= last : tp >= last)) throw badRequest(long ? 'Kâr-al fiyatı güncel fiyatın üstünde olmalı' : 'Kâr-al fiyatı güncel fiyatın altında olmalı')
  const u = await prisma.position.update({ where: { id }, data: { stopLoss: sl, takeProfit: tp } })
  await logActivity(userId, { exchangeId: pos.exchangeId, symbol: pos.symbol, message: `${pos.symbol} pozisyonu güncellendi · SL ${sl ? fmt(sl) : '–'} · TP ${tp ? fmt(tp) : '–'}` })
  emitTrading(userId, 'positions')
  return toApi(u)
}

/** Canlı hesap bakiyelerini borsadan çek */
export async function syncLiveBalances(conn) {
  if (conn.mode !== 'live') return
  const rows = await callAdapter(conn.provider, 'fetchBalances', decrypt(conn.credentialsEnc), conn.testnet)
  await prisma.$transaction([
    prisma.balance.deleteMany({ where: { exchangeId: conn.id } }),
    prisma.balance.createMany({ data: rows.map((r) => ({ exchangeId: conn.id, asset: r.asset, free: r.free })) }),
    prisma.exchangeAccount.update({ where: { id: conn.id }, data: { lastSyncAt: new Date() } }),
  ])
  emitTrading(conn.userId, 'balances')
}
