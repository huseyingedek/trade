// =====================================================================
//  WebSocket merkezi
//  Protokol:  istemci → {op:'subscribe'|'unsubscribe', channel} | {op:'ping'}
//             sunucu  → {channel, data} | {op:'pong'} | {op:'error', message}
//  Kanal türleri:
//    herkese açık : tickers, orderbook:<SYM>, trades:<SYM>, candles:<SYM>:<INT>
//    kullanıcıya özel: orders, positions, balances, exchanges, rules, bots, risk, activity, portfolio
// =====================================================================
import { EventEmitter } from 'node:events'

export const USER_CHANNELS = new Set(['orders', 'positions', 'balances', 'exchanges', 'rules', 'bots', 'risk', 'activity', 'portfolio'])
const PUBLIC_PATTERNS = [/^tickers$/, /^orderbook:[A-Z0-9/._-]+$/, /^trades:[A-Z0-9/._-]+$/, /^candles:[A-Z0-9/._-]+:(1m|5m|15m|1h|4h|1d)$/]

class Hub extends EventEmitter {
  constructor() {
    super()
    this.clients = new Set()
  }

  add(socket, user) {
    const client = { socket, userId: user.id, isAdmin: user.isAdmin, channels: new Set() }
    this.clients.add(client)
    return client
  }

  remove(client) {
    this.clients.delete(client)
    this.emit('subscriptions')
  }

  isValidChannel(channel) {
    return USER_CHANNELS.has(channel) || PUBLIC_PATTERNS.some((re) => re.test(channel))
  }

  subscribe(client, channel) {
    if (!this.isValidChannel(channel)) return false
    client.channels.add(channel)
    this.emit('subscriptions')
    return true
  }

  unsubscribe(client, channel) {
    client.channels.delete(channel)
    this.emit('subscriptions')
  }

  /** Abone olunan tüm kanallar (piyasa verisi çekimini sınırlamak için) */
  activeChannels() {
    const set = new Set()
    for (const c of this.clients) for (const ch of c.channels) set.add(ch)
    return set
  }

  hasSubscribers(channel) {
    for (const c of this.clients) if (c.channels.has(channel)) return true
    return false
  }

  send(client, msg) {
    if (client.socket.readyState === 1) client.socket.send(msg)
  }

  /** Herkese açık kanal yayını */
  broadcast(channel, data) {
    let msg
    for (const c of this.clients) {
      if (!c.channels.has(channel)) continue
      msg ??= JSON.stringify({ channel, data })
      this.send(c, msg)
    }
  }

  /** Belirli kullanıcının oturumlarına yayın */
  toUser(userId, channel, data = null) {
    let msg
    for (const c of this.clients) {
      if (c.userId !== userId || !c.channels.has(channel)) continue
      msg ??= JSON.stringify({ channel, data })
      this.send(c, msg)
    }
  }

  /** Kullanıcının tüm soketlerini kapat (oturum iptali) */
  disconnectUser(userId) {
    for (const c of this.clients) if (c.userId === userId) c.socket.close(4001, 'session revoked')
  }
}

export const hub = new Hub()
