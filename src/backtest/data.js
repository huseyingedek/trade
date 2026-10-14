// =====================================================================
//  GEÇMİŞ FİYAT VERİSİ (backtest için)
//  Binance'in herkese açık piyasa verisi adresinden (data-api.binance.vision)
//  mum (OHLC) verisi çekilir; API anahtarı gerekmez, IP ağırlık limitine
//  takılmamak için sonuçlar bellekte önbelleğe alınır.
//  MARKET_DATA=sim (yerel geliştirme / internet yok) iken gerçekçi bir
//  SİMÜLASYON serisi üretilir ve sonuçta açıkça belirtilir.
// =====================================================================
import { config } from '../config.js'
import { feed } from '../market/feed.js'
import { badRequest, unavailable } from '../lib/errors.js'
import { log } from '../lib/logger.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Test aralıkları → süre ve mum aralığı (daha kısa aralıkta daha ince mum = daha gerçekçi grid testi) */
export const RANGES = {
  '1W': { span: 7 * DAY, interval: '15m', ms: 15 * 60_000 },
  '1M': { span: 30 * DAY, interval: '1h', ms: HOUR },
  '3M': { span: 90 * DAY, interval: '1h', ms: HOUR },
  '6M': { span: 182 * DAY, interval: '1h', ms: HOUR },
  '1Y': { span: 365 * DAY, interval: '1h', ms: HOUR },
}

const BASES = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3']
const cache = new Map() // key → { at, candles }
const CACHE_TTL = 30 * 60_000
const CACHE_MAX = 60

/** Binance sembolü: "ETH/USDT" → "ETHUSDT" */
const binanceSymbol = (ins) => String(ins.sourceSymbol || ins.symbol).replace('/', '').toUpperCase()

async function fetchKlines(sym, interval, startTime, endTime) {
  let lastErr
  for (const base of BASES) {
    try {
      const out = []
      let from = startTime
      // en fazla 1000 mum/istek → sayfa sayfa
      for (let guard = 0; guard < 40 && from < endTime; guard++) {
        const url = `${base}/klines?symbol=${sym}&interval=${interval}&startTime=${from}&endTime=${endTime}&limit=1000`
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const rows = await res.json()
        if (!Array.isArray(rows) || !rows.length) break
        for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })
        const next = rows[rows.length - 1][0] + 1
        if (next <= from || rows.length < 1000) break
        from = next
      }
      return out
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('veri yok')
}

