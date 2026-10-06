// Değiştirilemez admin denetim kaydı (sadece INSERT)
import { prisma } from '../lib/prisma.js'

export function audit(req, action, target, details = '', targetId = null) {
  return prisma.auditLog.create({
    data: {
      actorId: req?.user?.id ?? null,
      actorName: req?.user?.name ?? 'Sistem',
      action,
      target: String(target),
      targetId,
      details,
      ip: req?.ip ?? null,
    },
  })
}
