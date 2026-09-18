import type { IncomingMessage } from 'node:http'
import { ROUTES, type Route } from '../types.js'
import { MAX_BODY_BYTES } from '../wallet.js'

/**
 * Reads the request body as bytes, never as a string.
 *
 * Two details that look like paranoia and are not:
 *
 *  - chunks are kept as Buffers and concatenated as Buffers. Building the body
 *    with `body += chunk` decodes each chunk to UTF-8 independently, which
 *    corrupts any multi-byte character that straddles a chunk boundary — and
 *    changes the bytes the HMAC is computed over.
 *  - the cap is enforced on bytes actually read, not on `Content-Length`. A
 *    header that lies is the whole point of a header that lies.
 */
export async function readRawBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array> {
  // Already captured upstream? Use it rather than reading a consumed stream.
  const pre = (req as { rawBody?: unknown }).rawBody ?? (req as { body?: unknown }).body
  if (pre instanceof Uint8Array) return pre

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.byteLength
    if (total > maxBytes) {
      // Stop reading; the caller answers 400. Draining the rest would let a
      // sender make us pay for bytes we have already refused.
      return Buffer.concat([...chunks, buf], total)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

/**
 * `verify` hook for a JSON body parser, for apps that need the parsed body too:
 *
 * ```js
 * app.use(express.json({ verify: captureRawBody }))
 * ```
 *
 * The SDK then finds the original bytes on `req.rawBody`. It is a plain
 * function, so using it pulls in no dependency.
 */
export function captureRawBody(req: unknown, _res: unknown, buf: Buffer): void {
  ;(req as { rawBody?: Buffer }).rawBody = buf
}

/**
 * Maps a request path to one of the four callback routes.
 *
 * Matching is on the SUFFIX because the mount path belongs to the operator: the
 * gateway POSTs to the full callback URL configured in the backoffice,
 * prefix and all, so `/api/v2/beexar/betwin` is as valid as `/betwin`.
 */
export function routeFromPath(path: string): Route | null {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '') || '/'
  for (const r of ROUTES) {
    if (clean === r || clean.endsWith(r)) return r
  }
  return null
}
