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
