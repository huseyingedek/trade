import { hub } from './hub.js'
import { authenticateToken } from '../plugins/auth.js'

export default async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    let client = null
    let closed = false
    const pending = []

    const handle = (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg?.op === 'ping') return socket.send(JSON.stringify({ op: 'pong' }))
      if (typeof msg?.channel !== 'string') return
      if (msg.op === 'subscribe' && !hub.subscribe(client, msg.channel)) socket.send(JSON.stringify({ op: 'error', message: `Geçersiz kanal: ${msg.channel}` }))
      if (msg.op === 'unsubscribe') hub.unsubscribe(client, msg.channel)
    }

    // Kimlik doğrulama sürerken gelen mesajlar kuyrukta bekler
    socket.on('message', (raw) => (client ? handle(raw) : pending.push(raw)))
    socket.on('close', () => {
      closed = true
      if (client) hub.remove(client)
    })
    socket.on('error', () => client && hub.remove(client))

    authenticateToken(req.query?.token)
      .then((auth) => {
        if (closed) return
        client = hub.add(socket, auth.user)
        pending.splice(0).forEach(handle)
      })
      .catch(() => socket.close(4001, 'unauthorized'))
  })
}
