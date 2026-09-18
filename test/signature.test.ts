import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CONFORMANCE_ROOT } from './conformance-root.js'
import { sign, verify } from '../src/signature.js'

const SECRET = 'conformance-secret-do-not-use-in-production'

describe('sign', () => {
  it('matches the value the platform computes for the same bytes', () => {
    // Independently generated: openssl dgst -sha256 -hmac <secret>
    const body = readFileSync(
      CONFORMANCE_ROOT + 'cases/0004-key-order-hostile/request.body',
    )
    const expected = JSON.parse(
      readFileSync(
        CONFORMANCE_ROOT + 'cases/0004-key-order-hostile/request.json',
        'utf8',
      ),
    ).headers['X-REQUEST-SIGN']
    expect(sign(body, SECRET)).toBe(expected)
  })

  it('signs bytes, not a re-serialisation', () => {
    const a = '{"b":1,"a":2}'
    const b = '{"a":2,"b":1}'
    expect(sign(a, SECRET)).not.toBe(sign(b, SECRET))
  })
})

describe('verify', () => {
  it('accepts a correct signature', () => {
    const body = Buffer.from('{"a":1}')
    expect(verify(body, sign(body, SECRET), SECRET)).toBe(true)
  })

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['wrong length', 'deadbeef'],
    ['wrong value', '0'.repeat(64)],
  ])('rejects a %s signature', (_label, sig) => {
    expect(verify(Buffer.from('{"a":1}'), sig, SECRET)).toBe(false)
  })

  it('rejects when the secret differs', () => {
    const body = Buffer.from('{"a":1}')
    expect(verify(body, sign(body, 'other'), SECRET)).toBe(false)
  })
})
