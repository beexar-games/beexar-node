import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import Fastify from 'fastify'
import { Money } from '../src/money.js'
import { sign } from '../src/signature.js'
import { WalletServer } from '../src/wallet.js'
import { nodeHttpWallet } from '../src/adapters/node-http.js'
import { beexarWallet, captureRawBody } from '../src/adapters/express.js'
import { fastifyWallet } from '../src/adapters/fastify.js'
import type { WalletHandler } from '../src/types.js'

const SECRET = 'adapter-test-secret'

/**
 * A body whose key order no JSON serialiser produces. If a binding parses and
 * re-serialises before the SDK sees it, these bytes change and the signature
 * cannot match — which is exactly the failure these tests exist to catch.
 */
const HOSTILE_BODY =
  '{"transactions":[{"type":"bet","id_provider":"tx-1","amount":"10.00"}],' +
  '"round_id":"r-1","game_id":"dice","currency":"EUR","account_id":"player_1"}'

const handler: WalletHandler = {
  balance: () => ({ balance: Money.parse('100.00') }),
  betWin: (req) => ({
    round_id: 'own-round',
    balance: Money.parse('90.00'),
    transactions: req.transactions.map((t) => ({ id_provider: t.id_provider, id: 'own-1' })),
  }),
  rollback: () => ({ balance: Money.parse('100.00'), round_id: 'own-round', transactions: [] }),
  finish: () => ({ balance: Money.parse('100.00') }),
}

const newServer = (onWarning = () => {}) =>
  new WalletServer(handler, { apiSecret: SECRET, onWarning })

async function post(url: string, body: string, signature: string | null) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'X-REQUEST-SIGN': signature }),
    },
    body,
  })
}

async function withServer<T>(server: Server, run: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('node:http binding', () => {
  it('verifies a hostile key order, so the bytes reached the SDK untouched', async () => {
    await withServer(createServer(nodeHttpWallet(newServer())), async (base) => {
      const res = await post(`${base}/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
      expect(res.status).toBe(200)
      expect(((await res.json()) as { balance: string }).balance).toBe('90.00')
    })
  })

  it('serves the callbacks under whatever prefix the operator mounted', async () => {
    // The gateway POSTs to the full callback URL from the backoffice, prefix
    // and all, so the binding matches on the suffix.
    await withServer(createServer(nodeHttpWallet(newServer())), async (base) => {
      const res = await post(`${base}/api/v2/psp/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
      expect(res.status).toBe(200)
    })
  })

  it('refuses an oversize body and stops reading it', async () => {
    // Sent chunked, with no Content-Length at all, so the cap can only be
    // enforced on bytes actually read — a header could not have been trusted.
    await withServer(createServer(nodeHttpWallet(newServer())), async (base) => {
      const huge = 'x'.repeat(70 * 1024)
      const res = await fetch(`${base}/betwin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-REQUEST-SIGN': sign(huge, SECRET) },
        body: new ReadableStream({
          start(controller) {
            const chunk = new TextEncoder().encode(huge)
            controller.enqueue(chunk)
            controller.close()
          },
        }),
        duplex: 'half',
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { meta: { api_code: string } }).meta.api_code).toBe('400')
    })
  })
})

describe('express binding', () => {
  const app = (mount: (a: express.Express) => void) => {
    const a = express()
    mount(a)
    return createServer(a)
  }

  it('works when mounted before any body parser', async () => {
    await withServer(
      app((a) => a.use('/wallet', beexarWallet(newServer()))),
      async (base) => {
        const res = await post(`${base}/wallet/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
        expect(res.status).toBe(200)
      },
    )
  })

  it('works behind a global express.json() when captureRawBody keeps the bytes', async () => {
    await withServer(
      app((a) => {
        a.use(express.json({ verify: captureRawBody }))
        a.use('/wallet', beexarWallet(newServer()))
      }),
      async (base) => {
        const res = await post(`${base}/wallet/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
        expect(res.status).toBe(200)
      },
    )
  })

  it('works behind express.raw(), which hands over the Buffer already', async () => {
    await withServer(
      app((a) => {
        a.use(express.raw({ type: '*/*' }))
        a.use('/wallet', beexarWallet(newServer()))
      }),
      async (base) => {
        const res = await post(`${base}/wallet/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
        expect(res.status).toBe(200)
      },
    )
  })

  it('fails loudly, and says why, behind a plain global express.json()', async () => {
    // This is the single most common broken integration. The parser consumed
    // the stream and the signed bytes no longer exist; all the SDK can do is
    // refuse and name the cause.
    const onWarning = vi.fn()
    await withServer(
      app((a) => {
        a.use(express.json())
        a.use('/wallet', beexarWallet(newServer(onWarning)))
      }),
      async (base) => {
        const res = await post(`${base}/wallet/betwin`, HOSTILE_BODY, sign(HOSTILE_BODY, SECRET))
        expect(res.status).toBe(400)
        expect(((await res.json()) as { meta: { api_code: string } }).meta.api_code).toBe('403')
        expect(onWarning.mock.calls.join(' ')).toMatch(/consumed the stream|re-serialisation/)
      },
    )
  })

  it('passes non-callback paths through to the rest of the app', async () => {
    await withServer(
      app((a) => {
        a.use('/wallet', beexarWallet(newServer()))
        a.get('/health', (_req, res) => {
          res.json({ ok: true })
        })
      }),
      async (base) => {
        const res = await fetch(`${base}/health`)
        expect(await res.json()).toEqual({ ok: true })
      },
    )
  })
})

describe('fastify binding', () => {
  it('replaces the JSON parser inside its own scope only', async () => {
    const app = Fastify()
    await app.register(fastifyWallet, { server: newServer(), prefix: '/wallet' })
    // Outside the plugin's scope Fastify keeps parsing JSON as usual.
    app.post('/echo', async (req) => req.body)

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/betwin',
      headers: { 'content-type': 'application/json', 'X-REQUEST-SIGN': sign(HOSTILE_BODY, SECRET) },
      payload: HOSTILE_BODY,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).balance).toBe('90.00')

    const echo = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"parsed":true}',
    })
    expect(JSON.parse(echo.payload)).toEqual({ parsed: true })

    await app.close()
  })
})
