// =====================================================================
//  TEKNİK GÖRÜNÜM PUANI – kurallı, tekrarlanabilir (aynı veri → aynı sonuç)
//  Her bileşen −1 (olumsuz) … +1 (olumlu) arası bir etki üretir; ağırlıklı
//  ortalama −100 … +100 puana çevrilir. Metinler çeviri anahtarı + değişken
//  olarak döner (arayüz kullanıcının dilinde gösterir).
//  NOT: Bu bir yatırım tavsiyesi değil, göstergelerin özetidir.
// =====================================================================
import { atr, changePct, ema, levels, macd, rsi, sma } from './indicators.js'

export const HORIZONS = {
  // Kısa vade: 4 saatlik mumlar, ~2 aylık geçmiş; trend 20/50 periyot, momentum 7 gün
  short: { interval: '4h', limit: 400, fast: 20, slow: 50, momBars: 42, momScale: 8, slopeBars: 12 },
  // Uzun vade: günlük mumlar, ~1 yıllık geçmiş; trend 50/200 gün, momentum 90 gün
  long: { interval: '1d', limit: 400, fast: 50, slow: 200, momBars: 90, momScale: 25, slopeBars: 20 },
}

const clamp = (x) => Math.max(-1, Math.min(1, x))
const r1 = (x) => Math.round(x * 10) / 10

/** Puan → etiket (ayrıca karne istatistiğinde kova olarak kullanılır) */
export function labelOf(score) {
  if (score >= 50) return 'strong_positive'
  if (score >= 15) return 'positive'
  if (score > -15) return 'neutral'
  if (score > -50) return 'negative'
  return 'strong_negative'
}

/**
 * @param candles [{t,o,h,l,c,v}] eski → yeni
 * @param horizon 'short' | 'long'
 */
