// =====================================================================
//  ARKA PLAN İŞLERİ
//  Tek süreç (single instance) için tasarlandı. Birden fazla sunucu
//  çalıştırılacaksa bu işler tek bir "worker" sürecine taşınmalı ve
//  kilitler Redis gibi paylaşılan bir yapıya alınmalıdır.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { log } from '../lib/logger.js'
import { feed } from '../market/feed.js'
import { tickCandles, pushDepth, warmCandleChannels } from '../market/depth.js'
import { processOrders, processProtection, pollLiveOrders } from '../trading/engine.js'
import { syncLiveBalances } from '../trading/orders.js'
import { syncCryptoCatalog } from '../market/catalog.js'
import { checkDailyLoss } from '../trading/risk.js'
import { processRules } from '../automation/rules.js'
import { processBots } from '../automation/bots.js'
import { summary, totalValueUsd, ensureDayStart } from '../trading/portfolio.js'
import { health } from '../exchanges/health.js'
import { hub } from '../realtime/hub.js'
import { num } from '../lib/serialize.js'
import { DAY } from '../lib/time.js'

const timers = []
const every = (ms, name, fn) => {
  let running = false
  const t = setInterval(async () => {
    if (running) return
    running = true
    try {
      await fn()
    } catch (e) {
      log.error({ err: e }, `iş hatası: ${name}`)
    } finally {
      running = false
    }
  }, ms)
  timers.push(t)
}

/** Portföy özetini canlı izleyen kullanıcılara gönder */
async function pushPortfolio() {
  const users = new Set()
  for (const c of hub.clients) if (!c.isAdmin && c.channels.has('portfolio')) users.add(c.userId)
  for (const id of users) hub.toUser(id, 'portfolio', await summary(id))
}

/** Portföy anlık görüntüsü (grafik geçmişi) */
async function snapshots() {
  const users = await prisma.user.findMany({ where: { role: 'user', exchanges: { some: {} } }, select: { id: true } })
  for (const u of users) {
    // gerçek ve sanal ayrı kaydedilir (grafikler ve günlük K/Z karışmaz)
    const [live, paper] = await Promise.all([totalValueUsd(u.id, 'live'), totalValueUsd(u.id, 'paper')])
    await prisma.portfolioSnapshot.create({ data: { userId: u.id, valueUsd: live + paper, liveUsd: live, paperUsd: paper } })
    await ensureDayStart(u.id, live, 'live') // gün dönümünde gün başı değerlerini yakala
    await ensureDayStart(u.id, paper, 'paper')
  }
  // 400 günden eski görüntüleri temizle
  await prisma.portfolioSnapshot.deleteMany({ where: { ts: { lt: new Date(Date.now() - 400 * DAY) } } })
}

/** Admin listeleri için kullanıcı metrikleri (AUM, 30 günlük hacim) */
async function userMetrics() {
  const users = await prisma.user.findMany({ where: { role: 'user' }, select: { id: true } })
  const since = new Date(Date.now() - 30 * DAY)
  for (const u of users) {
    const orders = await prisma.order.findMany({ where: { userId: u.id, status: 'filled', filledAt: { gte: since } }, select: { symbol: true, filledQty: true, avgPrice: true } })
    let vol = 0
    for (const o of orders) {
      const ins = feed.instrument(o.symbol)
      if (ins) vol += feed.toUsd(num(o.filledQty) * num(o.avgPrice), ins.quote)
    }
    await prisma.user.update({ where: { id: u.id }, data: { aumUsd: await totalValueUsd(u.id), volume30dUsd: vol } })
  }
}

async function cleanup() {
  const old = new Date(Date.now() - DAY)
  await prisma.loginChallenge.deleteMany({ where: { OR: [{ expiresAt: { lt: old } }, { usedAt: { lt: old } }] } })
  await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: old } }, { revokedAt: { lt: new Date(Date.now() - 30 * DAY) } }] } })
}

export function startJobs() {
  // ENGINE_ENABLED=false: bu süreç emir/bot/kural/risk işlerini YAPMAZ (yalnızca API + canlı ekran verisi).
  // Aynı veritabanına bağlı ikinci bir sunucu (ör. canlı DB'ye bağlanan yerel geliştirme) emirleri
  // ikinci kez işlemesin, canlı borsaya mükerrer emir göndermesin diye.
  const engine = config.ENGINE_ENABLED
  // Her fiyat güncellemesinde koşullu emirler ve SL/TP
  let tickBusy = false
  feed.on('tick', async () => {
    tickCandles()
    if (!engine || tickBusy) return
    tickBusy = true
    try {
      await processOrders()
      await processProtection()
    } catch (e) {
      log.error({ err: e }, 'emir motoru hatası')
    } finally {
      tickBusy = false
    }
  })
  every(2000, 'depth', pushDepth)
  hub.on('subscriptions', warmCandleChannels)
  every(5000, 'portfolio', pushPortfolio)
  every(60_000, 'health', () => health.ping())
  if (!engine) {
    log.warn('⚠️  ENGINE_ENABLED=false → emir motoru, botlar, kurallar ve risk kontrolleri bu süreçte KAPALI')
    setTimeout(() => health.ping().catch(() => {}), 3000)
    return
  }
  every(2000, 'rules', processRules)
  every(5000, 'bots', processBots)
  every(10_000, 'dailyLoss', checkDailyLoss)
  every(5 * 60_000, 'snapshots', snapshots)
  every(10 * 60_000, 'userMetrics', userMetrics)
  // Binance'teki tüm USDT pariteleri: açılıştan kısa süre sonra ve günde bir
  if (config.MARKET_DATA === 'auto') {
    const runCatalog = () => syncCryptoCatalog().catch((e) => log.warn(`kripto kataloğu güncellenemedi: ${e.message?.slice(0, 120)}`))
    setTimeout(runCatalog, 5000)
    every(24 * 60 * 60_000, 'catalog', runCatalog)
  }
  every(60 * 60_000, 'cleanup', cleanup)
  if (config.LIVE_TRADING_ENABLED) {
    every(5000, 'liveOrders', pollLiveOrders)
    // canlı hesap bakiyeleri (borsaya dışarıdan yatırılan / çekilen para) – 2 dakikada bir
    every(2 * 60_000, 'liveBalances', async () => {
      const list = await prisma.exchangeAccount.findMany({ where: { mode: 'live', status: 'connected' } })
      for (const c of list) await syncLiveBalances(c).catch((e) => log.warn({ err: e.message, exchange: c.id }, 'canlı bakiye senkronlanamadı'))
    })
  }

  // açılışta bir kez
  setTimeout(() => {
    health.ping().catch(() => {})
    snapshots().catch(() => {})
    userMetrics().catch(() => {})
  }, 3000)
  log.info('⏱️  Arka plan işleri başladı')
}

export function stopJobs() {
  timers.splice(0).forEach(clearInterval)
  feed.removeAllListeners('tick')
  hub.removeAllListeners('subscriptions')
}
