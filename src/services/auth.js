// =====================================================================
//  KİMLİK: kayıt, giriş, 2FA (TOTP), oturumlar, şifre sıfırlama, davet
// =====================================================================
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { encrypt, decrypt, sha256 } from '../lib/crypto.js'
import { signAccess, signPurpose, verifyToken, expiresAtFromNow } from '../lib/tokens.js'
import { newSecret, otpauth, verifyCode } from '../lib/totp.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { ROLES, isAdminRole, permissionsOf } from '../lib/rbac.js'
import { sendMail } from '../lib/mailer.js'
import { getPlatform } from './platform.js'
import { hub } from '../realtime/hub.js'
import { toApi } from '../lib/serialize.js'

const EMAIL_RE = /^\S+@\S+\.\S+$/
const CHALLENGE_TTL = 5 * 60_000

export const planView = (p) =>
  p && toApi({
    id: p.id, name: p.name, description: p.description, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly, currency: p.currency,
    limits: { exchanges: p.maxExchanges, bots: p.maxBots, rules: p.maxRules },
    features: { futures: p.futures, apiAccess: p.apiAccess, prioritySupport: p.prioritySupport, telegram: p.telegram },
    active: p.active, highlighted: p.highlighted, sortOrder: p.sortOrder,
  })

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw badRequest('Şifre en az 8 karakter olmalı')
  if (!/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(pw) || !/\d/.test(pw)) throw badRequest('Şifre en az bir harf ve bir rakam içermeli')
}

/** /auth/me yanıtı */
export async function meView(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { plan: true, _count: { select: { exchanges: true, bots: true, rules: true } } },
  })
  if (!u) throw notFound()
  const admin = isAdminRole(u.role)
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    kind: admin ? 'admin' : 'user',
    role: u.role,
    roleLabel: admin ? ROLES[u.role].label : 'Yatırımcı',
    permissions: permissionsOf(u.role),
    status: u.status,
    baseCurrency: u.baseCurrency,
    notifications: u.notifications,
    twoFactor: u.twoFactorEnabled,
    emailVerified: !!u.emailVerifiedAt,
    plan: admin ? null : planView(u.plan),
    usage: admin ? null : { exchanges: u._count.exchanges, bots: u._count.bots, rules: u._count.rules },
    createdAt: u.createdAt.getTime(),
  }
}

async function createSession(user, meta) {
  const s = await prisma.session.create({ data: { userId: user.id, ipAddress: meta.ip, userAgent: meta.ua?.slice(0, 300), expiresAt: expiresAtFromNow() } })
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastActiveAt: new Date(), failedLoginCount: 0 } })
  return { token: signAccess(user.id, s.id), user: await meView(user.id) }
}

// ------------------------------------------------------------------ kayıt
export async function register({ name, email, password }, meta) {
  const platform = await getPlatform()
  if (!platform.registrationOpen) throw forbidden('Yeni kayıtlar geçici olarak kapalı', 'REGISTRATION_CLOSED')
  if (!name?.trim() || name.trim().length < 2) throw badRequest('Ad soyad gerekli')
  if (!EMAIL_RE.test(email || '')) throw badRequest('Geçerli bir e-posta girin')
  checkPassword(password)
  const normalized = email.trim().toLowerCase()
  if (await prisma.user.findUnique({ where: { email: normalized } })) throw conflict('Bu e-posta ile kayıtlı bir hesap var', 'EMAIL_TAKEN')
  const user = await prisma.user.create({
    data: {
      name: name.trim(),
      email: normalized,
      passwordHash: await bcrypt.hash(password, 12),
      status: config.REQUIRE_EMAIL_VERIFICATION ? 'pending' : 'active',
      risk: { create: {} },
    },
  })
  const token = signPurpose('verify', user.id, { em: user.email }, '3d')
  await sendMail({ to: user.email, subject: 'Tradepilo – e-posta doğrulama', text: `Hesabınızı doğrulamak için: ${config.APP_URL}/verify-email?token=${token}` })
  if (config.REQUIRE_EMAIL_VERIFICATION) return { requiresVerification: true }
  return createSession(user, meta)
}

