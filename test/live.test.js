// =====================================================================
//  CANLI (live) EMİR AKIŞI – borsa adaptörü sahte (mock) ile, ağa istek gitmez.
//  Binance davranışı: alışta komisyon ALINAN coinden kesilir (100 ADA al → 99.9 ADA gelir).
//    TEST_DATABASE_URL=postgresql://.../tradenest_test node --test test/live.test.js
// =====================================================================
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import ccxt from 'ccxt'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = !TEST_DB && 'TEST_DATABASE_URL tanımlı değil – canlı akış testleri atlandı'
if (TEST_DB) {
  if (/neon\.tech/.test(TEST_DB) && !process.env.ALLOW_REMOTE_TEST_DB) throw new Error('Uzak veritabanında test çalıştırılmaz')
  process.env.DATABASE_URL = TEST_DB
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET ??= 'live-test-secret-live-test-secret-1234567'
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
  process.env.LIVE_TRADING_ENABLED = 'true'
  process.env.LOG_LEVEL = 'silent'
}

let prisma, feed, encrypt, num, placeOrder, cancelOrder, closePosition, processOrders, pollLiveOrders, ccxtAdapter, providerById
const users = []
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b} bekleniyordu`)
const SYM = 'BTC/USDT'

// ---- sahte borsa
let ex
function resetEx() {
  ex = { free: { USDT: 1000, BTC: 0 }, orders: new Map(), seq: 0, calls: [], feeInBnb: false }
}
function mockAdapter() {
  ccxtAdapter.test = async () => ({ ok: true, latencyMs: 1, permissions: ['read', 'spot'], info: 'mock' })
  ccxtAdapter.fetchBalances = async () => Object.entries(ex.free).filter(([, v]) => v > 0).map(([asset, free]) => ({ asset, free }))
  ccxtAdapter.freeBalance = async (_p, _c, _t, asset) => ex.free[asset] ?? 0
  ccxtAdapter.createOrder = async (_p, _c, _t, { symbol, side, type, qty, price }) => {
    ex.calls.push({ side, type, qty, price })
    const id = String(++ex.seq)
    const px = feed.last(symbol)
    if (type === 'limit') {
      ex.orders.set(id, { id, side, qty, price, filled: 0, status: 'open' })
      return { externalId: id, status: 'open', filled: 0, average: null, fees: [] }
    }
    if (side === 'buy') {
      if (ex.free.USDT < qty * px) throw new Error('Borsada yetersiz bakiye')
      ex.free.USDT -= qty * px
      const fee = qty * 0.001
      ex.free.BTC += qty - (ex.feeInBnb ? 0 : fee)
      return { externalId: id, status: 'closed', filled: qty, average: px, fees: ex.feeInBnb ? [{ cost: 0.01, currency: 'BNB' }] : [{ cost: fee, currency: 'BTC' }] }
    }
    if (ex.free.BTC < qty - 1e-12) throw new Error('Borsada yetersiz bakiye')
    ex.free.BTC -= qty
    const fee = qty * px * 0.001
    ex.free.USDT += qty * px - fee
    return { externalId: id, status: 'closed', filled: qty, average: px, fees: [{ cost: fee, currency: 'USDT' }] }
  }
  ccxtAdapter.fetchOrder = async (_p, _c, _t, id) => {
    const o = ex.orders.get(id)
    return { externalId: id, status: o.status, filled: o.filled, average: o.price, fees: o.filled ? [{ cost: o.filled * 0.001, currency: 'BTC' }] : [] }
  }
  ccxtAdapter.cancelOrder = async (_p, _c, _t, id) => {
    ex.orders.get(id).status = 'canceled'
  }
}

async function makeLiveUser() {
  const u = await prisma.user.create({ data: { email: `live-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, name: 'Live Test', passwordHash: 'x', planId: 'expert' } })
  users.push(u.id)
  await prisma.riskSettings.create({ data: { userId: u.id, maxPositionPct: 100, maxOpenOrders: 100, dailyLossEnabled: false } })
  const conn = await prisma.exchangeAccount.create({
    data: { userId: u.id, provider: 'binance', label: 'Live', market: 'crypto', mode: 'live', credentialsEnc: encrypt({ apiKey: 'k', apiSecret: 's' }), apiKeyMasked: 'k', permissions: ['read', 'spot'], balances: { create: Object.entries(ex.free).map(([asset, free]) => ({ asset, free })) } },
  })
  return { user: u, conn }
}
const pos = (id) => prisma.position.findUnique({ where: { exchangeId_symbol: { exchangeId: id, symbol: SYM } } })
const syncBal = async (conn) => {
  await prisma.balance.deleteMany({ where: { exchangeId: conn.id } })
  await prisma.balance.createMany({ data: Object.entries(ex.free).map(([asset, free]) => ({ exchangeId: conn.id, asset, free })) })
}

