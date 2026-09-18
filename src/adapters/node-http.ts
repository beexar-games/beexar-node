import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WalletServer } from '../wallet.js'
import { SIGNATURE_HEADER } from '../signature.js'
import { MAX_BODY_BYTES } from '../wallet.js'
import { readRawBody, routeFromPath } from './raw-body.js'

export interface NodeHttpWalletOptions {
  /** Answer 404 for paths that are not one of the four callbacks. Default true. */
  handleUnknownRoutes?: boolean
}

/**
 * A plain `http.createServer` handler for the four callbacks.
 *
 * This is the binding with the fewest moving parts, and the one every other
 * binding is built the same way as: read the bytes, hand them to the server,
 * write what comes back.
 */
export function nodeHttpWallet(
  server: WalletServer,
  options: NodeHttpWalletOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handleUnknown = options.handleUnknownRoutes ?? true

  return async (req, res) => {
    const route = routeFromPath(req.url ?? '/')
    if (route === null || req.method !== 'POST') {
      if (!handleUnknown) return
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"code":"invalid_argument","msg":"not found","meta":{"api_code":"404","api_message":"not found"}}')
      return
    }

    const rawBody = await readRawBody(req)
    const signature = req.headers[SIGNATURE_HEADER]
    const out = await server.dispatch(
      route,
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
      normaliseHeaders(req.headers),
    )
    res.writeHead(out.status, out.headers)

    // readRawBody stops at the cap rather than draining what it has already
    // refused. The sender may still be writing, so the socket has to go —
    // otherwise the connection sits open waiting for a body we will not read.
    // Destroying it only AFTER the response has flushed is the part that
    // matters: tear the socket down first and the client sees a reset instead
    // of the 400 explaining why.
    res.end(out.body, () => {
      if (rawBody.byteLength > MAX_BODY_BYTES && !req.readableEnded) req.destroy()
    })
  }
}

function normaliseHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ')
  }
  return out
}
