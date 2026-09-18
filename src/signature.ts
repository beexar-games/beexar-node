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
  if (!signature) return false
  const expected = sign(body, secret)
  // timingSafeEqual throws on a length mismatch, which for hex digests only
  // happens when the header is malformed — treat that as a plain rejection.
  if (signature.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
}