before(async () => {
  if (skip) return
  ;({ prisma } = await import('../src/lib/prisma.js'))
  ;({ feed } = await import('../src/market/feed.js'))
  ;({ encrypt } = await import('../src/lib/crypto.js'))
  ;({ num } = await import('../src/lib/serialize.js'))
  ;({ placeOrder, cancelOrder, closePosition } = await import('../src/trading/orders.js'))
  ;({ processOrders, pollLiveOrders } = await import('../src/trading/engine.js'))
  ;({ ccxtAdapter } = await import('../src/exchanges/adapters/ccxtAdapter.js'))
  ;({ providerById } = await import('../src/exchanges/providers.js'))
  await feed.reload()
  mockAdapter()
})
beforeEach(() => {
  if (skip) return
  resetEx()
  const st = feed.state.get(SYM)
  Object.assign(st, { last: 50000, bid: 50000, ask: 50000, source: 'sim', liveAt: 0 })
})
after(async () => {
  if (skip) return
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.$disconnect()
})

test('canlı alış: pozisyon borsanın kestiği komisyon kadar NET miktarla açılır, komisyon kaydedilir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
  assert.equal(o.status, 'filled')
  near(num((await pos(conn.id)).qty), 0.01 * 0.999)
  near(o.fee, 0.01 * 0.001 * 50000) // 0.5 USDT karşılığı
  near(ex.free.BTC, 0.00999)
})

test('canlı "tamamını kapat": borsadaki gerçek bakiye satılır, pozisyon tamamen kapanır (toz kalmaz)', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
  ex.free.BTC -= 0.000001 // kullanıcının borsada biraz eksik coini var (yuvarlama / dışarıda işlem)
  const p = await pos(conn.id)
  const s = await closePosition(user.id, p.id, 100)
  assert.equal(s.status, 'filled')
  assert.equal(await pos(conn.id), null)
  near(ex.calls.at(-1).qty, 0.009989)
  assert.ok(ex.free.BTC < 1e-12)
})

test('BNB ile komisyon: coin miktarı düşülmez, maliyet USD olarak kaydedilir', { skip }, async () => {
  ex.feeInBnb = true
  const { user, conn } = await makeLiveUser()
  await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
  near(num((await pos(conn.id)).qty), 0.01)
})

test('canlı: bakiye yetersizse emir borsaya HİÇ gönderilmez, anlaşılır hata', { skip }, async () => {
  ex.free.USDT = 3
  const { user, conn } = await makeLiveUser()
  await assert.rejects(placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.001 }), /Yetersiz bakiye: borsa hesabınızda 3/)
  assert.equal(ex.calls.length, 0)
})

test('canlı: Binance minimum tutarı (5 USDT) altı emir borsaya gönderilmez', { skip }, async () => {
  feed.state.get(SYM).last = 40000
  const { user, conn } = await makeLiveUser()
  await assert.rejects(placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.0001 }), /minimum emir tutarı/)
  assert.equal(ex.calls.length, 0)
})

test('canlı limit: emir motoru borsadaki limit emri için ikinci (piyasa) emir GÖNDERMEZ; dolum borsadan gelir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'limit', qty: 0.01, price: 49000 })
  assert.equal(o.status, 'open')
  feed.state.get(SYM).last = 48000
  await processOrders()
  assert.equal(ex.calls.length, 1, 'sadece limit emri gönderilmiş olmalı')
  const lo = ex.orders.get('1')
  Object.assign(lo, { status: 'closed', filled: 0.01 })
  ex.free.USDT -= 490; ex.free.BTC += 0.00999
  await pollLiveOrders()
  const f = await prisma.order.findUnique({ where: { id: o.id } })
  assert.equal(f.status, 'filled')
  near(num(f.avgPrice), 49000)
  near(num((await pos(conn.id)).qty), 0.00999)
})

