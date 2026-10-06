// .env dosyasını .env.example'dan oluşturur ve gizli anahtarları rastgele üretir.
// Kullanım: npm run init   (mevcut .env'i değiştirmez; --force ile anahtarları yeniler)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const force = process.argv.includes('--force')
const exists = existsSync('.env')
let text = readFileSync(exists ? '.env' : '.env.example', 'utf8')

const set = (key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm')
  const cur = text.match(re)?.[0]?.split('=').slice(1).join('=').trim()
  if (cur && !force && !cur.startsWith('change-me')) return false
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`
  return true
}

const a = set('JWT_SECRET', randomBytes(48).toString('base64url'))
const b = set('ENCRYPTION_KEY', randomBytes(32).toString('base64'))
writeFileSync('.env', text)
console.log(exists ? '• .env zaten vardı' : '✓ .env oluşturuldu (.env.example kopyalandı)')
if (a) console.log('✓ JWT_SECRET üretildi')
if (b) console.log('✓ ENCRYPTION_KEY üretildi')
if (!a && !b) console.log('• Anahtarlar zaten tanımlı (yenilemek için: npm run init -- --force)')
console.log('\nDATABASE_URL değerini kontrol edin, ardından: npm run setup')
if (force && exists) console.log('⚠️  ENCRYPTION_KEY değişti: kayıtlı API anahtarları ve 2FA sırları artık çözülemez!')
