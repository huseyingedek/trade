// =====================================================================
//  BORSA HESAPLARI (bağlantılar)
//  API anahtarları AES-256-GCM ile şifrelenir, hiçbir yanıtta dönmez.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { encrypt, decrypt, maskKey } from '../lib/crypto.js'
import { toApi } from '../lib/serialize.js'
import { badRequest, conflict, forbidden, notFound, unavailable } from '../lib/errors.js'
import { providerById, ACCOUNT_CCY } from '../exchanges/providers.js'
import { callAdapter } from '../exchanges/index.js'
import { assertPublicUrl } from '../exchanges/adapters/genericAdapter.js'
import { getProviderSettings } from './platform.js'
import { logActivity } from './activity.js'
import { hub } from '../realtime/hub.js'
import { feed } from '../market/feed.js'
import { syncLiveBalances } from '../trading/orders.js'
import { adjustDayStart, loadHoldings, valueOf } from '../trading/portfolio.js'

export const connToApi = (c) => {
  const { credentialsEnc, userId, updatedAt, ...rest } = c
  void credentialsEnc, void userId, void updatedAt
  return toApi(rest)
}

async function checkCreds(provider, creds = {}) {
  for (const f of provider.fields) if (!String(creds[f.key] || '').trim()) throw badRequest(`${f.label} gerekli`)
  const out = Object.fromEntries(provider.fields.map((f) => [f.key, String(creds[f.key]).trim()]))
  // özel entegrasyon adresi: iç ağa / yerel servislere istek attırılamaz (SSRF)
  if (out.baseUrl !== undefined) await assertPublicUrl(out.baseUrl).catch((e) => { throw badRequest(e.message, 'INVALID_URL') })
  return out
}

async function test(provider, creds, testnet) {
  try {
    return await callAdapter(provider.id, 'test', creds, testnet)
  } catch (e) {
    return { ok: false, message: e.message }
  }
}

