// Prisma çıktısını API biçimine çevirir: Date → ms, Decimal → number
const isDecimal = (v) => v && typeof v === 'object' && typeof v.toNumber === 'function' && 'd' in v && 'e' in v

export function toApi(value) {
  if (value === null || value === undefined) return value ?? null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'bigint') return Number(value)
  if (isDecimal(value)) return value.toNumber()
  if (Array.isArray(value)) return value.map(toApi)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = toApi(v)
    return out
  }
  return value
}

export const num = (v) => (v === null || v === undefined ? null : isDecimal(v) ? v.toNumber() : Number(v))
