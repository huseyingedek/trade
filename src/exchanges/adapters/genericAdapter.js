// API'si standart olmayan sağlayıcılar (BIST aracı kurumu, özel REST)
// Kimlik bilgileri biçim olarak doğrulanır ve şifreli saklanır; işlemler paper modda yürür.
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { isProd } from '../../config.js'

/** Özel / yerel / ayrılmış IP aralıkları – sunucu bu adreslere kullanıcı adına istek atmaz (SSRF koruması) */
const blocked = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) blocked.addSubnet(addr, prefix, 'ipv6')

function isBlockedIp(ip) {
  if (net.isIPv6(ip) && ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7) // IPv4-mapped IPv6
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')
}

/** Kullanıcının girdiği adres: sadece https (geliştirmede http de), sadece genel internet adresleri */
export async function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('Geçersiz API adresi')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProd)) throw new Error('API adresi https:// ile başlamalı')
  if (url.username || url.password) throw new Error('API adresinde kullanıcı adı/şifre olamaz')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (!addrs.length) throw new Error('API adresi çözümlenemedi')
  if (addrs.some((a) => isBlockedIp(a.address))) throw new Error('Yerel veya özel ağ adreslerine bağlanılamaz')
  return url
}

export const genericAdapter = {
  async test(provider, creds) {
    if (provider.id === 'custom_rest') {
      const url = await assertPublicUrl(creds.baseUrl)
      const t0 = Date.now()
      try {
        // yönlendirme takip edilmez: güvenli adres iç ağa yönlendirerek korumayı aşamasın
        const res = await fetch(url.toString().replace(/\/$/, ''), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
        return { ok: true, latencyMs: Date.now() - t0, permissions: ['read'], info: `HTTP ${res.status}` }
      } catch {
        throw new Error('Özel API adresine ulaşılamıyor')
      }
    }
    return { ok: true, latencyMs: null, permissions: ['read', 'spot'], info: provider.note || 'Biçim doğrulandı' }
  },
}
