// OANDA v20 REST – bağlantı testi gerçek API ile
export const oandaAdapter = {
  async test(provider, creds, testnet) {
    const base = testnet ? 'https://api-fxpractice.oanda.com' : 'https://api-fxtrade.oanda.com'
    const t0 = Date.now()
    const res = await fetch(`${base}/v3/accounts/${encodeURIComponent(creds.accountId)}/summary`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 401 || res.status === 403) throw new Error('401 Unauthorized – API token geçersiz')
    if (!res.ok) throw new Error(`OANDA yanıtı: HTTP ${res.status}`)
    const body = await res.json()
    return { ok: true, latencyMs: Date.now() - t0, permissions: ['read'], info: `Bakiye ${body?.account?.balance ?? '?'} ${body?.account?.currency ?? ''}` }
  },
}