export async function listConnections(userId) {
  return (await prisma.exchangeAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(connToApi)
}

export async function createConnection(userId, { provider: providerId, label, credentials, testnet = false, mode = 'paper', paperBalance }) {
  const provider = providerById[providerId]
  if (!provider) throw badRequest('Desteklenmeyen platform')
  if (!label?.trim()) throw badRequest('Hesap adı gerekli')
  const settings = (await getProviderSettings())[providerId]
  if (settings && (!settings.enabledForNew || settings.maintenance)) throw unavailable(`${provider.name} için yeni bağlantılar geçici olarak kapalı`, 'PROVIDER_CLOSED')

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { plan: true } })
  const count = await prisma.exchangeAccount.count({ where: { userId } })
  if (user.plan.maxExchanges !== -1 && count >= user.plan.maxExchanges)
    throw forbidden(`${user.plan.name} planı en fazla ${user.plan.maxExchanges} borsa hesabına izin veriyor. Planınızı yükseltin.`, 'PLAN_LIMIT')

  if (mode === 'live') {
    if (!config.LIVE_TRADING_ENABLED) throw forbidden('Canlı işlem sunucuda kapalı', 'LIVE_DISABLED')
    if (!provider.live) throw badRequest(`${provider.name} için canlı işlem henüz desteklenmiyor`)
  }
  // Sanal bakiye sınırı – hesap oluşturulmadan önce kontrol edilir
  const usd = paperBalance === undefined || paperBalance === null || paperBalance === '' ? config.PAPER_DEFAULT_BALANCE_USD : +paperBalance
  if (mode !== 'live' && !(usd >= 100 && usd <= 1_000_000)) throw badRequest('Sanal bakiye 100 ile 1.000.000 USD arasında olmalı')

  // Paper modda anahtar isteğe bağlı: hiç girilmezse anahtarsız sanal hesap açılır
  const noKeys = mode !== 'live' && provider.fields.every((f) => !String(credentials?.[f.key] || '').trim())
  const creds = noKeys ? {} : await checkCreds(provider, credentials)
  const res = noKeys ? { ok: true, latencyMs: null, permissions: ['read', 'spot', ...(provider.features.futures ? ['futures'] : [])] } : await test(provider, creds, !!testnet)
  // Paper modda gerçek anahtar zorunlu değil; ama girildiyse ve borsaya ulaşılabiliyorsa doğrulanır
  if (!res.ok && (mode === 'live' || /geçersiz|yetkisiz|Unauthorized|AuthenticationError/i.test(res.message))) {
    throw badRequest(`Bağlantı testi başarısız: ${res.message}`, 'AUTH_FAILED')
  }

  const keyForMask = noKeys ? 'paper' : creds.apiKey || creds.accountId || creds.customerNo
  const c = await prisma.exchangeAccount.create({
    data: {
      userId,
      provider: providerId,
      label: label.trim(),
      market: provider.market,
      mode: mode === 'live' ? 'live' : 'paper',
      testnet: !!testnet,
      credentialsEnc: encrypt(creds),
      apiKeyMasked: noKeys ? 'anahtarsız (sanal)' : maskKey(keyForMask),
      permissions: res.ok ? res.permissions : ['read', 'spot', ...(provider.features.futures ? ['futures'] : [])],
      latencyMs: res.latencyMs ?? null,
      lastSyncAt: new Date(),
      status: 'connected',
      errorMessage: res.ok ? null : `Doğrulanamadı (paper modda devam): ${res.message}`,
    },
  })

  if (c.mode === 'paper') {
    const acct = ACCOUNT_CCY[provider.market]
    await prisma.balance.create({ data: { exchangeId: c.id, asset: acct, free: feed.convert(usd, 'USD', acct) } })
    await adjustDayStart(userId, usd, 'paper')
  } else {
    await syncLiveBalances(c).catch(() => {})
    // yeni bağlanan gerçek hesabın bakiyesi "bugünkü kâr" sayılmasın
    const h = await loadHoldings(userId, 'live')
    await adjustDayStart(userId, valueOf({ balances: h.balances.filter((b) => b.exchangeId === c.id), positions: [] }), 'live')
  }
  await logActivity(userId, { level: 'success', source: 'system', notify: true, exchangeId: c.id, message: `${provider.name} hesabı bağlandı: ${c.label} (${c.mode === 'paper' ? 'paper / sanal' : 'canlı'})` })
  hub.toUser(userId, 'exchanges')
  hub.toUser(userId, 'balances')
  return connToApi(c)
}

async function own(userId, id) {
  const c = await prisma.exchangeAccount.findFirst({ where: { id, userId } })
  if (!c) throw notFound('Borsa hesabı bulunamadı')
  return c
}

export async function testConnection(userId, id) {
  const c = await own(userId, id)
  const provider = providerById[c.provider]
  const creds = decrypt(c.credentialsEnc)
  if (!Object.keys(creds).length) return { ok: true, latencyMs: null, permissions: c.permissions, info: 'Anahtarsız sanal hesap' }
  const res = await test(provider, creds, c.testnet)
  const authFail = !res.ok && /geçersiz|yetkisiz|Unauthorized|AuthenticationError/i.test(res.message)
  const u = await prisma.exchangeAccount.update({
    where: { id },
    data: res.ok
      ? { status: 'connected', errorMessage: null, latencyMs: res.latencyMs, lastSyncAt: new Date(), permissions: res.permissions }
      : { status: c.mode === 'live' || authFail ? 'error' : c.status, errorMessage: res.message },
  })
  if (res.ok && c.mode === 'live') await syncLiveBalances(u).catch(() => {})
  hub.toUser(userId, 'exchanges')
  return res.ok ? { ok: true, latencyMs: res.latencyMs, permissions: res.permissions, info: res.info } : { ok: false, message: res.message }
}

