// =====================================================================
//  PİYASA DURUMU – genel piyasa duygusu ve türev (vadeli) piyasa verisi
//  • Korku ve Hırs Endeksi: alternative.me (ücretsiz; ticari kullanımda verinin
//    HEMEN YANINDA kaynak gösterilmesi şartı var → arayüz "Kaynak: alternative.me" yazar)
//  • Fonlama oranı, açık pozisyon, long/short oranı: Binance USDⓈ-M vadeli açık verisi
//    (anahtar gerekmez). Ulaşılamazsa ilgili bölüm boş döner, ekran onu gizler.
//  Bilgi amaçlıdır; tavsiye değildir.
// =====================================================================
import { log } from '../lib/logger.js'

const FNG_URL = 'https://api.alternative.me/fng/?limit=31'
const FAPI = 'https://fapi.binance.com'
const CACHE_TTL = 10 * 60_000

async function httpJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 0–100 → etiket anahtarı (alternative.me sınıflarıyla uyumlu) */
export function fngLabel(v) {
  if (v <= 25) return 'extreme_fear'
  if (v <= 45) return 'fear'
  if (v < 55) return 'neutral'
  if (v < 75) return 'greed'
  return 'extreme_greed'
}

/** alternative.me yanıtını çözümle → { value, label, ts, history:[[ms, value]] eski→yeni } */
export function parseFng(json) {
  const rows = (json?.data || []).map((d) => [Number(d.timestamp) * 1000, Number(d.value)]).filter(([t, v]) => t > 0 && v >= 0 && v <= 100)
  if (!rows.length) return null
  rows.sort((a, b) => a[0] - b[0])
  const [ts, value] = rows.at(-1)
  const weekAgo = rows.length > 7 ? rows.at(-8)[1] : null
  return { value, label: fngLabel(value), ts, weekAgo, history: rows, source: 'alternative.me' }
}

const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null)

/**
 * Binance vadeli verisini çözümle.
 * @param premium   /fapi/v1/premiumIndex yanıtı
 * @param oiHist    /futures/data/openInterestHist (period=1d) – eski→yeni
 * @param lsHist    /futures/data/globalLongShortAccountRatio (period=1h)
 */
export function parseDerivatives(premium, oiHist, lsHist) {
  const funding = premium?.lastFundingRate != null ? Number(premium.lastFundingRate) * 100 : null // 8 saatlik, %
  const oi = (oiHist || []).map((r) => ({ t: r.timestamp, v: Number(r.sumOpenInterestValue) })).sort((a, b) => a.t - b.t)
  const ls = (lsHist || []).map((r) => ({ t: r.timestamp, ratio: Number(r.longShortRatio), long: Number(r.longAccount) })).sort((a, b) => a.t - b.t)
  const last = oi.at(-1)?.v ?? null
  return {
    fundingPct: funding,
    nextFundingTime: premium?.nextFundingTime ?? null,
    markPrice: premium?.markPrice != null ? Number(premium.markPrice) : null,
    openInterestUsd: last,
    oiChange1dPct: oi.length >= 2 ? pct(last, oi.at(-2).v) : null,
    oiChange7dPct: oi.length >= 8 ? pct(last, oi.at(-8).v) : null,
    longShortRatio: ls.at(-1)?.ratio ?? null,
    longPct: ls.at(-1)?.long != null ? ls.at(-1).long * 100 : null,
  }
}

/**
 * Durum notları (kurallı yorum). Metinler çeviri anahtarı + değişken olarak döner.
 * level: info | warning | positive
 */
