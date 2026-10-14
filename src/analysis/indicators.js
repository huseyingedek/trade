// =====================================================================
//  TEKNİK GÖSTERGELER – saf fonksiyonlar (yan etkisiz, test edilebilir)
//  Girdi: sayı dizisi (kapanışlar) veya mum dizisi [{o,h,l,c,v}].
//  Çıktı: girdiyle aynı uzunlukta dizi; hesaplanamayan baştaki değerler null.
// =====================================================================

export function sma(values, period) {
  const out = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** Üssel hareketli ortalama: ilk değer SMA ile başlatılır */
export function ema(values, period) {
  const out = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** RSI (Wilder yumuşatması) */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))
  out[period] = val()
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = val()
  }
  return out
}

/** MACD: { macd, signal, hist } */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast)
  const es = ema(values, slow)
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null))
  const start = line.findIndex((x) => x != null)
  const signal = new Array(values.length).fill(null)
  if (start >= 0) {
    const sig = ema(line.slice(start), signalPeriod)
    sig.forEach((v, j) => (signal[start + j] = v))
  }
  const hist = line.map((m, i) => (m != null && signal[i] != null ? m - signal[i] : null))
  return { macd: line, signal, hist }
}

/** Ortalama gerçek aralık (Wilder) */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null)
  if (candles.length <= period) return out
  const tr = candles.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c))))
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period
  out[period] = prev
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

/** n mum önceye göre yüzde değişim */
export const changePct = (values, n) => (values.length > n ? ((values.at(-1) - values.at(-1 - n)) / values.at(-1 - n)) * 100 : null)

/**
 * Destek / direnç: yerel dip ve tepeler (her iki yanda `wing` mum boyunca en düşük/en yüksek olan),
 * birbirine %tol yakın olanlar tek seviyede birleştirilir. Fiyata en yakın ikişer seviye döner.
 */
export function levels(candles, { wing = 3, tol = 1.5, count = 2 } = {}) {
  const price = candles.at(-1).c
  const lows = []
  const highs = []
  for (let i = wing; i < candles.length - wing; i++) {
    const win = candles.slice(i - wing, i + wing + 1)
    if (candles[i].l === Math.min(...win.map((k) => k.l))) lows.push(candles[i].l)
    if (candles[i].h === Math.max(...win.map((k) => k.h))) highs.push(candles[i].h)
  }
  const cluster = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b)
    const groups = []
    for (const v of sorted) {
      const g = groups.at(-1)
      if (g && (v - g.avg) / g.avg * 100 <= tol) {
        g.vals.push(v)
        g.avg = g.vals.reduce((a, b) => a + b, 0) / g.vals.length
      } else groups.push({ vals: [v], avg: v })
    }
    return groups.map((g) => ({ price: g.avg, touches: g.vals.length }))
  }
  const supports = cluster(lows).filter((x) => x.price < price).sort((a, b) => b.price - a.price).slice(0, count)
  const resistances = cluster(highs).filter((x) => x.price > price).sort((a, b) => a.price - b.price).slice(0, count)
  return { supports, resistances }
}
