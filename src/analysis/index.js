// =====================================================================
//  ANALİZ MERKEZİ – teknik görünüm (kısa / uzun vade) + karne
//  • analyze(symbol): bir sembolün iki vadedeki puanı, sinyalleri, seviyeleri
//  • overview(): en likit kripto paraların özet tablosu
//  • recordSignals / evaluateSignals: günlük kayıt + 1/7/30 gün sonra sonuç
//  • trackRecord(): "olumlu dediğimizde ne oldu?" istatistiği
//  Bilgi amaçlıdır; herkese aynı analiz gösterilir, kişiye özel tavsiye verilmez.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { feed } from '../market/feed.js'
import { log } from '../lib/logger.js'
import { badRequest } from '../lib/errors.js'
import { DAY } from '../lib/time.js'
import { getRecentCandles } from '../backtest/data.js'
import { HORIZONS, scoreCandles } from './score.js'
import { ema } from './indicators.js'

const CACHE_TTL = 5 * 60_000
const cache = new Map() // symbol → { at, data }
export const WATCHLIST_SIZE = 20

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)

/** Bir sembolün analizi (5 dk önbellek) */
export async function analyze(symbol, { fresh = false } = {}) {
  const ins = feed.instrument(symbol)
  if (!ins) throw badRequest('Bilinmeyen sembol')
  const hit = cache.get(ins.symbol)
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  const [s, l] = await Promise.all([
    getRecentCandles(ins.symbol, HORIZONS.short.interval, HORIZONS.short.limit),
    getRecentCandles(ins.symbol, HORIZONS.long.interval, HORIZONS.long.limit),
  ])
  const tk = feed.ticker(ins.symbol)
  const price = tk?.last ?? l.candles.at(-1).c
  const short = scoreCandles(s.candles, 'short')
  const long = scoreCandles(l.candles, 'long')

  // Grafik: son 180 gün kapanış + 50/200 günlük ortalama
  const closes = l.candles.map((k) => k.c)
  const e50 = ema(closes, 50)
  const e200 = ema(closes, 200)
  const from = Math.max(0, closes.length - 180)
  const chart = l.candles.slice(from).map((k, i) => [k.t, k.c, e50[from + i], e200[from + i]])

  const data = {
    symbol: ins.symbol,
    name: ins.name,
    base: ins.base,
    quote: ins.quote,
    price,
    changePct24h: tk?.changePct ?? null,
    dataSource: s.source === 'sim' || l.source === 'sim' ? 'sim' : 'binance',
    updatedAt: Date.now(),
    short,
    long,
    chart,
  }
  if (cache.size > 300) cache.delete(cache.keys().next().value)
  cache.set(ins.symbol, { at: Date.now(), data })
  return data
}

/** İzlenen semboller: katalog sırasına göre en likit USDT kripto pariteleri */
export function watchlist(n = WATCHLIST_SIZE) {
  return [...feed.instruments.values()]
    .filter((i) => i.market === 'crypto' && i.quote === 'USDT' && i.active !== false)
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
    .slice(0, n)
    .map((i) => i.symbol)
}

let overviewCache = null
let overviewRunning = null

/** Özet tablo: izlenen semboller (10 dk önbellek; aynı anda tek hesaplama) */
export async function overview({ fresh = false } = {}) {
  if (!fresh && overviewCache && Date.now() - overviewCache.at < 10 * 60_000) return overviewCache.data
  if (overviewRunning) return overviewRunning
  overviewRunning = (async () => {
    const rows = []
    const syms = watchlist()
    // borsayı yormamak için 4'erli gruplar
    for (let i = 0; i < syms.length; i += 4) {
      const part = await Promise.all(
        syms.slice(i, i + 4).map((sym) =>
          analyze(sym, { fresh }).catch((e) => {
            log.warn(`analiz yapılamadı (${sym}): ${e.message}`)
            return null
          }),
        ),
      )
      for (const a of part) {
        if (!a) continue
        rows.push({
          symbol: a.symbol, name: a.name, price: a.price, changePct24h: a.changePct24h,
          short: { score: a.short.score, label: a.short.label },
          long: { score: a.long.score, label: a.long.label },
          volatilityPct: a.long.volatilityPct,
          dataSource: a.dataSource,
        })
      }
    }
    const data = { rows, updatedAt: Date.now() }
    if (rows.length) overviewCache = { at: Date.now(), data }
    return data
  })().finally(() => (overviewRunning = null))
  return overviewRunning
}

