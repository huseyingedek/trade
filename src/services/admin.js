// =====================================================================
//  ADMIN SERVİSLERİ
//  Her yazma işlemi audit() ile denetim günlüğüne kaydedilir.
//  Admin, kullanıcı adına emir veremez ve API anahtarlarını göremez.
// =====================================================================
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { toApi, num } from '../lib/serialize.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { ROLES, PERMISSIONS, isAdminRole, permissionsOf } from '../lib/rbac.js'
import { randomToken } from '../lib/crypto.js'
import { signPurpose } from '../lib/tokens.js'
import { DAY } from '../lib/time.js'
import { sendMail } from '../lib/mailer.js'
import { audit } from './audit.js'
import { logActivity } from './activity.js'
import { planView, revokeAllSessions } from './auth.js'
import { getPlatform, invalidatePlatform, platformView, getProviderSettings, invalidateProviders } from './platform.js'
import { connToApi } from './exchanges.js'
import { PROVIDERS, providerById } from '../exchanges/providers.js'
import { health } from '../exchanges/health.js'
import { feed } from '../market/feed.js'
import { positionMetrics, valueOf } from '../trading/portfolio.js'
import { ruleToApi } from '../automation/rules.js'
import { botToApi } from '../automation/bots.js'
import { activityToApi } from './activity.js'
import { hub } from '../realtime/hub.js'

const USER_ROLE = { role: 'user' }

const parseUA = (ua = '') => {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı'
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Bilinmiyor'
  return `${b} · ${os}`
}

const userRow = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  plan: u.planId,
  billing: u.billingCycle,
  status: u.status,
  city: u.city,
  createdAt: u.createdAt.getTime(),
  lastLoginAt: u.lastLoginAt?.getTime() ?? null,
  twoFactor: u.twoFactorEnabled,
  exchanges: u._count?.exchanges ?? 0,
  bots: u._count?.bots ?? 0,
  rules: u._count?.rules ?? 0,
  aumUsd: u.aumUsd,
  volume30dUsd: u.volume30dUsd,
  riskFlags: u.riskFlags,
  notes: (u.notes || []).map((n) => ({ id: n.id, text: n.text, by: n.author?.name ?? '—', at: n.createdAt.getTime() })),
})

const COUNTS = { _count: { select: { exchanges: true, bots: true, rules: true } } }

// ================================================================== kullanıcılar
const SORTABLE = { createdAt: 1, lastLoginAt: 1, name: 1, plan: 'planId', status: 1, aumUsd: 1, volume30dUsd: 1, exchanges: 'count' }

export async function listUsers(q) {
  const where = { ...USER_ROLE }
  if (q.q) where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, { id: q.q }]
  if (q.plan) where.planId = q.plan
  if (q.status) where.status = q.status
  if (q.flagged === 'true') where.NOT = { riskFlags: { isEmpty: true } }
  const [key, dir = 'desc'] = String(q.sort || 'createdAt:desc').split(':')
  const d = dir === 'asc' ? 'asc' : 'desc'
  const field = SORTABLE[key]
  const orderBy = field === 'count' ? { exchanges: { _count: d } } : field === 'planId' ? { planId: d } : key === 'lastLoginAt' ? { lastLoginAt: { sort: d, nulls: 'last' } } : field ? { [key]: d } : { createdAt: 'desc' }
  const page = Math.max(1, +q.page || 1)
  const pageSize = Math.min(100, Math.max(1, +q.pageSize || 20))
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: COUNTS }),
    prisma.user.count({ where }),
  ])
  return { items: items.map(userRow), total, page, pageSize }
}

export async function userDetail(id) {
  const u = await prisma.user.findFirst({ where: { id, ...USER_ROLE }, include: { ...COUNTS, plan: true, notes: { include: { author: true }, orderBy: { createdAt: 'desc' } } } })
  if (!u) throw notFound('Kullanıcı bulunamadı')
  const [connections, positions, orders, bots, rules, activity, sessions, payments] = await Promise.all([
    prisma.exchangeAccount.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' } }),
    prisma.position.findMany({ where: { userId: id } }),
    prisma.order.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 15 }),
    prisma.bot.findMany({ where: { userId: id } }),
    prisma.rule.findMany({ where: { userId: id } }),
    prisma.activity.findMany({ where: { userId: id }, orderBy: { ts: 'desc' }, take: 25 }),
    prisma.session.findMany({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } }),
    prisma.payment.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
  ])
  return {
    user: userRow(u),
    plan: planView(u.plan),
    connections: connections.map(connToApi),
    positions: positions.map((p) => toApi({ ...p, ...positionMetrics(p) })),
    orders: orders.map(toApi),
    bots: bots.map(botToApi),
    rules: rules.map(ruleToApi),
    activity: activity.map(activityToApi),
    sessions: sessions.map((s, i) => ({ id: s.id, device: parseUA(s.userAgent || ''), ip: s.ipAddress, city: null, lastSeenAt: s.lastSeenAt.getTime(), current: i === 0 })),
    payments: payments.map(paymentRow(u)),
  }
}