test('canlı limit kısmen dolup iptal edilirse dolan kısım deftere işlenir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'limit', qty: 0.01, price: 49000 })
  Object.assign(ex.orders.get('1'), { filled: 0.004 })
  const c = await cancelOrder(user.id, o.id)
  assert.equal(c.status, 'filled')
  near(num((await pos(conn.id)).qty), 0.004 * 0.999)
})

test('sanal hesap komisyonu borsaya göre: Kraken taker %0,8', { skip }, async () => {
  const u = await prisma.user.create({ data: { email: `kr-${Date.now()}@test.local`, name: 'K', passwordHash: 'x', planId: 'expert' } })
  users.push(u.id)
  await prisma.riskSettings.create({ data: { userId: u.id, maxPositionPct: 100, maxOpenOrders: 100, dailyLossEnabled: false } })
  const c = await prisma.exchangeAccount.create({ data: { userId: u.id, provider: 'kraken', label: 'K', market: 'crypto', mode: 'paper', credentialsEnc: encrypt({}), apiKeyMasked: 't', permissions: ['read', 'spot'], balances: { create: { asset: 'USDT', free: 10000 } } } })
  const o = await placeOrder(u.id, { exchangeId: c.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
  near(o.fee, 0.01 * o.avgPrice * providerById.kraken.fees.taker)
})

// ------------------------------------------------------------------ gerçek / sanal ayrımı
test('gerçek ve sanal para karışmaz: özet, risk limiti ve günlük zarar ayrı hesaplanır', { skip }, async () => {
  const { summary } = await import('../src/trading/portfolio.js')
  const { checkDailyLoss, riskState } = await import('../src/trading/risk.js')
  ex.free = { USDT: 100, BTC: 0 }
  const { user, conn } = await makeLiveUser()
  await prisma.riskSettings.update({ where: { userId: user.id }, data: { maxPositionPct: 30, dailyLossEnabled: true, dailyLossPct: 5 } })
  const paper = await prisma.exchangeAccount.create({
    data: { userId: user.id, provider: 'binance', label: 'Sanal', market: 'crypto', mode: 'paper', credentialsEnc: encrypt({}), apiKeyMasked: 't', permissions: ['read', 'spot'], balances: { create: { asset: 'USDT', free: 10000 } } },
  })

  // özetler ayrı
  const sl = await summary(user.id, 'live')
  const sp = await summary(user.id, 'paper')
  near(sl.totalValue, 100)
  near(sp.totalValue, 10000)
  assert.equal((await summary(user.id)).mode, 'live', 'canlı hesap varsa varsayılan görünüm gerçek para')

  // risk limiti: 10.000$ sanal para, gerçek emrin limitini büyütmemeli (100$'ın %30'u = 30$)
  await assert.rejects(placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.001 }), /Risk limiti/)
  assert.equal(ex.calls.length, 0)
  // sanal hesapta aynı emir serbest (10.000$'ın %30'u)
  const po = await placeOrder(user.id, { exchangeId: paper.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
  assert.equal(po.status, 'filled')

  // günlük zarar: sanal hesaptaki büyük zarar, gerçek para için acil durdurmayı tetiklememeli
  const rs = await riskState(user.id) // gün başı değerleri oluşur
  assert.equal(rs.state.scope, 'live')
  await prisma.balance.update({ where: { exchangeId_asset: { exchangeId: paper.id, asset: 'USDT' } }, data: { free: 1000 } })
  await checkDailyLoss()
  assert.equal((await prisma.riskSettings.findUnique({ where: { userId: user.id } })).killSwitchActive, false)
  // gerçek hesap %10 düşerse tetiklenir
  await prisma.balance.update({ where: { exchangeId_asset: { exchangeId: conn.id, asset: 'USDT' } }, data: { free: 90 } })
  await checkDailyLoss()
  assert.equal((await prisma.riskSettings.findUnique({ where: { userId: user.id } })).killSwitchActive, true)
})

// ---------------------------------------------------------------- yanıtı alınamayan emirler (zaman aşımı)
const lastOrder = (userId) => prisma.order.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })

