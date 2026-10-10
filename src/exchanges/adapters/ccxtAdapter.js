// ccxt tabanlı kripto borsa adaptörü (Binance, Bybit, OKX, Kraken, BtcTurk…)
import ccxt from 'ccxt'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------- istemci önbelleği
// Her çağrıda yeni istemci + loadMarkets (Binance'te ağır "exchangeInfo") hem yavaştı hem de
// borsanın IP başına istek kotasını tüketiyordu. İstemciler anahtar başına, piyasa listesi
// borsa başına önbellekte tutulur.
const CLIENT_TTL = 30 * 60_000
const MARKETS_TTL = 6 * 60 * 60_000
const clients = new Map() // key → { ex, at }
const marketsCache = new Map() // providerId:testnet → { markets, at, promise }

function client(provider, creds = {}, testnet = false) {
  const Cls = ccxt[provider.ccxtId]
  if (!Cls) throw new Error(`ccxt desteği yok: ${provider.ccxtId}`)
  const key = createHash('sha256').update(`${provider.id}|${testnet ? 1 : 0}|${creds.apiKey}|${creds.apiSecret}|${creds.passphrase ?? ''}`).digest('hex')
  const hit = clients.get(key)
  if (hit && Date.now() - hit.at < CLIENT_TTL) return hit.ex
  const ex = new Cls({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.passphrase,
    enableRateLimit: true,
    timeout: 15000,
    options: { adjustForTimeDifference: true, recvWindow: 10000 },
  })
  if (provider.ccxtId === 'binance') {
    // sadece spot: vadeli/opsiyon piyasalarını yüklemek gereksiz istek demek
    ex.options.fetchMarkets = ['spot']
    ex.options.defaultType = 'spot'
  }
  if (testnet) {
    if (!ex.urls?.test) throw new Error(`${provider.name} için test ağı desteklenmiyor`)
    ex.setSandboxMode(true)
  }
  if (clients.size > 500) clients.delete(clients.keys().next().value)
  clients.set(key, { ex, at: Date.now() })
  return ex
}

async function ensureMarkets(provider, ex, testnet) {
  if (ex.markets && Object.keys(ex.markets).length) return
  const k = `${provider.id}:${testnet ? 1 : 0}`
  let c = marketsCache.get(k)
  if (!c || (Date.now() - c.at > MARKETS_TTL && !c.promise)) {
    c = { at: Date.now(), markets: null, promise: ex.loadMarkets().then((m) => m) }
    marketsCache.set(k, c)
    try {
      c.markets = await c.promise
    } catch (e) {
      marketsCache.delete(k)
      throw e
    } finally {
      c.promise = null
    }
    return
  }
  if (c.promise) await c.promise
  ex.setMarkets(c.markets)
}

export function humanizeCcxtError(e) {
  if (e instanceof ccxt.AuthenticationError) return 'API anahtarı geçersiz veya yetkisiz (AuthenticationError)'
  if (e instanceof ccxt.PermissionDenied) return 'API anahtarının bu işlem için izni yok'
  if (e instanceof ccxt.InsufficientFunds) return 'Borsada yetersiz bakiye'
  if (e instanceof ccxt.InvalidOrder) return `Borsa emri reddetti: ${e.message.slice(0, 160)}`
  if (e instanceof ccxt.RateLimitExceeded || e instanceof ccxt.DDoSProtection) return 'Borsa istek limiti aşıldı, biraz sonra tekrar deneyin'
  if (e instanceof ccxt.NetworkError) return 'Borsaya ulaşılamıyor (ağ hatası)'
  return e.message?.slice(0, 200) || 'Bilinmeyen borsa hatası'
}

const feesOf = (o) => (o?.fees?.length ? o.fees : o?.fee ? [o.fee] : [])

/** Emrin komisyonu yanıtta yoksa işlemlerinden (fills) topla */
async function feesWithFallback(ex, o, symbol) {
  const f = feesOf(o)
  if (f.length || !(o.filled > 0)) return f
  try {
    const trades = await ex.fetchOrderTrades(o.id, symbol)
    return trades.flatMap((t) => (t.fees?.length ? t.fees : t.fee ? [t.fee] : []))
  } catch {
    return [] // bilinmiyor → çağıran standart oranla tahmin eder
  }
}

const view = (o, fees) => ({
  externalId: o.id,
  status: o.status, // open | closed | canceled | expired | rejected
  filled: o.filled ?? 0,
  average: o.average ?? (o.filled && o.cost ? o.cost / o.filled : null) ?? o.price ?? null,
  fees,
})

