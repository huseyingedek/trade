// =====================================================================
//  EMİR MOTORU – her fiyat güncellemesinde çalışır
//  • Bekleyen limit / stop / stop-limit / iz süren / OCO emirlerini tetikler
//  • Pozisyonların zarar-kes / kâr-al seviyelerini uygular
//  • Canlı (live) limit emirlerinin borsadaki durumunu takip eder
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { feed } from '../market/feed.js'
import { withLock } from '../lib/mutex.js'
import { num } from '../lib/serialize.js'
import { execute, closePosition, emitTrading, reject } from './orders.js'
import { logActivity } from '../services/activity.js'
import { callAdapter } from '../exchanges/index.js'
import { decrypt } from '../lib/crypto.js'
import { log } from '../lib/logger.js'

let busy = false

export async function processOrders() {
  if (busy) return
  busy = true
  try {
    const open = await prisma.order.findMany({ where: { status: 'open', NOT: { externalId: { not: null }, type: 'limit' } }, include: { exchange: true } })
    for (const o of open) {
      let p
      try {
        p = feed.last(o.symbol)
      } catch {
        continue
      }
      const buy = o.side === 'buy'
      const price = num(o.price)
      const stop = num(o.stopPrice)
      let fillAt = null
      const patch = {}
      switch (o.type) {
        case 'limit':
          if (buy ? p <= price : p >= price) fillAt = price
          break
        case 'stop_market':
          if (buy ? p >= stop : p <= stop) fillAt = p
          break
        case 'stop_limit':
          if (!o.triggered && (buy ? p >= stop : p <= stop)) {
            patch.triggered = true
            await logActivity(o.userId, { source: o.source, symbol: o.symbol, message: `${o.symbol} stop-limit tetiklendi, limit emir aktif @ ${price}` })
          }
          if ((o.triggered || patch.triggered) && (buy ? p <= price : p >= price)) fillAt = price
          break
        case 'trailing_stop': {
          const ref = o.refPrice ?? p
          const nextRef = buy ? Math.min(ref, p) : Math.max(ref, p)
          if (nextRef !== o.refPrice) patch.refPrice = nextRef
          if (buy ? p >= nextRef * (1 + o.trailingPct / 100) : p <= nextRef * (1 - o.trailingPct / 100)) fillAt = p
          break
        }
        case 'oco':
          if (buy ? p <= price : p >= price) fillAt = price
          else if (buy ? p >= stop : p <= stop) fillAt = p
          break
        default:
          break
      }
      if (Object.keys(patch).length && fillAt === null) await prisma.order.update({ where: { id: o.id }, data: patch }).catch(() => {})
      if (fillAt === null) continue
      await withLock(`u:${o.userId}`, async () => {
        const fresh = await prisma.order.findUnique({ where: { id: o.id }, include: { exchange: true } })
        if (fresh?.status !== 'open') return
        try {
          await execute(fresh, fillAt)
        } catch (e) {
          await reject(fresh, e.message, false)
        }
      })
    }
  } catch (e) {
    log.error({ err: e }, 'emir motoru hatası')
  } finally {
    busy = false
  }
}

let protBusy = false
/** Başarısız koruma denemeleri: pozisyon id → bir sonraki deneme zamanı (koruma silinmez, tekrar denenir) */
const protRetry = new Map()
const PROT_RETRY_MS = 60_000
/** Teminatın bu oranı kaybedilince pozisyon tasfiye edilir (kalan %10 komisyon/kayma payı) */
export const LIQUIDATION_LOSS_RATIO = 0.9

/** Tasfiye fiyatı (kaldıraçlı veya açığa satış pozisyonları için; diğerlerinde null) */
export function liquidationPrice(p) {
  const qty = num(p.qty)
  if (!(qty > 0) || (p.leverage <= 1 && p.side === 'long')) return null
  const move = (num(p.margin) * LIQUIDATION_LOSS_RATIO) / qty
  const px = p.side === 'long' ? num(p.entryPrice) - move : num(p.entryPrice) + move
  return px > 0 ? px : null
}