export async function updateUser(req, id, body) {
  const u = await prisma.user.findFirst({ where: { id, ...USER_ROLE } })
  if (!u) throw notFound('Kullanıcı bulunamadı')
  const perms = req.user.permissions
  if (body.status && body.status !== u.status) {
    const tradingChange = body.status === 'trading_halted' || (u.status === 'trading_halted' && body.status === 'active')
    if (!perms.includes(tradingChange ? 'users.trading' : 'users.manage')) throw forbidden()
    if (!['active', 'suspended', 'trading_halted'].includes(body.status)) throw badRequest('Geçersiz durum')
    const reason = String(body.reason || '').trim()
    if (body.status !== 'active' && reason.length < 5) throw badRequest('İşlem gerekçesi en az 5 karakter olmalı')
    const action = { suspended: 'user.suspend', trading_halted: 'user.trading_halt', active: u.status === 'suspended' ? 'user.reactivate' : 'user.trading_resume' }[body.status]
    await prisma.user.update({ where: { id }, data: { status: body.status } })
    if (body.status !== 'active') {
      await prisma.bot.updateMany({ where: { userId: id, status: 'running' }, data: { status: 'paused' } })
      hub.toUser(id, 'bots')
    }
    if (body.status === 'suspended') await revokeAllSessions(id)
    if (body.status === 'trading_halted') await logActivity(id, { level: 'danger', source: 'risk', notify: true, message: 'Hesabınızda işlemler yönetici tarafından durduruldu. Destek ile iletişime geçin.' })
    if (body.status === 'active') await logActivity(id, { level: 'success', source: 'risk', notify: true, message: 'Hesabınız yönetici tarafından yeniden etkinleştirildi' })
    await audit(req, action, u.name, reason || 'Hesap yeniden etkinleştirildi', id)
  }
  if (body.plan && body.plan !== u.planId) {
    if (!perms.includes('users.manage')) throw forbidden()
    const plan = await prisma.plan.findUnique({ where: { id: body.plan } })
    if (!plan) throw badRequest('Plan bulunamadı')
    await prisma.user.update({ where: { id }, data: { planId: plan.id } })
    await logActivity(id, { level: 'info', source: 'system', notify: true, message: `Planınız "${plan.name}" olarak güncellendi` })
    await audit(req, 'user.plan_change', u.name, `${u.planId} → ${plan.id}`, id)
  }
  return userRow(await prisma.user.findUnique({ where: { id }, include: COUNTS }))
}

export async function userAction(req, id, action, body = {}) {
  const u = await prisma.user.findFirst({ where: { id, ...USER_ROLE } })
  if (!u) throw notFound('Kullanıcı bulunamadı')
  if (action !== 'note' && !req.user.permissions.includes('users.manage')) throw forbidden()
  if (action === 'logout-all') {
    const n = await revokeAllSessions(id)
    await audit(req, 'user.logout_all', u.name, `${n} oturum sonlandırıldı`, id)
  } else if (action === 'reset-2fa') {
    if ((body.reason || '').trim().length < 5) throw badRequest('Gerekçe gerekli')
    await prisma.user.update({ where: { id }, data: { twoFactorEnabled: false, twoFactorSecretEnc: null } })
    await revokeAllSessions(id)
    await audit(req, 'user.reset_2fa', u.name, body.reason.trim(), id)
  } else if (action === 'resend-verification') {
    const token = signPurpose('verify', u.id, {}, '3d')
    await sendMail({ to: u.email, subject: 'Tradepilo – e-posta doğrulama', text: `${config.APP_URL}/verify-email?token=${token}` })
    await audit(req, 'user.verify_email', u.name, 'Doğrulama e-postası yeniden gönderildi', id)
  } else if (action === 'note') {
    const text = String(body.text || '').trim()
    if (!text) throw badRequest('Not boş olamaz')
    await prisma.userNote.create({ data: { userId: id, authorId: req.user.id, text: text.slice(0, 2000) } })
    await audit(req, 'user.note', u.name, 'Not eklendi', id)
  }
  return userRow(await prisma.user.findUnique({ where: { id }, include: { ...COUNTS, notes: { include: { author: true }, orderBy: { createdAt: 'desc' } } } }))
}

