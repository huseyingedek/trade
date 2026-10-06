// =====================================================================
//  Mum grafikleri, emir defteri ve son işlemler
//  Gerçek kaynak (ccxt) ulaşılabilirse oradan, değilse simülasyon.
// =====================================================================
import { feed } from './feed.js'
import { hub } from '../realtime/hub.js'
import { gauss, roundTo } from '../lib/num.js'
import { badRequest, notFound } from '../lib/errors.js'

export const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
const candleCache = new Map() // key → { bars, at, live }
const bookCache = new Map() // symbol → { book, at }
const tradeCache = new Map() // symbol → { list, at, lastId }

const instrumentOr404 = (symbol) => {
  const i = feed.instrument(symbol)
  if (!i) throw notFound(`Bilinmeyen sembol: ${symbol}`)
  return i
}
const liveSource = (i) => feed.usesExternal(i) && feed.ccxtOk

// ------------------------------------------------------------------ mumlar
function simHistory(i, sec, limit) {
  const sigma = Math.min(i.volatility * Math.sqrt(sec) * 0.12, 0.03)
  const now = Math.floor(Date.now() / 1000)
  const lastT = Math.floor(now / sec) * sec
  const closes = [feed.last(i.symbol)]
  for (let k = 1; k < limit; k++) closes.unshift(closes[0] / (1 + gauss() * sigma + sigma * 0.02))
  return closes.map((c, k) => {
    const o = k ? closes[k - 1] : c
    return {
      time: lastT - (limit - 1 - k) * sec,
      open: roundTo(o, i.tickSize),
      high: roundTo(Math.max(o, c) * (1 + Math.abs(gauss()) * sigma * 0.4), i.tickSize),
      low: roundTo(Math.min(o, c) * (1 - Math.abs(gauss()) * sigma * 0.4), i.tickSize),
      close: roundTo(c, i.tickSize),
      volume: Math.round((0.3 + Math.random()) * 1000) / 10,
    }
  })
}

export async function getCandles(symbol, interval = '1h', limit = 300) {
  const i = instrumentOr404(symbol)
  const sec = INTERVALS[interval]
  if (!sec) throw badRequest('Geçersiz periyot')
  limit = Math.min(Math.max(+limit || 300, 10), 1000)
  const key = `${symbol}:${interval}`
  const cached = candleCache.get(key)
  if (cached && Date.now() - cached.at < 30_000 && cached.bars.length >= Math.min(limit, 50)) return cached.bars.slice(-limit)

  let bars = null
  let live = false
  if (liveSource(i)) {
    try {
      const raw = await feed.ccxt.fetchOHLCV(i.sourceSymbol || i.symbol, interval, undefined, limit)
      bars = raw.map(([t, o, h, l, c, v]) => ({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: c, volume: v }))
      live = true
    } catch {
      bars = null
    }
  }
  if (!bars?.length) bars = cached && !cached.live ? cached.bars : simHistory(i, sec, limit)
  candleCache.set(key, { bars, at: Date.now(), live })
  return bars.slice(-limit)
}

/** Her saniye: önbellekteki mumların son çubuğunu güncel fiyatla ilerlet */
export function tickCandles() {
  const now = Math.floor(Date.now() / 1000)
  for (const [key, entry] of candleCache) {
    const idx = key.lastIndexOf(':')
    const symbol = key.slice(0, idx)
    const sec = INTERVALS[key.slice(idx + 1)]
    const price = feed.state.get(symbol)?.last
    if (!price) continue
    const bars = entry.bars
    const t = Math.floor(now / sec) * sec
    let bar = bars[bars.length - 1]
    if (bar.time === t) {
      bar.close = price
      bar.high = Math.max(bar.high, price)
      bar.low = Math.min(bar.low, price)
    } else if (t > bar.time) {
      bar = { time: t, open: bar.close, high: Math.max(bar.close, price), low: Math.min(bar.close, price), close: price, volume: 0 }
      bars.push(bar)
      if (bars.length > 1200) bars.shift()
    }
    const ch = `candles:${key}`
    if (hub.hasSubscribers(ch)) hub.broadcast(ch, { ...bar })
  }
}

