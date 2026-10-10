// =====================================================================
//  ALGORİTMA TESTLERİ – emir motoru, defter (bakiye/pozisyon), tasfiye,
//  koşullu emirler, SL/TP, botlar, kurallar, risk.
//  Fiyatlar test tarafından elle belirlenir (deterministik).
//
//  Çalıştırma (AYRI bir test veritabanı ile – production DB KULLANMAYIN):
//    TEST_DATABASE_URL=postgresql://.../tradenest_test npm run test:algo
//  Test veritabanında "npm run setup" ile tablolar + başlangıç verisi olmalı.
// =====================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = !TEST_DB && 'TEST_DATABASE_URL tanımlı değil – algoritma testleri atlandı'

if (TEST_DB) {
  if (/neon\.tech/.test(TEST_DB) && !process.env.ALLOW_REMOTE_TEST_DB) throw new Error('Uzak (Neon) veritabanında test çalıştırılmaz. Yerel bir test DB kullanın veya ALLOW_REMOTE_TEST_DB=1 verin.')
  process.env.DATABASE_URL = TEST_DB
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET ??= 'algo-test-secret-algo-test-secret-123456'
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64')
  process.env.LIVE_TRADING_ENABLED = 'true' // sadece "canlıda kaldıraç yasak" kontrolünü test etmek için (borsaya istek gitmez)
  process.env.TRADING_FEE_RATE = '0.001'
  process.env.LOG_LEVEL = 'silent'
}

let prisma, feed, encrypt, placeOrder, cancelOrder, closePosition, processOrders, processProtection, processRules, createRule
let createBot, processBots, setKillSwitch, totalValueUsd, num
const FEE = 0.001
const users = []
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b} bekleniyordu`)

function setPx(symbol, px) {
  const st = feed.state.get(symbol)
  Object.assign(st, { last: px, bid: px, ask: px, high: Math.max(st.high, px), low: Math.min(st.low, px), source: 'sim', liveAt: 0 })
}
async function cash(exchangeId, asset = 'USDT') {
  const b = await prisma.balance.findUnique({ where: { exchangeId_asset: { exchangeId, asset } } })
  return num(b?.free ?? 0)
}
const pos = (exchangeId, symbol) => prisma.position.findUnique({ where: { exchangeId_symbol: { exchangeId, symbol } } })

/** Pro planlı kullanıcı + paper Binance (spot) + paper Bybit (vadeli/açığa satış) */
async function makeUser(opts = {}) {
  const u = await prisma.user.create({
    data: { email: `algo-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, name: 'Algo Test', passwordHash: 'x', planId: opts.plan || 'expert' },
  })
  users.push(u.id)
  await prisma.riskSettings.create({ data: { userId: u.id, maxPositionPct: opts.maxPositionPct ?? 100, maxOpenOrders: 100, dailyLossEnabled: false } })
  const mk = (provider, label, perms, amount) =>
    prisma.exchangeAccount.create({
      data: { userId: u.id, provider, label, market: 'crypto', mode: 'paper', credentialsEnc: encrypt({}), apiKeyMasked: 'test', permissions: perms, balances: { create: { asset: 'USDT', free: amount } } },
    })
  const spot = await mk('binance', 'Spot', ['read', 'spot'], opts.cash ?? 10000)
  const fut = await mk('bybit', 'Futures', ['read', 'spot', 'futures'], opts.cash ?? 10000)
  return { user: u, spot, fut }
}

before(async () => {
  if (skip) return
  ;({ prisma } = await import('../src/lib/prisma.js'))
  ;({ feed } = await import('../src/market/feed.js'))
  ;({ encrypt } = await import('../src/lib/crypto.js'))
  ;({ num } = await import('../src/lib/serialize.js'))
  ;({ placeOrder, cancelOrder, closePosition } = await import('../src/trading/orders.js'))
  ;({ processOrders, processProtection } = await import('../src/trading/engine.js'))
  ;({ processRules, createRule } = await import('../src/automation/rules.js'))
  ;({ createBot, processBots } = await import('../src/automation/bots.js'))
  ;({ setKillSwitch } = await import('../src/trading/risk.js'))
  ;({ totalValueUsd } = await import('../src/trading/portfolio.js'))
  await feed.reload()
  setPx('BTC/USDT', 60000)
  setPx('ETH/USDT', 3000)
  setPx('XRP/USDT', 1.5)
})

