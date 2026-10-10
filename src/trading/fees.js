// =====================================================================
//  KOMİSYON
//  • Sanal (paper) hesap: borsanın standart oranı (providers.js → fees)
//      - piyasa / stop / iz süren / OCO / hemen eşleşen limit → "taker"
//      - defterde bekleyip sonradan dolan limit → "maker"
//  • Canlı hesap: borsanın emir yanıtında bildirdiği gerçek komisyon (normalizeLiveFees)
// =====================================================================
import { providerById } from '../exchanges/providers.js'
import { config } from '../config.js'
import { assetToUsd } from './portfolio.js'

export function feeRate(providerId, liquidity = 'taker') {
  const f = providerById[providerId]?.fees
  if (!f) return config.TRADING_FEE_RATE
  return liquidity === 'maker' ? f.maker : f.taker
}

/** Bekleyen emir dolduğunda hangi oranın uygulanacağı */
export const liquidityOf = (order, { immediate = false } = {}) => (order.type === 'limit' && !immediate ? 'maker' : 'taker')

/**
 * Borsanın bildirdiği komisyon listesini çözümle.
 * Binance alışta komisyonu ALINAN varlıktan keser (ADA alırken ADA), BNB ile ödeme açıksa BNB'den.
 * @returns {{ feeQuote: number, feeBase: number }} feeQuote: quote cinsinden toplam maliyet,
 *          feeBase: baz varlıktan düşülen miktar (pozisyon miktarından çıkarılmalı)
 */
export function normalizeLiveFees(fees, { base, quote, price }) {
  let feeQuote = 0
  let feeBase = 0
  for (const f of fees || []) {
    const cost = +f?.cost || 0
    if (!cost) continue
    const cur = String(f.currency || '').toUpperCase()
    if (cur === quote) feeQuote += cost
    else if (cur === base) {
      feeBase += cost
      feeQuote += cost * price
    } else {
      // üçüncü varlık (ör. BNB) → USD üzerinden quote'a çevir (USDT ≈ USD)
      const usd = assetToUsd(cost, cur)
      const quoteUsd = assetToUsd(1, quote) || 1
      feeQuote += usd / quoteUsd
    }
  }
  return { feeQuote, feeBase }
}
