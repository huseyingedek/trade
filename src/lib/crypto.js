// AES-256-GCM ile hassas veri şifreleme (API anahtarları, 2FA sırları)
import crypto from 'node:crypto'
import { config } from '../config.js'

const KEY = Buffer.from(config.ENCRYPTION_KEY, 'base64')

/** Herhangi bir JSON değerini şifreler → "v1:iv:tag:data" (base64) */
export function encrypt(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':')
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split(':')
  if (v !== 'v1') throw new Error('Bilinmeyen şifreleme sürümü')
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])
  return JSON.parse(out.toString('utf8'))
}

export const maskKey = (key) => {
  const k = String(key || '')
  if (k.length <= 8) return '••••••••'
  return `${k.slice(0, 4)}••••••••${k.slice(-4)}`
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