after(async () => {
  if (skip) return
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

// ------------------------------------------------------------------ defter
test('spot al-sat: nakit, komisyon ve gerçekleşen K/Z kuruşu kuruşuna doğru', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, spot } = await makeUser()
  const b = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1 })
  assert.equal(b.status, 'filled')
  near(await cash(spot.id), 10000 - 0.1 * b.avgPrice * (1 + FEE))
  const p = await pos(spot.id, 'BTC/USDT')
  near(num(p.qty), 0.1)
  near(num(p.margin), 0.1 * b.avgPrice)

  setPx('BTC/USDT', 66000)
  const s = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'sell', type: 'market', qty: 0.1 })
  near(s.realizedPnl, (s.avgPrice - b.avgPrice) * 0.1)
  assert.equal(await pos(spot.id, 'BTC/USDT'), null)
  // son nakit = başlangıç + K/Z – iki komisyon
  near(await cash(spot.id), 10000 + s.realizedPnl - b.fee - s.fee)
})

test('kısmi kapatma: miktar ve teminat orantılı azalır, giriş fiyatı değişmez', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const b = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 2 })
  const p0 = await pos(spot.id, 'ETH/USDT')
  await closePosition(user.id, p0.id, 25)
  const p1 = await pos(spot.id, 'ETH/USDT')
  near(num(p1.qty), 1.5)
  near(num(p1.margin), num(p0.margin) * 0.75)
  near(num(p1.entryPrice), b.avgPrice)
})

test('ortalama maliyet: aynı yöne ekleme ağırlıklı ortalama giriş fiyatı üretir', { skip }, async () => {
  const { user, spot } = await makeUser()
  setPx('ETH/USDT', 3000)
  const a = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  setPx('ETH/USDT', 2000)
  const b = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  const p = await pos(spot.id, 'ETH/USDT')
  near(num(p.entryPrice), (a.avgPrice + b.avgPrice) / 2)
  near(num(p.qty), 2)
})

test('spot hesapta açığa satış ve pozisyondan fazla satış reddedilir', { skip }, async () => {
  setPx('XRP/USDT', 1.5)
  const { user, spot } = await makeUser()
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'sell', type: 'market', qty: 10 }), /yeterli pozisyon/)
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'buy', type: 'market', qty: 100 })
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'sell', type: 'market', qty: 150 }), /yeterli pozisyon/)
})

test('bekleyen satış emirleri pozisyonu rezerve eder', { skip }, async () => {
  setPx('XRP/USDT', 1.5)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'buy', type: 'market', qty: 100 })
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'sell', type: 'limit', qty: 100, price: 2 })
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'XRP/USDT', side: 'sell', type: 'limit', qty: 10, price: 2.1 }), /Satılabilir miktar/)
})

test('yetersiz bakiye reddedilir, bekleyen alış emirleri nakdi kilitler', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser({ cash: 1000 })
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 }), /Yetersiz bakiye/)
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.3, price: 2900 }) // 870 kilitli
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1 }), /Yetersiz bakiye/)
})

// ------------------------------------------------------------------ kaldıraç / açığa satış / tasfiye
test('kaldıraçlı açığa satış: teminat = tutar / kaldıraç, kâr doğru', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, fut } = await makeUser()
  const o = await placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'sell', type: 'market', qty: 0.1, leverage: 5 })
  const p = await pos(fut.id, 'BTC/USDT')
  assert.equal(p.side, 'short')
  near(num(p.margin), (0.1 * o.avgPrice) / 5)
  setPx('BTC/USDT', 57000)
  const c = await closePosition(user.id, p.id, 100)
  near(c.realizedPnl, (o.avgPrice - c.avgPrice) * 0.1)
  near(await cash(fut.id), 10000 + c.realizedPnl - o.fee - c.fee)
})

test('tasfiye: teminatın %90ı kaybedilince pozisyon kapanır, bakiye eksiye düşmez', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, fut } = await makeUser()
  await placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 }) // teminat ~600
  setPx('BTC/USDT', 55500) // −%7.5 → teminatın %75'i kayıp → henüz tasfiye yok
  await processProtection()
  assert.ok(await pos(fut.id, 'BTC/USDT'))
  setPx('BTC/USDT', 54500) // −%9.2 → >%90 kayıp → tasfiye
  await processProtection()
  assert.equal(await pos(fut.id, 'BTC/USDT'), null)
  assert.ok((await cash(fut.id)) > 0)
  const act = await prisma.activity.findFirst({ where: { userId: user.id, message: { contains: 'Tasfiye' } } })
  assert.ok(act, 'tasfiye aktivitesi yazılmalı')
})

