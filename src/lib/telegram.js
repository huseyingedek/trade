import { config } from '../config.js'
import { log } from './logger.js'

/** Telegram bot üzerinden mesaj (TELEGRAM_BOT_TOKEN tanımlıysa) */
export async function sendTelegram(chatId, text) {
  if (!config.TELEGRAM_BOT_TOKEN || !chatId) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch (e) {
    log.warn({ err: e.message }, 'Telegram gönderilemedi')
    return false
  }
}
