import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WalletServer } from '../wallet.js'
import { SIGNATURE_HEADER } from '../signature.js'
import { readRawBody, routeFromPath } from './raw-body.js'

export { captureRawBody } from './raw-body.js'

type Next = (err?: unknown) => void

/**
 * Express / Connect middleware for the four callbacks.
 *
 * ```js
 * app.use('/wallet', beexarWallet(server))
 * ```
 *
 * It reads the raw stream itself and pulls in no dependency, so it works the
 * same in Express 4, Express 5, Connect, and anything else with the
 * `(req, res, next)` shape.
 *
 * **Mount it before any JSON body parser.** `express.json()` consumes the
 * stream, and `JSON.stringify(req.body)` is a different byte string from what
 * the platform signed — different key order, different escaping, different
 * number rendering. Those bytes are unrecoverable. If you need the parsed body
 * elsewhere in the app, keep the original with the `verify` hook instead:
 *
 * ```js
 * app.use(express.json({ verify: captureRawBody }))
 * ```
 *
 * and this middleware will find them on `req.rawBody`.
 */
export function beexarWallet(
  server: WalletServer,
): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    const path = (req as { originalUrl?: string; url?: string }).url ?? ''
    const route = routeFromPath(path)
    if (route === null || req.method !== 'POST') {
      next()
      return
    }

    void (async () => {
      try {
        const rawBody = await readRawBody(req)
        const signature = req.headers[SIGNATURE_HEADER]
        const out = await server.dispatch(
          route,
          rawBody,
          Array.isArray(signature) ? signature[0] : signature,
          req.headers as Record<string, string>,
        )
        res.writeHead(out.status, out.headers)
        res.end(out.body)
      } catch (err) {
        next(err)
      }
    })()
  }
}