test('fiyat boşluğu: kayıp hiçbir zaman teminatı aşmaz', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, fut } = await makeUser()
  const o = await placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.1, leverage: 10 })
  const margin = num((await pos(fut.id, 'BTC/USDT')).margin)
  setPx('BTC/USDT', 30000) // −%50 ani düşüş (teminatın 5 katı zarar)
  assert.ok((await totalValueUsd(user.id)) >= 0)
  await processProtection()
  const after = await cash(fut.id)
  near(after, 10000 - margin - o.fee - 0.1 * 30000 * FEE, 1e-4) // sadece teminat + komisyonlar kaybedildi
})

test('mevcut pozisyona farklı kaldıraçla ekleme reddedilir', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, fut } = await makeUser()
  await placeOrder(user.id, { exchangeId: fut.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1, leverage: 3 })
  await assert.rejects(placeOrder(user.id, { exchangeId: fut.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1, leverage: 5 }), /aynı kaldıraç/)
})

test('canlı hesapta kaldıraç ve açığa satış engellenir (borsaya istek gitmeden)', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, fut } = await makeUser()
  await prisma.exchangeAccount.update({ where: { id: fut.id }, data: { mode: 'live' } })
  await assert.rejects(placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.01, leverage: 3 }), /kaldıraçsız/)
  await assert.rejects(placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'sell', type: 'market', qty: 0.01 }), /açığa satış/)
})

// ------------------------------------------------------------------ koşullu emirler
test('limit alış: fiyat limite inene kadar bekler, limit fiyatından dolar', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 1, price: 2900 })
  assert.equal(o.status, 'open')
  setPx('ETH/USDT', 2950)
  await processOrders()
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'open')
  setPx('ETH/USDT', 2890)
  await processOrders()
  const f = await prisma.order.findUnique({ where: { id: o.id } })
  assert.equal(f.status, 'filled')
  near(num(f.avgPrice), 2900)
})

test('stop-piyasa satış: stop seviyesine inince tetiklenir', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'sell', type: 'stop_market', qty: 1, stopPrice: 2800 })
  setPx('ETH/USDT', 2850)
  await processOrders()
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'open')
  setPx('ETH/USDT', 2790)
  await processOrders()
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'filled')
  assert.equal(await pos(spot.id, 'ETH/USDT'), null)
})

test('stop-limit: önce tetiklenir, sonra limit fiyatı gelince dolar', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'stop_limit', qty: 1, stopPrice: 3100, price: 3120 })
  setPx('ETH/USDT', 3150) // tetiklenir ama 3150 > 3120 → dolmaz
  await processOrders()
  let f = await prisma.order.findUnique({ where: { id: o.id } })
  assert.equal(f.triggered, true)
  assert.equal(f.status, 'open')
  setPx('ETH/USDT', 3110)
  await processOrders()
  f = await prisma.order.findUnique({ where: { id: o.id } })
  assert.equal(f.status, 'filled')
  near(num(f.avgPrice), 3120)
})

test('iz süren stop: tepe fiyatı takip eder, tepeden %5 düşünce satar', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.05 })
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'sell', type: 'trailing_stop', qty: 0.05, trailingPct: 5 })
  for (const px of [62000, 65000, 70000]) {
    setPx('BTC/USDT', px)
    await processOrders()
  }
  near((await prisma.order.findUnique({ where: { id: o.id } })).refPrice, 70000)
  setPx('BTC/USDT', 66600) // 70000*0.95 = 66500 → henüz değil
  await processOrders()
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'open')
  setPx('BTC/USDT', 66400)
  await processOrders()
  assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'filled')
})

test('OCO satış: kâr-al seviyesinde dolar', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'buy', type: 'market', qty: 0.05 })
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'BTC/USDT', side: 'sell', type: 'oco', qty: 0.05, price: 63000, stopPrice: 58000 })
  setPx('BTC/USDT', 63100)
  await processOrders()
  const f = await prisma.order.findUnique({ where: { id: o.id } })
  assert.equal(f.status, 'filled')
  near(num(f.avgPrice), 63000)
})