// ------------------------------------------------------------------ giriş
export async function login({ email, password }, meta) {
  if (!EMAIL_RE.test(email || '') || !password) throw badRequest('E-posta ve şifre gerekli')
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
  const ok = user && (await bcrypt.compare(password, user.passwordHash))
  if (!ok) {
    if (user) {
      const recent = user.lastFailedLoginAt && Date.now() - user.lastFailedLoginAt.getTime() < 3_600_000
      const count = recent ? user.failedLoginCount + 1 : 1
      const flag = 'Çok sayıda hatalı giriş denemesi'
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: count, lastFailedLoginAt: new Date(), ...(count >= 5 && !user.riskFlags.includes(flag) ? { riskFlags: { push: flag } } : {}) },
      })
    }
    throw unauthorized('E-posta veya şifre hatalı', 'INVALID_CREDENTIALS')
  }
  if (['suspended', 'disabled'].includes(user.status)) throw forbidden('Hesabınız askıya alınmış. Destek ile iletişime geçin.', 'ACCOUNT_SUSPENDED')
  if (user.status === 'invited') throw forbidden('Önce e-postanızdaki daveti kabul edin', 'INVITE_PENDING')
  if (user.status === 'pending') throw forbidden('E-posta adresinizi doğrulayın', 'EMAIL_NOT_VERIFIED')

  const admin = isAdminRole(user.role)
  const platform = await getPlatform()
  const needs2fa = user.twoFactorEnabled || admin || platform.requireUser2fa
  if (!needs2fa) return createSession(user, meta)

  if (!user.twoFactorEnabled) {
    // İlk kurulum: geçici sır üret, QR ile göster
    const secret = newSecret()
    const ch = await prisma.loginChallenge.create({ data: { userId: user.id, purpose: 'setup', expiresAt: new Date(Date.now() + 10 * 60_000), pendingSecretEnc: encrypt(secret) } })
    const { uri, qr } = await otpauth(secret, user.email)
    return { requires2fa: true, setupRequired: true, challengeId: ch.id, secret, otpauthUrl: uri, qr }
  }
  const ch = await prisma.loginChallenge.create({ data: { userId: user.id, purpose: 'login', expiresAt: new Date(Date.now() + CHALLENGE_TTL) } })
  return { requires2fa: true, challengeId: ch.id, method: 'totp' }
}

const MAX_2FA_ATTEMPTS = 5

export async function verify2fa({ challengeId, code }, meta) {
  const id = String(challengeId || '')
  const ch = await prisma.loginChallenge.findUnique({ where: { id }, include: { user: true } })
  if (!ch || ch.usedAt || ch.expiresAt < new Date()) throw unauthorized('Doğrulama süresi doldu, tekrar giriş yapın', 'CHALLENGE_EXPIRED')
  // Deneme hakkı ATOMİK olarak düşülür: aynı anda gönderilen paralel istekler 5 deneme sınırını aşamaz
  const claim = await prisma.loginChallenge.updateMany({
    where: { id, usedAt: null, attempts: { lt: MAX_2FA_ATTEMPTS }, expiresAt: { gt: new Date() } },
    data: { attempts: { increment: 1 } },
  })
  if (!claim.count) throw unauthorized('Çok fazla hatalı deneme, tekrar giriş yapın', 'CHALLENGE_LOCKED')
  const secret = ch.purpose === 'setup' ? decrypt(ch.pendingSecretEnc) : decrypt(ch.user.twoFactorSecretEnc)
  if (!verifyCode(secret, code)) throw unauthorized('Doğrulama kodu hatalı', 'INVALID_2FA')
  // Tek kullanımlık: aynı doğrulama ile iki oturum açılamaz
  const used = await prisma.loginChallenge.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })
  if (!used.count) throw unauthorized('Doğrulama süresi doldu, tekrar giriş yapın', 'CHALLENGE_EXPIRED')
  if (ch.purpose === 'setup') await prisma.user.update({ where: { id: ch.userId }, data: { twoFactorEnabled: true, twoFactorSecretEnc: encrypt(secret) } })
  return createSession(ch.user, meta)
}

// ------------------------------------------------------------------ 2FA yönetimi (oturum açıkken)
export async function start2faSetup(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (user.twoFactorEnabled) throw conflict('2FA zaten açık')
  const secret = newSecret()
  const ch = await prisma.loginChallenge.create({ data: { userId, purpose: 'setup', expiresAt: new Date(Date.now() + 10 * 60_000), pendingSecretEnc: encrypt(secret) } })
  const { uri, qr } = await otpauth(secret, user.email)
  return { challengeId: ch.id, secret, otpauthUrl: uri, qr }
}

