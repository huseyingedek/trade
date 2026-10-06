// Ağ teşhisi: borsa API'lerine bu bilgisayardan erişilebiliyor mu?
// Kullanım: node scripts/net-check.js
import dns from 'node:dns/promises'

const TARGETS = [
  ['Binance', 'https://api.binance.com/api/v3/ping'],
  ['Bybit', 'https://api.bybit.com/v5/market/time'],
  ['OKX', 'https://www.okx.com/api/v5/public/time'],
  ['Kraken', 'https://api.kraken.com/0/public/Time'],
  ['BtcTurk', 'https://api.btcturk.com/api/v2/server/exchangeinfo'],
  ['OANDA', 'https://api-fxtrade.oanda.com'],
  ['ECB kur', 'https://api.frankfurter.app/latest?from=USD&to=TRY'],
  ['Google (kontrol)', 'https://www.google.com'],
]

console.log(`Node ${process.version} · proxy: ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'yok'}\n`)
for (const [name, url] of TARGETS) {
  const host = new URL(url).hostname
  let ip = '?'
  try {
    const r = await dns.lookup(host, { all: true })
    ip = r.map((x) => x.address).join(', ')
  } catch (e) {
    ip = `DNS HATASI (${e.code})`
  }
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    console.log(`✓ ${name.padEnd(16)} HTTP ${res.status}  ${Date.now() - t0} ms   [${host} → ${ip}]`)
  } catch (e) {
    const c = e.cause || {}
    console.log(`✗ ${name.padEnd(16)} ${e.name === 'TimeoutError' ? 'ZAMAN AŞIMI' : c.code || e.message}  ${c.message || ''}  [${host} → ${ip}]`)
  }
}
