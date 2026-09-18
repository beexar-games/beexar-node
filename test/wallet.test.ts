import { describe, expect, it, vi } from 'vitest'
import { Money } from '../src/money.js'
import { WalletError, ApiCode, isFundsRelatedCode } from '../src/errors.js'
import { sign } from '../src/signature.js'
import { WalletServer, MAX_BODY_BYTES } from '../src/wallet.js'
import type { WalletHandler } from '../src/types.js'

const SECRET = 'unit-test-secret'

const stub = (over: Partial<WalletHandler> = {}): WalletHandler => ({
  balance: () => ({ balance: Money.parse('10.00') }),
  betWin: () => ({ round_id: 'r', balance: Money.parse('10.00'), transactions: [] }),
  rollback: () => ({ balance: Money.parse('10.00'), round_id: 'r', transactions: [] }),
  finish: () => ({ balance: Money.parse('10.00') }),
  ...over,
})

const send = (server: WalletServer, route: Parameters<WalletServer['dispatch']>[0], body: string) =>
  server.dispatch(route, Buffer.from(body), sign(body, SECRET))

describe('construction', () => {
  it.each([['empty', ''], ['blank', '   ']])('refuses a %s api secret', (_l, secret) => {
    // The gateway treats an empty secret as an automatic failure, so a server
    // built with one would authenticate nothing while looking healthy.
    expect(() => new WalletServer(stub(), { apiSecret: secret })).toThrow(TypeError)
  })
})

describe('signature', () => {
  it('answers 400 with api_code 403 — never HTTP 403', async () => {
    const server = new WalletServer(stub(), { apiSecret: SECRET, onWarning: () => {} })
    const out = await server.dispatch('/balance', Buffer.from('{}'), '0'.repeat(64))
    expect(out.status).toBe(400)
    expect(JSON.parse(out.body).meta.api_code).toBe(ApiCode.FORBIDDEN)
  })

  it('names the re-serialisation trap when the body looks machine-generated', async () => {
    const onWarning = vi.fn()
    const server = new WalletServer(stub(), { apiSecret: SECRET, onWarning })
    // What a body parser would hand us: JSON.stringify of the parsed object.
    const reserialised = JSON.stringify({ account_id: 'p', currency: 'EUR', game_id: 'dice' })
    await server.dispatch('/balance', Buffer.from(reserialised), '0'.repeat(64))
    expect(onWarning.mock.calls.join(' ')).toContain('re-serialisation')
  })

  it('says the stream was consumed when the body is empty', async () => {
    const onWarning = vi.fn()
    const server = new WalletServer(stub(), { apiSecret: SECRET, onWarning })
    await server.dispatch('/balance', Buffer.from(''), '0'.repeat(64))
    expect(onWarning.mock.calls.join(' ')).toContain('consumed the stream')
  })
})

describe('body limits', () => {
  it('refuses a body past the gateway cap', async () => {
    const server = new WalletServer(stub(), { apiSecret: SECRET })
    const body = 'x'.repeat(MAX_BODY_BYTES + 1)
    const out = await server.dispatch('/balance', Buffer.from(body), sign(body, SECRET))
    expect(out.status).toBe(400)
    expect(JSON.parse(out.body).meta.api_code).toBe(ApiCode.BAD_REQUEST)
  })

  it('refuses a decoded string, because a decode is not always reversible', async () => {
    const server = new WalletServer(stub(), { apiSecret: SECRET })
    await expect(
      server.dispatch('/balance', '{}' as unknown as Uint8Array, 'x'),
    ).rejects.toThrow(TypeError)
  })
})

describe('validation', () => {
  const server = new WalletServer(stub(), { apiSecret: SECRET })

  it('rejects a zero amount', async () => {
    const out = await send(
      server,
      '/betwin',
      '{"account_id":"p","currency":"EUR","game_id":"d","round_id":"r","transactions":[{"id_provider":"t","type":"bet","amount":"0"}]}',
    )
    expect(out.status).toBe(400)
    expect(JSON.parse(out.body).msg).toContain('greater than zero')
  })

  it('rejects a lowercase currency instead of upcasing it', async () => {
    const out = await send(server, '/balance', '{"account_id":"p","currency":"eur","game_id":"d"}')
    expect(JSON.parse(out.body).msg).toContain('currency')
  })

  it('tolerates unknown fields — the contract is additionalProperties: true', async () => {
    const out = await send(
      server,
      '/balance',
      '{"account_id":"p","currency":"EUR","game_id":"d","new_param":"probe"}',
    )
    expect(out.status).toBe(200)
  })

  it('accepts a rollback without game_id and reports it as empty', async () => {
    let seen = 'unset'
    const s = new WalletServer(
      stub({
        rollback: (req) => {
          seen = req.game_id
          return { balance: Money.parse('1.00'), round_id: 'r', transactions: [] }
        },
      }),
      { apiSecret: SECRET },
    )
    const out = await send(
      s,
      '/rollback',
      '{"account_id":"p","currency":"EUR","round_id_provider":"r","finished":true,"transactions":[{"id_provider":"rb","type":"rollback","original_id_provider":"t"}]}',
    )
    expect(out.status).toBe(200)
    expect(seen).toBe('')
  })
})

describe('error envelope', () => {
  it('refuses to build a funds error without a balance', () => {
    expect(isFundsRelatedCode(ApiCode.INSUFFICIENT_FUNDS)).toBe(true)
    expect(() =>
      WalletError.withApiCode(ApiCode.INSUFFICIENT_FUNDS, 'no funds'),
    ).toThrow(TypeError)
  })

  it('carries the balance for 100, 105 and 106', () => {
    for (const e of [
      WalletError.insufficientFunds(Money.parse('1.23')),
      WalletError.betLimitReached(Money.parse('1.23')),
      WalletError.maxBetExceeded(Money.parse('1.23')),
    ]) {
      expect(e.toEnvelope().meta.balance).toBe('1.23')
    }
  })

  it('turns an unexpected throw into an opaque 500 and leaks nothing', async () => {
    const s = new WalletServer(
      stub({
        balance: () => {
          throw new Error('connection to ledger-db-7 refused')
        },
      }),
      { apiSecret: SECRET },
    )
    const out = await send(s, '/balance', '{"account_id":"p","currency":"EUR","game_id":"d"}')
    expect(out.status).toBe(500)
    expect(out.body).not.toContain('ledger-db-7')
    expect(JSON.parse(out.body)).toEqual({
      code: 'internal',
      msg: 'internal error',
      meta: { api_code: '500', api_message: 'internal error' },
    })
  })

  it('defaults bonus_amount to "0.00" because the contract requires the field', async () => {
    const s = new WalletServer(
      stub({
        betWin: () => ({
          round_id: 'r1',
          balance: Money.parse('5.00'),
          transactions: [{ id_provider: 't', id: 'own-1' }],
        }),
      }),
      { apiSecret: SECRET },
    )
    const out = await send(
      s,
      '/betwin',
      '{"account_id":"p","currency":"EUR","game_id":"d","round_id":"r","transactions":[{"id_provider":"t","type":"bet","amount":"1.00"}]}',
    )
    expect(JSON.parse(out.body).transactions[0].bonus_amount).toBe('0.00')
  })
})
