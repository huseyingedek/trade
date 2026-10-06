import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import { config, isProd } from '../config.js'

export const newSecret = () => generateSecret()

export async function otpauth(secret, email) {
  const uri = generateURI({ secret, issuer: 'Tradepilo', label: email })
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 })
  return { uri, qr }
}

/** ±1 zaman adımı toleransla doğrular */
export function verifyCode(secret, code) {
  const token = String(code || '').trim()
  if (!/^\d{6}$/.test(token)) return false
  if (!isProd && config.DEV_2FA_CODE && token === config.DEV_2FA_CODE) return true
  try {
    return verifySync({ secret, token, epochTolerance: 30 }).valid === true
  } catch {
    return false
  }
}
