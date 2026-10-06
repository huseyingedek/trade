// =====================================================================
//  ADMIN API'Sİ  (/api/v1/admin/...)  – her uç nokta izin kontrollü
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { toApi } from '../lib/serialize.js'
import { conflict, notFound } from '../lib/errors.js'
import { requireAdmin } from '../plugins/auth.js'
import * as A from '../services/admin.js'
import { audit } from '../services/audit.js'
import { logActivity } from '../services/activity.js'
import { getPlatform, platformView } from '../services/platform.js'
import { feed } from '../market/feed.js'

const can = (perm) => ({ preHandler: requireAdmin(perm) })

export default async function adminRoutes(app) {
  app.get('/overview', can('overview.read'), () => A.overview())

  // ---------------------------------------------------------------- kullanıcılar
  app.get('/users', can('users.read'), (req) => A.listUsers(req.query))
  app.get('/users/:id', can('users.read'), (req) => A.userDetail(req.params.id))
  app.patch('/users/:id', can('users.read'), (req) => A.updateUser(req, req.params.id, req.body || {}))
  app.post('/users/:id/logout-all', can('users.manage'), (req) => A.userAction(req, req.params.id, 'logout-all'))
  app.post('/users/:id/reset-2fa', can('users.manage'), (req) => A.userAction(req, req.params.id, 'reset-2fa', req.body || {}))
  app.post('/users/:id/resend-verification', can('users.manage'), (req) => A.userAction(req, req.params.id, 'resend-verification'))
  app.post('/users/:id/notes', can('users.read'), (req) => A.userAction(req, req.params.id, 'note', req.body || {}))

  // ---------------------------------------------------------------- platform riski
  app.get('/platform', can('overview.read'), async () => platformView(await getPlatform(true)))
  app.patch('/platform', can('risk.manage'), (req) => A.updatePlatform(req, req.body || {}))
  app.post('/platform/kill-switch', can('risk.manage'), (req) => A.platformKill(req, req.body || {}))
  app.get('/instruments', can('overview.read'), async () => [...feed.instruments.values()].map((i) => ({ symbol: i.symbol, name: i.name, market: i.market })))

  // ---------------------------------------------------------------- entegrasyonlar
  app.get('/providers', can('overview.read'), () => A.listProviders())
  app.patch('/providers/:id', can('integrations.manage'), (req) => A.updateProvider(req, req.params.id, req.body || {}))

  // ---------------------------------------------------------------- abonelik
  app.get('/plans', can('billing.read'), () => A.listPlans())
  app.post('/plans', can('billing.manage'), (req) => A.savePlan(req, null, req.body || {}))
  app.patch('/plans/:id', can('billing.manage'), (req) => A.savePlan(req, req.params.id, req.body || {}))
  app.delete('/plans/:id', can('billing.manage'), (req) => A.deletePlan(req, req.params.id))
  app.get('/payments', can('billing.read'), (req) => A.listPayments(req.query))
  app.post('/payments/:id/refund', can('billing.manage'), (req) => A.refund(req, req.params.id, req.body?.reason))
  /** Manuel ödeme modu: havale/EFT onaylanınca planı aktifleştir */
  app.post('/payments/:id/confirm', can('billing.manage'), async (req) => {
    const p = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { user: true, plan: true } })
    if (!p) throw notFound('Ödeme bulunamadı')
    if (p.status !== 'pending') throw conflict('Sadece bekleyen ödemeler onaylanabilir')
    const renews = new Date()
    renews.setMonth(renews.getMonth() + (p.billingCycle === 'yearly' ? 12 : 1))
    await prisma.$transaction([
      prisma.payment.update({ where: { id: p.id }, data: { status: 'paid' } }),
      prisma.user.update({ where: { id: p.userId }, data: { planId: p.planId, billingCycle: p.billingCycle, planRenewsAt: renews } }),
    ])
    await logActivity(p.userId, { level: 'success', notify: true, message: `Ödemeniz onaylandı, ${p.plan.name} planınız aktif` })
    await audit(req, 'payment.confirm', p.user.name, `${p.plan.name} – ₺${Number(p.amount).toLocaleString('tr-TR')}`, p.id)
    return { ok: true }
  })
  app.post('/payments/:id/fail', can('billing.manage'), async (req) => {
    const p = await prisma.payment.findUnique({ where: { id: req.params.id }, include: { user: true } })
    if (!p) throw notFound('Ödeme bulunamadı')
    if (p.status !== 'pending') throw conflict('Sadece bekleyen ödemeler reddedilebilir')
    await prisma.payment.update({ where: { id: p.id }, data: { status: 'failed', failureReason: String(req.body?.reason || 'Ödeme alınamadı') } })
    await logActivity(p.userId, { level: 'warning', notify: true, message: 'Ödeme talebiniz onaylanmadı. Detay için destek ile iletişime geçin.' })
    await audit(req, 'payment.fail', p.user.name, String(req.body?.reason || 'Ödeme alınamadı'), p.id)
    return { ok: true }
  })

  // ---------------------------------------------------------------- duyurular
  app.get('/announcements', can('announcements.manage'), async () => (await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } })).map(toApi))
  app.post('/announcements', can('announcements.manage'), (req) => A.saveAnnouncement(req, null, req.body || {}))
  app.patch('/announcements/:id', can('announcements.manage'), async (req) => {
    const cur = await prisma.announcement.findUnique({ where: { id: req.params.id } })
    if (!cur) throw notFound('Duyuru bulunamadı')
    return A.saveAnnouncement(req, req.params.id, { ...toApi(cur), ...(req.body || {}) })
  })
  app.delete('/announcements/:id', can('announcements.manage'), (req) => A.deleteAnnouncement(req, req.params.id))

  // ---------------------------------------------------------------- denetim
  app.get('/audit', can('audit.read'), (req) => A.listAudit(req.query))

  // ---------------------------------------------------------------- ekip
  app.get('/team', can('overview.read'), () => A.team())
  app.post('/team', can('team.manage'), (req) => A.inviteAdmin(req, req.body || {}))
  app.patch('/team/:id', can('team.manage'), (req) => A.updateAdmin(req, req.params.id, req.body || {}))
  app.delete('/team/:id', can('team.manage'), (req) => A.removeAdmin(req, req.params.id))
}