export async function processProtection() {
  if (protBusy) return
  protBusy = true
  try {
    const list = await prisma.position.findMany({
      where: { OR: [{ stopLoss: { not: null } }, { takeProfit: { not: null } }, { leverage: { gt: 1 } }, { side: 'short' }] },
    })
    const seen = new Set()
    for (const pos of list) {
      seen.add(pos.id)
      let p
      try {
        p = feed.last(pos.symbol)
      } catch {
        continue
      }
      const long = pos.side === 'long'
      const sl = num(pos.stopLoss)
      const tp = num(pos.takeProfit)
      const margin = num(pos.margin)
      const pnl = (p - num(pos.entryPrice)) * num(pos.qty) * (long ? 1 : -1)
      let reason = null
      if (margin > 0 && pnl <= -margin * LIQUIDATION_LOSS_RATIO) reason = 'Tasfiye (teminat tükendi)'
      else if (sl && (long ? p <= sl : p >= sl)) reason = 'Zarar-kes'
      else if (tp && (long ? p >= tp : p <= tp)) reason = 'Kâr-al'
      if (!reason) {
        protRetry.delete(pos.id)
        continue
      }
      const next = protRetry.get(pos.id)
      if (next && Date.now() < next) continue
      const liquidation = reason.startsWith('Tasfiye')
      await logActivity(pos.userId, { level: liquidation ? 'danger' : 'warning', source: liquidation ? 'risk' : 'system', exchangeId: pos.exchangeId, symbol: pos.symbol, notify: true, message: `${pos.symbol} ${reason} tetiklendi @ ${p} – pozisyon kapatılıyor` })
      try {
        await closePosition(pos.userId, pos.id, 100, liquidation ? 'risk' : 'system')
        protRetry.delete(pos.id)
      } catch (e) {
        // Koruma silinmez: 1 dk sonra tekrar denenir, kullanıcı bilgilendirilir
        const first = !next
        protRetry.set(pos.id, Date.now() + PROT_RETRY_MS)
        if (first) await logActivity(pos.userId, { level: 'danger', source: 'system', notify: true, symbol: pos.symbol, message: `${pos.symbol} ${reason} çalıştırılamadı: ${e.message}. 1 dakika içinde tekrar denenecek.` })
      }
    }
    for (const id of protRetry.keys()) if (!seen.has(id)) protRetry.delete(id)
  } catch (e) {
    log.error({ err: e }, 'koruma motoru hatası')
  } finally {
    protBusy = false
  }
}

/** Canlı limit emirlerinin borsadaki durumunu senkronize et */
export async function pollLiveOrders() {
  const list = await prisma.order.findMany({ where: { status: 'open', externalId: { not: null } }, include: { exchange: true } })
  for (const o of list) {
    try {
      const r = await callAdapter(o.exchange.provider, 'fetchOrder', decrypt(o.exchange.credentialsEnc), o.exchange.testnet, o.externalId, o.symbol)
      if (r.status === 'closed') {
        await withLock(`u:${o.userId}`, async () => {
          const fresh = await prisma.order.findUnique({ where: { id: o.id }, include: { exchange: true } })
          if (fresh?.status !== 'open') return
          // borsa emri doldurdu → defteri güncelle (borsaya yeniden göndermeden)
          await prisma.exchangeAccount.update({ where: { id: o.exchangeId }, data: { lastSyncAt: new Date() } })
          await execute({ ...fresh, exchange: { ...fresh.exchange, mode: 'paper-ledger' } }, r.average || num(fresh.price))
        })
      } else if (r.status === 'canceled' || r.status === 'expired' || r.status === 'rejected') {
        await prisma.order.update({ where: { id: o.id }, data: { status: 'canceled', canceledAt: new Date(), reason: 'Borsada iptal edildi' } })
        emitTrading(o.userId, 'orders')
      }
    } catch (e) {
      log.warn({ err: e.message, order: o.id }, 'canlı emir durumu alınamadı')
    }
  }
}