// ================================================================== genel bakış
export async function overview() {
  const now = Date.now()
  const since = (d) => new Date(now - d * DAY)
  const [users, plans, connectedAccounts, runningBots, activeRules, failedPayments, recentAudit, platform, settings] = await Promise.all([
    prisma.user.findMany({ where: USER_ROLE, select: { id: true, name: true, planId: true, billingCycle: true, status: true, createdAt: true, lastActiveAt: true, aumUsd: true, riskFlags: true } }),
    prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.exchangeAccount.count({ where: { user: USER_ROLE } }),
    prisma.bot.count({ where: { status: 'running' } }),
    prisma.rule.count({ where: { enabled: true } }),
    prisma.payment.count({ where: { status: 'failed', createdAt: { gte: since(30) } } }),
    prisma.auditLog.findMany({ orderBy: { ts: 'desc' }, take: 8 }),
    getPlatform(),
    getProviderSettings(),
  ])
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p]))
  const active24 = users.filter((u) => u.lastActiveAt && u.lastActiveAt.getTime() > now - DAY).length
  const new7 = users.filter((u) => u.createdAt.getTime() > now - 7 * DAY).length
  const new7prev = users.filter((u) => u.createdAt.getTime() > now - 14 * DAY && u.createdAt.getTime() <= now - 7 * DAY).length
  // Gelir: sadece o plan için onaylanmış ödemesi olanlar. Admin'in ücretsiz verdiği ücretli planlar ("hediye") gelire sayılmaz.
  const paidPayments = await prisma.payment.findMany({ where: { status: 'paid', user: USER_ROLE }, select: { userId: true, planId: true } })
  const paidKeys = new Set(paidPayments.map((p) => `${p.userId}:${p.planId}`))
  const onPaidPlan = users.filter((u) => num(planMap[u.planId]?.priceMonthly) > 0 && u.status !== 'pending')
  const paid = onPaidPlan.filter((u) => paidKeys.has(`${u.id}:${u.planId}`))
  const compUsers = onPaidPlan.length - paid.length
  const mrr = paid.reduce((a, u) => a + (u.billingCycle === 'yearly' ? num(planMap[u.planId].priceYearly) / 12 : num(planMap[u.planId].priceMonthly)), 0)
  const growth = Array.from({ length: 90 }, (_, i) => {
    const t = now - (89 - i) * DAY
    return [t, users.filter((u) => u.createdAt.getTime() <= t).length]
  })
  const signups = Array.from({ length: 14 }, (_, i) => {
    const end = now - (13 - i) * DAY
    return [end, users.filter((u) => u.createdAt.getTime() > end - DAY && u.createdAt.getTime() <= end).length]
  })

  // 30 günlük platform hacmi (gerçekleşen emirlerden, USD)
  const filled = await prisma.order.findMany({ where: { status: 'filled', filledAt: { gte: since(30) }, user: USER_ROLE }, select: { symbol: true, filledQty: true, avgPrice: true, filledAt: true } })
  const vol = Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * DAY, crypto: 0, bist: 0, forex: 0 }))
  let volume24h = 0
  for (const o of filled) {
    const ins = feed.instrument(o.symbol)
    if (!ins) continue
    const usd = feed.toUsd(num(o.filledQty) * num(o.avgPrice), ins.quote)
    const idx = 29 - Math.floor((now - o.filledAt.getTime()) / DAY)
    if (idx >= 0 && idx < 30) vol[idx][ins.market] += usd
    if (o.filledAt.getTime() > now - DAY) volume24h += usd
  }
  const healthList = await providersHealth(settings)
  // Varlık: canlı (gerçek para) ve sanal (paper) ayrı
  const [accByMode, allBalances, allPositions] = await Promise.all([
    prisma.exchangeAccount.groupBy({ by: ['mode'], where: { user: USER_ROLE }, _count: true }),
    prisma.balance.findMany({ where: { exchange: { user: USER_ROLE } }, include: { exchange: { select: { mode: true } } } }),
    prisma.position.findMany({ where: { user: USER_ROLE }, include: { exchange: { select: { mode: true } } } }),
  ])
  const modeCount = (m) => accByMode.find((r) => r.mode === m)?._count ?? 0
  const aumLiveUsd = valueOf({ balances: allBalances.filter((b) => b.exchange.mode === 'live'), positions: [] })
  const aumPaperUsd = valueOf({ balances: allBalances.filter((b) => b.exchange.mode !== 'live'), positions: allPositions.filter((p) => p.exchange.mode !== 'live') })
  const totalAcc = healthList.reduce((a, h) => a + h.accounts, 0)
  return {
    kpis: {
      totalUsers: users.length,
      activeUsers24h: active24,
      newUsers7d: new7,
      newUsers7dChangePct: new7prev ? ((new7 - new7prev) / new7prev) * 100 : null,
      paidUsers: paid.length,
      compUsers,
      conversionPct: users.length ? (paid.length / users.length) * 100 : 0,
      mrr: Math.round(mrr),
      currency: 'TRY',
      connectedAccounts,
      liveAccounts: modeCount('live'),
      paperAccounts: modeCount('paper'),
      aumUsd: aumLiveUsd + aumPaperUsd,
      aumLiveUsd,
      aumPaperUsd,
      volume24hUsd: volume24h,
      runningBots,
      activeRules,
      errorRatePct: totalAcc ? healthList.reduce((a, h) => a + h.errorRatePct * h.accounts, 0) / totalAcc : 0,
    },
    growth,
    signups,
    volume: vol,
    planDistribution: plans.map((p) => ({ plan: p.id, name: p.name, count: users.filter((u) => u.planId === p.id).length })),
    health: healthList,
    alerts: users.filter((u) => u.riskFlags.length).slice(0, 8).map((u) => ({ userId: u.id, userName: u.name, flags: u.riskFlags, status: u.status })),
    failedPayments,
    recentAudit: recentAudit.map(auditRow),
    platform: platformView(platform),
  }
}