export async function enable2fa(userId, { challengeId, code }) {
  const ch = await prisma.loginChallenge.findFirst({ where: { id: String(challengeId || ''), userId, purpose: 'setup', usedAt: null } })
  if (!ch || ch.expiresAt < new Date()) throw badRequest('Kurulum süresi doldu, yeniden başlatın')
  const claim = await prisma.loginChallenge.updateMany({ where: { id: ch.id, usedAt: null, attempts: { lt: MAX_2FA_ATTEMPTS } }, data: { attempts: { increment: 1 } } })
  if (!claim.count) throw badRequest('Çok fazla hatalı deneme, kurulumu yeniden başlatın', 'CHALLENGE_LOCKED')
  const secret = decrypt(ch.pendingSecretEnc)
  if (!verifyCode(secret, code)) throw badRequest('Doğrulama kodu hatalı', 'INVALID_2FA')
  await prisma.$transaction(async (tx) => {
    const used = await tx.loginChallenge.updateMany({ where: { id: ch.id, usedAt: null }, data: { usedAt: new Date() } })
    if (!used.count) throw badRequest('Kurulum süresi doldu, yeniden başlatın')
    await tx.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, twoFactorSecretEnc: encrypt(secret) } })
  })
  return meView(userId)
}

export async function disable2fa(userId, { code }) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user.twoFactorEnabled) return meView(userId)
  if (isAdminRole(user.role)) throw forbidden('Admin hesaplarında 2FA kapatılamaz')
  if ((await getPlatform()).requireUser2fa) throw forbidden('Platform politikası gereği 2FA zorunlu')
  if (!verifyCode(decrypt(user.twoFactorSecretEnc), code)) throw badRequest('Doğrulama kodu hatalı', 'INVALID_2FA')
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecretEnc: null } })
  return meView(userId)
}

// ------------------------------------------------------------------ profil
export async function updateMe(userId, body, sessionId = null) {
  const data = {}
  let emailChanged = false
  if (body.name !== undefined) {
    if (!body.name.trim() || body.name.trim().length < 2) throw badRequest('Ad en az 2 karakter olmalı')
    data.name = body.name.trim()
  }
  if (body.email !== undefined) {
    const e = String(body.email).trim().toLowerCase()
    if (!EMAIL_RE.test(e)) throw badRequest('Geçerli bir e-posta girin')
    const current = await prisma.user.findUnique({ where: { id: userId } })
    if (e !== current.email) {
      // E-posta, şifre sıfırlamanın gittiği adres: değiştirmek hesabı ele geçirmek demek.
      // Bu yüzden mevcut şifre (ve 2FA açıksa kod) istenir; yeni adres yeniden doğrulanır.
      if (!(await bcrypt.compare(String(body.currentPassword || ''), current.passwordHash)))
        throw badRequest('E-posta değiştirmek için mevcut şifrenizi girin', 'PASSWORD_REQUIRED')
      if (current.twoFactorEnabled && !verifyCode(decrypt(current.twoFactorSecretEnc), body.code))
        throw badRequest('E-posta değiştirmek için doğrulama kodunu girin', 'INVALID_2FA')
      const other = await prisma.user.findUnique({ where: { email: e } })
      if (other) throw conflict('Bu e-posta başka bir hesapta kullanılıyor', 'EMAIL_TAKEN')
      data.email = e
      data.emailVerifiedAt = null
      emailChanged = current.email
    }
  }
  if (body.baseCurrency !== undefined) {
    if (!['USD', 'TRY', 'EUR'].includes(body.baseCurrency)) throw badRequest('Desteklenmeyen para birimi')
    data.baseCurrency = body.baseCurrency
  }
  if (body.notifications) {
    const n = body.notifications
    data.notifications = { app: !!n.app, email: !!n.email, telegram: !!n.telegram, telegramChatId: String(n.telegramChatId || '').slice(0, 64) }
    if (data.notifications.telegram && !data.notifications.telegramChatId) throw badRequest('Telegram için Chat ID gerekli')
  }
  await prisma.user.update({ where: { id: userId }, data })
  if (emailChanged) {
    const token = signPurpose('verify', userId, { em: data.email }, '3d')
    await sendMail({ to: data.email, subject: 'Tradepilo – e-posta doğrulama', text: `Yeni e-posta adresinizi doğrulamak için: ${config.APP_URL}/verify-email?token=${token}` })
    // eski adrese bilgi: hesap sahibi değişikliği yapmadıysa fark edebilsin
    await sendMail({ to: emailChanged, subject: 'Tradepilo – e-posta adresiniz değiştirildi', text: `Hesabınızın e-posta adresi ${data.email} olarak değiştirildi. Bu değişikliği siz yapmadıysanız hemen destek ile iletişime geçin.` })
    // diğer oturumlar kapatılır (bu oturum açık kalır)
    await prisma.session.updateMany({ where: { userId, revokedAt: null, ...(sessionId ? { id: { not: sessionId } } : {}) }, data: { revokedAt: new Date() } })
  }
  return meView(userId)
}