export const ccxtAdapter = {
  async test(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    const t0 = Date.now()
    const bal = await ex.fetchBalance()
    const latencyMs = Date.now() - t0
    const permissions = ['read', 'spot']
    if (provider.features.futures) permissions.push('futures')
    const nonZero = Object.entries(bal.total || {}).filter(([, v]) => v > 0).length
    return { ok: true, latencyMs, permissions, info: `${nonZero} varlık bulundu` }
  },

  async fetchBalances(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    const bal = await ex.fetchBalance()
    return Object.entries(bal.free || {})
      .filter(([, v]) => v > 0)
      .map(([asset, free]) => ({ asset, free }))
  },

  /** Tek varlığın serbest bakiyesi (satıştan hemen önce) */
  async freeBalance(provider, creds, testnet, asset) {
    const ex = client(provider, creds, testnet)
    const bal = await ex.fetchBalance()
    return +(bal.free?.[asset] ?? 0)
  },

  /** Borsanın sembol kuralları: miktar adımı ve minimum tutarlar */
  async marketRules(provider, creds, testnet, symbol) {
    const ex = client(provider, creds, testnet)
    await ensureMarkets(provider, ex, testnet)
    const m = ex.market(symbol)
    return { minQty: m.limits?.amount?.min ?? null, minCost: m.limits?.cost?.min ?? null, precision: m.precision?.amount ?? null }
  },

  /**
   * Canlı emir: sadece market/limit borsaya gider; koşullu tipler platform motorunda tetiklenir.
   * clientOrderId: platformun ürettiği kimlik – yanıt alınamazsa emir bununla borsadan bulunur.
   */
  async createOrder(provider, creds, testnet, { symbol, side, type, qty, price, clientOrderId }) {
    const ex = client(provider, creds, testnet)
    await ensureMarkets(provider, ex, testnet)
    const m = ex.market(symbol)
    const amount = +ex.amountToPrecision(symbol, qty) // borsanın adımına AŞAĞI yuvarlar
    if (!(amount > 0)) throw new ccxt.InvalidOrder(`miktar borsanın en küçük adımının altında (${qty})`)
    const minQty = m.limits?.amount?.min
    if (minQty && amount < minQty) throw new ccxt.InvalidOrder(`en az ${minQty} ${m.base} olmalı`)
    const refPx = type === 'limit' ? price : price ?? null
    const minCost = m.limits?.cost?.min
    if (minCost && refPx && amount * refPx < minCost) throw new ccxt.InvalidOrder(`minimum emir tutarı ${minCost} ${m.quote}`)
    const px = type === 'limit' ? +ex.priceToPrecision(symbol, price) : undefined
    const o = await ex.createOrder(symbol, type, side, amount, px, clientOrderId ? { clientOrderId } : {})
    return view(o, await feesWithFallback(ex, o, symbol))
  },

  /** externalId: borsanın emir kimliği veya "cid:<clientOrderId>" (yanıt alınamamış emir) */
  async fetchOrder(provider, creds, testnet, externalId, symbol) {
    const ex = client(provider, creds, testnet)
    await ensureMarkets(provider, ex, testnet)
    const o = String(externalId).startsWith('cid:') ? await findByClientId(provider, ex, symbol, externalId.slice(4)) : await ex.fetchOrder(externalId, symbol)
    const done = o.status !== 'open'
    return view(o, done ? await feesWithFallback(ex, o, symbol) : feesOf(o))
  },

  async cancelOrder(provider, creds, testnet, externalId, symbol) {
    const ex = client(provider, creds, testnet)
    await ensureMarkets(provider, ex, testnet)
    const id = String(externalId).startsWith('cid:') ? (await findByClientId(provider, ex, symbol, externalId.slice(4))).id : externalId
    await ex.cancelOrder(id, symbol)
  },
}

/** Platformun verdiği müşteri emir kimliğiyle borsadaki emri bul (yoksa OrderNotFound) */
async function findByClientId(provider, ex, symbol, cid) {
  // Binance ve OKX doğrudan clientOrderId ile sorgulamayı destekler
  if (['binance', 'okx'].includes(provider.ccxtId)) {
    try {
      return await ex.fetchOrder(undefined, symbol, { clientOrderId: cid })
    } catch (e) {
      if (e instanceof ccxt.OrderNotFound || e instanceof ccxt.NetworkError) throw e
      // desteklenmiyorsa aşağıdaki listeleme yöntemine düş
    }
  }
  const since = Date.now() - 24 * 60 * 60_000
  const list = []
  if (ex.has.fetchOpenOrders) list.push(...(await ex.fetchOpenOrders(symbol)))
  if (ex.has.fetchClosedOrders) list.push(...(await ex.fetchClosedOrders(symbol, since)))
  else if (ex.has.fetchOrders) list.push(...(await ex.fetchOrders(symbol, since)))
  const hit = list.find((o) => o.clientOrderId === cid)
  if (!hit) throw new ccxt.OrderNotFound(`clientOrderId ${cid} borsada bulunamadı`)
  return hit
}