// ================================================================== platform
export async function updatePlatform(req, body) {
  const p = await getPlatform(true)
  const data = {}
  const changes = []
  if (body.maxLeverage !== undefined) {
    const v = Math.round(+body.maxLeverage)
    if (!(v >= 1 && v <= 125)) throw badRequest('Kaldıraç 1–125 arasında olmalı')
    if (v !== p.maxLeverage) changes.push(`Maks. kaldıraç ${p.maxLeverage}x → ${v}x`)
    data.maxLeverage = v
  }
  if (body.maxOrderUsd !== undefined) {
    const v = +body.maxOrderUsd
    if (!(v >= 10)) throw badRequest('Maks. emir tutarı geçersiz')
    if (v !== p.maxOrderUsd) changes.push(`Maks. emir $${p.maxOrderUsd} → $${v}`)
    data.maxOrderUsd = v
  }
  if (Array.isArray(body.blockedSymbols)) {
    const list = [...new Set(body.blockedSymbols.filter((s) => feed.instrument(s)))]
    const added = list.filter((s) => !p.blockedSymbols.includes(s))
    const removed = p.blockedSymbols.filter((s) => !list.includes(s))
    if (added.length) changes.push(`İşleme kapatılan: ${added.join(', ')}`)
    if (removed.length) changes.push(`İşleme açılan: ${removed.join(', ')}`)
    data.blockedSymbols = list
  }
  if (body.registrationOpen !== undefined && !!body.registrationOpen !== p.registrationOpen) {
    data.registrationOpen = !!body.registrationOpen
    changes.push(`Yeni kayıt ${data.registrationOpen ? 'açıldı' : 'kapatıldı'}`)
  }
  if (body.requireUser2fa !== undefined && !!body.requireUser2fa !== p.requireUser2fa) {
    data.requireUser2fa = !!body.requireUser2fa
    changes.push(`Kullanıcılar için 2FA ${data.requireUser2fa ? 'zorunlu' : 'isteğe bağlı'}`)
  }
  if (body.maintenance) {
    data.maintenanceActive = !!body.maintenance.active
    data.maintenanceMessage = String(body.maintenance.message || '').slice(0, 500)
    if (data.maintenanceActive !== p.maintenanceActive) changes.push(`Bakım modu ${data.maintenanceActive ? 'açıldı' : 'kapatıldı'}`)
  }
  const u = await prisma.platformSetting.update({ where: { id: 1 }, data })
  invalidatePlatform()
  if (changes.length) await audit(req, 'risk.update', 'Platform', changes.join(' · '))
  return platformView(u)
}