test('emir iptali kilitli nakdi serbest bırakır', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser({ cash: 1000 })
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.3, price: 2900 })
  await cancelOrder(user.id, o.id)
  const m = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.3 })
  assert.equal(m.status, 'filled')
})

// ------------------------------------------------------------------ SL / TP
test('zarar-kes ve kâr-al pozisyonu otomatik kapatır', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1, stopLoss: 2700, takeProfit: 3300 })
  setPx('ETH/USDT', 2800)
  await processProtection()
  assert.ok(await pos(spot.id, 'ETH/USDT'))
  setPx('ETH/USDT', 2690)
  await processProtection()
  assert.equal(await pos(spot.id, 'ETH/USDT'), null)

  setPx('ETH/USDT', 3000)
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1, takeProfit: 3300 })
  setPx('ETH/USDT', 3310)
  await processProtection()
  assert.equal(await pos(spot.id, 'ETH/USDT'), null)
})

// ------------------------------------------------------------------ risk
test('pozisyon limiti birikimli kontrol edilir (küçük emirlerle aşılamaz)', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser({ maxPositionPct: 30 }) // toplam 20.000 → pozisyon başına 6.000
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1.5 }) // 4.500
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 }), /Risk limiti/) // 7.500 > 6.000
})

test('acil durdurma: yeni emirleri engeller, botları duraklatır, açık emirleri iptal eder', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const lim = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.1, price: 2000 })
  const bot = await createBot(user.id, { name: 'dca', strategy: 'dca', exchangeId: spot.id, symbol: 'ETH/USDT', investment: 500, config: { amount: 50, intervalHours: 24, maxOrders: 10 }, autoStart: true })
  await setKillSwitch(user.id, { active: true, reason: 'test', cancelOrders: true }, 'manual')
  assert.equal((await prisma.order.findUnique({ where: { id: lim.id } })).status, 'canceled')
  assert.equal((await prisma.bot.findUnique({ where: { id: bot.id } })).status, 'paused')
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1 }), /Acil durdurma/)
  await setKillSwitch(user.id, { active: false }, 'manual')
  const ok = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1 })
  assert.equal(ok.status, 'filled')
})

// ------------------------------------------------------------------ botlar
async function runBot(botId) {
  await processBots()
  return prisma.bot.findUnique({ where: { id: botId } })
}

test('grid bot: düşüşte alır, bir kademe yükselişte satar; K/Z komisyon düşülmüş', { skip }, async () => {
  setPx('XRP/USDT', 1.5)
  const { user, spot } = await makeUser()
  const bot = await createBot(user.id, { name: 'grid', strategy: 'grid', exchangeId: spot.id, symbol: 'XRP/USDT', investment: 100, config: { lower: 1.4, upper: 1.6, grids: 10 }, autoStart: true })
  // kademeler 0.02: …1.48, 1.50… → 1.5'ten 1.479'a düşüş 1.48 kademesinde alım
  await runBot(bot.id) // ilk adım: sadece son fiyatı kaydeder
  setPx('XRP/USDT', 1.479)
  let b = await runBot(bot.id)
  assert.equal(b.trades, 1)
  assert.equal(Object.keys(b.state.holdings).length, 1)
  setPx('XRP/USDT', 1.501) // 1.48 + 0.02 = 1.50 satış seviyesi
  b = await runBot(bot.id)
  assert.equal(b.trades, 2)
  assert.equal(Object.keys(b.state.holdings).length, 0)
  const fills = await prisma.order.findMany({ where: { botId: bot.id, status: 'filled' }, orderBy: { createdAt: 'asc' } })
  assert.equal(fills.length, 2)
  const gross = (num(fills[1].avgPrice) - num(fills[0].avgPrice)) * num(fills[0].qty)
  const fees = num(fills[0].fee) + num(fills[1].fee)
  near(b.pnl, Math.round((gross - fees) * 100) / 100, 1e-9)
})

