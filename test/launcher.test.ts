import { describe, expect, it } from 'vitest'
import { Client } from '../src/launcher.js'
import { ApiCode, BeexarApiError } from '../src/errors.js'
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

describe('Client freespins calls', () => {
  const issue = {
    issue_id: 'fs-1',
    games: ['dice', 'plinko'],
    freespins_quantity: 10,
    bet_level: 2,
    valid_until: '2026-11-30T12:00:00Z',
    account: { id: 'player_1', currency: 'EUR' },
  }

  it('issueFreespins signs the exact bytes it posts, with casino_id added', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: {} })
    await expect(client(fetchImpl).issueFreespins(issue)).resolves.toBeUndefined()

    const call = calls[0]!
    expect(call.url).toBe('https://gw.test/api/v1/softswiss/freespins/issue')
    expect(call.init.method).toBe('POST')
    const sent = call.init.body as string
    const signature = (call.init.headers as Record<string, string>)['X-REQUEST-SIGN']!
    expect(verify(sent, signature, SECRET)).toBe(true)
    // Integers stay integers on the wire; the platform's schema refuses "10".
    expect(JSON.parse(sent)).toEqual({ casino_id: 'casinoxyz', ...issue })
  })

  it('cancelFreespins posts the issue_id, signed', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: {} })
    await expect(client(fetchImpl).cancelFreespins({ issue_id: 'fs-1' })).resolves.toBeUndefined()

    const call = calls[0]!
    expect(call.url).toBe('https://gw.test/api/v1/softswiss/freespins/cancel')
    expect(JSON.parse(call.init.body as string)).toEqual({ casino_id: 'casinoxyz', issue_id: 'fs-1' })
    const signature = (call.init.headers as Record<string, string>)['X-REQUEST-SIGN']!
    expect(verify(call.init.body as string, signature, SECRET)).toBe(true)
  })

  it('betLevels sends the filters and unwraps bet_levels', async () => {
    const levels = [
      {
        games: ['dice'],
        currencies: [{ currency: 'EUR', bet_levels: [{ bet_level: 1, amount: '0.10' }, { bet_level: 2, amount: '0.20' }] }],
      },
    ]
    const { calls, fetchImpl } = recorder({ status: 200, body: { bet_levels: levels } })
    const got = await client(fetchImpl).betLevels({ games: ['dice'], currencies: ['EUR'] })

    expect(got).toEqual(levels)
    expect(calls[0]!.url).toBe('https://gw.test/api/v1/softswiss/bet/levels')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      casino_id: 'casinoxyz',
      games: ['dice'],
      currencies: ['EUR'],
    })
  })

  it('betLevels without filters asks for every game and currency', async () => {
    const { calls, fetchImpl } = recorder({ status: 200, body: { bet_levels: [] } })
    expect(await client(fetchImpl).betLevels()).toEqual([])
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ casino_id: 'casinoxyz' })
  })

  it('surfaces a refusal as BeexarApiError keyed on api_code', async () => {
    const { fetchImpl } = recorder({
      status: 400,
      body: {
        code: 'invalid_argument',
        msg: 'issue_id fs-1 was issued with other terms: valid_until',
        meta: { api_code: '610', api_message: 'issue_id fs-1 was issued with other terms: valid_until' },
      },
    })
    await expect(client(fetchImpl).issueFreespins(issue)).rejects.toSatisfy(
      (e: BeexarApiError) =>
        e.apiCode === ApiCode.FREESPINS_INVALID_ISSUE && !e.isRetryable() && e.apiMessage.includes('valid_until'),
    )
  })

  it('surfaces a 5xx as retryable', async () => {
    const { fetchImpl } = recorder({ status: 500, body: { code: 'internal', meta: { api_code: '500' } } })
    await expect(client(fetchImpl).cancelFreespins({ issue_id: 'fs-1' })).rejects.toSatisfy(
      (e: BeexarApiError) => e.isRetryable(),
    )
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