export async function platformKill(req, { active, reason }) {
  if (active) {
    const r = String(reason || '').trim()
    if (r.length < 5) throw badRequest('Gerekçe en az 5 karakter olmalı')
    const u = await prisma.platformSetting.update({ where: { id: 1 }, data: { killSwitchActive: true, killReason: r, killAt: new Date(), killBy: req.user.name } })
    invalidatePlatform()
    const running = await prisma.bot.findMany({ where: { status: 'running' }, select: { userId: true } })
    await prisma.bot.updateMany({ where: { status: 'running' }, data: { status: 'paused', pausedByKillSwitch: true } })
    const userIds = [...new Set(running.map((b) => b.userId))]
    for (const uid of userIds) hub.toUser(uid, 'bots')
    // aktif kullanıcılara bildirim
    const recent = await prisma.user.findMany({ where: { ...USER_ROLE, lastActiveAt: { gte: new Date(Date.now() - 7 * DAY) } }, select: { id: true } })
    for (const x of recent) await logActivity(x.id, { level: 'danger', source: 'risk', notify: true, message: `Platform genelinde işlemler durduruldu: ${r}` })
    await audit(req, 'risk.platform_halt', 'Platform', `GLOBAL DURDURMA – ${r}`)
    return platformView(u)
  }
  const u = await prisma.platformSetting.update({ where: { id: 1 }, data: { killSwitchActive: false, killReason: null, killAt: null, killBy: null } })
  invalidatePlatform()
  await audit(req, 'risk.platform_resume', 'Platform', 'Global durdurma kaldırıldı')
  return platformView(u)
}

// ================================================================== entegrasyonlar
export async function providersHealth(settings) {
  settings ??= await getProviderSettings(true)
  const counts = await prisma.exchangeAccount.groupBy({ by: ['provider'], _count: { _all: true } })
  const cmap = Object.fromEntries(counts.map((c) => [c.provider, c._count._all]))
  return PROVIDERS.map((p) => {
    const s = settings[p.id] || { enabledForNew: true, tradingHalted: false, maintenance: false }
    return {
      id: p.id, name: p.name, market: p.market, color: p.color, textColor: p.textColor,
      ...health.view(p.id, s),
      accounts: cmap[p.id] || 0,
      enabledForNew: s.enabledForNew,
      tradingHalted: s.tradingHalted,
      maintenance: s.maintenance,
      rateLimitPct: null,
    }
  })
}

export async function listProviders() {
  return {
    providers: await providersHealth(),
    incidents: (await prisma.incident.findMany({ orderBy: { startedAt: 'desc' }, take: 30 })).map((i) => toApi({ ...i, provider: i.providerId })),
  }
}

export async function updateProvider(req, id, body) {
  const p = providerById[id]
  if (!p) throw notFound('Platform bulunamadı')
  const cur = await prisma.providerSetting.upsert({ where: { id }, update: {}, create: { id } })
  const data = {}
  const msgs = []
  for (const k of ['enabledForNew', 'tradingHalted', 'maintenance']) {
    if (body[k] === undefined || !!body[k] === cur[k]) continue
    data[k] = !!body[k]
    msgs.push({ enabledForNew: data[k] ? 'Yeni bağlantılara açıldı' : 'Yeni bağlantılara kapatıldı', tradingHalted: data[k] ? 'Tüm kullanıcılar için işlemler durduruldu' : 'İşlemler yeniden açıldı', maintenance: data[k] ? 'Bakım moduna alındı' : 'Bakım modu kapatıldı' }[k])
    if (k === 'tradingHalted') {
      const owners = await prisma.exchangeAccount.findMany({ where: { provider: id }, select: { userId: true }, distinct: ['userId'] })
      for (const o of owners) await logActivity(o.userId, { level: data[k] ? 'danger' : 'success', source: 'risk', notify: true, message: `${p.name}: ${data[k] ? 'platform yöneticisi işlemleri geçici olarak durdurdu' : 'işlemler yeniden açıldı'}` })
    }
  }
  await prisma.providerSetting.update({ where: { id }, data })
  invalidateProviders()
  if (msgs.length) await audit(req, 'tradingHalted' in data ? (data.tradingHalted ? 'provider.halt' : 'provider.resume') : 'provider.update', p.name, `${msgs.join(' · ')}${body.reason ? ` – ${body.reason}` : ''}`)
  return (await providersHealth(await getProviderSettings(true))).find((x) => x.id === id)
}

