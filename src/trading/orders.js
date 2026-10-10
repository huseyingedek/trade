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
import { callAdapter, isOrderNotFound, isUncertainError } from '../exchanges/index.js'
import { decrypt } from '../lib/crypto.js'
import { getPlatform, getProviderSettings } from '../services/platform.js'
import { logActivity } from '../services/activity.js'
import { totalValueUsd } from './portfolio.js'
import { feeRate, liquidityOf, normalizeLiveFees } from './fees.js'
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
  if (!(qty > 0) || !Number.isFinite(qty)) throw badRequest(`Miktar en az ${ins.qtyStep} olmalı`)
  // sayısal alanlar: boş → null; sayı değilse / sonsuzsa / negatifse 400 (aksi halde veritabanı hatası 500 olur)
  const n = (v, label) => {
    if (v === null || v === undefined || v === '') return null
    const x = +v
    if (!Number.isFinite(x) || x < 0) throw badRequest(`${label} geçerli bir pozitif sayı olmalı`)
    return x
  }
  const price = n(body.price, 'Fiyat')
  const stopPrice = n(body.stopPrice, 'Stop fiyatı')
  const trailingPct = n(body.trailingPct, 'İz mesafesi')
  const takeProfit = n(body.takeProfit, 'Kâr-al')
  const stopLoss = n(body.stopLoss, 'Zarar-kes')

  // kaldıraç: sağlayıcı + hesap izni + plan
  const futuresOk = prov.features.futures && conn.permissions.includes('futures') && user.plan.futures
  let leverage = Math.round(n(body.leverage, 'Kaldıraç') || 1)
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

  const refPrice = price || stopPrice || last

  const pos = await prisma.position.findUnique({ where: { exchangeId_symbol: { exchangeId, symbol } } })
  const orderUsd = feed.toUsd(qty * refPrice, ins.quote)
  const reducing = !!pos && ((pos.side === 'long' && side === 'sell') || (pos.side === 'short' && side === 'buy'))
  const openingQty = reducing ? Math.max(0, roundTo(qty - num(pos.qty), ins.qtyStep)) : qty

  // SL/TP, emirden SONRA kalacak pozisyonun yönüyle tutarlı olmalı (uzun: SL < fiyat < TP)
  if (takeProfit !== null || stopLoss !== null) {
    const long = reducing && openingQty <= 0 ? pos.side === 'long' : side === 'buy'
    if (stopLoss !== null && !(stopLoss > 0 && (long ? stopLoss < refPrice : stopLoss > refPrice)))
      throw badRequest(long ? 'Zarar-kes fiyatı emir fiyatının altında olmalı' : 'Zarar-kes fiyatı emir fiyatının üstünde olmalı')
    if (takeProfit !== null && !(takeProfit > 0 && (long ? takeProfit > refPrice : takeProfit < refPrice)))
      throw badRequest(long ? 'Kâr-al fiyatı emir fiyatının üstünde olmalı' : 'Kâr-al fiyatı emir fiyatının altında olmalı')
  }

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
        // teminat + komisyon (komisyon kaldıraçlı işlemde de tüm tutar üzerinden alınır)
        const needQuote = marginQuote + openingQty * refPrice * feeRate(conn.provider, 'taker')
        if (feed.convert(needQuote, ins.quote, acct) > num(cash?.free ?? 0) - lockedAmt + 1e-9)
          throw unprocessable('Yetersiz bakiye', 'INSUFFICIENT_FUNDS')
      } else {
        // Canlı (spot) hesap: borsadan senkronlanan serbest bakiye (borsadaki açık emirler zaten düşülmüş)
        const need = openingQty * refPrice * (1 + feeRate(conn.provider, 'taker'))
        const minCost = prov.minOrderQuote
        if (minCost && openingQty * refPrice < minCost)
          throw badRequest(`Borsanın minimum emir tutarı yaklaşık ${minCost} ${ins.quote}. Bu emir ${roundTo(openingQty * refPrice, 0.01)} ${ins.quote}.`, 'MIN_NOTIONAL')
        const readFree = async () => num((await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId, asset: ins.quote } } }))?.free ?? 0)
        let free = await readFree()
        // kayıtlı bakiye eski olabilir (kullanıcı borsaya yeni para yatırmış olabilir) → borsadan tazele
        if (need > free + 1e-9) {
          await syncLiveBalances(conn).catch(() => {})
          free = await readFree()
        }
        if (need > free + 1e-9)
          throw unprocessable(`Yetersiz bakiye: borsa hesabınızda ${roundTo(free, 0.01)} ${ins.quote} var, bu emir için yaklaşık ${roundTo(need, 0.01)} ${ins.quote} gerekiyor`, 'INSUFFICIENT_FUNDS')
      }
      // 2) sonra pozisyon büyüklüğü limiti (bu emirden sonra pozisyonun toplam teminatı)
      // limit, emrin verildiği hesabın türüne göre: gerçek para emri sadece gerçek varlığa, sanal emir sanala oranlanır
      const total = await totalValueUsd(userId, conn.mode === 'live' ? 'live' : 'paper')
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
      takeProfit, stopLoss,
      source, ruleId, botId, refPrice: type === 'trailing_stop' ? last : null,
    },
    include: { exchange: true },
  })

  if (type === 'market') {
    order = await execute(order, last * (1 + (side === 'buy' ? 1 : -1) * 0.0002), { silent: true })
  } else if (type === 'limit' && conn.mode === 'live') {
    order = await sendLiveLimit(order)
  } else if (type === 'limit' && (side === 'buy' ? last <= price : last >= price)) {
    order = await execute(order, last, { silent: true, liquidity: 'taker' })
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

/**
 * Bekleyen emirlerin kilitlediği nakit (paper).
 * Pozisyon AÇAN kısım teminat kilitler: uzun pozisyonu kapatan satış (veya kısa pozisyonu kapatan alış)
 * kilit gerektirmez, pozisyonu aşan kısım ise yeni (ters) pozisyon açacağı için teminat ayırır.
 */
export async function lockedCash(conn) {
  const [open, positions] = await Promise.all([
    prisma.order.findMany({ where: { exchangeId: conn.id, status: 'open' } }),
    prisma.position.findMany({ where: { exchangeId: conn.id } }),
  ])
  const acct = ACCOUNT_CCY[conn.market]
  const posBySym = new Map(positions.map((p) => [p.symbol, p]))
  // sembol + yön bazında, pozisyonu kapatmaya ayrılabilecek miktar (sırayla tüketilir)
  const closable = new Map()
  let sum = 0
  for (const o of open) {
    const ins = feed.instrument(o.symbol)
    if (!ins) continue
    let qty = num(o.qty)
    const p = posBySym.get(o.symbol)
    if (p && ((p.side === 'long' && o.side === 'sell') || (p.side === 'short' && o.side === 'buy'))) {
      const k = `${o.symbol}:${o.side}`
      const left = closable.has(k) ? closable.get(k) : num(p.qty)
      const use = Math.min(left, qty)
      closable.set(k, left - use)
      qty -= use
    }
    if (!(qty > 0)) continue
    let px
    try {
      px = num(o.price) || num(o.stopPrice) || feed.last(o.symbol)
    } catch {
      continue
    }
    sum += feed.convert((qty * px) / (o.leverage || 1), ins.quote, acct)
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
export async function execute(order, px, { silent = false, liquidity } = {}) {
  const conn = order.exchange ?? (await prisma.exchangeAccount.findUnique({ where: { id: order.exchangeId } }))
  if (conn.mode === 'live') return executeLive(order, conn, px, silent)
  return applyFill(order, conn, px, silent, { liquidity: liquidity ?? liquidityOf(order) })
}

/** Borsaya gönderilen emrin platform kimliği (Kraken sınırı nedeniyle en fazla 18 karakter, harf+rakam) */
export const clientIdFor = (order) => `tp${order.id.slice(-16)}`

const reload = (order) => prisma.order.findUnique({ where: { id: order.id }, include: { exchange: true } })

/**
 * Borsaya emir gönderildi ama yanıt alınamadı (zaman aşımı, bağlantı kopması).
 * Emir "reddedildi" İŞARETLENMEZ: borsada gerçekleşmiş olabilir. Açık kalır ve
 * pollLiveOrders müşteri kimliğiyle (cid:…) borsadan durumunu doğrular.
 */
async function pendingReconcile(order, err, silent) {
  log.warn({ err: err.message, order: order.id }, 'canlı emir: borsa yanıtı alınamadı, durum doğrulanacak')
  await logActivity(order.userId, {
    level: 'warning', source: 'system', exchangeId: order.exchangeId, symbol: order.symbol, notify: !silent,
    message: `${order.symbol} ${SIDE_TR[order.side]} emri için borsadan yanıt alınamadı (${err.message}). Emrin durumu borsadan doğrulanıyor; tekrar emir vermeden önce bekleyin.`,
  })
  emitTrading(order.userId, 'orders')
  return reload(order)
}

/** Canlı piyasa emri (doğrudan veya tetiklenen stop / OCO / iz süren emir) */
async function executeLive(order, conn, px, silent) {
  const ins = feed.instrument(order.symbol)
  let creds, qty, closeAll
  try {
    creds = decrypt(conn.credentialsEnc)
    ;({ qty, closeAll } = await liveSellQty(order, conn, creds, ins))
  } catch (e) {
    return reject(order, e.message, silent)
  }
  // Kimlik ÖNCE kaydedilir: yanıt gelmezse emir bu kimlikle borsada aranır
  const cid = clientIdFor(order)
  await prisma.order.update({ where: { id: order.id }, data: { externalId: `cid:${cid}` } })
  let res
  try {
    res = await callAdapter(conn.provider, 'createOrder', creds, conn.testnet, { symbol: order.symbol, side: order.side, type: 'market', qty, price: px, clientOrderId: cid })
  } catch (e) {
    if (isUncertainError(e)) return pendingReconcile(order, e, silent)
    await prisma.order.update({ where: { id: order.id }, data: { externalId: null } }).catch(() => {})
    return reject(order, e.message, silent)
  }
  // Bundan sonraki hatalar emrin borsada VAR olduğunu değiştirmez → asla "reddedildi" denmez
  await prisma.order.update({ where: { id: order.id }, data: { externalId: res.externalId ?? `cid:${cid}` } }).catch((e) => log.error({ err: e, order: order.id }, 'borsa emir kimliği kaydedilemedi'))
  syncLiveBalances(conn).catch(() => {})
  if (!(res.filled > 0)) {
    if (['canceled', 'expired', 'rejected'].includes(res.status)) return reject(order, 'Borsada gerçekleşmedi (dolum yok)', silent)
    // Bazı borsalar (Bybit, OKX) piyasa emrine sadece kimlik döndürür: dolum pollLiveOrders ile işlenir
    emitTrading(order.userId, 'orders')
    return reload(order)
  }
  px = res.average || px
  let fees
  try {
    fees = res.fees?.length ? normalizeLiveFees(res.fees, { base: ins.base, quote: ins.quote, price: px }) : null
  } catch {
    fees = null
  }
  fees ??= { feeQuote: res.filled * px * feeRate(conn.provider, 'taker'), feeBase: 0 }
  return applyFill(order, conn, px, silent, { qty: res.filled, ...fees, closeAll: closeAll && res.filled >= qty * 0.999 })
}

/**
 * Canlı spot satış: borsadaki GERÇEK serbest bakiyeye göre miktar.
 * Borsa alışta komisyonu alınan coinden keser; kullanıcı borsada elle de işlem yapmış olabilir.
 * Pozisyonun tamamı satılıyorsa ve borsada biraz daha az coin varsa, olanın tamamı satılır
 * ve defterdeki pozisyon tamamen kapatılır (geriye "toz" kalmaz).
 */
async function liveSellQty(order, conn, creds, ins) {
  let qty = num(order.qty)
  if (order.side !== 'sell') return { qty, closeAll: false }
  const [free, pos] = await Promise.all([
    callAdapter(conn.provider, 'freeBalance', creds, conn.testnet, ins.base),
    prisma.position.findUnique({ where: { exchangeId_symbol: { exchangeId: conn.id, symbol: order.symbol } } }),
  ])
  const closeAll = !!pos && pos.side === 'long' && qty >= num(pos.qty) - 1e-12
  if (!(free > 0)) throw new Error(`Borsa hesabınızda satılabilir ${ins.base} yok`)
  if (free < qty) qty = free
  return { qty, closeAll }
}

/** Canlı limit emri borsada (kısmen) doldu → defteri güncelle (borsaya yeniden emir göndermeden) */
export async function applyLiveFill(order, r, note) {
  const conn = order.exchange ?? (await prisma.exchangeAccount.findUnique({ where: { id: order.exchangeId } }))
  const ins = feed.instrument(order.symbol)
  let px = r.average || num(order.price)
  if (!px) {
    try {
      px = feed.last(order.symbol)
    } catch {
      px = 0
    }
  }
  const fees = r.fees?.length
    ? normalizeLiveFees(r.fees, { base: ins.base, quote: ins.quote, price: px })
    : { feeQuote: r.filled * px * feeRate(conn.provider, 'maker'), feeBase: 0 }
  syncLiveBalances(conn).catch(() => {})
  return applyFill(order, conn, px, false, { qty: r.filled, ...fees, note })
}

async function sendLiveLimit(order) {
  const conn = order.exchange
  let creds, qty
  try {
    creds = decrypt(conn.credentialsEnc)
    ;({ qty } = await liveSellQty(order, conn, creds, feed.instrument(order.symbol)))
  } catch (e) {
    return reject(order, e.message, false)
  }
  const cid = clientIdFor(order)
  await prisma.order.update({ where: { id: order.id }, data: { externalId: `cid:${cid}` } })
  let res
  try {
    res = await callAdapter(conn.provider, 'createOrder', creds, conn.testnet, { symbol: order.symbol, side: order.side, type: 'limit', qty, price: num(order.price), clientOrderId: cid })
  } catch (e) {
    if (isUncertainError(e)) return pendingReconcile(order, e, false)
    await prisma.order.update({ where: { id: order.id }, data: { externalId: null } }).catch(() => {})
    return reject(order, e.message, false)
  }
  return prisma.order.update({ where: { id: order.id }, data: { externalId: res.externalId ?? `cid:${cid}` }, include: { exchange: true } })
}

export async function reject(order, reason, silent) {
  const o = await prisma.order.update({ where: { id: order.id }, data: { status: 'rejected', reason }, include: { exchange: true } })
  await logActivity(order.userId, { level: 'danger', source: order.source, exchangeId: order.exchangeId, symbol: order.symbol, notify: !silent, message: `${order.symbol} ${SIDE_TR[order.side]} emri reddedildi: ${reason}` })
  emitTrading(order.userId, 'orders')
  return o
}

/** Pozisyon / bakiye defterini güncelle (tek transaction) */
async function applyFill(order, conn, px, silent, fill = {}) {
  const prov = providerById[conn.provider]
  const ins = feed.instrument(order.symbol)
  const acct = ACCOUNT_CCY[conn.market]
  px = roundTo(px, ins.tickSize)
  const dir = order.side === 'buy' ? 1 : -1
  const futuresOk = prov.features.futures && conn.permissions.includes('futures')
  const canShort = prov.features.short && (futuresOk || conn.market === 'forex')

  try {
    const result = await prisma.$transaction(async (tx) => {
      const live = conn.mode === 'live'
      // canlıda borsanın adımı/komisyon kesintisi bizim adımımızla uyuşmayabilir → yuvarlama yok
      const rq = (x) => (live ? +(+x).toFixed(12) : roundTo(x, ins.qtyStep))
      let qtyLeft = fill.qty != null ? +fill.qty : num(order.qty)
      let filledQty = qtyLeft
      let cashDeltaQuote = 0
      let realized = 0
      let pos = await tx.position.findUnique({ where: { exchangeId_symbol: { exchangeId: conn.id, symbol: order.symbol } } })

      // 1) ters yöndeki pozisyonu azalt / kapat
      if (pos && ((pos.side === 'long' && dir === -1) || (pos.side === 'short' && dir === 1))) {
        const pQty = num(pos.qty)
        // canlı satışta borsadaki bakiyenin tamamı satıldıysa defterdeki pozisyon da tamamen kapanır
        const closeQty = fill.closeAll ? pQty : Math.min(pQty, qtyLeft)
        const posDir = pos.side === 'long' ? 1 : -1
        const released = (num(pos.margin) * closeQty) / pQty
        // Zarar yatırılan teminatı aşamaz (bakiye eksiye düşmez – tasfiye mantığı)
        const pnl = Math.max((px - num(pos.entryPrice)) * closeQty * posDir, -released)
        cashDeltaQuote += released + pnl
        realized += pnl
        qtyLeft = fill.closeAll ? 0 : rq(qtyLeft - closeQty)
        const remain = rq(pQty - closeQty)
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
          filledQty = rq(filledQty - qtyLeft)
          qtyLeft = 0
        } else {
          const lev = order.leverage || 1
          // canlı alış: borsa komisyonu alınan coinden kestiyse pozisyon net miktarla açılır
          if (live && fill.feeBase > 0 && dir === 1) qtyLeft = rq(Math.max(0, qtyLeft - fill.feeBase))
          const margin = (qtyLeft * px) / lev
          if (conn.mode === 'paper') {
            const cash = await tx.balance.findUnique({ where: { exchangeId_asset: { exchangeId: conn.id, asset: acct } } })
            const estFee = filledQty * px * feeRate(conn.provider, fill.liquidity ?? 'taker')
            const available = num(cash?.free ?? 0) + feed.convert(cashDeltaQuote - estFee, ins.quote, acct)
            if (feed.convert(margin, ins.quote, acct) > available + 1e-9) throw new Error('Yetersiz bakiye')
          }
          if (pos) {
            const pQty = num(pos.qty)
            pos = await tx.position.update({
              where: { id: pos.id },
              data: { entryPrice: (num(pos.entryPrice) * pQty + px * qtyLeft) / (pQty + qtyLeft), qty: rq(pQty + qtyLeft), margin: num(pos.margin) + margin },
            })
          } else {
            pos = await tx.position.create({
              data: { userId: order.userId, exchangeId: conn.id, symbol: order.symbol, side: dir === 1 ? 'long' : 'short', qty: qtyLeft, entryPrice: px, leverage: lev, margin },
            })
          }
          cashDeltaQuote -= margin
        }
      }
      // komisyon: canlıda borsanın kestiği gerçek tutar, sanalda borsanın standart oranı (maker/taker)
      const fee = fill.feeQuote != null ? fill.feeQuote : filledQty * px * feeRate(conn.provider, fill.liquidity ?? 'taker')
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
        data: { status: 'filled', qty: filledQty, filledQty, avgPrice: px, fee, realizedPnl: realized || null, filledAt: new Date(), ...(fill.note ? { reason: fill.note } : {}) },
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
    if (conn.mode === 'live') {
      // Borsada GERÇEKLEŞMİŞ bir emir "reddedildi" olarak işaretlenmemeli
      log.error({ err: e, order: order.id }, 'canlı dolum deftere işlenemedi')
      const o = await prisma.order.update({ where: { id: order.id }, data: { status: 'filled', filledQty: fill.qty ?? order.qty, avgPrice: px, filledAt: new Date(), reason: 'Borsada gerçekleşti; platform defteri güncellenemedi – pozisyonu borsadan kontrol edin' }, include: { exchange: true } })
      await logActivity(order.userId, { level: 'danger', source: 'system', exchangeId: order.exchangeId, symbol: order.symbol, notify: true, message: `${order.symbol} emri borsada gerçekleşti ancak platformdaki pozisyon güncellenemedi. Lütfen borsadaki bakiyenizi kontrol edin.` })
      emitTrading(order.userId, 'orders', 'positions', 'balances')
      return o
    }
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
      const creds = decrypt(o.exchange.credentialsEnc)
      try {
        await callAdapter(o.exchange.provider, 'cancelOrder', creds, o.exchange.testnet, o.externalId, o.symbol)
      } catch (e) {
        // yanıtı alınamamış ve borsada hiç oluşmamış emir → sadece platformda iptal edilir
        if (!(o.externalId.startsWith('cid:') && isOrderNotFound(e))) throw unprocessable(`Borsada iptal edilemedi: ${e.message}`)
      }
      // iptalden önce kısmen dolduysa dolan kısım deftere işlenir
      const r = await callAdapter(o.exchange.provider, 'fetchOrder', creds, o.exchange.testnet, o.externalId, o.symbol).catch(() => null)
      if (r?.filled > 0) {
        const f = await applyLiveFill(o, r, 'Kısmen gerçekleşti, kalanı iptal edildi')
        return orderToApi(stripRel(f))
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
  if ((sl !== null && !(Number.isFinite(sl) && sl > 0)) || (tp !== null && !(Number.isFinite(tp) && tp > 0))) throw badRequest('Zarar-kes / kâr-al geçerli bir pozitif fiyat olmalı')
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
