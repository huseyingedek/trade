// Platform ayarları (tekil satır) – 3 sn önbellek
import { prisma } from '../lib/prisma.js'

let cache = null
let at = 0
let provCache = null
let provAt = 0

export async function getPlatform(force = false) {
  if (!force && cache && Date.now() - at < 3000) return cache
  cache = await prisma.platformSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  at = Date.now()
  return cache
}
export const invalidatePlatform = () => (at = 0)

export async function getProviderSettings(force = false) {
  if (!force && provCache && Date.now() - provAt < 3000) return provCache
  const rows = await prisma.providerSetting.findMany()
  provCache = Object.fromEntries(rows.map((r) => [r.id, r]))
  provAt = Date.now()
  return provCache
}
export const invalidateProviders = () => (provAt = 0)

export function platformView(p) {
  return {
    killSwitch: { active: p.killSwitchActive, reason: p.killReason, at: p.killAt?.getTime() ?? null, by: p.killBy },
    maintenance: { active: p.maintenanceActive, message: p.maintenanceMessage },
    registrationOpen: p.registrationOpen,
    maxLeverage: p.maxLeverage,
    maxOrderUsd: p.maxOrderUsd,
    blockedSymbols: p.blockedSymbols,
    requireUser2fa: p.requireUser2fa,
  }
}