// ------------------------------------------------------------------ emir defteri
function simBook(i, depth) {
  const last = feed.last(i.symbol)
  const step = Math.max(i.tickSize, roundTo(last * 0.00012, i.tickSize))
  const base = i.market === 'crypto' ? 25000 / last : i.market === 'bist' ? 50000 / last : 100000
  const lvl = (k, dir) => [roundTo(last + dir * step * (k + 0.5), i.tickSize), roundTo(base * (0.15 + Math.random() * (0.6 + k * 0.12)), i.qtyStep) || i.qtyStep]
  return { symbol: i.symbol, asks: Array.from({ length: depth }, (_, k) => lvl(k, 1)), bids: Array.from({ length: depth }, (_, k) => lvl(k, -1)), ts: Date.now(), source: 'sim' }
}

export async function getOrderBook(symbol, depth = 14) {
  const i = instrumentOr404(symbol)
  depth = Math.min(Math.max(+depth || 14, 5), 50)
  const c = bookCache.get(symbol)
  if (c && Date.now() - c.at < 1500) return c.book
  let book = null
  if (liveSource(i)) {
    try {
      const ob = await feed.ccxt.fetchOrderBook(i.sourceSymbol || i.symbol, depth)
      book = { symbol, asks: ob.asks.slice(0, depth).map(([p, q]) => [p, q]), bids: ob.bids.slice(0, depth).map(([p, q]) => [p, q]), ts: Date.now(), source: 'live' }
    } catch {
      book = null
    }
  }
  book ??= simBook(i, depth)
  bookCache.set(symbol, { book, at: Date.now() })
  return book
}

// ------------------------------------------------------------------ son işlemler
function simTrade(i, ts = Date.now()) {
  const last = feed.last(i.symbol)
  const base = i.market === 'crypto' ? 3000 / last : i.market === 'bist' ? 20000 / last : 50000
  return {
    id: `${ts}${Math.random().toString(36).slice(2, 6)}`,
    price: roundTo(last * (1 + gauss() * 0.0001), i.tickSize),
    qty: roundTo(base * Math.random() * 2, i.qtyStep) || i.qtyStep,
    side: Math.random() > 0.5 ? 'buy' : 'sell',
    ts,
  }
}

export async function getTrades(symbol) {
  const i = instrumentOr404(symbol)
  const c = tradeCache.get(symbol)
  if (c && Date.now() - c.at < 1500) return c.list
  let list = null
  if (liveSource(i)) {
    try {
      const raw = await feed.ccxt.fetchTrades(i.sourceSymbol || i.symbol, undefined, 40)
      list = raw.reverse().map((t) => ({ id: String(t.id), price: t.price, qty: t.amount, side: t.side, ts: t.timestamp }))
    } catch {
      list = null
    }
  }
  if (!list) {
    list = c?.list ? [simTrade(i), ...c.list].slice(0, 40) : Array.from({ length: 25 }, (_, k) => simTrade(i, Date.now() - k * 2500))
  }
  tradeCache.set(symbol, { list, at: Date.now() })
  return list
}

/** Abone olunan semboller için emir defteri ve işlemleri yayınla (her 2 sn) */
export async function pushDepth() {
  const channels = hub.activeChannels()
  const tasks = []
  for (const ch of channels) {
    if (ch.startsWith('orderbook:')) {
      const sym = ch.slice(10)
      tasks.push(getOrderBook(sym).then((b) => hub.broadcast(ch, b)).catch(() => {}))
    } else if (ch.startsWith('trades:')) {
      const sym = ch.slice(7)
      const prevIds = new Set((tradeCache.get(sym)?.list || []).map((t) => t.id))
      tasks.push(
        getTrades(sym)
          .then((list) => {
            const fresh = list.filter((t) => !prevIds.has(t.id))
            if (fresh.length) hub.broadcast(ch, fresh.slice(0, 20))
          })
          .catch(() => {}),
      )
    }
  }
  await Promise.all(tasks)
}

/** Abone olunan mum kanalları için önbelleği ısıt (REST çağrısı yapılmadan abone olunursa) */
export function warmCandleChannels() {
  for (const ch of hub.activeChannels()) {
    if (!ch.startsWith('candles:')) continue
    const key = ch.slice(8)
    if (candleCache.has(key)) continue
    const idx = key.lastIndexOf(':')
    const symbol = key.slice(0, idx)
    const interval = key.slice(idx + 1)
    if (feed.instrument(symbol) && INTERVALS[interval]) getCandles(symbol, interval).catch(() => {})
  }
}
