// =====================================================================
//  Desteklenen platform kataloğu
//  ccxtId: ccxt kütüphanesindeki borsa kimliği (kripto) – canlı işlem ve bağlantı testi bununla yapılır
//  live:   canlı (gerçek) emir desteği var mı
// =====================================================================
export const PROVIDERS = [
  {
    id: 'binance', name: 'Binance', market: 'crypto', color: '#f0b90b', textColor: '#1e2329', ccxtId: 'binance', live: true, testnet: true,
    features: { spot: true, futures: true, short: false, oco: true, trailing: true },
    fields: [{ key: 'apiKey', label: 'API Key', type: 'text' }, { key: 'apiSecret', label: 'API Secret', type: 'password' }],
    healthUrl: 'https://api.binance.com/api/v3/ping',
  },
  {
    id: 'bybit', name: 'Bybit', market: 'crypto', color: '#17181e', textColor: '#f7a600', ccxtId: 'bybit', live: true, testnet: true,
    features: { spot: true, futures: true, short: true, oco: false, trailing: true },
    fields: [{ key: 'apiKey', label: 'API Key', type: 'text' }, { key: 'apiSecret', label: 'API Secret', type: 'password' }],
    healthUrl: 'https://api.bybit.com/v5/market/time',
  },
  {
    id: 'okx', name: 'OKX', market: 'crypto', color: '#2b2b2b', textColor: '#ffffff', ccxtId: 'okx', live: true, testnet: true,
    features: { spot: true, futures: true, short: true, oco: true, trailing: true },
    fields: [{ key: 'apiKey', label: 'API Key', type: 'text' }, { key: 'apiSecret', label: 'Secret Key', type: 'password' }, { key: 'passphrase', label: 'Passphrase', type: 'password' }],
    healthUrl: 'https://www.okx.com/api/v5/public/time',
  },
  {
    id: 'kraken', name: 'Kraken', market: 'crypto', color: '#5741d9', textColor: '#ffffff', ccxtId: 'kraken', live: true, testnet: false,
    features: { spot: true, futures: false, short: false, oco: false, trailing: true },
    fields: [{ key: 'apiKey', label: 'API Key', type: 'text' }, { key: 'apiSecret', label: 'Private Key', type: 'password' }],
    healthUrl: 'https://api.kraken.com/0/public/Time',
  },
  {
    id: 'btcturk', name: 'BtcTurk', market: 'crypto', color: '#1c6ed8', textColor: '#ffffff', ccxtId: 'btcturk', live: true, testnet: false,
    features: { spot: true, futures: false, short: false, oco: false, trailing: false },
    fields: [{ key: 'apiKey', label: 'Public Key', type: 'text' }, { key: 'apiSecret', label: 'Private Key', type: 'password' }],
    healthUrl: 'https://api.btcturk.com/api/v2/server/exchangeinfo',
  },
  {
    id: 'bist_broker', name: 'BIST Aracı Kurum', market: 'bist', color: '#e30a17', textColor: '#ffffff', ccxtId: null, live: false, testnet: false,
    features: { spot: true, futures: false, short: false, oco: false, trailing: false },
    fields: [{ key: 'customerNo', label: 'Müşteri No', type: 'text' }, { key: 'apiKey', label: 'API Anahtarı', type: 'text' }, { key: 'apiSecret', label: 'API Şifresi', type: 'password' }],
    healthUrl: null,
    note: 'Aracı kuruma özel API entegrasyonu henüz bağlanmadı – hesap paper (sanal) modda çalışır.',
  },
  {
    id: 'oanda', name: 'OANDA', market: 'forex', color: '#0a7c3e', textColor: '#ffffff', ccxtId: null, live: false, testnet: true,
    features: { spot: true, futures: false, short: true, oco: true, trailing: true },
    fields: [{ key: 'accountId', label: 'Hesap ID', type: 'text' }, { key: 'apiKey', label: 'API Token', type: 'password' }],
    healthUrl: 'https://api-fxtrade.oanda.com',
    healthAuthRequired: true, // anahtarsız istek 401/403 döner – bu, sunucunun ayakta olduğunu gösterir
    note: 'Bağlantı testi gerçek OANDA v20 API ile yapılır; emirler şimdilik paper modda simüle edilir.',
  },
  {
    id: 'custom_rest', name: 'Özel Entegrasyon', market: 'crypto', color: '#6c757d', textColor: '#ffffff', ccxtId: null, live: false, testnet: false,
    features: { spot: true, futures: false, short: false, oco: false, trailing: false },
    fields: [{ key: 'baseUrl', label: 'API Base URL', type: 'text' }, { key: 'apiKey', label: 'API Key', type: 'text' }, { key: 'apiSecret', label: 'API Secret', type: 'password' }],
    healthUrl: null,
  },
]

export const providerById = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]))

/** İstemciye gönderilen görünüm (iç alanlar hariç) */
export const providerView = ({ healthUrl, healthAuthRequired, ...p }) => (void healthUrl, void healthAuthRequired, p)

/** Hesap türüne göre nakit para birimi */
export const ACCOUNT_CCY = { crypto: 'USDT', bist: 'TRY', forex: 'USD' }