/** Basit tohumlu rastgele sayı üreteci (aynı sembol → aynı seri; testler tekrarlanabilir) */
function rng(seedStr) {
  let h = 2166136261
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Simülasyon serisi: rejim değiştiren (yükseliş / düşüş / yatay) rastgele yürüyüş.
 * Son kapanış güncel fiyata eşitlenir. SADECE internet erişimi olmayan geliştirme ortamı içindir.
 */
export function syntheticCandles(symbol, endPrice, startTime, endTime, stepMs) {
  const rand = rng(`${symbol}|${stepMs}`)
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  const n = Math.max(2, Math.floor((endTime - startTime) / stepMs))
  const vol = 0.009 * Math.sqrt(stepMs / HOUR) // ~%0,9 saatlik oynaklık
  let drift = 0
  let regimeLeft = 0
  const closes = [0]
  for (let i = 1; i < n; i++) {
    if (regimeLeft-- <= 0) {
      drift = [0.0004, -0.0004, 0, 0][Math.floor(rand() * 4)] * (stepMs / HOUR)
      regimeLeft = Math.floor((24 * 5 + rand() * 24 * 20) * (HOUR / stepMs))
    }
    closes.push(closes[i - 1] + drift + vol * gauss())
  }
  const shift = Math.log(endPrice) - closes[n - 1]
  const out = []
  let prev = Math.exp(closes[0] + shift)
  for (let i = 0; i < n; i++) {
    const c = Math.exp(closes[i] + shift)
    const o = prev
    const wick = Math.abs(gauss()) * vol * 0.5
    const v = 1000 * (1 + Math.abs(gauss())) * (1 + Math.abs(c - o) / o / vol) // hareketli mumlarda daha yüksek hacim
    out.push({ t: startTime + i * stepMs, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, v })
    prev = c
  }
  return out
}

/**
 * Sembol + aralık için mumlar.
 * @returns {{ candles: {t,o,h,l,c}[], source: 'binance'|'sim', interval: string }}
 */
export async function getHistory(symbol, range) {
  const r = RANGES[range]
  if (!r) throw badRequest('Geçersiz test aralığı')
  const ins = feed.instrument(symbol)
  if (!ins) throw badRequest('Bilinmeyen sembol')
  const endTime = Math.floor(Date.now() / r.ms) * r.ms
  const startTime = endTime - r.span
  const simMode = config.MARKET_DATA === 'sim'
  if (ins.market !== 'crypto' && !simMode) throw badRequest('Geçmiş veri testi şimdilik yalnızca kripto paralar için kullanılabilir')

  const key = `${symbol}|${range}|${endTime}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  let data
  try {
    if (simMode || ins.dataSource === 'sim') throw new Error('simülasyon modu')
    const candles = await fetchKlines(binanceSymbol(ins), r.interval, startTime, endTime)
    if (candles.length < 20) throw new Error('yetersiz veri')
    data = { candles, source: 'binance', interval: r.interval }
  } catch (e) {
    if (!simMode) {
      log.warn(`backtest verisi alınamadı (${symbol}): ${e.message}`)
      throw unavailable('Geçmiş fiyat verisi şu an alınamadı, biraz sonra tekrar deneyin', 'HISTORY_UNAVAILABLE')
    }
    let last = 100
    try {
      last = feed.last(symbol)
    } catch {
      /* fiyat yok */
    }
    data = { candles: syntheticCandles(symbol, last, startTime, endTime, r.ms), source: 'sim', interval: r.interval }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), data })
  return data
}

// ------------------------------------------------------------------ analiz için son N mum
const INTERVAL_MS = { '15m': 15 * 60_000, '1h': HOUR, '4h': 4 * HOUR, '1d': DAY }
const recentCache = new Map()

/**
 * Son `limit` mum (analiz ekranı için). 4 saatlik veri 10 dk, günlük veri 30 dk önbellekte tutulur.
 * @returns {{ candles: {t,o,h,l,c,v}[], source: 'binance'|'sim' }}
 */
export async function getRecentCandles(symbol, interval, limit) {
  const ms = INTERVAL_MS[interval]
  if (!ms) throw badRequest('Geçersiz mum aralığı')
  const ins = feed.instrument(symbol)
  if (!ins) throw badRequest('Bilinmeyen sembol')
  const simMode = config.MARKET_DATA === 'sim'
  if (ins.market !== 'crypto' && !simMode) throw badRequest('Analiz şimdilik yalnızca kripto paralar için kullanılabilir')
  const key = `${symbol}|${interval}|${limit}`
  const ttl = ms >= DAY ? 30 * 60_000 : 10 * 60_000
  const hit = recentCache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.data
  const endTime = Date.now()
  const startTime = (Math.floor(endTime / ms) - limit + 1) * ms
  let data
  try {
    if (simMode || ins.dataSource === 'sim') throw new Error('simülasyon modu')
    const candles = await fetchKlines(binanceSymbol(ins), interval, startTime, endTime)
    if (candles.length < 30) throw new Error('yetersiz veri')
    data = { candles, source: 'binance' }
  } catch (e) {
    if (!simMode) {
      log.warn(`analiz verisi alınamadı (${symbol} ${interval}): ${e.message}`)
      throw unavailable('Fiyat geçmişi şu an alınamadı, biraz sonra tekrar deneyin', 'HISTORY_UNAVAILABLE')
    }
    let last = 100
    try {
      last = feed.last(symbol)
    } catch {
      /* fiyat yok */
    }
    data = { candles: syntheticCandles(symbol, last, startTime, startTime + limit * ms, ms), source: 'sim' }
  }
  if (recentCache.size >= 400) recentCache.delete(recentCache.keys().next().value)
  recentCache.set(key, { at: Date.now(), data })
  return data
}
