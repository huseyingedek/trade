// =====================================================================
//  PİYASA VERİSİ AKIŞI
//  • Kripto: ccxt üzerinden gerçek fiyatlar (varsayılan Binance public API)
//  • Forex: ECB referans kurları (frankfurter.app) etrafında simülasyon
//  • BIST: ücretsiz gerçek zamanlı kaynak olmadığı için simülasyon
//  Kaynak ulaşılamazsa son gerçek fiyattan simülasyona otomatik geçilir.
//  Her ticker'da `source: 'live' | 'sim'` alanı bulunur.
// =====================================================================
import { EventEmitter } from 'node:events'
import ccxt from 'ccxt'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { hub } from '../realtime/hub.js'
import { gauss, roundTo } from '../lib/num.js'
import { log } from '../lib/logger.js'
import { health } from '../exchanges/health.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class MarketFeed extends EventEmitter {
  constructor() {
    super()
    this.instruments = new Map()
    this.state = new Map()
    this.ccxt = null
    this.ccxtOk = false
    this.running = false
    this.setMaxListeners(50)
  }

  async start() {
    this.running = true
    await this.reload()
    if (config.MARKET_DATA === 'auto') {
      const Cls = ccxt[config.MARKET_DATA_EXCHANGE]
      if (Cls) this.ccxt = new Cls({ enableRateLimit: true, timeout: 10000 })
      this.pollLoop()
    }
    if (config.FX_REFERENCE) this.fxLoop()
    this.timers = [setInterval(() => this.simTick(), 1000), setInterval(() => this.publish(), 1000)]
    log.info(`📈 Piyasa verisi başladı (${this.instruments.size} enstrüman, mod: ${config.MARKET_DATA})`)
  }

  stop() {
    this.running = false
    this.timers?.forEach(clearInterval)
  }

  /** Enstrümanları veritabanından yükle (admin eklerse yeniden çağrılır) */
  async reload() {
    const list = await prisma.instrument.findMany({ where: { active: true }, orderBy: [{ market: 'asc' }, { sortOrder: 'asc' }] })
    this.instruments = new Map(
      list.map((i) => [i.symbol, { ...i, tickSize: Number(i.tickSize), qtyStep: Number(i.qtyStep) }]),
    )
    for (const i of this.instruments.values()) {
      if (this.state.has(i.symbol)) continue
      const chg = gauss() * (i.market === 'crypto' ? 0.02 : i.market === 'bist' ? 0.012 : 0.003)
      const open = i.seedPrice / (1 + chg)
      this.state.set(i.symbol, {
        last: i.seedPrice, open, high: Math.max(open, i.seedPrice), low: Math.min(open, i.seedPrice),
        volume: (0.3 + Math.random()) * (i.market === 'crypto' ? 3e8 : 1.5e9), bid: i.seedPrice, ask: i.seedPrice,
        ts: Date.now(), source: 'sim', liveAt: 0, anchor: null,
      })
    }
  }

  instrument(symbol) {
    return this.instruments.get(symbol)
  }

  usesExternal(i) {
    return i.dataSource !== 'sim' && !!this.ccxt
  }

  // ------------------------------------------------------------- gerçek kaynak
  async pollLoop() {
    let backoff = 0
    while (this.running) {
      const live = [...this.instruments.values()].filter((i) => this.usesExternal(i))
      if (!live.length) {
        await sleep(5000)
        continue
      }
      const map = new Map(live.map((i) => [i.sourceSymbol || i.symbol, i.symbol]))
      const t0 = Date.now()
      try {
        const res = await this.ccxt.fetchTickers([...map.keys()])
        health.record(config.MARKET_DATA_EXCHANGE, Date.now() - t0, true)
        for (const [src, t] of Object.entries(res)) {
          const symbol = map.get(src)
          const s = symbol && this.state.get(symbol)
          if (!s || !t.last) continue
          const open = t.open ?? (t.percentage != null ? t.last / (1 + t.percentage / 100) : s.open)
          Object.assign(s, {
            last: t.last, open, high: t.high ?? Math.max(s.high, t.last), low: t.low ?? Math.min(s.low, t.last),
            volume: t.quoteVolume ?? (t.baseVolume ?? 0) * t.last, bid: t.bid ?? t.last, ask: t.ask ?? t.last,
            ts: Date.now(), source: 'live', liveAt: Date.now(),
          })
        }
        if (!this.ccxtOk) log.info(`✅ Gerçek kripto fiyatları alınıyor (${config.MARKET_DATA_EXCHANGE})`)
        this.ccxtOk = true
        backoff = 0
        await sleep(config.MARKET_POLL_MS)
      } catch (e) {
        health.record(config.MARKET_DATA_EXCHANGE, Date.now() - t0, false)
        if (this.ccxtOk || backoff === 0) log.warn(`⚠️  ${config.MARKET_DATA_EXCHANGE} fiyatları alınamadı (${e.constructor?.name}): simülasyona geçildi, tekrar denenecek`)
        this.ccxtOk = false
        backoff = Math.min(60_000, (backoff || 5000) * 2)
        await sleep(backoff)
      }
    }
  }

  /** ECB referans kurları – forex simülasyonunu gerçek seviyeye sabitler */
  async fxLoop() {
    while (this.running) {
      try {
        const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=TRY,EUR,GBP,JPY', { signal: AbortSignal.timeout(8000) })
        if (res.ok) {
          const { rates } = await res.json()
          const anchors = { 'USD/TRY': rates.TRY, 'EUR/USD': 1 / rates.EUR, 'GBP/USD': 1 / rates.GBP, 'USD/JPY': rates.JPY }
          for (const [sym, v] of Object.entries(anchors)) {
            const s = this.state.get(sym)
            if (!s || !v) continue
            if (!s.anchor) Object.assign(s, { last: v, open: v * (1 + gauss() * 0.002), high: v * 1.002, low: v * 0.998 })
            s.anchor = v
          }
          log.info('💱 Forex referans kurları güncellendi (ECB)')
        }
      } catch {
        /* ağ yoksa simülasyon devam eder */
      }
      await sleep(3_600_000)
    }
  }

  // ------------------------------------------------------------- simülasyon
  simTick() {
    const now = Date.now()
    for (const i of this.instruments.values()) {
      const s = this.state.get(i.symbol)
      if (s.source === 'live' && now - s.liveAt < 15_000) continue
      if (s.source === 'live') s.source = 'sim'
      const target = s.anchor ?? i.seedPrice
      const pull = s.anchor ? (target - s.last) / target / 300 : (target - s.last) / target / 5000
      s.last = roundTo(Math.max(i.tickSize, s.last * (1 + gauss() * i.volatility + pull)), i.tickSize)
      s.high = Math.max(s.high, s.last)
      s.low = Math.min(s.low, s.last)
      const spread = Math.max(i.tickSize, s.last * 0.0001)
      s.bid = roundTo(s.last - spread / 2, i.tickSize)
      s.ask = roundTo(s.last + spread / 2, i.tickSize)
      s.volume += Math.random() * s.volume * 0.00004
      s.ts = now
    }
  }

  publish() {
    this.emit('tick')
    hub.broadcast('tickers', this.list())
  }

  // ------------------------------------------------------------- erişim
  ticker(symbol) {
    const s = this.state.get(symbol)
    if (!s) return null
    return {
      symbol, last: s.last, open: s.open, high: s.high, low: s.low,
      change: s.last - s.open, changePct: ((s.last - s.open) / s.open) * 100,
      volume: s.volume, bid: s.bid, ask: s.ask, ts: s.ts, source: s.source,
    }
  }

  list(symbols) {
    const keys = symbols?.length ? symbols : [...this.instruments.keys()]
    return keys.filter((k) => this.state.has(k) && this.instruments.has(k)).map((k) => this.ticker(k))
  }

  last(symbol) {
    const s = this.state.get(symbol)
    if (!s) throw new Error(`Fiyat yok: ${symbol}`)
    return s.last
  }

  // ------------------------------------------------------------- kur çevirme
  toUsd(amount, ccy) {
    const p = (sym, fallback) => this.state.get(sym)?.last ?? fallback
    switch (ccy) {
      case 'TRY':
        return amount / p('USD/TRY', 42)
      case 'EUR':
        return amount * p('EUR/USD', 1.08)
      case 'GBP':
        return amount * p('GBP/USD', 1.27)
      case 'JPY':
        return amount / p('USD/JPY', 150)
      default:
        return amount
    }
  }

  convert(amount, from, to) {
    if (from === to || (['USD', 'USDT', 'USDC'].includes(from) && ['USD', 'USDT', 'USDC'].includes(to))) return amount
    const usd = this.toUsd(amount, from)
    const p = (sym, f) => this.state.get(sym)?.last ?? f
    switch (to) {
      case 'TRY':
        return usd * p('USD/TRY', 42)
      case 'EUR':
        return usd / p('EUR/USD', 1.08)
      case 'GBP':
        return usd / p('GBP/USD', 1.27)
      case 'JPY':
        return usd * p('USD/JPY', 150)
      default:
        return usd
    }
  }
}

export const feed = new MarketFeed()