export function scoreCandles(candles, horizon) {
  const H = HORIZONS[horizon]
  const closes = candles.map((k) => k.c)
  const price = closes.at(-1)
  const n = closes.length
  const signals = []
  const add = (key, weight, impact, text, args = []) => signals.push({ key, weight, impact: clamp(impact), text, args })

  // 1) Trend konumu: fiyat ve ortalamaların dizilişi
  const eF = ema(closes, H.fast)
  const eS = ema(closes, H.slow)
  const fast = eF.at(-1)
  const slow = eS.at(-1)
  if (fast != null && slow != null) {
    const aboveF = price > fast
    const aboveS = price > slow
    let imp = (aboveF ? 0.35 : -0.35) + (aboveS ? 0.35 : -0.35) + (fast > slow ? 0.3 : -0.3)
    const text =
      aboveF && aboveS && fast > slow ? 'Fiyat {0} ve {1} periyotluk ortalamaların üzerinde, kısa ortalama uzun ortalamanın üstünde: yükseliş trendi.'
        : !aboveF && !aboveS && fast < slow ? 'Fiyat {0} ve {1} periyotluk ortalamaların altında, kısa ortalama uzun ortalamanın altında: düşüş trendi.'
          : 'Fiyat {0} ve {1} periyotluk ortalamalar arasında gidip geliyor: trend net değil.'
    add('trend', 25, imp, text, [H.fast, H.slow])
  } else if (fast != null) {
    add('trend', 25, price > fast ? 0.5 : -0.5, price > fast ? 'Fiyat {0} periyotluk ortalamanın üzerinde.' : 'Fiyat {0} periyotluk ortalamanın altında.', [H.fast])
  }

  // 2) Trend eğimi: uzun ortalama yükseliyor mu?
  const base = eS.at(-1) != null && eS.at(-1 - H.slopeBars) != null ? eS : eF
  const b1 = base.at(-1)
  const b0 = base.at(-1 - H.slopeBars)
  if (b1 != null && b0 != null) {
    const slopePct = ((b1 - b0) / b0) * 100
    add('slope', 15, slopePct / 3, slopePct >= 0 ? 'Uzun ortalama yükseliyor (%{0}).' : 'Uzun ortalama düşüyor (%{0}).', [r1(slopePct)])
  }

  // 3) MACD: momentumun yönü ve ivmesi
  const { hist } = macd(closes)
  const h1 = hist.at(-1)
  const h0 = hist.at(-4)
  if (h1 != null && h0 != null) {
    const rising = h1 > h0
    const imp = h1 > 0 ? (rising ? 1 : 0.4) : rising ? -0.4 : -1
    const text = h1 > 0 ? (rising ? 'MACD pozitif ve güçleniyor.' : 'MACD pozitif ama zayıflıyor.') : rising ? 'MACD negatif ama toparlanıyor.' : 'MACD negatif ve zayıflıyor.'
    add('macd', 15, imp, text)
  }

  // 4) RSI: momentum + aşırılık
  const rv = rsi(closes).at(-1)
  if (rv != null) {
    let imp
    let text
    if (rv >= 75) [imp, text] = [-0.6, 'RSI {0}: aşırı alım bölgesi, geri çekilme riski yüksek.']
    else if (rv >= 60) [imp, text] = [0.6, 'RSI {0}: güçlü alıcı momentumu.']
    else if (rv > 45) [imp, text] = [(rv - 52.5) / 15, 'RSI {0}: nötr bölge.']
    else if (rv > 30) [imp, text] = [-0.6, 'RSI {0}: satıcılar baskın.']
    else [imp, text] = [0.3, 'RSI {0}: aşırı satım bölgesi, tepki yükselişi gelebilir.']
    add('rsi', 15, imp, text, [Math.round(rv)])
  }

  // 5) Momentum: son dönemdeki getiri
  const mom = changePct(closes, Math.min(H.momBars, n - 1))
  if (mom != null) {
    add('momentum', 20, Math.tanh(mom / H.momScale), horizon === 'short' ? 'Son 7 günde %{0} değişim.' : 'Son 90 günde %{0} değişim.', [r1(mom)])
  }

  // 6) Hacim teyidi: son hareket hacimle destekleniyor mu?
  const vols = candles.map((k) => k.v || 0)
  if (vols.some((v) => v > 0) && n > 25) {
    const vs = sma(vols, 5).at(-1)
    const vl = sma(vols, 20).at(-1)
    const ratio = vl ? vs / vl : 1
    const dir = changePct(closes, 5) ?? 0
    if (ratio >= 1.25) add('volume', 10, dir >= 0 ? 0.8 : -0.8, dir >= 0 ? 'Yükseliş ortalamanın {0} katı hacimle destekleniyor.' : 'Düşüş ortalamanın {0} katı hacimle geliyor.', [r1(ratio)])
    else if (ratio <= 0.75) add('volume', 10, 0, 'İşlem hacmi ortalamanın altında ({0}×): hareketin gücü sınırlı.', [r1(ratio)])
    else add('volume', 10, 0, 'İşlem hacmi normal seviyede.')
  }

  const wSum = signals.reduce((a, s) => a + s.weight, 0)
  const score = wSum ? Math.round((signals.reduce((a, s) => a + s.weight * s.impact, 0) / wSum) * 100) : 0

  // Bilgi (puana katılmaz): oynaklık ve önemli seviyeler
  const a = atr(candles).at(-1)
  const volPct = a ? (a / price) * 100 : null
  const lv = levels(candles.slice(-Math.min(n, horizon === 'short' ? 180 : 250)))

  return {
    horizon,
    interval: H.interval,
    score,
    label: labelOf(score),
    signals: signals.map((s) => ({ ...s, impact: Math.round(s.impact * 100) / 100 })),
    volatilityPct: volPct != null ? r1(volPct) : null,
    rsi: rv != null ? Math.round(rv) : null,
    emaFast: fast,
    emaSlow: slow,
    supports: lv.supports,
    resistances: lv.resistances,
  }
}
