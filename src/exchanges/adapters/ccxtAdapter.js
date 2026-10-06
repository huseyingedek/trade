// ccxt tabanlı kripto borsa adaptörü (Binance, Bybit, OKX, Kraken, BtcTurk…)
import ccxt from 'ccxt'

function client(provider, creds = {}, testnet = false) {
  const Cls = ccxt[provider.ccxtId]
  if (!Cls) throw new Error(`ccxt desteği yok: ${provider.ccxtId}`)
  const ex = new Cls({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    password: creds.passphrase,
    enableRateLimit: true,
    timeout: 15000,
  })
  if (testnet) {
    if (!ex.urls?.test) throw new Error(`${provider.name} için test ağı desteklenmiyor`)
    ex.setSandboxMode(true)
  }
  return ex
}

export function humanizeCcxtError(e) {
  if (e instanceof ccxt.AuthenticationError) return 'API anahtarı geçersiz veya yetkisiz (AuthenticationError)'
  if (e instanceof ccxt.PermissionDenied) return 'API anahtarının bu işlem için izni yok'
  if (e instanceof ccxt.InsufficientFunds) return 'Borsada yetersiz bakiye'
  if (e instanceof ccxt.InvalidOrder) return `Borsa emri reddetti: ${e.message.slice(0, 160)}`
  if (e instanceof ccxt.RateLimitExceeded || e instanceof ccxt.DDoSProtection) return 'Borsa istek limiti aşıldı, biraz sonra tekrar deneyin'
  if (e instanceof ccxt.NetworkError) return 'Borsaya ulaşılamıyor (ağ hatası)'
  return e.message?.slice(0, 200) || 'Bilinmeyen borsa hatası'
}

export const ccxtAdapter = {
  async test(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    const t0 = Date.now()
    const bal = await ex.fetchBalance()
    const latencyMs = Date.now() - t0
    const permissions = ['read', 'spot']
    if (provider.features.futures) permissions.push('futures')
    const nonZero = Object.entries(bal.total || {}).filter(([, v]) => v > 0).length
    return { ok: true, latencyMs, permissions, info: `${nonZero} varlık bulundu` }
  },

  async fetchBalances(provider, creds, testnet) {
    const ex = client(provider, creds, testnet)
    const bal = await ex.fetchBalance()
    return Object.entries(bal.free || {})
      .filter(([, v]) => v > 0)
      .map(([asset, free]) => ({ asset, free }))
  },

  /** Canlı emir: sadece market/limit borsaya gider; koşullu tipler platform motorunda tetiklenir */
  async createOrder(provider, creds, testnet, { symbol, side, type, qty, price }) {
    const ex = client(provider, creds, testnet)
    const o = await ex.createOrder(symbol, type, side, qty, type === 'limit' ? price : undefined)
    return { externalId: o.id, status: o.status, filled: o.filled ?? 0, average: o.average ?? o.price ?? null, fee: o.fee?.cost ?? null }
  },

  async fetchOrder(provider, creds, testnet, externalId, symbol) {
    const ex = client(provider, creds, testnet)
    const o = await ex.fetchOrder(externalId, symbol)
    return { status: o.status, filled: o.filled ?? 0, average: o.average ?? o.price ?? null, fee: o.fee?.cost ?? null }
  },

  async cancelOrder(provider, creds, testnet, externalId, symbol) {
    const ex = client(provider, creds, testnet)
    await ex.cancelOrder(externalId, symbol)
  },
}