// ================================================================== planlar & ödemeler
export async function listPlans() {
  const [plans, users] = await Promise.all([prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } }), prisma.user.findMany({ where: USER_ROLE, select: { planId: true, billingCycle: true } })])
  return plans.map((p) => {
    const subs = users.filter((u) => u.planId === p.id)
    const mrr = subs.reduce((a, u) => a + (u.billingCycle === 'yearly' ? num(p.priceYearly) / 12 : num(p.priceMonthly)), 0)
    return { ...planView(p), subscribers: subs.length, mrr: Math.round(mrr) }
  })
}

function planData(b) {
  if (!b.name?.trim()) throw badRequest('Plan adı gerekli')
  if (!(+b.priceMonthly >= 0) || !(+b.priceYearly >= 0)) throw badRequest('Fiyatlar 0 veya üzeri olmalı')
  const lim = b.limits || {}
  for (const k of ['exchanges', 'bots', 'rules']) if (!(+lim[k] === -1 || +lim[k] >= 0)) throw badRequest('Limitler 0+ veya sınırsız (-1) olmalı')
  const f = b.features || {}
  return {
    name: b.name.trim(), description: String(b.description || ''), priceMonthly: +b.priceMonthly, priceYearly: +b.priceYearly,
    maxExchanges: +lim.exchanges, maxBots: +lim.bots, maxRules: +lim.rules,
    futures: !!f.futures, apiAccess: !!f.apiAccess, prioritySupport: !!f.prioritySupport, telegram: !!f.telegram,
    active: b.active !== false, highlighted: !!b.highlighted,
  }
}

export async function savePlan(req, id, body) {
  const data = planData(body)
  if (id) {
    const old = await prisma.plan.findUnique({ where: { id } })
    if (!old) throw notFound('Plan bulunamadı')
    const p = await prisma.plan.update({ where: { id }, data })
    const diff = []
    if (num(old.priceMonthly) !== data.priceMonthly) diff.push(`aylık ₺${num(old.priceMonthly)} → ₺${data.priceMonthly}`)
    for (const [k, l] of [['maxExchanges', 'borsa'], ['maxBots', 'bot'], ['maxRules', 'kural']]) if (old[k] !== data[k]) diff.push(`${l} ${old[k]} → ${data[k]}`)
    await audit(req, 'plan.update', p.name, diff.join(' · ') || 'Plan güncellendi', id)
    return planView(p)
  }
  let slug = data.name.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomToken(4)
  if (await prisma.plan.findUnique({ where: { id: slug } })) slug = `${slug}-${randomToken(3).toLowerCase()}`
  const count = await prisma.plan.count()
  const p = await prisma.plan.create({ data: { id: slug, ...data, sortOrder: count + 1 } })
  await audit(req, 'plan.create', p.name, `₺${data.priceMonthly}/ay`, p.id)
  return planView(p)
}

export async function deletePlan(req, id) {
  if (await prisma.user.count({ where: { planId: id } })) throw conflict('Bu planda aboneler var; önce planı pasifleştirin')
  if (await prisma.payment.count({ where: { planId: id } })) throw conflict('Bu plana ait ödeme kayıtları var; planı silmek yerine pasifleştirin')
  const p = await prisma.plan.delete({ where: { id } })
  await audit(req, 'plan.delete', p.name, 'Plan silindi', id)
  return { ok: true }
}

const paymentRow = (u) => (p) => toApi({ id: p.id, userId: p.userId, userName: u?.name ?? p.user?.name, plan: p.planId, billing: p.billingCycle, amount: p.amount, currency: p.currency, status: p.status, method: p.method, createdAt: p.createdAt, failureReason: p.failureReason, refundReason: p.refundReason })

