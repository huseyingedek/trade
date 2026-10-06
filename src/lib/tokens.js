import jwt from 'jsonwebtoken'
import { config } from '../config.js'

const ISSUER = 'tradenest-api'

/** Oturum token'ı: sub=userId, sid=sessionId */
export const signAccess = (userId, sessionId) => jwt.sign({ sid: sessionId, typ: 'access' }, config.JWT_SECRET, { subject: userId, expiresIn: config.JWT_EXPIRES_IN, issuer: ISSUER })

/** Tek amaçlı kısa ömürlü token (şifre sıfırlama, e-posta doğrulama, davet) */
export const signPurpose = (purpose, userId, extra = {}, expiresIn = '1h') => jwt.sign({ typ: purpose, ...extra }, config.JWT_SECRET, { subject: userId, expiresIn, issuer: ISSUER })

export function verifyToken(token, typ) {
  const payload = jwt.verify(token, config.JWT_SECRET, { issuer: ISSUER })
  if (typ && payload.typ !== typ) throw new Error('Yanlış token türü')
  return payload
}

export function expiresAtFromNow() {
  const m = /^(\d+)([smhd])$/.exec(config.JWT_EXPIRES_IN)
  const n = m ? +m[1] : 12
  const unit = m ? m[2] : 'h'
  return new Date(Date.now() + n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit])
}
