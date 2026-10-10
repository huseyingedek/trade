// =====================================================================
//  KRİPTO KATALOĞU – Binance'te işlem gören TÜM spot USDT paritelerini
//  enstrüman olarak ekler / günceller (günde bir ve açılışta).
//  • Kaldıraçlı tokenlar (…UP/…DOWN/…BULL/…BEAR) eklenmez
//  • Fiyat adımı ve miktar adımı borsanın kurallarından alınır
//  • Elle eklenmiş / seed enstrümanların sırası ve adı korunur
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { log } from '../lib/logger.js'
import { feed } from './feed.js'

const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/
const decimalStep = (p) => (p == null ? null : p >= 1 && Number.isInteger(p) && p > 1 ? 10 ** -p : p) // ccxt TICK_SIZE modunda zaten adım

export async function syncCryptoCatalog() {
  const ex = feed.ccxt
  if (!ex || ex.id !== 'binance') return { added: 0, updated: 0 }
  const markets = await ex.loadMarkets(true)
  const list = Object.values(markets).filter(
    (m) => m.spot && m.active !== false && m.quote === 'USDT' && !LEVERAGED.test(m.base) && m.base !== 'USDT',
  )
  // hacme göre sıralamak ve başlangıç fiyatı için 24s özet (tek istek)
  let tickers = {}
  try {
    tickers = await ex.fetchTickers()
  } catch (e) {
    log.warn(`katalog: 24s özet alınamadı (${e.message?.slice(0, 80)}) – hacim sıralaması atlandı`)
  }
  const existing = new Map((await prisma.instrument.findMany({ where: { market: 'crypto' } })).map((i) => [i.symbol, i]))
  const ranked = list
    .map((m) => ({ m, t: tickers[m.symbol] }))
    .filter(({ t }) => !t || (t.quoteVolume ?? 0) > 0) // işlem görmeyenler hariç
    .sort((a, b) => (b.t?.quoteVolume ?? 0) - (a.t?.quoteVolume ?? 0))

  let added = 0
  let updated = 0
  for (const [rank, { m, t }] of ranked.entries()) {
    const tickSize = decimalStep(m.precision?.price) ?? 0.00000001
    const qtyStep = decimalStep(m.precision?.amount) ?? 0.00000001
    const cur = existing.get(m.symbol)
    if (cur) {
      // borsa kuralları değişmiş olabilir → adımları güncelle (ad/sıra/aktiflik admin'e ait)
      if (Number(cur.tickSize) !== tickSize || Number(cur.qtyStep) !== qtyStep || cur.dataSource !== 'binance') {
        await prisma.instrument.update({ where: { symbol: m.symbol }, data: { tickSize, qtyStep, dataSource: 'binance', sourceSymbol: m.symbol } })
        updated++
      }
      continue
    }
    const last = t?.last ?? t?.close
    if (!(last > 0)) continue
    await prisma.instrument.create({
      data: {
        symbol: m.symbol, name: m.base, base: m.base, quote: 'USDT', market: 'crypto',
        tickSize, qtyStep, dataSource: 'binance', sourceSymbol: m.symbol,
        seedPrice: last, volatility: 0.0008, active: true, sortOrder: 1000 + rank,
      },
    })
    added++
  }
  if (added || updated) await feed.reload()
  log.info(`🪙 Kripto kataloğu: ${ranked.length} Binance USDT paritesi (${added} yeni, ${updated} güncellendi)`)
  return { added, updated, total: ranked.length }
}
