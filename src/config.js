// =====================================================================
//  Ortam değişkenleri – başlangıçta doğrulanır, hatalıysa uygulama açılmaz
// =====================================================================
import { z } from 'zod'

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),
  TZ_APP: z.string().default('Europe/Istanbul'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL gerekli'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET en az 32 karakter olmalı'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  /** 32 byte, base64 – API anahtarları ve 2FA sırları bununla şifrelenir */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY 32 byte base64 olmalı (npm run keygen)'),

  CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:4173'),
  APP_URL: z.string().default('http://localhost:5173'),

  /** auto: kripto için ccxt (gerçek), ulaşılamazsa simülasyon. sim: her şey simülasyon */
  MARKET_DATA: z.enum(['auto', 'sim']).default('auto'),
  MARKET_DATA_EXCHANGE: z.string().default('binance'),
  MARKET_POLL_MS: z.coerce.number().int().min(500).default(2000),
  /** Forex referans kurları (ECB) – frankfurter.app */
  FX_REFERENCE: bool(true),

  /** Gerçek borsaya emir gönderimi. Kapalıyken tüm hesaplar paper (sanal) modda çalışır */
  LIVE_TRADING_ENABLED: bool(false),
  PAPER_DEFAULT_BALANCE_USD: z.coerce.number().default(10000),
  TRADING_FEE_RATE: z.coerce.number().default(0.001),

  REQUIRE_EMAIL_VERIFICATION: bool(false),
  /** Sadece geliştirmede: bu kod 2FA yerine kabul edilir (üretimde yok sayılır) */
  DEV_2FA_CODE: z.string().optional(),

  /** manual: ödeme sağlayıcısı yok, abonelik admin/manuel yönetilir */
  PAYMENTS_MODE: z.enum(['manual', 'disabled']).default('manual'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Gönderen adresi. Resend'de doğrulanmış alan adınızdan olmalı (örn. Tradepilo <no-reply@alanadiniz.com>) */
  SMTP_FROM: z.string().default('Tradepilo <no-reply@tradepilo.local>'),
  /** E-posta sağlayıcısı (https://resend.com). Boşsa e-postalar sadece log'a yazılır */
  RESEND_API_KEY: z.string().optional(),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@tradepilo.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin12345!'),
  SEED_ADMIN_NAME: z.string().default('Süper Admin'),
  SEED_DEMO: bool(false),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('\n❌ Ortam değişkenleri hatalı:\n')
  for (const i of parsed.error.issues) console.error(`  • ${i.path.join('.')}: ${i.message}`)
  console.error('\n.env.example dosyasını .env olarak kopyalayıp doldurun.\n')
  process.exit(1)
}

export const config = parsed.data
export const isProd = config.NODE_ENV === 'production'
