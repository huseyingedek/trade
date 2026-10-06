// =====================================================================
//  Uçtan uca duman testi – çalışan bir API'ye karşı (npm run dev açıkken)
//  Kullanım: npm run smoke   (API_URL=http://localhost:8080/api/v1)
//  Not: Demo kullanıcı (SEED_DEMO=true) ve DEV_2FA_CODE gerektirir. Üretimde ÇALIŞTIRMAYIN.
// =====================================================================
const API = process.env.API_URL || 'http://localhost:8080/api/v1'
const DEV_CODE = process.env.DEV_2FA_CODE || '000000'
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@tradepilo.com'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin12345!'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ` – ${extra}` : ''}`)
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`API: ${API}\n`)
  const meta = await call('GET', '/meta')
  ok('GET /meta', meta.status === 200, `canlı işlem: ${meta.data.liveTradingEnabled}, piyasa: ${meta.data.marketData?.connected ? 'gerçek' : 'simülasyon'}`)

  console.log('\n— Yatırımcı')
  const bad = await call('POST', '/auth/login', { body: { email: 'demo@tradepilo.com', password: 'yanlis123' } })
  ok('hatalı şifre → 401', bad.status === 401)
  let login = await call('POST', '/auth/login', { body: { email: 'demo@tradepilo.com', password: 'Demo12345!' } })
  if (login.data.requires2fa) login = await call('POST', '/auth/2fa', { body: { challengeId: login.data.challengeId, code: DEV_CODE } })
  ok('demo giriş', login.status === 200 && !!login.data.token, login.data.message)
  const T = login.data.token
  if (!T) return
  const me = await call('GET', '/auth/me', { token: T })
  ok('GET /auth/me', me.data.kind === 'user' && !!me.data.plan?.id)

  const ins = await call('GET', '/markets/instruments', { token: T })
  ok('enstrümanlar', ins.data.length >= 20)
  const tick = await call('GET', '/markets/tickers?symbols=BTC/USDT,THYAO', { token: T })
  ok('ticker', tick.data.length === 2 && tick.data[0].last > 0, `BTC ${tick.data[0]?.last} (${tick.data[0]?.source})`)
  const candles = await call('GET', '/markets/candles?symbol=ETH/USDT&interval=1h&limit=50', { token: T })
  ok('mum verisi', Array.isArray(candles.data) && candles.data.length >= 10)
  const book = await call('GET', '/markets/orderbook?symbol=BTC/USDT', { token: T })
  ok('emir defteri', book.data.bids?.length > 0)

  const conns = await call('GET', '/exchanges', { token: T })
  ok('bağlantılar', conns.data.length >= 1)
  const binance = conns.data.find((c) => c.provider === 'binance')
  const bal0 = await call('GET', '/balances', { token: T })
  ok('bakiyeler', bal0.data.length >= 1)

  const buy = await call('POST', '/orders', { token: T, body: { exchangeId: binance.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.01 } })
  ok('piyasa alış emri', buy.status === 200 && buy.data.status === 'filled', buy.data.message)
  const last = tick.data[0].last
  const lim = await call('POST', '/orders', { token: T, body: { exchangeId: binance.id, symbol: 'BTC/USDT', side: 'buy', type: 'limit', qty: 0.001, price: +(last * 0.8).toFixed(2) } })
  ok('limit emir (açık)', lim.data.status === 'open', lim.data.message)
  const big = await call('POST', '/orders', { token: T, body: { exchangeId: binance.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 50 } })
  ok('yetersiz bakiye reddedildi', big.status >= 400, big.data.message)
  const pos = await call('GET', '/positions', { token: T })
  ok('pozisyon oluştu', pos.data.some((p) => p.symbol === 'BTC/USDT'))
  const p = pos.data.find((x) => x.symbol === 'BTC/USDT')
  const upd = await call('PATCH', `/positions/${p.id}`, { token: T, body: { stopLoss: +(last * 0.5).toFixed(2) } })
  ok('SL güncelle', upd.status === 200, upd.data.message)
  const cancel = await call('DELETE', `/orders/${lim.data.id}`, { token: T })
  ok('emir iptal', cancel.data.status === 'canceled')

  const rule = await call('POST', '/rules', { token: T, body: { name: 'BTC alarm', symbol: 'BTC/USDT', trigger: { type: 'price_above', value: 1 }, action: { type: 'notify' }, repeat: 'once' } })
  ok('kural oluştur', rule.status === 200, rule.data.message)
  const bot = await call('POST', '/bots', { token: T, body: { name: 'ETH DCA', strategy: 'dca', exchangeId: binance.id, symbol: 'ETH/USDT', investment: 500, config: { amount: 50, intervalHours: 1, maxOrders: 5 }, autoStart: true } })
  ok('bot oluştur + başlat', bot.status === 200 && bot.data.status === 'running', bot.data.message)

  const risk = await call('GET', '/risk', { token: T })
  ok('risk durumu', risk.status === 200 && risk.data.killSwitch?.active === false)
  const kill = await call('POST', '/risk/kill-switch', { token: T, body: { active: true, reason: 'test', cancelOrders: true } })
  ok('acil durdurma', kill.data.killSwitch?.active === true)
  const blocked = await call('POST', '/orders', { token: T, body: { exchangeId: binance.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.001 } })
  ok('durdurma sırasında emir engellendi', blocked.status === 423, blocked.data.message)
  const unkill = await call('POST', '/risk/kill-switch', { token: T, body: { active: false } })
  ok('durdurma kaldırıldı', unkill.data.killSwitch?.active === false)

  await sleep(2500)
  const rules = await call('GET', '/rules', { token: T })
  ok('kural motoru tetikledi', rules.data.find((r) => r.id === rule.data.id)?.triggerCount >= 1)
  const close = await call('POST', `/positions/${p.id}/close`, { token: T, body: { percent: 100 } })
  ok('pozisyon kapat', close.data.status === 'filled', close.data.message)
  const sum = await call('GET', '/portfolio/summary', { token: T })
  ok('portföy özeti', sum.data.totalValue > 0, `$${Math.round(sum.data.totalValue)}`)
  const hist = await call('GET', '/portfolio/history?range=1D', { token: T })
  ok('portföy geçmişi', hist.data.points?.length >= 1)
  const act = await call('GET', '/activity?limit=10', { token: T })
  ok('aktivite günlüğü', act.data.length > 0)
  const ann = await call('GET', '/announcements/active', { token: T })
  ok('aktif duyurular/platform', ann.data.platform && ann.data.account)
  const adm = await call('GET', '/admin/overview', { token: T })
  ok('yatırımcı admin API kullanamaz', adm.status === 403)

  console.log('\n— Admin')
  const a1 = await call('POST', '/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  ok('admin giriş → 2FA', a1.data.requires2fa === true, a1.data.setupRequired ? 'ilk kurulum (QR)' : 'kod')
  const a2 = await call('POST', '/auth/2fa', { body: { challengeId: a1.data.challengeId, code: DEV_CODE } })
  ok('2FA doğrulama', !!a2.data.token, a2.data.message)
  const A = a2.data.token
  if (!A) return
  const ov = await call('GET', '/admin/overview', { token: A })
  ok('genel bakış', ov.status === 200 && ov.data.kpis.totalUsers >= 1, `${ov.data.kpis?.totalUsers} kullanıcı`)
  const users = await call('GET', '/admin/users?q=demo', { token: A })
  ok('kullanıcı arama', users.data.items?.length === 1)
  const uid = users.data.items[0].id
  const det = await call('GET', `/admin/users/${uid}`, { token: A })
  ok('kullanıcı detayı', det.data.user?.id === uid && Array.isArray(det.data.connections))
  ok('API anahtarı sızmıyor', !JSON.stringify(det.data).includes('credentialsEnc'))
  const tradeAsAdmin = await call('POST', '/orders', { token: A, body: {} })
  ok('admin emir veremez', tradeAsAdmin.status === 403)
  const halt = await call('PATCH', `/admin/users/${uid}`, { token: A, body: { status: 'trading_halted', reason: 'Smoke test durdurma' } })
  ok('kullanıcı işlem durdurma', halt.data.status === 'trading_halted')
  const tryOrder = await call('POST', '/orders', { token: T, body: { exchangeId: binance.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.001 } })
  ok('durdurulan kullanıcı emir veremez', tryOrder.status === 423, tryOrder.data.message)
  await call('PATCH', `/admin/users/${uid}`, { token: A, body: { status: 'active' } })
  const note = await call('POST', `/admin/users/${uid}/notes`, { token: A, body: { text: 'Smoke test notu' } })
  ok('not ekle', note.data.notes?.length >= 1)
  const plat = await call('PATCH', '/admin/platform', { token: A, body: { maxLeverage: 20 } })
  ok('platform ayarı', plat.data.maxLeverage === 20)
  await call('PATCH', '/admin/platform', { token: A, body: { maxLeverage: 10 } })
  const prov = await call('GET', '/admin/providers', { token: A })
  ok('entegrasyon sağlığı', prov.data.providers?.length >= 5)
  const plans = await call('GET', '/admin/plans', { token: A })
  ok('planlar', plans.data.length === 4)
  const pay = await call('GET', '/admin/payments', { token: A })
  ok('ödemeler', Array.isArray(pay.data.items) && pay.data.monthly?.length === 6)
  const an = await call('POST', '/admin/announcements', { token: A, body: { title: 'Test', message: 'Smoke test duyurusu', level: 'info', audience: 'all' } })
  ok('duyuru oluştur', an.status === 200, an.data.message)
  const seen = await call('GET', '/announcements/active', { token: T })
  ok('kullanıcı duyuruyu görüyor', seen.data.announcements.some((x) => x.id === an.data.id))
  await call('DELETE', `/admin/announcements/${an.data.id}`, { token: A })
  const audit = await call('GET', '/admin/audit', { token: A })
  ok('denetim günlüğü', audit.data.length >= 3)
  const team = await call('GET', '/admin/team', { token: A })
  ok('ekip', team.data.admins?.length >= 1 && !!team.data.roles.super_admin)

  // temizlik
  await call('POST', `/bots/${bot.data.id}/stop`, { token: T })
  await call('DELETE', `/bots/${bot.data.id}`, { token: T })
  await call('DELETE', `/rules/${rule.data.id}`, { token: T })
  await call('POST', '/auth/logout', { token: A })
}

main()
  .catch((e) => {
    fail++
    console.error('\n✗ Beklenmeyen hata:', e.message)
  })
  .finally(() => {
    console.log(`\n${fail ? '❌' : '✅'} ${pass} başarılı, ${fail} başarısız`)
    process.exitCode = fail ? 1 : 0
  })