test('grid bot: aralık dışında işlem yapmaz', { skip }, async () => {
  setPx('XRP/USDT', 1.5)
  const { user, spot } = await makeUser()
  const bot = await createBot(user.id, { name: 'grid2', strategy: 'grid', exchangeId: spot.id, symbol: 'XRP/USDT', investment: 100, config: { lower: 1.4, upper: 1.6, grids: 10 }, autoStart: true })
  await runBot(bot.id)
  setPx('XRP/USDT', 1.3)
  const b = await runBot(bot.id)
  assert.equal(b.trades, 0)
})

test('DCA bot: aralıkla alır, hedef kârda tümünü satar, bütçeyi aşmaz', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const bot = await createBot(user.id, { name: 'dca', strategy: 'dca', exchangeId: spot.id, symbol: 'ETH/USDT', investment: 300, config: { amount: 100, intervalHours: 0.0001, takeProfitPct: 5, maxOrders: 10 }, autoStart: true })
  let b = await runBot(bot.id)
  assert.equal(b.trades, 1)
  for (const px of [2900, 2800, 2700]) {
    await new Promise((r) => setTimeout(r, 400))
    setPx('ETH/USDT', px)
    b = await runBot(bot.id)
  }
  assert.equal(b.trades, 3, 'bütçe 300 / 100 → en fazla 3 alım')
  near(b.state.cost, 300, 0.05)
  const avg = b.state.cost / b.state.qty
  setPx('ETH/USDT', avg * 1.051)
  b = await runBot(bot.id)
  assert.equal(b.trades, 4)
  assert.equal(b.state.qty, 0)
  assert.ok(b.pnl > 0)
})

test('iz süren stop botu: alır, tepeyi takip eder, geri çekilmede satar ve durur', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, spot } = await makeUser()
  const bot = await createBot(user.id, { name: 'trail', strategy: 'trailing', exchangeId: spot.id, symbol: 'BTC/USDT', investment: 1000, config: { trailingPct: 3 }, autoStart: true })
  await runBot(bot.id)
  setPx('BTC/USDT', 66000)
  await runBot(bot.id)
  setPx('BTC/USDT', 64100) // 66000*0.97 = 64020 → henüz değil
  let b = await runBot(bot.id)
  assert.equal(b.status, 'running')
  setPx('BTC/USDT', 64000)
  b = await runBot(bot.id)
  assert.equal(b.status, 'stopped')
  assert.ok(b.pnl > 0)
})

test('bot durdurulurken motor durumu "çalışıyor"a geri çevirmez', { skip }, async () => {
  setPx('XRP/USDT', 1.5)
  const { user, spot } = await makeUser()
  const bot = await createBot(user.id, { name: 'race', strategy: 'grid', exchangeId: spot.id, symbol: 'XRP/USDT', investment: 100, config: { lower: 1.4, upper: 1.6, grids: 10 }, autoStart: true })
  await prisma.bot.update({ where: { id: bot.id }, data: { status: 'stopped' } }) // kullanıcı durdurdu
  await processBots()
  assert.equal((await prisma.bot.findUnique({ where: { id: bot.id } })).status, 'stopped')
})

// ------------------------------------------------------------------ kurallar
test('kural: fiyat koşulu bir kez tetiklenir ve devre dışı kalır; alım aksiyonu çalışır', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const r = await createRule(user.id, { name: 'dipten al', exchangeId: spot.id, symbol: 'ETH/USDT', trigger: { type: 'price_below', value: 2800 }, action: { type: 'market_buy', qty: 0.1 }, repeat: 'once' })
  await processRules()
  assert.equal((await prisma.rule.findUnique({ where: { id: r.id } })).triggerCount, 0)
  setPx('ETH/USDT', 2790)
  await processRules()
  const after = await prisma.rule.findUnique({ where: { id: r.id } })
  assert.equal(after.triggerCount, 1)
  assert.equal(after.enabled, false)
  near(num((await pos(spot.id, 'ETH/USDT')).qty), 0.1)
  await processRules() // tekrar tetiklenmez
  near(num((await pos(spot.id, 'ETH/USDT')).qty), 0.1)
})

