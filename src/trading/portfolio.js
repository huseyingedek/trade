// =====================================================================
//  Portföy değerleme – bakiyeler + pozisyonlar, USD bazında
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { feed } from '../market/feed.js'
import { num } from '../lib/serialize.js'
import { DAY, HOUR, dayKey } from '../lib/time.js'
import { badRequest } from '../lib/errors.js'

export function positionMetrics(p) {
  const qty = num(p.qty)
  const entry = num(p.entryPrice)
  const margin = num(p.margin)
  let mark = entry
  try {
    mark = feed.last(p.symbol)
  } catch {
    /* fiyat yoksa giriş fiyatı */
  }
  const dir = p.side === 'long' ? 1 : -1
  // kayıp teminatı aşamaz (tasfiye)
  const pnl = Math.max((mark - entry) * qty * dir, -margin)
  return { markPrice: mark, pnl, pnlPct: margin ? (pnl / margin) * 100 : 0, value: margin + pnl, notional: qty * mark }
}

const CASH = new Set(['USD', 'USDT', 'USDC', 'TRY', 'EUR', 'GBP', 'JPY'])

/** Herhangi bir varlık miktarını USD'ye çevirir (nakit → kur, coin → güncel fiyat). Bilinmeyen varlık 0. */
export function assetToUsd(amount, asset) {
  if (!amount) return 0
  if (CASH.has(asset)) return feed.toUsd(amount, asset)
  for (const q of ['USDT', 'USDC', 'USD']) {
    if (feed.instrument(`${asset}/${q}`)) {
      try {
        return amount * feed.last(`${asset}/${q}`)
      } catch {
        return 0
      }
    }
  }
  return 0
}
export const isCashAsset = (asset) => CASH.has(asset)

const quoteOf = (symbol) => feed.instrument(symbol)?.quote ?? 'USD'
const marketOf = (symbol) => feed.instrument(symbol)?.market ?? 'crypto'

/** Kullanıcının tüm varlıklarını yükleyip USD toplamını hesaplar */
export async function loadHoldings(userId) {
  const [balances, positions] = await Promise.all([
    prisma.balance.findMany({ where: { exchange: { userId } }, include: { exchange: { select: { id: true, market: true, mode: true } } } }),
    prisma.position.findMany({ where: { userId }, include: { exchange: { select: { mode: true } } } }),
  ])
  return { balances, positions }
}

/**
 * Paper hesaplar: nakit bakiye + pozisyon değeri (pozisyon defterde tutulur).
 * Canlı hesaplar: borsadan gelen tüm bakiyeler (coinler dahil) zaten varlığın tamamıdır;
 * pozisyonlar sadece K/Z takibi içindir, tekrar eklenmez.
 */
export function valueOf({ balances, positions }) {
  let total = 0
  for (const b of balances) total += assetToUsd(num(b.free), b.asset)
  for (const p of positions) if (p.exchange?.mode !== 'live') total += feed.toUsd(positionMetrics(p).value, quoteOf(p.symbol))
  return total
}

export async function totalValueUsd(userId) {
  return valueOf(await loadHoldings(userId))
}

/**
 * Gün başı portföy değeri (günlük K/Z ve günlük zarar limiti için).
 * Gün değiştiyse güncel değerle yeniden başlar.
 */
export async function ensureDayStart(userId, total) {
  const key = dayKey()
  const r = await prisma.riskSettings.upsert({ where: { userId }, update: {}, create: { userId } })
  if (r.dayKey === key && r.dayStartValue) return r.dayStartValue
  total ??= await totalValueUsd(userId)
  await prisma.riskSettings.update({ where: { userId }, data: { dayKey: key, dayStartValue: total } })
  return total
}

/** Para yatırma/çekme (yeni paper hesap, hesap silme) günlük K/Z'yi bozmasın diye gün başı değerini kaydır */
export async function adjustDayStart(userId, deltaUsd) {
  const r = await prisma.riskSettings.findUnique({ where: { userId } })
  if (!r || r.dayKey !== dayKey() || !r.dayStartValue) return
  await prisma.riskSettings.update({ where: { userId }, data: { dayStartValue: Math.max(0, r.dayStartValue + deltaUsd) } })
}

export async function summary(userId) {
  const h = await loadHoldings(userId)
  const allocation = { crypto: 0, bist: 0, forex: 0, cash: 0 }
  const byExchange = {}
  let unrealized = 0
  for (const b of h.balances) {
    const v = assetToUsd(num(b.free), b.asset)
    if (isCashAsset(b.asset)) allocation.cash += v
    else allocation[b.exchange?.market || 'crypto'] += v
    byExchange[b.exchangeId] = (byExchange[b.exchangeId] || 0) + v
  }
  for (const p of h.positions) {
    const m = positionMetrics(p)
    const q = quoteOf(p.symbol)
    unrealized += feed.toUsd(m.pnl, q)
    if (p.exchange?.mode === 'live') continue // canlı: değer zaten bakiyelerde
    const v = feed.toUsd(m.value, q)
    allocation[marketOf(p.symbol)] += v
    byExchange[p.exchangeId] = (byExchange[p.exchangeId] || 0) + v
  }
  const total = Object.values(allocation).reduce((a, b) => a + b, 0)
  const dayStart = await ensureDayStart(userId, total)
  return {
    baseCurrency: 'USD',
    totalValue: total,
    cashValue: allocation.cash,
    positionsValue: total - allocation.cash,
    unrealizedPnl: unrealized,
    dayPnl: total - dayStart,
    dayPnlPct: dayStart ? ((total - dayStart) / dayStart) * 100 : 0,
    allocation: [
      { key: 'crypto', label: 'Kripto', value: allocation.crypto },
      { key: 'bist', label: 'BIST', value: allocation.bist },
      { key: 'forex', label: 'Forex', value: allocation.forex },
      { key: 'cash', label: 'Nakit', value: allocation.cash },
    ],
    byExchange: Object.entries(byExchange).map(([exchangeId, value]) => ({ exchangeId, value })),
    ts: Date.now(),
  }
}

const RANGES = { '1D': [DAY, 15 * 60_000], '1W': [7 * DAY, HOUR], '1M': [30 * DAY, 4 * HOUR], '3M': [90 * DAY, DAY], '1Y': [365 * DAY, DAY] }

/** Portföy geçmişi – periyodik anlık görüntülerden (snapshot) kovalara ayrılır */
export async function history(userId, range = '1M') {
  const cfg = RANGES[range]
  if (!cfg) throw badRequest('Geçersiz aralık')
  const [span, bucket] = cfg
  const since = new Date(Date.now() - span)
  const rows = await prisma.portfolioSnapshot.findMany({ where: { userId, ts: { gte: since } }, orderBy: { ts: 'asc' }, select: { ts: true, valueUsd: true } })
  const buckets = new Map()
  for (const r of rows) buckets.set(Math.floor(r.ts.getTime() / bucket) * bucket, r.valueUsd)
  const points = [...buckets.entries()].map(([t, v]) => [t, v])
  points.push([Date.now(), await totalValueUsd(userId)])
  return { range, points }
}