export async function updateConnection(userId, id, patch, source = 'manual') {
  const c = await own(userId, id)
  const data = {}
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw badRequest('Hesap adı boş olamaz')
    data.label = patch.label.trim()
  }
  if (patch.credentials) {
    const provider = providerById[c.provider]
    const creds = await checkCreds(provider, patch.credentials)
    const res = await test(provider, creds, c.testnet)
    // Hesap açarken olduğu gibi: anahtar borsa tarafından reddedildiyse (veya canlı hesapta hiç doğrulanamadıysa)
    // KAYDEDİLMEZ, eski anahtarlar korunur. Sanal hesapta yalnızca borsaya ulaşılamama (ağ/bölge) durumunda uyarıyla kaydedilir.
    const authFail = !res.ok && /geçersiz|yetkisiz|Unauthorized|AuthenticationError/i.test(res.message)
    if (!res.ok && (c.mode === 'live' || authFail)) throw badRequest(`Anahtarlar kaydedilmedi – bağlantı testi başarısız: ${res.message}`, 'AUTH_FAILED')
    data.credentialsEnc = encrypt(creds)
    data.apiKeyMasked = maskKey(creds.apiKey || creds.accountId || creds.customerNo)
    Object.assign(data, res.ok ? { status: 'connected', errorMessage: null, latencyMs: res.latencyMs, permissions: res.permissions, lastSyncAt: new Date() } : { status: c.mode === 'live' ? 'error' : 'connected', errorMessage: res.message })
    await logActivity(userId, { level: res.ok ? 'success' : 'warning', source, exchangeId: id, notify: true, message: `${c.label} API anahtarları güncellendi${res.ok ? '' : ` (doğrulanamadı: ${res.message})`}` })
  }
  if (patch.paused !== undefined && !!patch.paused !== c.paused) {
    data.paused = !!patch.paused
    if (data.paused) await prisma.bot.updateMany({ where: { exchangeId: id, status: 'running' }, data: { status: 'paused' } })
    await logActivity(userId, { level: data.paused ? 'warning' : 'success', source: source === 'manual' ? 'risk' : source, exchangeId: id, message: `${c.label} hesabında işlemler ${data.paused ? 'duraklatıldı' : 'yeniden açıldı'}` })
    hub.toUser(userId, 'bots')
  }
  const u = await prisma.exchangeAccount.update({ where: { id }, data })
  hub.toUser(userId, 'exchanges')
  return connToApi(u)
}

export async function deleteConnection(userId, id) {
  const c = await own(userId, id)
  if (await prisma.position.count({ where: { exchangeId: id } })) throw conflict('Bu hesapta açık pozisyonlar var. Önce pozisyonları kapatın.')
  if (await prisma.bot.count({ where: { exchangeId: id, status: 'running' } })) throw conflict('Bu hesapta çalışan botlar var. Önce botları durdurun.')
  // Canlı hesapta borsaya iletilmiş emirler bağlantı silinince takipsiz kalır → önce iptal edilmeli
  if (c.mode === 'live') {
    const openOrders = await prisma.order.count({ where: { exchangeId: id, status: 'open' } })
    if (openOrders) throw conflict(`Bu hesapta ${openOrders} açık emir var. Bağlantıyı kaldırmadan önce emirleri iptal edin.`)
  }
  const h = await loadHoldings(userId)
  // silinen hesabın nakit + (sanal hesapta) açık pozisyon değeri: hesapla birlikte silinir, "zarar" sayılmamalı
  const removedUsd = valueOf({ balances: h.balances.filter((b) => b.exchangeId === id), positions: h.positions.filter((p) => p.exchangeId === id) })
  await prisma.exchangeAccount.delete({ where: { id } })
  await adjustDayStart(userId, -removedUsd, c.mode === 'live' ? 'live' : 'paper')
  await logActivity(userId, { level: 'warning', message: `${c.label} bağlantısı kaldırıldı` })
  ;['exchanges', 'orders', 'balances', 'bots'].forEach((ch) => hub.toUser(userId, ch))
  return { ok: true }
}