test('kural: tekrarlı kural koşul bozulup yeniden oluşunca tekrar tetiklenir', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user } = await makeUser()
  const r = await createRule(user.id, { name: 'alarm', symbol: 'ETH/USDT', trigger: { type: 'price_above', value: 3100 }, action: { type: 'notify' }, repeat: 'always', cooldownSec: 0 })
  setPx('ETH/USDT', 3150)
  await processRules()
  await processRules() // koşul sürerken tekrar tetiklenmez
  assert.equal((await prisma.rule.findUnique({ where: { id: r.id } })).triggerCount, 1)
  setPx('ETH/USDT', 3050)
  await processRules()
  setPx('ETH/USDT', 3160)
  await processRules()
  assert.equal((await prisma.rule.findUnique({ where: { id: r.id } })).triggerCount, 2)
})

// ------------------------------------------------------------------ portföy
test('portföy değeri = nakit + pozisyon değerleri (fiyat değişince doğru güncellenir)', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const o = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  const c = await cash(spot.id)
  setPx('ETH/USDT', 3300)
  near(await totalValueUsd(user.id), c + 10000 + o.avgPrice * 1 + (3300 - o.avgPrice) * 1)
})

test('kural: pozisyon K/Z eşiğinde pozisyonu kapatır', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  await createRule(user.id, { name: 'zarar sınırı', exchangeId: spot.id, symbol: 'ETH/USDT', trigger: { type: 'position_pnl_below', value: -5 }, action: { type: 'close_position' }, repeat: 'once' })
  setPx('ETH/USDT', 2900) // ~ -%3.4
  await processRules()
  assert.ok(await pos(spot.id, 'ETH/USDT'))
  setPx('ETH/USDT', 2840) // ~ -%5.4
  await processRules()
  assert.equal(await pos(spot.id, 'ETH/USDT'), null)
})

test('kural: acil durdurma aksiyonu kill switch açar', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user } = await makeUser()
  await createRule(user.id, { name: 'çöküş', symbol: 'BTC/USDT', trigger: { type: 'price_below', value: 50000 }, action: { type: 'kill_switch' }, repeat: 'once' })
  setPx('BTC/USDT', 49000)
  await processRules()
  assert.equal((await prisma.riskSettings.findUnique({ where: { userId: user.id } })).killSwitchActive, true)
})

test('günlük zarar limiti aşılınca otomatik acil durdurma', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const { checkDailyLoss } = await import('../src/trading/risk.js')
  const { ensureDayStart } = await import('../src/trading/portfolio.js')
  await prisma.riskSettings.update({ where: { userId: user.id }, data: { dailyLossEnabled: true, dailyLossPct: 5 } })
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 3 }) // ~9000 ETH
  await ensureDayStart(user.id)
  setPx('ETH/USDT', 2700) // −900 ≈ toplam 20.000'in %4,5'i → limit altında
  await checkDailyLoss()
  assert.equal((await prisma.riskSettings.findUnique({ where: { userId: user.id } })).killSwitchActive, false)
  setPx('ETH/USDT', 2600) // −1200 ≈ %6 → limit aşıldı
  await checkDailyLoss()
  assert.equal((await prisma.riskSettings.findUnique({ where: { userId: user.id } })).killSwitchActive, true)
})

// ---------------------------------------------------------------- durdurmalar bekleyen emirleri de kapsar
const statusOf = async (id) => (await prisma.order.findUnique({ where: { id } })).status

test('acil durdurma (emirler iptal edilmeden): tetiklenen açılış emri bekler, pozisyon azaltan emir gerçekleşir', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 1 })
  const buy = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.1, price: 2900 })
  const stop = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'sell', type: 'stop_market', qty: 0.5, stopPrice: 2950 })
  await setKillSwitch(user.id, { active: true, reason: 'test' }, 'manual')
  setPx('ETH/USDT', 2850)
  await processOrders()
  assert.equal(await statusOf(buy.id), 'open', 'yeni pozisyon açan emir durdurmada gerçekleşmemeli')
  assert.equal(await statusOf(stop.id), 'filled', 'koruyucu (pozisyon azaltan) stop durdurmada da çalışmalı')
  await setKillSwitch(user.id, { active: false }, 'manual')
  await processOrders()
  assert.equal(await statusOf(buy.id), 'filled', 'durdurma kalkınca emir yeniden değerlendirilir')
})

