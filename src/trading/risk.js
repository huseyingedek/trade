// =====================================================================
//  KULLANICI RİSK YÖNETİMİ – acil durdurma, günlük zarar limiti, limitler
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { dayKey } from '../lib/time.js'
import { badRequest } from '../lib/errors.js'
import { totalValueUsd, ensureDayStart } from './portfolio.js'
import { cancelAll, closePosition, emitTrading } from './orders.js'
import { logActivity } from '../services/activity.js'

export const getRisk = (userId) => prisma.riskSettings.upsert({ where: { userId }, update: {}, create: { userId } })

/** Gün başı değeri gerekirse yeniler; güncel durumu döndürür */
export async function riskState(userId) {
  const total = await totalValueUsd(userId)
  const start = (await ensureDayStart(userId, total)) || total
  const r = await getRisk(userId)
  const pct = start ? ((total - start) / start) * 100 : 0
  const [openOrders, runningBots, activeRules] = await Promise.all([
    prisma.order.count({ where: { userId, status: 'open' } }),
    prisma.bot.count({ where: { userId, status: 'running' } }),
    prisma.rule.count({ where: { userId, enabled: true } }),
  ])
  return {
    killSwitch: { active: r.killSwitchActive, reason: r.killReason, at: r.killAt?.getTime() ?? null, by: r.killBy },
    dailyLossLimit: { enabled: r.dailyLossEnabled, pct: r.dailyLossPct },
    maxPositionPct: r.maxPositionPct,
    maxOpenOrders: r.maxOpenOrders,
    requireConfirm: r.requireConfirm,
    state: {
      totalValue: total,
      dayStartValue: start,
      dayPnl: total - start,
      dayPnlPct: pct,
      lossLimitUsedPct: r.dailyLossEnabled && pct < 0 ? Math.min(100, (-pct / r.dailyLossPct) * 100) : 0,
      openOrders, runningBots, activeRules,
    },
  }
}

export async function updateRisk(userId, patch) {
  const data = {}
  if (patch.dailyLossLimit) {
    const pct = +patch.dailyLossLimit.pct
    if (!(pct > 0 && pct <= 100)) throw badRequest('Günlük zarar limiti %0–100 arasında olmalı')
    data.dailyLossEnabled = !!patch.dailyLossLimit.enabled
    data.dailyLossPct = pct
  }
  if (patch.maxPositionPct !== undefined) {
    if (!(+patch.maxPositionPct > 0 && +patch.maxPositionPct <= 100)) throw badRequest('Maks. pozisyon oranı %1–100 olmalı')
    data.maxPositionPct = +patch.maxPositionPct
  }
  if (patch.maxOpenOrders !== undefined) {
    if (!(+patch.maxOpenOrders >= 1 && +patch.maxOpenOrders <= 500)) throw badRequest('Maks. açık emir 1–500 olmalı')
    data.maxOpenOrders = Math.round(+patch.maxOpenOrders)
  }
  if (patch.requireConfirm !== undefined) data.requireConfirm = !!patch.requireConfirm
  await getRisk(userId)
  await prisma.riskSettings.update({ where: { userId }, data })
  await logActivity(userId, { source: 'risk', message: 'Risk ayarları güncellendi' })
  emitTrading(userId, 'risk')
  return riskState(userId)
}

/** Kullanıcı acil durdurma (kill switch) */
export async function setKillSwitch(userId, { active, reason, cancelOrders = false, closePositions = false }, source = 'manual') {
  await getRisk(userId)
  if (active) {
    await prisma.riskSettings.update({ where: { userId }, data: { killSwitchActive: true, killReason: reason || 'Manuel acil durdurma', killAt: new Date(), killBy: source } })
    const paused = await prisma.bot.updateMany({ where: { userId, status: 'running' }, data: { status: 'paused', pausedByKillSwitch: true } })
    const canceled = cancelOrders ? (await cancelAll(userId, {}, source)).canceled : 0
    let closed = 0
    if (closePositions) {
      for (const p of await prisma.position.findMany({ where: { userId }, select: { id: true } })) {
        try {
          await closePosition(userId, p.id, 100, source)
          closed++
        } catch {
          /* bağlantı sorunu olan hesap atlanır */
        }
      }
    }
    await logActivity(userId, { level: 'danger', source: 'risk', notify: true, message: `ACİL DURDURMA: ${reason || 'Manuel'} · ${paused.count} bot duraklatıldı · ${canceled} emir iptal · ${closed} pozisyon kapatıldı` })
  } else {
    const total = await totalValueUsd(userId)
    const r = await getRisk(userId)
    await prisma.riskSettings.update({
      where: { userId },
      // gün başı değerini sıfırla ki günlük limit hemen tekrar tetiklenmesin
      data: { killSwitchActive: false, killReason: null, killAt: null, killBy: null, dayStartValue: Math.min(r.dayStartValue ?? total, total * 1.0001) },
    })
    await logActivity(userId, { level: 'success', source: 'risk', notify: true, message: 'İşlemler yeniden etkinleştirildi' })
  }
  emitTrading(userId, 'risk', 'bots', 'orders')
  return riskState(userId)
}

/** Periyodik: günlük zarar limitini kontrol et (tüm kullanıcılar) */
export async function checkDailyLoss() {
  const list = await prisma.riskSettings.findMany({ where: { dailyLossEnabled: true, killSwitchActive: false, dayStartValue: { not: null } } })
  for (const r of list) {
    if (r.dayKey !== dayKey()) continue
    const total = await totalValueUsd(r.userId)
    const pct = ((total - r.dayStartValue) / r.dayStartValue) * 100
    if (pct <= -Math.abs(r.dailyLossPct)) await setKillSwitch(r.userId, { active: true, reason: `Günlük zarar limiti (%${r.dailyLossPct}) aşıldı`, cancelOrders: true }, 'risk')
  }
}