test('canlı: borsadan yanıt gelmezse emir "reddedildi" sayılmaz; borsadan doğrulanıp deftere işlenir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  const realCreate = ccxtAdapter.createOrder
  const byCid = new Map()
  try {
    ccxtAdapter.createOrder = async (p, c, t, args) => {
      const r = await realCreate(p, c, t, args) // borsa emri ALDI ve doldurdu…
      byCid.set(args.clientOrderId, r)
      throw new ccxt.RequestTimeout('zaman aşımı') // …ama yanıt bize ulaşmadı
    }
    ccxtAdapter.fetchOrder = async (_p, _c, _t, id) => {
      assert.ok(id.startsWith('cid:'))
      const r = byCid.get(id.slice(4))
      if (!r) throw new ccxt.OrderNotFound('yok')
      return { ...r }
    }
    const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
    assert.equal(o.status, 'open', 'belirsiz emir açık kalmalı, reddedilmemeli')
    assert.match(o.externalId, /^cid:tp/)
    assert.equal(await pos(conn.id), null)
    await processOrders()
    assert.equal(ex.calls.length, 1, 'motor aynı emri borsaya ikinci kez göndermemeli')
    await pollLiveOrders()
    const f = await prisma.order.findUnique({ where: { id: o.id } })
    assert.equal(f.status, 'filled')
    assert.equal(f.externalId, '1', 'gerçek borsa kimliği kaydedilir')
    near(num((await pos(conn.id)).qty), 0.01 * 0.999)
  } finally {
    mockAdapter()
  }
})

test('canlı: zaman aşımı + borsada kayıt yok → bekleme süresinden sonra reddedilir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  try {
    ccxtAdapter.createOrder = async () => {
      throw new ccxt.RequestTimeout('zaman aşımı')
    }
    ccxtAdapter.fetchOrder = async () => {
      throw new ccxt.OrderNotFound('yok')
    }
    const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
    assert.equal(o.status, 'open')
    await pollLiveOrders()
    assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'open', 'bekleme süresi dolmadan karar verilmez')
    await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE id = ${o.id}`
    await pollLiveOrders()
    const f = await prisma.order.findUnique({ where: { id: o.id } })
    assert.equal(f.status, 'rejected')
    assert.match(f.reason, /borsaya ulaşmadı/)
  } finally {
    mockAdapter()
  }
})

test('canlı: borsanın açıkça reddettiği emir hemen reddedilir, kimlik temizlenir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  try {
    ccxtAdapter.createOrder = async () => {
      throw new ccxt.InvalidOrder('LOT_SIZE')
    }
    await assert.rejects(placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 }), /reddetti/)
    const o = await lastOrder(user.id)
    assert.equal(o.status, 'rejected')
    assert.equal(o.externalId, null)
  } finally {
    mockAdapter()
  }
})

test('canlı: sadece emir kimliği dönen borsa (OKX/Bybit) – dolum borsadan takip edilir', { skip }, async () => {
  const { user, conn } = await makeLiveUser()
  const realCreate = ccxtAdapter.createOrder
  let filled
  try {
    ccxtAdapter.createOrder = async (p, c, t, args) => {
      filled = await realCreate(p, c, t, args)
      return { externalId: filled.externalId, status: undefined, filled: 0, average: null, fees: [] }
    }
    ccxtAdapter.fetchOrder = async () => ({ ...filled })
    const o = await placeOrder(user.id, { exchangeId: conn.id, symbol: SYM, side: 'buy', type: 'market', qty: 0.01 })
    assert.equal(o.status, 'open')
    await pollLiveOrders()
    assert.equal((await prisma.order.findUnique({ where: { id: o.id } })).status, 'filled')
    near(num((await pos(conn.id)).qty), 0.01 * 0.999)
  } finally {
    mockAdapter()
  }
})