test('platform global durdurma ve kullanıcı durdurma bekleyen emirleri gerçekleştirmez', { skip }, async () => {
  const { invalidatePlatform } = await import('../src/services/platform.js')
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  const buy = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.1, price: 2900 })
  try {
    await prisma.platformSetting.update({ where: { id: 1 }, data: { killSwitchActive: true, killReason: 'test' } })
    invalidatePlatform()
    setPx('ETH/USDT', 2850)
    await processOrders()
    assert.equal(await statusOf(buy.id), 'open')
  } finally {
    await prisma.platformSetting.update({ where: { id: 1 }, data: { killSwitchActive: false, killReason: null } })
    invalidatePlatform()
  }
  await prisma.user.update({ where: { id: user.id }, data: { status: 'trading_halted' } })
  await processOrders()
  assert.equal(await statusOf(buy.id), 'open')
  await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } })
  await processOrders()
  assert.equal(await statusOf(buy.id), 'filled')
  setPx('ETH/USDT', 3000)
})

test('bekleyen açığa satış emirleri teminat kilitler (aynı nakit iki kez kullanılamaz)', { skip }, async () => {
  setPx('BTC/USDT', 60000)
  const { user, fut } = await makeUser({ cash: 1000 })
  // 5x kaldıraçla 0,05 BTC @ 61.000 = 3.050$ tutar → 610$ teminat
  const first = await placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'sell', type: 'limit', qty: 0.05, price: 61000, leverage: 5 })
  assert.equal(first.status, 'open')
  await assert.rejects(placeOrder(user.id, { exchangeId: fut.id, symbol: 'BTC/USDT', side: 'sell', type: 'limit', qty: 0.05, price: 61000, leverage: 5 }), /Yetersiz bakiye/)
})

test('geçersiz sayılar ve tutarsız SL/TP 400 ile reddedilir (500 değil)', { skip }, async () => {
  setPx('ETH/USDT', 3000)
  const { user, spot } = await makeUser()
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', qty: 0.1, price: 'abc' }), (e) => e.status === 400)
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1, stopLoss: 3100 }), /Zarar-kes/)
  await assert.rejects(placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1, takeProfit: -5 }), (e) => e.status === 400)
  const ok = await placeOrder(user.id, { exchangeId: spot.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', qty: 0.1, stopLoss: 2800, takeProfit: 3300 })
  assert.equal(ok.status, 'filled')
})

// ---------------------------------------------------------------- kimlik: e-posta değişikliği ve 2FA denemeleri
test('e-posta değişikliği mevcut şifre olmadan yapılamaz; değişince doğrulama sıfırlanır', { skip }, async () => {
  const bcrypt = (await import('bcryptjs')).default
  const auth = await import('../src/services/auth.js')
  const { user } = await makeUser()
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash('Sifre12345', 4), emailVerifiedAt: new Date() } })
  const newEmail = `yeni-${Date.now()}@test.local`
  await assert.rejects(auth.updateMe(user.id, { email: newEmail }), (e) => e.code === 'PASSWORD_REQUIRED')
  await assert.rejects(auth.updateMe(user.id, { email: newEmail, currentPassword: 'yanlis' }), (e) => e.code === 'PASSWORD_REQUIRED')
  // aynı e-posta + isim değişikliği şifresiz serbest
  await auth.updateMe(user.id, { email: user.email, name: 'Yeni Ad' })
  const me = await auth.updateMe(user.id, { email: newEmail, currentPassword: 'Sifre12345' })
  assert.equal(me.email, newEmail)
  assert.equal(me.emailVerified, false)
})

test('2FA: paralel denemeler 5 hakkı aşamaz', { skip }, async () => {
  const auth = await import('../src/services/auth.js')
  const { encrypt: enc } = await import('../src/lib/crypto.js')
  const { newSecret } = await import('../src/lib/totp.js')
  const { user } = await makeUser()
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true, twoFactorSecretEnc: enc(newSecret()) } })
  const ch = await prisma.loginChallenge.create({ data: { userId: user.id, purpose: 'login', expiresAt: new Date(Date.now() + 60_000) } })
  const res = await Promise.allSettled(Array.from({ length: 20 }, () => auth.verify2fa({ challengeId: ch.id, code: '123456' }, { ip: '1', ua: 't' })))
  const wrong = res.filter((r) => r.status === 'rejected' && r.reason.code === 'INVALID_2FA').length
  assert.ok(wrong <= 5, `en fazla 5 kod denenmeli, ${wrong} denendi`)
  assert.equal((await prisma.loginChallenge.findUnique({ where: { id: ch.id } })).attempts, 5)
})
