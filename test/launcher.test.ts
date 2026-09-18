import { describe, expect, it } from 'vitest'
import { Client } from '../src/launcher.js'
import { BeexarApiError } from '../src/errors.js'
import { verify } from '../src/signature.js'

const SECRET = 'launcher-test-secret'

/** Captures exactly what went on the wire. */
function recorder(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetchImpl }
}

const client = (fetchImpl: typeof globalThis.fetch, baseUrl = 'https://gw.test') =>
  new Client({ casinoId: 'casinoxyz', apiSecret: SECRET, baseUrl, fetch: fetchImpl })

describe('Client.launchReal', () => {
  it('signs the exact bytes it sends', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: { launch_url: 'https://games/x' } })
    const res = await client(fetchImpl).launchReal({
      game: 'dice',
      account: { id: 'player_1', currency: 'EUR' },
    })

    expect(res.launch_url).toBe('https://games/x')
    const call = calls[0]!
    const sent = call.init.body as string
    const signature = (call.init.headers as Record<string, string>)['X-REQUEST-SIGN']!
    // The signature and the body come from one serialisation, so they cannot
    // drift — this is the property that keeps launches working.
    expect(verify(sent, signature, SECRET)).toBe(true)
  })

  it('puts casino_id in the body without the caller repeating it', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: { launch_url: 'u' } })
    await client(fetchImpl).launchReal({ game: 'dice', account: { id: 'p', currency: 'EUR' } })
    expect(JSON.parse(calls[0]!.init.body as string).casino_id).toBe('casinoxyz')
  })

  it('reads the error out of meta.api_code, not the HTTP status', async () => {
    const { fetchImpl } = recorder({
      status: 403,
      body: {
        code: 'invalid_argument',
        msg: 'invalid request signature',
        meta: { api_code: '403', api_message: 'invalid request signature' },
      },
    })
    await expect(
      client(fetchImpl).launchReal({ game: 'dice', account: { id: 'p', currency: 'EUR' } }),
    ).rejects.toSatisfy((e: BeexarApiError) => e.isSignatureError() && !e.isRetryable())
  })

  it('treats 5xx as retryable and 4xx as terminal', async () => {
    const five = recorder({ status: 500, body: { code: 'internal', meta: { api_code: '500' } } })
    await expect(
      client(five.fetchImpl).launchReal({ game: 'dice', account: { id: 'p', currency: 'EUR' } }),
    ).rejects.toSatisfy((e: BeexarApiError) => e.isRetryable())

    const four = recorder({ status: 400, body: { code: 'invalid_argument', meta: { api_code: '405' } } })
    await expect(
      four
        .fetchImpl &&
        client(four.fetchImpl).launchReal({ game: 'dice', account: { id: 'p', currency: 'EUR' } }),
    ).rejects.toSatisfy((e: BeexarApiError) => !e.isRetryable() && e.apiCode === '405')
  })
})

describe('Client.listGames', () => {
  it('is a plain GET with no signature — the endpoint is public', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: { games: [{ identifier: 'dice' }] } })
    const games = await client(fetchImpl).listGames()
    expect(games).toEqual([{ identifier: 'dice' }])
    expect(calls[0]!.url).toContain('operator=casinoxyz')
    expect((calls[0]!.init.headers as Record<string, string>)['X-REQUEST-SIGN']).toBeUndefined()
  })
})

describe('Client construction', () => {
  it.each([
    ['casinoId', { casinoId: '', apiSecret: 's' }],
    ['apiSecret', { casinoId: 'c', apiSecret: '' }],
  ])('refuses a missing %s', (_l, opts) => {
    expect(() => new Client(opts as never)).toThrow(TypeError)
  })
})
