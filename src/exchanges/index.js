import ccxt from 'ccxt'
import { providerById } from './providers.js'
import { ccxtAdapter, humanizeCcxtError } from './adapters/ccxtAdapter.js'
import { oandaAdapter } from './adapters/oandaAdapter.js'
import { genericAdapter } from './adapters/genericAdapter.js'
import { health } from './health.js'

export function adapterFor(provider) {
  if (provider.ccxtId) return ccxtAdapter
  if (provider.id === 'oanda') return oandaAdapter
  return genericAdapter
}

const causeOf = (e) => e?.cause ?? e

/** Borsada böyle bir emir yok */
export const isOrderNotFound = (e) => causeOf(e) instanceof ccxt.OrderNotFound

/**
 * Emir gönderiminde hata: borsa emri alıp almadığı BİLİNMİYOR mu?
 * Zaman aşımı / bağlantı kopması → belirsiz (emir borsada gerçekleşmiş olabilir).
 * Borsanın açıkça reddettiği durumlar (geçersiz emir, bakiye, yetki, istek limiti) → kesin.
 */
export function isUncertainError(e) {
  const c = causeOf(e)
  if (c instanceof ccxt.DDoSProtection || c instanceof ccxt.InvalidNonce || c instanceof ccxt.OnMaintenance) return false
  if (c instanceof ccxt.NetworkError) return true
  return !(c instanceof ccxt.BaseError)
}

/** Adaptör çağrısı + sağlık metrikleri (gecikme / hata oranı) */
export async function callAdapter(providerId, method, ...args) {
  const provider = providerById[providerId]
  const adapter = adapterFor(provider)
  if (!adapter[method]) throw new Error(`${provider.name} için '${method}' desteklenmiyor`)
  const t0 = Date.now()
  try {
    const r = await adapter[method](provider, ...args)
    health.record(providerId, Date.now() - t0, true)
    return r
  } catch (e) {
    health.record(providerId, Date.now() - t0, false)
    const err = new Error(provider.ccxtId ? humanizeCcxtError(e) : e.message)
    err.cause = e
    throw err
  }
}
