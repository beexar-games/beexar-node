import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { WalletServer } from '../wallet.js'
import { SIGNATURE_HEADER } from '../signature.js'
import { MAX_BODY_BYTES } from '../wallet.js'
import { ROUTES } from '../types.js'

export interface FastifyWalletOptions {
  server: WalletServer
  /** Path prefix the four routes are registered under. Default `''`. */
  prefix?: string
}

/**
 * Fastify plugin registering the four callbacks.
 *
 * ```js
 * await app.register(fastifyWallet, { server, prefix: '/wallet' })
 * ```
 *
 * Fastify parses `application/json` for you by default, which would destroy the
 * bytes the signature covers. The plugin replaces that parser with one that
 * yields the raw Buffer — and does it **inside its own encapsulated scope**, so
 * the rest of your app keeps the normal JSON parsing it expects. That
 * encapsulation is why this plugin must NOT be wrapped in `fastify-plugin`.
 */
export const fastifyWallet: FastifyPluginAsync<FastifyWalletOptions> = async (
  app: FastifyInstance,
  opts: FastifyWalletOptions,
) => {
  const { server } = opts

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })
  // Anything else also arrives as bytes rather than being refused with a 415.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  for (const route of ROUTES) {
    app.post(route, { bodyLimit: MAX_BODY_BYTES * 2 }, async (req: FastifyRequest, reply) => {
      const raw = req.body
      const rawBody = raw instanceof Uint8Array ? raw : new Uint8Array(0)
      const signature = req.headers[SIGNATURE_HEADER]
      const out = await server.dispatch(
        route,
        rawBody,
        Array.isArray(signature) ? signature[0] : signature,
        req.headers as Record<string, string>,
      )
      return reply.code(out.status).headers(out.headers).send(out.body)
    })
  }
}

export default fastifyWallet
