// Kullanıcı aktivite günlüğü + canlı bildirim + Telegram/e-posta
import { prisma } from '../lib/prisma.js'
import { hub } from '../realtime/hub.js'
import { toApi } from '../lib/serialize.js'
import { sendTelegram } from '../lib/telegram.js'
import { sendMail } from '../lib/mailer.js'
import { log } from '../lib/logger.js'

export const activityToApi = (a) => toApi({ ...a, ts: a.ts })

/**
 * @param {string} userId
 * @param {{level?, source?, message, notify?, exchangeId?, symbol?, ruleId?, botId?}} e
 */
export async function logActivity(userId, e) {
  try {
    const row = await prisma.activity.create({
      data: {
        userId,
        level: e.level || 'info',
        source: e.source || 'system',
        message: e.message,
        notify: !!e.notify,
        exchangeId: e.exchangeId ?? null,
        symbol: e.symbol ?? null,
        ruleId: e.ruleId ?? null,
        botId: e.botId ?? null,
      },
    })
    const api = activityToApi(row)
    hub.toUser(userId, 'activity', api)
    if (e.notify) notifyExternal(userId, api).catch(() => {})
    return api
  } catch (err) {
    log.error({ err }, 'aktivite kaydedilemedi')
    return null
  }
}

async function notifyExternal(userId, entry) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, notifications: true, plan: { select: { telegram: true } } } })
  if (!u) return
  const n = u.notifications || {}
  if (n.telegram && u.plan?.telegram) await sendTelegram(n.telegramChatId, `Tradepilo: ${entry.message}`)
  if (n.email && entry.level === 'danger') await sendMail({ to: u.email, subject: 'Tradepilo – önemli uyarı', text: entry.message })
}
