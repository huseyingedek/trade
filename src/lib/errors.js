// Uygulama hataları – route'lardan fırlatılır, errorHandler JSON'a çevirir
export class AppError extends Error {
  constructor(status, message, code, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (msg, code = 'BAD_REQUEST', details) => new AppError(400, msg, code, details)
export const unauthorized = (msg = 'Oturum geçersiz, tekrar giriş yapın', code = 'UNAUTHORIZED') => new AppError(401, msg, code)
export const forbidden = (msg = 'Bu işlem için yetkiniz yok', code = 'FORBIDDEN') => new AppError(403, msg, code)
export const notFound = (msg = 'Kayıt bulunamadı', code = 'NOT_FOUND') => new AppError(404, msg, code)
export const conflict = (msg, code = 'CONFLICT') => new AppError(409, msg, code)
export const unprocessable = (msg, code = 'UNPROCESSABLE') => new AppError(422, msg, code)
export const locked = (msg, code = 'LOCKED') => new AppError(423, msg, code)
export const unavailable = (msg, code = 'UNAVAILABLE') => new AppError(503, msg, code)
