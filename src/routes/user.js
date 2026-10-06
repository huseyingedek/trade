// =====================================================================
//  KULLANICI API'Sİ  (/api/v1/...)
//  Sözleşme: hirenest-admin/docs/API.md
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { toApi, num } from '../lib/serialize.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAuth, requireTrader } from '../plugins/auth.js'
import * as auth from '../services/auth.js'
import * as ex from '../services/exchanges.js'
import { activeForUser } from '../services/admin.js'
import { activityToApi, logActivity } from '../services/activity.js'
import { PROVIDERS, providerView } from '../exchanges/providers.js'
import { feed } from '../market/feed.js'
import { INTERVALS, getCandles, getOrderBook, getTrades } from '../market/depth.js'
import { placeOrder, cancelOrder, cancelAll, closePosition, updatePosition, lockedCash, orderToApi } from '../trading/orders.js'
import { positionMetrics, summary, history, assetToUsd } from '../trading/portfolio.js'
import { riskState, updateRisk, setKillSwitch } from '../trading/risk.js'
import { liquidationPrice } from '../trading/engine.js'
import * as rules from '../automation/rules.js'
import * as bots from '../automation/bots.js'
import { getProviderSettings } from '../services/platform.js'

const meta = (req) => ({ ip: req.ip, ua: req.headers['user-agent'] || '' })
const AUTH_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

const instrumentView = (i) => ({
  symbol: i.symbol, name: i.name, base: i.base, quote: i.quote, market: i.market, tickSize: i.tickSize, qtyStep: i.qtyStep,
  dataSource: feed.usesExternal(i) ? 'live' : 'sim',
})

