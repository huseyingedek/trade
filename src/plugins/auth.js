// =====================================================================
//  Kimlik doğrulama ve yetki kontrolü
//  Authorization: Bearer <jwt>  →  JWT + veritabanındaki oturum (iptal edilebilir)
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { verifyToken } from '../lib/tokens.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { ROLES, isAdminRole, permissionsOf } from '../lib/rbac.js'

const TOUCH_MS = 60_000

/** Token'ı doğrular, oturumu ve kullanıcıyı yükler */
export async function authenticateToken(token) {
  if (!token) throw unauthorized()
  let payload
  try {
    payload = verifyToken(token, 'access')
  } catch {
    throw unauthorized()
  }
  const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } })
  if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) throw unauthorized()
  const u = session.user
  if (['suspended', 'disabled'].includes(u.status)) throw forbidden('Hesabınız askıya alınmış. Destek ile iletişime geçin.', 'ACCOUNT_SUSPENDED')
  if (u.status === 'invited') throw forbidden('Davet henüz kabul edilmemiş', 'INVITE_PENDING')

  // son görülme zamanını seyrek güncelle
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_MS) {
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
    prisma.user.update({ where: { id: u.id }, data: { lastActiveAt: new Date() } }).catch(() => {})
  }
  const isAdmin = isAdminRole(u.role)
  return {
    session,
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      planId: u.planId,
      isAdmin,
      roleLabel: isAdmin ? ROLES[u.role].label : 'Yatırımcı',
      permissions: permissionsOf(u.role),
    },
  }
}

const bearer = (req) => {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

/** Herhangi bir oturum açmış hesap */
export const requireAuth = async (req) => {
  const { user, session } = await authenticateToken(bearer(req))
  req.user = user
  req.sessionId = session.id
}

/** Sadece yatırımcı (işlem yapan) hesaplar – admin hesapları kullanıcı adına işlem yapamaz */
export const requireTrader = async (req) => {
  await requireAuth(req)
  if (req.user.isAdmin) throw forbidden('Admin hesapları işlem uç noktalarını kullanamaz', 'ADMIN_NOT_TRADER')
}

/** Admin + belirli izin */
export const requireAdmin = (perm) => async (req) => {
  await requireAuth(req)
  if (!req.user.isAdmin) throw forbidden()
  if (perm && !req.user.permissions.includes(perm)) throw forbidden('Bu işlem için yetkiniz yok', 'FORBIDDEN')
}
