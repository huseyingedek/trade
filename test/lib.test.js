// Birim testleri (veritabanı gerektirmez): npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x'
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-123'
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

const { encrypt, decrypt, maskKey } = await import('../src/lib/crypto.js')
const { can, permissionsOf, isAdminRole } = await import('../src/lib/rbac.js')
const { roundTo, floorTo, decimalsOf } = await import('../src/lib/num.js')
const { signPurpose, verifyToken } = await import('../src/lib/tokens.js')

test('AES-GCM şifreleme geri çözülür ve her seferinde farklı çıktı üretir', () => {
  const data = { apiKey: 'abc', apiSecret: 'çok-gizli' }
  const a = encrypt(data)
  const b = encrypt(data)
  assert.notEqual(a, b)
  assert.deepEqual(decrypt(a), data)
})

test('şifreli veri değiştirilirse çözme başarısız olur', () => {
  const enc = encrypt({ k: 1 })
  const parts = enc.split(':')
  parts[3] = Buffer.from('bozuk').toString('base64')
  assert.throws(() => decrypt(parts.join(':')))
})

test('API anahtarı maskeleme', () => {
  const m = maskKey('ABCDEFGHIJKLMNOP')
  assert.ok(m.startsWith('ABCD') && m.endsWith('MNOP') && m.includes('•'))
})

test('RBAC izinleri', () => {
  assert.ok(isAdminRole('super_admin'))
  assert.ok(!isAdminRole('user'))
  assert.ok(can('finance', 'billing.manage'))
  assert.ok(!can('support', 'risk.manage'))
  assert.ok(!can('risk', 'team.manage'))
  assert.deepEqual(permissionsOf('user'), [])
})

test('fiyat/miktar yuvarlama', () => {
  assert.equal(decimalsOf(0.001), 3)
  assert.equal(roundTo(1.23456, 0.01), 1.23)
  assert.equal(floorTo(0.12999, 0.001), 0.129)
})

test('amaç tokenları türü doğrular', () => {
  const t = signPurpose('reset', 'u1', { pv: 'x' }, '5m')
  assert.equal(verifyToken(t, 'reset').sub, 'u1')
  assert.throws(() => verifyToken(t, 'access'))
})