export default async function userRoutes(app) {
  const auth$ = { preHandler: requireAuth }
  const trader = { preHandler: requireTrader }

  // ================================================================ sistem
  app.get('/health', async () => ({ ok: true, ts: Date.now() }))
  app.get('/meta', async () => ({
    name: 'Tradepilo API',
    version: '1.0.0',
    liveTradingEnabled: config.LIVE_TRADING_ENABLED,
    paymentsMode: config.PAYMENTS_MODE,
    marketData: { mode: config.MARKET_DATA, exchange: config.MARKET_DATA_EXCHANGE, connected: feed.ccxtOk },
    registrationOpen: (await prisma.platformSetting.findUnique({ where: { id: 1 } }))?.registrationOpen ?? true,
  }))

  // ================================================================ auth
  app.post('/auth/login', AUTH_LIMIT, (req) => auth.login(req.body || {}, meta(req)))
  app.post('/auth/2fa', AUTH_LIMIT, (req) => auth.verify2fa(req.body || {}, meta(req)))
  app.post('/auth/register', AUTH_LIMIT, (req) => auth.register(req.body || {}, meta(req)))
  app.post('/auth/forgot-password', AUTH_LIMIT, (req) => auth.forgotPassword(req.body || {}))
  app.post('/auth/reset-password', AUTH_LIMIT, (req) => auth.resetPassword(req.body || {}))
  app.post('/auth/verify-email', AUTH_LIMIT, (req) => auth.verifyEmail(req.body || {}))
  app.post('/auth/accept-invite', AUTH_LIMIT, (req) => auth.acceptInvite(req.body || {}))

  app.get('/auth/me', auth$, (req) => auth.meView(req.user.id))
  app.patch('/auth/me', auth$, (req) => auth.updateMe(req.user.id, req.body || {}))
  app.post('/auth/logout', auth$, (req) => auth.logout(req.sessionId))
  app.post('/auth/delete-account', { ...AUTH_LIMIT, preHandler: requireAuth }, (req) => auth.deleteAccount(req.user.id, req.body || {}))
  app.post('/auth/change-password', auth$, (req) => auth.changePassword(req.user.id, req.sessionId, req.body || {}))
  app.post('/auth/2fa/setup', auth$, (req) => auth.start2faSetup(req.user.id))
  app.post('/auth/2fa/enable', auth$, (req) => auth.enable2fa(req.user.id, req.body || {}))
  app.post('/auth/2fa/disable', auth$, (req) => auth.disable2fa(req.user.id, req.body || {}))
  app.get('/auth/sessions', auth$, async (req) =>
    (await prisma.session.findMany({ where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } })).map((s) => ({
      id: s.id, ip: s.ipAddress, userAgent: s.userAgent, createdAt: s.createdAt.getTime(), lastSeenAt: s.lastSeenAt.getTime(), current: s.id === req.sessionId,
    })),
  )
  app.delete('/auth/sessions/:id', auth$, async (req) => {
    const r = await prisma.session.updateMany({ where: { id: req.params.id, userId: req.user.id, revokedAt: null }, data: { revokedAt: new Date() } })
    if (!r.count) throw notFound('Oturum bulunamadı')
    return { ok: true }
  })

  app.get('/announcements/active', auth$, (req) => activeForUser(req.user))

  // ================================================================ abonelik
  app.get('/billing/plans', async () => {
    const { planView } = auth
    return (await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })).map(planView)
  })
  app.get('/billing/payments', trader, async (req) =>
    (await prisma.payment.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { plan: { select: { name: true } } } })).map((p) =>
      toApi({ id: p.id, plan: p.planId, planName: p.plan.name, billing: p.billingCycle, amount: p.amount, currency: p.currency, status: p.status, method: p.method, createdAt: p.createdAt }),
    ),
  )
  /**
   * Plan değişikliği.
   * PAYMENTS_MODE=manual: ücretli planlar için "bekleyen" ödeme oluşturulur; finans ekibi ödemeyi onaylayınca plan aktifleşir.
   * Ücretsiz plana geçiş anında yapılır.
   * Gerçek ödeme sağlayıcısı (iyzico/Stripe vb.) bağlandığında burada ödeme oturumu açılıp webhook ile onaylanmalıdır.
   */
  app.post('/billing/subscribe', trader, async (req) => {
    if (config.PAYMENTS_MODE === 'disabled') throw badRequest('Ödemeler şu an kapalı', 'PAYMENTS_DISABLED')
    const { planId, billing = 'monthly' } = req.body || {}
    const plan = await prisma.plan.findFirst({ where: { id: String(planId || ''), active: true } })
    if (!plan) throw badRequest('Plan bulunamadı')
    if (!['monthly', 'yearly'].includes(billing)) throw badRequest('Geçersiz ödeme dönemi')
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (user.planId === plan.id && user.billingCycle === billing) throw conflict('Zaten bu plandasınız')
    const amount = num(billing === 'yearly' ? plan.priceYearly : plan.priceMonthly)
    if (amount === 0) {
      await prisma.user.update({ where: { id: user.id }, data: { planId: plan.id, billingCycle: billing, planRenewsAt: null } })
      await logActivity(user.id, { level: 'info', message: `Planınız "${plan.name}" olarak değiştirildi` })
      return { status: 'active', me: await auth.meView(user.id) }
    }
    if (await prisma.payment.count({ where: { userId: user.id, status: 'pending' } })) throw conflict('Onay bekleyen bir ödeme talebiniz var')
    const p = await prisma.payment.create({ data: { userId: user.id, planId: plan.id, billingCycle: billing, amount, currency: plan.currency, status: 'pending', method: 'Havale/EFT', provider: 'manual' } })
    await logActivity(user.id, { level: 'info', notify: true, message: `${plan.name} planı için ödeme talebiniz alındı (₺${amount.toLocaleString('tr-TR')}). Ödeme onaylanınca planınız aktifleşecek.` })
    return { status: 'pending', paymentId: p.id, amount, currency: plan.currency }
  })

  // ================================================================ platformlar & bağlantılar
  app.get('/providers', auth$, async () => {
    const s = await getProviderSettings()
    return PROVIDERS.map((p) => ({ ...providerView(p), liveSupported: p.live && config.LIVE_TRADING_ENABLED, enabledForNew: s[p.id]?.enabledForNew ?? true, maintenance: s[p.id]?.maintenance ?? false }))
  })
  app.get('/exchanges', trader, (req) => ex.listConnections(req.user.id))
  app.post('/exchanges', trader, (req) => ex.createConnection(req.user.id, req.body || {}))
  app.post('/exchanges/:id/test', trader, (req) => ex.testConnection(req.user.id, req.params.id))
  app.patch('/exchanges/:id', trader, (req) => ex.updateConnection(req.user.id, req.params.id, req.body || {}))
  app.delete('/exchanges/:id', trader, (req) => ex.deleteConnection(req.user.id, req.params.id))

  // ================================================================ piyasa verisi
  app.get('/markets/instruments', auth$, async (req) => [...feed.instruments.values()].filter((i) => !req.query.market || i.market === req.query.market).map(instrumentView))
  app.get('/markets/tickers', auth$, async (req) => feed.list(req.query.symbols ? String(req.query.symbols).split(',') : null))
  app.get('/markets/candles', auth$, async (req) => {
    const { symbol, interval = '1h', limit = 300 } = req.query
    if (!feed.instrument(symbol)) throw badRequest('Bilinmeyen sembol')
    if (!INTERVALS[interval]) throw badRequest('Geçersiz aralık')
    return getCandles(symbol, interval, Math.min(1000, Math.max(10, +limit || 300)))
  })
  app.get('/markets/orderbook', auth$, async (req) => {
    if (!feed.instrument(req.query.symbol)) throw badRequest('Bilinmeyen sembol')
    return getOrderBook(req.query.symbol, Math.min(50, +req.query.depth || 14))
  })
  app.get('/markets/trades', auth$, async (req) => {
    if (!feed.instrument(req.query.symbol)) throw badRequest('Bilinmeyen sembol')
    return getTrades(req.query.symbol)
  })

  // ================================================================ emirler
  app.get('/orders', trader, async (req) => {
    const q = req.query
    const where = { userId: req.user.id }
    if (q.status === 'open') where.status = 'open'
    else if (q.status === 'history') where.status = { not: 'open' }
    else if (q.status) where.status = q.status
    if (q.exchangeId) where.exchangeId = q.exchangeId
    if (q.symbol) where.symbol = q.symbol
    return (await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(1000, +q.limit || 500) })).map(orderToApi)
  })
  app.post('/orders', trader, (req) => placeOrder(req.user.id, req.body || {}, { source: 'manual' }))
  app.delete('/orders/:id', trader, (req) => cancelOrder(req.user.id, req.params.id))
  app.post('/orders/cancel-all', trader, (req) => cancelAll(req.user.id, req.body || {}))

  // ================================================================ pozisyon / bakiye / portföy
  app.get('/positions', trader, async (req) =>
    (await prisma.position.findMany({ where: { userId: req.user.id }, orderBy: { openedAt: 'desc' } })).map((p) => toApi({ ...p, ...positionMetrics(p), liquidationPrice: liquidationPrice(p) })),
  )
  app.post('/positions/:id/close', trader, (req) => closePosition(req.user.id, req.params.id, req.body?.percent ?? 100))
  app.patch('/positions/:id', trader, (req) => updatePosition(req.user.id, req.params.id, req.body || {}))
  app.get('/balances', trader, async (req) => {
    const conns = await prisma.exchangeAccount.findMany({ where: { userId: req.user.id }, include: { balances: true } })
    const out = []
    for (const c of conns) {
      const lockedAmt = c.mode === 'paper' ? await lockedCash(c) : 0
      for (const b of c.balances) {
        const free = num(b.free)
        const l = b.asset === (c.market === 'bist' ? 'TRY' : c.market === 'forex' ? 'USD' : 'USDT') ? lockedAmt : 0
        out.push({ exchangeId: c.id, asset: b.asset, free, locked: l, total: free, available: Math.max(0, free - l), valueUsd: assetToUsd(free, b.asset) })
      }
    }
    return out
  })
  app.get('/portfolio/summary', trader, (req) => summary(req.user.id))
  app.get('/portfolio/history', trader, (req) => history(req.user.id, req.query.range || '1M'))

  // ================================================================ kurallar
  app.get('/rules', trader, (req) => rules.listRules(req.user.id))
  app.post('/rules', trader, (req) => rules.createRule(req.user.id, req.body || {}))
  app.patch('/rules/:id', trader, (req) => rules.updateRule(req.user.id, req.params.id, req.body || {}))
  app.delete('/rules/:id', trader, (req) => rules.deleteRule(req.user.id, req.params.id))

  // ================================================================ botlar
  app.get('/bots', trader, (req) => bots.listBots(req.user.id))
  app.post('/bots', trader, (req) => bots.createBot(req.user.id, req.body || {}))
  app.post('/bots/:id/start', trader, (req) => bots.setStatus(req.user.id, req.params.id, 'running'))
  app.post('/bots/:id/pause', trader, (req) => bots.setStatus(req.user.id, req.params.id, 'paused'))
  app.post('/bots/:id/stop', trader, (req) => bots.setStatus(req.user.id, req.params.id, 'stopped'))
  app.delete('/bots/:id', trader, (req) => bots.deleteBot(req.user.id, req.params.id))

  // ================================================================ risk
  app.get('/risk', trader, (req) => riskState(req.user.id))
  app.patch('/risk', trader, (req) => updateRisk(req.user.id, req.body || {}))
  app.post('/risk/kill-switch', trader, (req) => setKillSwitch(req.user.id, req.body || {}, 'manual'))

  // ================================================================ aktivite
  app.get('/activity', trader, async (req) => {
    const q = req.query
    const where = { userId: req.user.id }
    if (q.source) where.source = q.source
    if (q.level) where.level = q.level
    return (await prisma.activity.findMany({ where, orderBy: { ts: 'desc' }, take: Math.min(1000, +q.limit || 200) })).map(activityToApi)
  })
}
