// =====================================================================
//  E-posta gönderimi
//  RESEND_API_KEY tanımlıysa Resend HTTP API ile gönderilir (ek paket yok).
//  Tanımlı değilse içerik log'a yazılır (geliştirme).
// =====================================================================
import { config, isProd } from '../config.js'
import { log } from './logger.js'

export async function sendMail({ to, subject, text }) {
  if (!config.RESEND_API_KEY) {
    // Production'da e-posta içeriğinde tek kullanımlık bağlantılar olabilir → log'a yazma
    if (isProd) log.warn({ mail: { to, subject } }, '📧 E-posta gönderilemedi: RESEND_API_KEY tanımlı değil')
    else log.info({ mail: { to, subject } }, `📧 [mail] ${to} – ${subject}\n${text}`)
    return { queued: false }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.SMTP_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.error({ mail: { to, subject }, status: res.status, body: (await res.text()).slice(0, 300) }, '📧 E-posta gönderilemedi')
      return { queued: false }
    }
    log.info({ mail: { to, subject } }, '📧 E-posta gönderildi')
    return { queued: true }
  } catch (e) {
    log.error({ mail: { to, subject }, err: e.message }, '📧 E-posta gönderilemedi')
    return { queued: false }
  }
}
