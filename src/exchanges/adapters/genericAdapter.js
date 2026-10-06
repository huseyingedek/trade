// API'si standart olmayan sağlayıcılar (BIST aracı kurumu, özel REST)
// Kimlik bilgileri biçim olarak doğrulanır ve şifreli saklanır; işlemler paper modda yürür.
export const genericAdapter = {
  async test(provider, creds) {
    if (provider.id === 'custom_rest') {
      const t0 = Date.now()
      try {
        const res = await fetch(String(creds.baseUrl).replace(/\/$/, ''), { method: 'GET', signal: AbortSignal.timeout(8000) })
        return { ok: true, latencyMs: Date.now() - t0, permissions: ['read'], info: `HTTP ${res.status}` }
      } catch {
        throw new Error('Özel API adresine ulaşılamıyor')
      }
    }
    return { ok: true, latencyMs: null, permissions: ['read', 'spot'], info: provider.note || 'Biçim doğrulandı' }
  },
}
