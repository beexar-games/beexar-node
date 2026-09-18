import { BeexarApiError } from './errors.js'
import { sign } from './signature.js'
import type {
  GameInfo,
  LaunchDemoRequest,
  LaunchRealRequest,
  LaunchResult,
  ListGamesQuery,
} from './types.js'

export const PRODUCTION_BASE_URL = 'https://gateway.beexar.com'

export interface ClientOptions {
  /** Your operator slug — the `casino_id` on every request. */
  casinoId: string
  /** The API secret from the backoffice. Never ship this to a browser. */
  apiSecret: string
  /** Defaults to {@link PRODUCTION_BASE_URL}. */
  baseUrl?: string
  /** Per-request timeout in milliseconds. Default 10000. */
  timeoutMs?: number
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/**
 * Calls you make to Beexar: launch a session, list the catalogue.
 *
 * Every POST is signed with `hex(HMAC-SHA256(body, apiSecret))` over the exact
 * bytes that go on the wire — the body is serialised once, signed, and sent.
 * Serialising twice is how signatures mysteriously stop matching.
 */
export class Client {
  private readonly casinoId: string
  private readonly apiSecret: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: ClientOptions) {
    if (!options.casinoId) throw new TypeError('Client: casinoId is required')
    if (!options.apiSecret) throw new TypeError('Client: apiSecret is required')
    this.casinoId = options.casinoId
    this.apiSecret = options.apiSecret
    this.baseUrl = (options.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('Client: no global fetch available — pass one via options.fetch (Node < 18)')
    }
  }

  /** Launches a real-money session and returns the URL to put in your iframe. */
  async launchReal(request: LaunchRealRequest): Promise<LaunchResult> {
    return this.postSigned<LaunchResult>('/api/v1/softswiss/launcher/real', {
      casino_id: this.casinoId,
      ...request,
    })
  }

  /** Launches a demo session on a virtual balance. No wallet callbacks are made. */
  async launchDemo(request: LaunchDemoRequest): Promise<LaunchResult> {
    return this.postSigned<LaunchResult>('/api/v1/softswiss/launcher/demo', {
      casino_id: this.casinoId,
      ...request,
    })
  }

  /** The games enabled for your operator. This endpoint is public — no signature. */
  async listGames(query: ListGamesQuery = {}): Promise<GameInfo[]> {
    const params = new URLSearchParams({ operator: query.operator ?? this.casinoId })
    if (query.active !== undefined) params.set('active', String(query.active))

    const res = await this.withTimeout((signal) =>
      this.fetchImpl(`${this.baseUrl}/api/v1/operator/games?${params}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      }),
    )
    const body = await readJson(res)
    if (!res.ok) throw new BeexarApiError(res.status, body as never)
    return ((body as { games?: GameInfo[] }).games ?? []) as GameInfo[]
  }

  private async postSigned<T>(path: string, payload: unknown): Promise<T> {
    // Serialise ONCE. The signature and the request body are the same string,
    // so they cannot disagree.
    const body = JSON.stringify(payload)
    const res = await this.withTimeout((signal) =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-REQUEST-SIGN': sign(body, this.apiSecret),
        },
        body,
        signal,
      }),
    )
    const parsed = await readJson(res)
    if (!res.ok) throw new BeexarApiError(res.status, parsed as never)
    return parsed as T
  }

  private async withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await run(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { msg: text }
  }
}
