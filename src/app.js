// =====================================================================
//  Fastify uygulaması – eklentiler, hata yönetimi, rotalar
// =====================================================================
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { config } from './config.js'
import { AppError } from './lib/errors.js'
import { setLogger } from './lib/logger.js'
import userRoutes from './routes/user.js'
import adminRoutes from './routes/admin.js'
import wsRoutes from './realtime/ws.js'

// "https://site.com/", tırnaklı veya boşluklu girilen adresleri de doğru eşleştir
export function corsOrigins() {
  return config.CORS_ORIGIN.split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, ''))
    .filter(Boolean)
}

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.credentials', 'req.body.code'],
      serializers: {
        // WebSocket adresindeki oturum anahtarı (…/ws?token=…) log'a yazılmasın
        req: (req) => ({
          method: req.method,
          url: String(req.url || '').replace(/([?&](token|code|password)=)[^&]*/gi, '$1***'),
          remoteAddress: req.ip,
        }),
      },
    },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  })
  setLogger(app.log)

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : corsOrigins(),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: false,
  })
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, message: `Çok fazla istek. ${Math.ceil(ctx.ttl / 1000)} sn sonra tekrar deneyin.`, code: 'RATE_LIMITED' }),
  })
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } })

  // Boş gövdeli JSON POST'ları kabul et (ör. /bots/:id/start)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, {})
    try {
      done(null, JSON.parse(body))
    } catch {
      done(new AppError(400, 'Geçersiz JSON gövdesi', 'INVALID_JSON'))
    }
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ message: err.message, code: err.code, details: err.details })
    if (err.validation) return reply.status(400).send({ message: 'Geçersiz istek', code: 'VALIDATION', details: err.validation })
    if (err.statusCode === 429) return reply.status(429).send({ message: err.message, code: 'RATE_LIMITED' })
    // Prisma bilinen hatalar
    if (err.code === 'P2025') return reply.status(404).send({ message: 'Kayıt bulunamadı', code: 'NOT_FOUND' })
    if (err.code === 'P2002') return reply.status(409).send({ message: 'Bu kayıt zaten mevcut', code: 'DUPLICATE' })
    if (err.code === 'P2003') return reply.status(409).send({ message: 'İlişkili kayıtlar olduğu için işlem yapılamadı', code: 'FK_CONSTRAINT' })
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ message: err.message, code: err.code || 'BAD_REQUEST' })
    req.log.error({ err }, 'beklenmeyen hata')
    return reply.status(500).send({ message: 'Sunucu hatası, lütfen tekrar deneyin', code: 'INTERNAL' })
  })
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ message: `Uç nokta bulunamadı: ${req.method} ${req.url.split('?')[0]}`, code: 'NOT_FOUND' }))

  await app.register(wsRoutes)
  await app.register(
    async (api) => {
      await api.register(userRoutes)
      await api.register(adminRoutes, { prefix: '/admin' })
    },
    { prefix: '/api/v1' },
  )
  app.get('/', async () => ({ name: 'Tradepilo API', docs: '/api/v1/meta', health: '/api/v1/health' }))
  return app
}
