// =====================================================================
//  Tradepilo API – giriş noktası
// =====================================================================
import { config } from './config.js'
import { buildApp } from './app.js'
import { prisma } from './lib/prisma.js'
import { feed } from './market/feed.js'
import { startJobs, stopJobs } from './jobs/scheduler.js'
import { productionChecks } from './lib/prodChecks.js'

const app = await buildApp()

try {
  await prisma.$queryRaw`SELECT 1`
} catch (e) {
  app.log.fatal(`Veritabanına bağlanılamadı (${e.message}). DATABASE_URL'i ve PostgreSQL'in çalıştığını kontrol edin.`)
  process.exit(1)
}
if (!(await prisma.plan.count())) {
  app.log.fatal('Veritabanı boş görünüyor. Önce "npm run setup" (migrate + seed) çalıştırın.')
  process.exit(1)
}

await productionChecks(app.log).catch((e) => app.log.warn(`production kontrolleri çalıştırılamadı: ${e.message}`))
await feed.start()
startJobs()
await app.listen({ host: config.HOST, port: config.PORT })
app.log.info(`🚀 Tradepilo API hazır → port ${config.PORT}  ·  REST /api/v1  ·  WebSocket /ws`)
app.log.info(`   Canlı işlem: ${config.LIVE_TRADING_ENABLED ? 'AÇIK ⚠️' : 'kapalı (paper mod)'} · Piyasa verisi: ${config.MARKET_DATA}`)

let closing = false
async function shutdown(sig) {
  if (closing) return
  closing = true
  app.log.info(`${sig} alındı, kapatılıyor…`)
  stopJobs()
  feed.stop()
  await app.close().catch(() => {})
  await prisma.$disconnect().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (e) => app.log.error({ err: e }, 'unhandledRejection'))
