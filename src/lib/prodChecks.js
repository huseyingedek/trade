// =====================================================================
//  Production açılış kontrolleri – riskli ayarlar varsa log'a uyarı yazar
//  (uygulamayı durdurmaz; ama canlıya çıkmadan bu uyarıların hepsi
//  temizlenmiş olmalı)
// =====================================================================
import bcrypt from 'bcryptjs'
import { prisma } from './prisma.js'
import { config, isProd } from '../config.js'

export async function productionChecks(log) {
  if (!isProd) return
  const warn = []
  if (/localhost|127\.0\.0\.1/.test(config.CORS_ORIGIN)) warn.push(`CORS_ORIGIN hâlâ localhost içeriyor (${config.CORS_ORIGIN}) – frontend alan adınızı yazın`)
  if (/localhost|127\.0\.0\.1/.test(config.APP_URL)) warn.push(`APP_URL localhost (${config.APP_URL}) – e-postalardaki bağlantılar çalışmaz`)
  if (config.DEV_2FA_CODE) warn.push('DEV_2FA_CODE tanımlı (production\'da yok sayılır, yine de silin)')
  if (config.LIVE_TRADING_ENABLED) warn.push('LIVE_TRADING_ENABLED=true – GERÇEK emirler borsaya gider')
  if (!config.RESEND_API_KEY) warn.push('E-posta sağlayıcısı yok (RESEND_API_KEY) – şifre sıfırlama ve doğrulama e-postaları GÖNDERİLMEZ')

  const admins = await prisma.user.findMany({ where: { role: { not: 'user' }, status: 'active' }, select: { email: true, passwordHash: true } })
  for (const a of admins) {
    if (await bcrypt.compare('Admin12345!', a.passwordHash)) warn.push(`${a.email} hâlâ varsayılan şifreyi (Admin12345!) kullanıyor – HEMEN değiştirin`)
  }
  const demo = await prisma.user.findUnique({ where: { email: 'demo@tradepilo.com' }, select: { passwordHash: true } })
  if (demo && (await bcrypt.compare('Demo12345!', demo.passwordHash))) warn.push('Herkesin bildiği şifreye sahip demo hesap (demo@tradepilo.com) aktif – silin veya şifresini değiştirin')

  if (warn.length) log.warn(`\n🚨 PRODUCTION UYARILARI (${warn.length}):\n${warn.map((w) => `   • ${w}`).join('\n')}\n`)
  else log.info('✅ Production kontrolleri temiz')
}