export function marketNotes({ fng, deriv, btc }) {
  const notes = []
  const add = (level, text, args = []) => notes.push({ level, text, args })
  if (fng) {
    if (fng.value <= 25) add('info', 'Piyasada aşırı korku var ({0}). Tarihsel olarak bu dönemler uzun vadeli alımlar için fırsat da olabilir, düşüş de sürebilir.', [fng.value])
    else if (fng.value >= 75) add('warning', 'Piyasada aşırı hırs var ({0}). Bu dönemlerde ani geri çekilmeler sıklaşır; yeni alımlarda dikkatli olun.', [fng.value])
    if (fng.weekAgo != null && Math.abs(fng.value - fng.weekAgo) >= 15) add('info', 'Korku ve Hırs Endeksi bir haftada {0} puan değişti ({1} → {2}): duygu hızla değişiyor.', [Math.abs(fng.value - fng.weekAgo), fng.weekAgo, fng.value])
  }
  const d = deriv?.BTC
  if (d) {
    if (d.fundingPct != null && d.fundingPct >= 0.05) add('warning', 'BTC fonlama oranı yüksek (%{0}): kaldıraçlı long pozisyonlar kalabalık, ani düşüşte zincirleme tasfiye riski var.', [round(d.fundingPct, 3)])
    else if (d.fundingPct != null && d.fundingPct < -0.01) add('info', 'BTC fonlama oranı negatif (%{0}): short pozisyonlar kalabalık, ani yükselişte short sıkışması olabilir.', [round(d.fundingPct, 3)])
    if (d.longShortRatio != null && d.longShortRatio >= 2.5) add('warning', 'Hesapların %{0} kadarı long: kalabalık tek yönlü pozisyon, tersine harekette sert hareket görülebilir.', [round(d.longPct, 0)])
    else if (d.longShortRatio != null && d.longShortRatio <= 0.8) add('info', 'Hesapların çoğu short (long oranı %{0}): olası yükselişte short kapatmaları hareketi hızlandırabilir.', [round(d.longPct, 0)])
    if (d.oiChange7dPct != null && d.oiChange7dPct >= 15) add('warning', 'BTC vadeli açık pozisyonları 7 günde %{0} arttı: piyasada kaldıraç birikiyor.', [round(d.oiChange7dPct, 1)])
    else if (d.oiChange7dPct != null && d.oiChange7dPct <= -15) add('info', 'BTC vadeli açık pozisyonları 7 günde %{0} azaldı: kaldıraç temizlendi.', [round(Math.abs(d.oiChange7dPct), 1)])
  }
  if (btc) {
    if (btc.long.label.includes('negative')) add('warning', 'BTC uzun vadede olumsuz görünümde: altcoinler genellikle BTC düşüşlerinde daha sert düşer.')
    else if (btc.long.label.includes('positive') && btc.short.label.includes('positive')) add('positive', 'BTC hem kısa hem uzun vadede olumlu görünümde: genel piyasa yönü yukarı.')
  }
  return notes
}
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n

// ------------------------------------------------------------------ toplama
let cache = null
let running = null

/**
 * @param deps { getJson, analyzeBtc } – testte sahte kaynak verilebilir
 */
export async function marketStatus({ fresh = false, getJson = httpJson, analyzeBtc } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL) return cache.data
  if (running) return running
  running = (async () => {
    const safe = (p, what) =>
      p.catch((e) => {
        log.warn(`piyasa durumu: ${what} alınamadı (${e.message})`)
        return null
      })
    const deriv = async (sym) => {
      const [prem, oi, ls] = await Promise.all([
        getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${sym}`),
        getJson(`${FAPI}/futures/data/openInterestHist?symbol=${sym}&period=1d&limit=8`),
        getJson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
      ])
      return parseDerivatives(prem, oi, ls)
    }
    const [fngJson, btcD, ethD, btc] = await Promise.all([
      safe(getJson(FNG_URL), 'Korku ve Hırs Endeksi'),
      safe(deriv('BTCUSDT'), 'BTC vadeli verisi'),
      safe(deriv('ETHUSDT'), 'ETH vadeli verisi'),
      analyzeBtc ? safe(analyzeBtc(), 'BTC analizi') : null,
    ])
    const fng = fngJson ? parseFng(fngJson) : null
    const derivatives = btcD || ethD ? { BTC: btcD, ETH: ethD } : null
    const data = {
      fearGreed: fng,
      derivatives,
      btc: btc ? { short: { score: btc.short.score, label: btc.short.label }, long: { score: btc.long.score, label: btc.long.label }, price: btc.price, dataSource: btc.dataSource } : null,
      notes: marketNotes({ fng, deriv: derivatives, btc }),
      updatedAt: Date.now(),
    }
    // en az bir kaynak geldiyse önbelleğe al (hepsi düştüyse bir sonraki istekte tekrar denenir)
    if (fng || derivatives || btc) cache = { at: Date.now(), data }
    return data
  })().finally(() => (running = null))
  return running
}
