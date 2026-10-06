// =====================================================================
//  Entegrasyon sağlığı – gerçek ölçüm
//  • Her adaptör çağrısının gecikmesi ve başarısı kaydedilir
//  • Her dakika sağlayıcıların açık (public) uç noktalarına ping atılır
//  • Kesinti başlayınca Incident kaydı açılır, düzelince kapanır
// =====================================================================
import { PROVIDERS } from './providers.js'
import { prisma } from '../lib/prisma.js'
import { log } from '../lib/logger.js'

const WINDOW_MS = 15 * 60_000

class Health {
  constructor() {
    this.stats = new Map(PROVIDERS.map((p) => [p.id, { samples: [], history: [], pings: { ok: 0, total: 0 }, consecutiveFails: 0, lastStatus: null }]))
  }

  record(id, ms, ok) {
    const s = this.stats.get(id)
    if (!s) return
    s.samples.push({ t: Date.now(), ms, ok })
    const cutoff = Date.now() - WINDOW_MS
    while (s.samples.length && (s.samples[0].t < cutoff || s.samples.length > 500)) s.samples.shift()
  }

  async ping() {
    await Promise.all(
      PROVIDERS.filter((p) => p.healthUrl).map(async (p) => {
        const s = this.stats.get(p.id)
        const t0 = Date.now()
        let ok = false
        let reason = null
        try {
          const res = await fetch(p.healthUrl, { signal: AbortSignal.timeout(8000) })
          ok = res.status < 500
          if (!ok) reason = `HTTP ${res.status}`
        } catch (e) {
          ok = false
          reason = e.name === 'TimeoutError' ? 'zaman aşımı (8 sn)' : e.cause?.code || e.message
        }
        // Erişim ilk kez kesildiğinde nedeni terminale yaz (her dakika tekrarlamaz)
        if (!ok && s.consecutiveFails === 0) log.warn(`⚠️  ${p.name} sağlık kontrolü başarısız: ${reason} (${p.healthUrl})`)
        if (ok && s.consecutiveFails > 0) log.info(`✅ ${p.name} yeniden erişilebilir`)
        const ms = Date.now() - t0
        this.record(p.id, ms, ok)
        s.pings.total++
        if (ok) s.pings.ok++
        s.consecutiveFails = ok ? 0 : s.consecutiveFails + 1
        s.history.push(ok ? ms : null)
        if (s.history.length > 30) s.history.shift()
      }),
    )
    await this.syncIncidents()
  }

  view(id, setting = {}) {
    const s = this.stats.get(id)
    const ms = s.samples.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b)
    const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : null)
    const errorRatePct = s.samples.length ? (s.samples.filter((x) => !x.ok).length / s.samples.length) * 100 : 0
    let status = 'unknown'
    if (setting.maintenance) status = 'maintenance'
    else if (!s.samples.length) status = 'unknown'
    // hiç başarılı istek yoksa, art arda 2 hata varsa ya da isteklerin yarısı başarısızsa → kesinti
    else if (!ms.length || s.consecutiveFails >= 2 || errorRatePct >= 50) status = 'down'
    // yavaşlama: ara sıra hata ya da kalıcı yüksek gecikme (tek bir yavaş ölçüm sayılmaz)
    else if (errorRatePct > 5 || (ms.length >= 3 && pct(0.5) > 1500)) status = 'degraded'
    else status = 'operational'
    return {
      status,
      latencyP50: pct(0.5),
      latencyP95: pct(0.95),
      errorRatePct: +errorRatePct.toFixed(2),
      uptime30d: s.pings.total ? +((s.pings.ok / s.pings.total) * 100).toFixed(2) : null,
      latencyHistory: s.history.map((x) => x ?? 0),
      samples: s.samples.length,
    }
  }

  async syncIncidents() {
    for (const p of PROVIDERS) {
      const v = this.view(p.id)
      const s = this.stats.get(p.id)
      if (v.status === s.lastStatus) continue
      try {
        if (v.status === 'down') {
          const open = await prisma.incident.findFirst({ where: { providerId: p.id, status: 'investigating' } })
          if (!open) await prisma.incident.create({ data: { providerId: p.id, title: `${p.name} erişilemiyor` } })
        } else if (v.status === 'operational' && s.lastStatus === 'down') {
          await prisma.incident.updateMany({ where: { providerId: p.id, status: 'investigating' }, data: { status: 'resolved', resolvedAt: new Date() } })
        }
      } catch (e) {
        log.warn({ err: e.message }, 'incident güncellenemedi')
      }
      s.lastStatus = v.status
    }
  }
}

export const health = new Health()
