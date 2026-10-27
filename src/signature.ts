import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * `X-REQUEST-SIGN` — hex-encoded HMAC-SHA256 of the RAW request body, keyed
 * with the operator's API secret. 64 lowercase hex characters.
 */
export const SIGNATURE_HEADER = 'x-request-sign'

/** Signs the exact bytes you are about to put on the wire. */
export function sign(body: Uint8Array | string, secret: string): string {
  return createHmac('sha256', secret).update(body as never).digest('hex')
}

/** The only shape the gateway sends: a SHA-256 MAC as 64 lowercase hex characters. */
const HEX64 = /^[0-9a-f]{64}$/

/**
 * Constant-time signature check.
 *
 * `body` must be the bytes as received. If anything between the socket and
 * this call parsed the JSON and serialised it again, those bytes are gone and
 * no amount of care here can recover them — see the adapters.
 */
export function verify(
  body: Uint8Array | string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  // Shape first, and by character class rather than by count: `length` counts
  // UTF-16 code units, so 64 non-ASCII characters pass a count and still
  // encode to more than 64 bytes — and timingSafeEqual throws on buffers of
  // unequal length, which turned a malformed header into an HTTP 500 instead
  // of the plain signature refusal. Anything that is not 64 lowercase hex
  // characters cannot be a signature the gateway produced.
  if (!signature || !HEX64.test(signature)) return false
  const expected = sign(body, secret)
  return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
}
