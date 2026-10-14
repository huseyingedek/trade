// =====================================================================
//  BACKTEST SERVİSİ – POST /backtest
// =====================================================================
import { feed } from '../market/feed.js'
import { badRequest, conflict } from '../lib/errors.js'
import { feeRate } from '../trading/fees.js'
import { getHistory, RANGES } from './data.js'
import { normalizeBot, runBacktest } from './engine.js'

const running = new Set() // kullanıcı başına aynı anda tek test
let global = 0
const GLOBAL_MAX = 4

export async function backtest(userId, body = {}) {
  const range = body.range || '3M'
  if (!RANGES[range]) throw badRequest('Geçersiz test aralığı')
  const ins = feed.instrument(body.symbol)
  if (!ins) throw badRequest('Bilinmeyen sembol')
  const bot = normalizeBot(body)
  if (running.has(userId) || global >= GLOBAL_MAX) throw conflict('Bir test zaten çalışıyor, birkaç saniye sonra tekrar deneyin')
  running.add(userId)
  global++
  try {
    const { candles, source, interval } = await getHistory(ins.symbol, range)
    const provider = body.provider || 'binance'
    const result = await runBacktest(bot, candles, {
      feeRate: feeRate(provider, 'taker'),
      qtyStep: Number(ins.qtyStep) || 0,
      candleMs: RANGES[range].ms,
    })
    return { symbol: ins.symbol, quote: ins.quote, range, interval, dataSource: source, feeRate: feeRate(provider, 'taker'), config: bot.config, ...result }
  } finally {
    running.delete(userId)
    global--
  }
}
