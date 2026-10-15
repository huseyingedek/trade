// ccxt tabanlı kripto borsa adaptörü (Binance, Bybit, OKX, Kraken, BtcTurk…)
import ccxt from 'ccxt'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------- istemci önbelleği
// Her çağrıda yeni istemci + loadMarkets (Binance'te ağır "exchangeInfo") hem yavaştı hem de
// borsanın IP başına istek kotasını tüketiyordu. İstemciler anahtar başına, piyasa listesi
// borsa başına önbellekte tutulur.
const CLIENT_TTL = 30 * 60_000
const MAX_CLIENTS = 100
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
  // BELLEK: anahtarlı istemcide loadMarkets, Binance'in tüm coin/ağ listesini (capital/config/getall,
  // megabaytlarca JSON) de indirir. Buna ihtiyacımız yok; 512 MB'lık sunucuda bellek taşmasına yol açıyordu.
  ex.options.fetchCurrencies = false
  // piyasa listesi daha önce yüklendiyse paylaşılan kopyayı kullan (her kullanıcı için ayrı indirme yok)
  const shared = marketsCache.get(`${provider.id}:${testnet ? 1 : 0}`)?.markets
  if (shared) ex.setMarkets(shared)
  if (provider.ccxtId === 'binance') {
    // sadece spot: vadeli/opsiyon piyasalarını yüklemek gereksiz istek demek
    ex.options.fetchMarkets = ['spot']
    ex.options.defaultType = 'spot'
  }
  if (testnet) {
    if (!ex.urls?.test) throw new Error(`${provider.name} için test ağı desteklenmiyor`)
    ex.setSandboxMode(true)
  }
  // her istemci ~0,5 MB bellek: süresi dolanları at, toplamı sınırla (en eskisi gider)
  for (const [k, v] of clients) if (Date.now() - v.at >= CLIENT_TTL) clients.delete(k)
  while (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value)
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

const isBinance = (provider) => provider.ccxtId === 'binance'

/**
 * Binance Spot bakiyeleri – doğrudan /api/v3/account (piyasa listesi YÜKLENMEZ).
 * ccxt fetchBalance önce loadMarkets çağırıyor; binlerce paritelik listeyi sadece bakiye için
 * belleğe açmak sunucuyu çökertiyordu.
 */
async function binanceSpot(ex) {
  const acc = await ex.privateGetAccount({ omitZeroBalances: true })
  const rows = (acc?.balances || []).map((b) => ({ asset: String(b.asset).toUpperCase(), free: +b.free || 0, used: +b.locked || 0 }))
  return { rows, canTrade: acc?.canTrade !== false }
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
    let nonZero
    if (isBinance(provider)) {
      const { rows } = await binanceSpot(ex)
      nonZero = rows.filter((r) => r.free + r.used > 0).length
    } else {
      const bal = await ex.fetchBalance()
      nonZero = Object.entries(bal.total || {}).filter(([, v]) => v > 0).length
    }
    const latencyMs = Date.now() - t0
    const permissions = ['read', 'spot']
    if (provider.features.futures) permissions.push('futures')
    return { ok: true, latencyMs, permissions, info: `${nonZero} varlık bulundu` }
  },

  async fetchBalances(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    if (isBinance(provider)) return (await binanceSpot(ex)).rows.filter((r) => r.free > 0 || r.used > 0)
    await ensureMarkets(provider, ex, testnet) // diğer borsalar: paylaşılan piyasa listesi
    const bal = await ex.fetchBalance()
    // free: serbest (işlemde kullanılabilir) · used: açık emirlerde kilitli
    const assets = new Set([...Object.keys(bal.free || {}), ...Object.keys(bal.used || {})])
    return [...assets]
      .map((asset) => ({ asset, free: +(bal.free?.[asset] ?? 0), used: +(bal.used?.[asset] ?? 0) }))
      .filter((r) => r.free > 0 || r.used > 0)
  },

  /**
   * Spot DIŞINDAKİ varlıklar (yalnızca görüntüleme / portföy değeri için):
   *  (Spot'ta emirlerde kilitli tutar fetchBalances'tan gelir – her senkronizasyonda güncellenir)
   *  • funding       – Binance Fonlama cüzdanı ("Kripto Satın Al", P2P, kartla alımlar çoğunlukla buraya düşer)
   *  • earn_flexible / earn_locked – Binance Simple Earn
   *  • futures       – Binance USDⓈ-M vadeli cüzdan bakiyesi
   * Her kaynak ayrı denenir; biri başarısız olursa diğerleri yine döner. Hata listesi `errors` içinde.
   */
  async fetchWallets(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    const rows = []
    const errors = []
    const add = (wallet, asset, amount) => {
      const n = +amount
      if (asset && n > 0) rows.push({ wallet, asset: String(asset).toUpperCase(), amount: n })
    }
    if (provider.ccxtId === 'binance' && !testnet) {
      try {
        // Fonlama cüzdanı – doğrudan uç nokta (piyasa listesi gerekmez)
        const f = await ex.sapiPostAssetGetFundingAsset({})
        for (const x of Array.isArray(f) ? f : []) add('funding', x.asset, (+x.free || 0) + (+x.locked || 0) + (+x.freeze || 0) + (+x.withdrawing || 0))
      } catch (e) {
        errors.push(`funding: ${humanizeCcxtError(e)}`)
      }
      // Simple Earn – sayfalı (en fazla 100'er), birkaç sayfa yeter
      const earn = async (method, wallet, field) => {
        for (let page = 1; page <= 5; page++) {
          const r = await ex[method]({ current: page, size: 100 })
          const list = r?.rows || []
          for (const x of list) add(wallet, x.asset, x[field])
          if (list.length < 100) break
        }
      }
      try {
        // USDⓈ-M vadeli cüzdan (teminat bakiyesi). Anahtarda vadeli izni yoksa hata → atlanır
        const fut = await ex.fapiPrivateV2GetBalance({})
        for (const x of Array.isArray(fut) ? fut : []) add('futures', x.asset, x.balance)
      } catch (e) {
        errors.push(`futures: ${humanizeCcxtError(e)}`)
      }
      try {
        await earn('sapiGetSimpleEarnFlexiblePosition', 'earn_flexible', 'totalAmount')
      } catch (e) {
        errors.push(`earn: ${humanizeCcxtError(e)}`)
      }
      try {
        await earn('sapiGetSimpleEarnLockedPosition', 'earn_locked', 'amount')
      } catch (e) {
        errors.push(`earn_locked: ${humanizeCcxtError(e)}`)
      }
    }
    // aynı cüzdan + varlık birden çok satırda gelebilir (ör. farklı Earn ürünleri) → topla
    const merged = new Map()
    for (const r of rows) {
      const k = `${r.wallet}|${r.asset}`
      merged.set(k, { ...r, amount: (merged.get(k)?.amount || 0) + r.amount })
    }
    return { rows: [...merged.values()], errors }
  },

  /** Tek varlığın serbest bakiyesi (satıştan hemen önce) */
  async freeBalance(provider, creds, testnet, asset) {
    const ex = client(provider, creds, testnet)
    if (isBinance(provider)) return (await binanceSpot(ex)).rows.find((r) => r.asset === String(asset).toUpperCase())?.free ?? 0
    await ensureMarkets(provider, ex, testnet)
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
