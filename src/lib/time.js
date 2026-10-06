import { config } from '../config.js'

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.TZ_APP, year: 'numeric', month: '2-digit', day: '2-digit' })
/** Uygulama saat dilimine göre gün anahtarı: 2026-10-06 */
export const dayKey = (d = new Date()) => fmt.format(d)
export const MIN = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000
