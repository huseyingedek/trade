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

export const MODES = ['live', 'paper']
const modeFilter = (mode) => (mode === 'live' ? { mode: 'live' } : mode === 'paper' ? { mode: { not: 'live' } } : {})

/**
 * Kullanıcının varlıkları. mode: 'live' (gerçek para) | 'paper' (sanal) | undefined (hepsi).
 * Gerçek ve sanal para ASLA toplanarak risk/limit hesabında kullanılmaz – çağıran mod belirtir.
 */
export async function loadHoldings(userId, mode) {
  const ex = modeFilter(mode)
  const [balances, positions] = await Promise.all([
    prisma.balance.findMany({ where: { exchange: { userId, ...ex } }, include: { exchange: { select: { id: true, market: true, mode: true } } } }),
    prisma.position.findMany({ where: { userId, ...(mode ? { exchange: ex } : {}) }, include: { exchange: { select: { mode: true } } } }),
  ])
  return { balances, positions }
}

/** Risk takibinin yapılacağı mod: kullanıcının canlı hesabı varsa gerçek para, yoksa sanal */
export async function riskScope(userId) {
  return (await prisma.exchangeAccount.count({ where: { userId, mode: 'live' } })) ? 'live' : 'paper'
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

export async function totalValueUsd(userId, mode) {
  return valueOf(await loadHoldings(userId, mode))
}

/**
 * Gün başı portföy değeri (günlük K/Z ve günlük zarar limiti için) – gerçek ve sanal için AYRI.
 * Gün değiştiyse güncel değerle yeniden başlar.
 */
// Eski tek-değerli alanlar (dayStartValue/dayKey) artık kullanılmıyor. Her yazımda sıfırlanır ki
// eski sürümle çalışan bir sunucu (ör. henüz güncellenmemiş Render) bunlarla yanlış "zarar" hesaplayıp
// acil durdurmayı tetiklemesin (eski kod boş görünce gün başını güncel değerle yeniden başlatır).
const LEGACY_RESET = { dayStartValue: null, dayKey: null }

export async function ensureDayStart(userId, total, mode = 'paper') {
  const key = dayKey()
  const r = await prisma.riskSettings.upsert({ where: { userId }, update: {}, create: { userId } })
  const d = r.dayStartModes && r.dayStartModes.key === key ? { ...r.dayStartModes } : { key }
  if (d[mode] != null) return d[mode]
  total ??= await totalValueUsd(userId, mode)
  d[mode] = total
  await prisma.riskSettings.update({ where: { userId }, data: { dayStartModes: d, ...LEGACY_RESET } })
  return total
}

/** Gün başı değerini doğrudan ayarla (acil durdurma kaldırılınca vb.) */
export async function setDayStart(userId, mode, value) {
  const key = dayKey()
  const r = await prisma.riskSettings.upsert({ where: { userId }, update: {}, create: { userId } })
  const d = r.dayStartModes && r.dayStartModes.key === key ? { ...r.dayStartModes } : { key }
  d[mode] = value
  await prisma.riskSettings.update({ where: { userId }, data: { dayStartModes: d, ...LEGACY_RESET } })
}

/** Para yatırma/çekme (yeni hesap, hesap silme) günlük K/Z'yi bozmasın diye gün başı değerini kaydır */
export async function adjustDayStart(userId, deltaUsd, mode = 'paper') {
  const r = await prisma.riskSettings.findUnique({ where: { userId } })
  const d = r?.dayStartModes
  if (!d || d.key !== dayKey() || d[mode] == null) return
  await prisma.riskSettings.update({ where: { userId }, data: { dayStartModes: { ...d, [mode]: Math.max(0, d[mode] + deltaUsd) }, ...LEGACY_RESET } })
}

export async function summary(userId, mode) {
  const counts = await prisma.exchangeAccount.groupBy({ by: ['mode'], where: { userId }, _count: true })
  const hasLive = counts.some((c) => c.mode === 'live')
  const hasPaper = counts.some((c) => c.mode !== 'live')
  if (!MODES.includes(mode)) mode = hasLive ? 'live' : 'paper'
  const h = await loadHoldings(userId, mode)
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
  const dayStart = await ensureDayStart(userId, total, mode)
  return {
    mode, // 'live' = gerçek para · 'paper' = sanal para (ikisi asla toplanmaz)
    hasLive,
    hasPaper,
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
export async function history(userId, range = '1M', mode) {
  const cfg = RANGES[range]
  if (!cfg) throw badRequest('Geçersiz aralık')
  if (!MODES.includes(mode)) mode = await riskScope(userId)
  const [span, bucket] = cfg
  const since = new Date(Date.now() - span)
  const rows = await prisma.portfolioSnapshot.findMany({ where: { userId, ts: { gte: since } }, orderBy: { ts: 'asc' }, select: { ts: true, valueUsd: true, liveUsd: true, paperUsd: true } })
  const buckets = new Map()
  for (const r of rows) {
    // eski kayıtlarda ayrım yok: sanal görünümde toplam değer kullanılır (o dönem canlı hesap yoktu), canlıda atlanır
    const v = mode === 'live' ? r.liveUsd : r.paperUsd ?? r.valueUsd
    if (v == null) continue
    buckets.set(Math.floor(r.ts.getTime() / bucket) * bucket, v)
  }
  const points = [...buckets.entries()].map(([t, v]) => [t, v])
  points.push([Date.now(), await totalValueUsd(userId, mode)])
  return { range, mode, points }
}