// ------------------------------------------------------------------ karne
/** Günlük kayıt: her izlenen sembol ve vade için günde bir görünüm (zaten varsa atlanır) */
export async function recordSignals() {
  const { rows } = await overview({ fresh: true })
  const day = utcDay()
  const data = []
  for (const r of rows) {
    if (r.dataSource === 'sim') continue // simülasyon verisi karneye girmez
    for (const h of ['short', 'long']) data.push({ symbol: r.symbol, horizon: h, day, score: r[h].score, label: r[h].label, price: r.price })
  }
  if (!data.length) return 0
  const res = await prisma.analysisSignal.createMany({ data, skipDuplicates: true })
  return res.count
}

/** Güncel gerçek fiyat; simülasyon fiyatı karneye yazılmaz */
function livePrice(symbol) {
  try {
    if (feed.ticker(symbol)?.source === 'sim') return null
    return feed.last(symbol)
  } catch {
    return null
  }
}

/** Vadesi gelen kayıtlara 1/7/30 gün sonraki fiyat değişimini yaz */
export async function evaluateSignals(now = Date.now(), priceOf = livePrice) {
  let n = 0
  for (const [field, days] of [['ret1d', 1], ['ret7d', 7], ['ret30d', 30]]) {
    const due = await prisma.analysisSignal.findMany({
      where: { [field]: null, createdAt: { lte: new Date(now - days * DAY) } },
      take: 500,
    })
    for (const s of due) {
      const price = priceOf(s.symbol)
      if (!(price > 0)) continue
      await prisma.analysisSignal.update({ where: { id: s.id }, data: { [field]: ((price - s.price) / s.price) * 100 } })
      n++
    }
  }
  return n
}

const LABELS = ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative']

/**
 * Karne: her etiket için kayıt sayısı, ortalama getiri ve isabet oranı.
 * İsabet: olumlu etiketlerde fiyatın yükselmesi, olumsuz etiketlerde düşmesi.
 */
export async function trackRecord({ horizon = 'short', days = 180, symbol } = {}) {
  if (!HORIZONS[horizon]) throw badRequest('Geçersiz vade')
  const rows = await prisma.analysisSignal.findMany({
    where: { horizon, createdAt: { gte: new Date(Date.now() - days * DAY) }, ...(symbol ? { symbol } : {}) },
    orderBy: { createdAt: 'desc' },
  })
  const stat = (list, field, dir) => {
    const ev = list.filter((r) => r[field] != null)
    if (!ev.length) return { n: 0, avg: null, hit: null }
    const avg = ev.reduce((a, r) => a + r[field], 0) / ev.length
    const hit = dir === 0 ? null : (ev.filter((r) => (dir > 0 ? r[field] > 0 : r[field] < 0)).length / ev.length) * 100
    return { n: ev.length, avg, hit }
  }
  const buckets = LABELS.map((label) => {
    const list = rows.filter((r) => r.label === label)
    const dir = label.includes('positive') ? 1 : label.includes('negative') ? -1 : 0
    return { label, count: list.length, d1: stat(list, 'ret1d', dir), d7: stat(list, 'ret7d', dir), d30: stat(list, 'ret30d', dir) }
  })
  return {
    horizon,
    days,
    total: rows.length,
    since: rows.at(-1)?.createdAt?.getTime() ?? null,
    buckets,
    recent: symbol ? rows.slice(0, 60).map((r) => ({ day: r.day, score: r.score, label: r.label, price: r.price, ret1d: r.ret1d, ret7d: r.ret7d, ret30d: r.ret30d })) : undefined,
  }
}