export async function listPayments(q) {
  const where = {}
  if (q.status) where.status = q.status
  if (q.plan) where.planId = q.plan
  if (q.q) where.user = { name: { contains: q.q, mode: 'insensitive' } }
  const page = Math.max(1, +q.page || 1)
  const pageSize = Math.min(100, +q.pageSize || 20)
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { name: true } } } }),
    prisma.payment.count({ where }),
  ])
  const monthly = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date()
    const start = new Date(d.getFullYear(), d.getMonth() - i, 1)
    const end = new Date(d.getFullYear(), d.getMonth() - i + 1, 1)
    const [paid, refunded] = await Promise.all([
      prisma.payment.aggregate({ where: { status: 'paid', createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { status: 'refunded', createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    ])
    monthly.push({ month: start.getTime(), revenue: num(paid._sum.amount) || 0, refunds: num(refunded._sum.amount) || 0 })
  }
  return { items: items.map((p) => paymentRow(null)(p)), total, page, pageSize, monthly }
}

export async function refund(req, id, reason) {
  const p = await prisma.payment.findUnique({ where: { id }, include: { user: true } })
  if (!p) throw notFound('Ödeme bulunamadı')
  if (p.status !== 'paid') throw conflict('Sadece başarılı ödemeler iade edilebilir')
  const r = String(reason || '').trim()
  if (r.length < 5) throw badRequest('İade gerekçesi gerekli')
  // Not: ödeme sağlayıcısı bağlandığında burada sağlayıcının iade API'si çağrılmalı
  const u = await prisma.payment.update({ where: { id }, data: { status: 'refunded', refundReason: r } })
  await audit(req, 'payment.refund', p.user.name, `₺${num(p.amount).toLocaleString('tr-TR')} iade – ${r}`, id)
  return paymentRow(p.user)(u)
}

// ================================================================== duyurular
const annRow = (a) => toApi(a)

export async function saveAnnouncement(req, id, b) {
  if (!String(b.title || '').trim() || !String(b.message || '').trim()) throw badRequest('Başlık ve mesaj gerekli')
  if (!['info', 'warning', 'maintenance'].includes(b.level)) throw badRequest('Geçersiz seviye')
  const data = {
    title: b.title.trim().slice(0, 200), message: b.message.trim().slice(0, 2000), level: b.level, audience: b.audience || 'all',
    active: b.active !== false, startsAt: b.startsAt ? new Date(+b.startsAt) : new Date(), endsAt: b.endsAt ? new Date(+b.endsAt) : null,
  }
  if (data.endsAt && data.endsAt <= data.startsAt) throw badRequest('Bitiş zamanı başlangıçtan sonra olmalı')
  if (id) {
    const a = await prisma.announcement.update({ where: { id }, data })
    await audit(req, 'announcement.update', a.title, a.active ? 'Yayında' : 'Yayından kaldırıldı', id)
    return annRow(a)
  }
  const a = await prisma.announcement.create({ data: { ...data, createdById: req.user.id, createdBy: req.user.name } })
  await audit(req, 'announcement.create', a.title, `Hedef: ${a.audience === 'all' ? 'tüm kullanıcılar' : `${a.audience} planı`}`, a.id)
  return annRow(a)
}

export async function deleteAnnouncement(req, id) {
  const a = await prisma.announcement.delete({ where: { id } })
  await audit(req, 'announcement.delete', a.title, 'Duyuru silindi', id)
  return { ok: true }
}

/** Kullanıcı paneli: aktif duyurular + platform durumu + hesap durumu */
export async function activeForUser(user) {
  const now = new Date()
  const [list, platform, settings, me] = await Promise.all([
    prisma.announcement.findMany({ where: { active: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, orderBy: { startsAt: 'desc' } }),
    getPlatform(),
    getProviderSettings(),
    prisma.user.findUnique({ where: { id: user.id }, include: { plan: true } }),
  ])
  return {
    announcements: list.filter((a) => a.audience === 'all' || a.audience === me.planId).map(annRow),
    platform: {
      tradingHalted: platform.killSwitchActive,
      haltReason: platform.killReason,
      maintenance: { active: platform.maintenanceActive, message: platform.maintenanceMessage },
      haltedProviders: Object.values(settings).filter((s) => s.tradingHalted).map((s) => s.id),
      blockedSymbols: platform.blockedSymbols,
      maxLeverage: platform.maxLeverage,
    },
    account: { status: me.status, plan: planView(me.plan) },
  }
}

// ================================================================== denetim
export const auditRow = (a) => toApi({ id: a.id, ts: a.ts, actor: a.actorName, action: a.action, target: a.target, details: a.details, ip: a.ip })

export async function listAudit(q) {
  const where = {}
  if (q.actor) where.actorName = q.actor
  if (q.action) where.action = { startsWith: q.action }
  if (q.q) where.OR = [{ target: { contains: q.q, mode: 'insensitive' } }, { details: { contains: q.q, mode: 'insensitive' } }]
  return (await prisma.auditLog.findMany({ where, orderBy: { ts: 'desc' }, take: Math.min(1000, +q.limit || 300) })).map(auditRow)
}

// ================================================================== ekip
const adminRow = (a) => ({
  id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, twoFactor: a.twoFactorEnabled,
  lastActiveAt: a.lastActiveAt?.getTime() ?? null, createdAt: a.createdAt.getTime(), kind: 'admin', roleLabel: ROLES[a.role]?.label, permissions: permissionsOf(a.role),
})

export async function team() {
  const admins = await prisma.user.findMany({ where: { role: { not: 'user' } }, orderBy: { createdAt: 'asc' } })
  return { admins: admins.map(adminRow), roles: ROLES, permissions: PERMISSIONS }
}

export async function inviteAdmin(req, b) {
  if (!String(b.name || '').trim() || !/^\S+@\S+\.\S+$/.test(b.email || '')) throw badRequest('Ad ve geçerli e-posta gerekli')
  if (!isAdminRole(b.role)) throw badRequest('Geçersiz rol')
  const email = b.email.trim().toLowerCase()
  if (await prisma.user.findUnique({ where: { email } })) throw conflict('Bu e-posta ile bir hesap zaten var')
  const a = await prisma.user.create({ data: { name: b.name.trim(), email, role: b.role, status: 'invited', passwordHash: await bcrypt.hash(randomToken(24), 10) } })
  const token = signPurpose('invite', a.id, {}, '7d')
  await sendMail({ to: email, subject: 'Tradepilo yönetim paneline davet', text: `${req.user.name} sizi ${ROLES[b.role].label} olarak davet etti: ${config.APP_URL}/accept-invite?token=${token}` })
  await audit(req, 'team.invite', a.name, `${ROLES[a.role].label} rolüyle davet edildi`, a.id)
  return { ...adminRow(a), inviteUrl: config.NODE_ENV === 'production' ? undefined : `${config.APP_URL}/accept-invite?token=${token}` }
}

export async function updateAdmin(req, id, b) {
  const a = await prisma.user.findFirst({ where: { id, role: { not: 'user' } } })
  if (!a) throw notFound('Admin bulunamadı')
  const data = {}
  if (b.role && b.role !== a.role) {
    if (a.id === req.user.id) throw conflict('Kendi rolünüzü değiştiremezsiniz')
    if (!isAdminRole(b.role)) throw badRequest('Geçersiz rol')
    if (a.role === 'super_admin' && (await prisma.user.count({ where: { role: 'super_admin', status: 'active' } })) <= 1) throw conflict('En az bir aktif süper admin kalmalı')
    data.role = b.role
    await audit(req, 'team.role_change', a.name, `${ROLES[a.role].label} → ${ROLES[b.role].label}`, id)
  }
  if (b.status && b.status !== a.status) {
    if (a.id === req.user.id) throw conflict('Kendi hesabınızı devre dışı bırakamazsınız')
    if (!['active', 'disabled'].includes(b.status)) throw badRequest('Geçersiz durum')
    data.status = b.status
    if (b.status === 'disabled') await revokeAllSessions(id)
    await audit(req, 'team.status', a.name, b.status === 'disabled' ? 'Erişimi kapatıldı' : 'Erişimi açıldı', id)
  }
  return adminRow(await prisma.user.update({ where: { id }, data }))
}

export async function removeAdmin(req, id) {
  if (id === req.user.id) throw conflict('Kendinizi silemezsiniz')
  const a = await prisma.user.findFirst({ where: { id, role: { not: 'user' } } })
  if (!a) throw notFound('Admin bulunamadı')
  if (a.role === 'super_admin') throw conflict('Süper admin silinemez, önce rolünü değiştirin')
  await prisma.user.delete({ where: { id } })
  await audit(req, 'team.remove', a.name, 'Ekipten çıkarıldı', id)
  return { ok: true }
}