export async function changePassword(userId, sessionId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!(await bcrypt.compare(currentPassword || '', user.passwordHash))) throw badRequest('Mevcut şifre hatalı')
  checkPassword(newPassword)
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } })
  await prisma.session.updateMany({ where: { userId, id: { not: sessionId }, revokedAt: null }, data: { revokedAt: new Date() } })
  return { ok: true }
}

/**
 * Kullanıcının kendi hesabını kalıcı olarak silmesi (KVKK – silme hakkı).
 * Şifre (ve 2FA açıksa kod) ile doğrulanır. Bağlantılar, bakiyeler, emirler,
 * kurallar, botlar ve geçmiş birlikte silinir. Ödeme kayıtları da silinir;
 * yasal saklama yükümlülüğünüz varsa önce dışa aktarın.
 */
export async function deleteAccount(userId, { password, code }) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound()
  if (isAdminRole(user.role)) throw forbidden('Admin hesapları buradan silinemez; ekip yönetiminden kaldırılmalı')
  if (!(await bcrypt.compare(String(password || ''), user.passwordHash))) throw badRequest('Şifre hatalı')
  if (user.twoFactorEnabled && !verifyCode(decrypt(user.twoFactorSecretEnc), code)) throw badRequest('Doğrulama kodu hatalı', 'INVALID_2FA')
  const liveOpen = await prisma.order.count({ where: { userId, status: 'open', exchange: { mode: 'live' } } })
  if (liveOpen) throw conflict(`Borsada bekleyen ${liveOpen} canlı emriniz var. Önce bu emirleri iptal edin.`)
  hub.disconnectUser(userId)
  await prisma.user.delete({ where: { id: userId } })
  return { ok: true }
}

export async function logout(sessionId) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
  return { ok: true }
}

export async function revokeAllSessions(userId) {
  const r = await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  hub.disconnectUser(userId)
  return r.count
}

// ------------------------------------------------------------------ şifre sıfırlama / doğrulama / davet
const pwdVersion = (u) => sha256(u.passwordHash).slice(0, 16)

export async function forgotPassword({ email }) {
  const user = await prisma.user.findUnique({ where: { email: String(email || '').trim().toLowerCase() } })
  if (user && !['suspended', 'disabled'].includes(user.status)) {
    const token = signPurpose('reset', user.id, { pv: pwdVersion(user) }, '30m')
    await sendMail({ to: user.email, subject: 'Tradepilo – şifre sıfırlama', text: `Şifrenizi sıfırlamak için (30 dk geçerli): ${config.APP_URL}/reset-password?token=${token}` })
  }
  // Kullanıcı varlığını sızdırmamak için her zaman aynı yanıt
  return { ok: true }
}

export async function resetPassword({ token, password }) {
  let p
  try {
    p = verifyToken(token, 'reset')
  } catch {
    throw badRequest('Bağlantı geçersiz veya süresi dolmuş')
  }
  const user = await prisma.user.findUnique({ where: { id: p.sub } })
  if (!user || p.pv !== pwdVersion(user)) throw badRequest('Bağlantı daha önce kullanılmış')
  checkPassword(password)
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12), failedLoginCount: 0 } })
  await revokeAllSessions(user.id)
  return { ok: true }
}

export async function verifyEmail({ token }) {
  let p
  try {
    p = verifyToken(token, 'verify')
  } catch {
    throw badRequest('Doğrulama bağlantısı geçersiz')
  }
  // Bağlantı hangi adres için üretildiyse sadece o adresi doğrular (e-posta sonradan değiştiyse eski bağlantı geçersiz)
  const cur = await prisma.user.findUnique({ where: { id: p.sub }, select: { email: true } })
  if (!cur || (p.em && p.em !== cur.email)) throw badRequest('Doğrulama bağlantısı geçersiz')
  const u = await prisma.user.update({ where: { id: p.sub }, data: { emailVerifiedAt: new Date() } })
  if (u.status === 'pending') await prisma.user.update({ where: { id: u.id }, data: { status: 'active' } })
  return { ok: true }
}

export async function acceptInvite({ token, password }) {
  let p
  try {
    p = verifyToken(token, 'invite')
  } catch {
    throw badRequest('Davet bağlantısı geçersiz veya süresi dolmuş')
  }
  const u = await prisma.user.findUnique({ where: { id: p.sub } })
  if (!u || u.status !== 'invited') throw badRequest('Davet zaten kullanılmış')
  checkPassword(password)
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12), status: 'active', emailVerifiedAt: new Date() } })
  return { ok: true, email: u.email }
}
