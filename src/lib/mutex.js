// Anahtar bazlı basit kilit – aynı kullanıcının işlem adımlarını sıraya koyar.
// Tek süreç (single instance) için yeterli; yatay ölçeklemede Redis kilidi kullanılmalı.
const chains = new Map()

export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  chains.set(key, tail)
  tail.then(() => chains.get(key) === tail && chains.delete(key))
  return next
}
