import { Money, Currency } from './money.js'
import { WalletError } from './errors.js'
import { verify } from './signature.js'
import type {
  BalanceRequest,
  BetWinRequest,
  BetWinTransaction,
  FinishRequest,
  RequestContext,
  RollbackRequest,
  RollbackTransaction,
  Route,
  WalletHandler,
} from './types.js'
import { ROUTES } from './types.js'

/**
 * The gateway caps an operator request body at 64 KiB. The wallet server
 * mirrors that so a body it would never have sent cannot be used to make your
 * process allocate.
 */
export const MAX_BODY_BYTES = 64 * 1024

export interface WalletServerOptions {
  /** The operator API secret from the backoffice. Required and non-empty. */
  apiSecret: string
  /** Defaults to {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number
  /**
   * Called with a diagnostic when the SDK can tell WHY a signature failed.
   * Defaults to `console.warn`; pass `() => {}` to silence it.
   */
  onWarning?: (message: string) => void
}

export interface DispatchResponse {
  status: number
  /** Always `application/json`. */
  headers: Record<string, string>
  body: string
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw WalletError.badRequest(`${field}: required, must be a non-empty string`)
  }
  return v
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    throw WalletError.badRequest(`${field}: must be a string`)
  }
  return v
}

function requireCurrency(obj: Record<string, unknown>): string {
  const v = obj['currency']
  if (!Currency.isValid(v)) {
    throw WalletError.badRequest(`currency: must match ^${Currency.pattern.slice(1, -1)}$`)
  }
  return v
}

function requireBool(obj: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const v = obj[field]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') throw WalletError.badRequest(`${field}: must be a boolean`)
  return v
}

function requireArray(obj: Record<string, unknown>, field: string): unknown[] {
  const v = obj[field]
  if (!Array.isArray(v) || v.length === 0) {
    throw WalletError.badRequest(`${field}: required, must be a non-empty array`)
  }
  return v
}

function parseAmount(raw: unknown, path: string): Money {
  const m = Money.tryParse(raw)
  if (m === null) throw WalletError.badRequest(`${path}: not a valid decimal amount`)
  if (!m.isPositive()) throw WalletError.badRequest(`${path}: must be greater than zero`)
  return m
}

function parseBalanceRequest(body: Record<string, unknown>): BalanceRequest {
  const sessionId = optionalString(body, 'session_id')
  return {
    account_id: requireString(body, 'account_id'),
    currency: requireCurrency(body),
    game_id: requireString(body, 'game_id'),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  }
}

function parseBetWinRequest(body: Record<string, unknown>): BetWinRequest {
  const raw = requireArray(body, 'transactions')
  const transactions: BetWinTransaction[] = raw.map((t, i) => {
    if (!isRecord(t)) throw WalletError.badRequest(`transactions[${i}]: must be an object`)
    const type = requireString(t, 'type')
    if (type !== 'bet' && type !== 'win') {
      throw WalletError.badRequest(`transactions[${i}].type: must be "bet" or "win"`)
    }
    return {
      id_provider: requireString(t, 'id_provider'),
      type,
      amount: parseAmount(t['amount'], `transactions[${i}].amount`),
    }
  })

  const sessionId = optionalString(body, 'session_id')
  return {
    account_id: requireString(body, 'account_id'),
    currency: requireCurrency(body),
    game_id: requireString(body, 'game_id'),
    round_id: requireString(body, 'round_id'),
    finished: requireBool(body, 'finished', false),
    transactions,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  }
}

function parseRollbackRequest(body: Record<string, unknown>): RollbackRequest {
  const raw = requireArray(body, 'transactions')
  const transactions: RollbackTransaction[] = raw.map((t, i) => {
    if (!isRecord(t)) throw WalletError.badRequest(`transactions[${i}]: must be an object`)
    const type = requireString(t, 'type')
    if (type !== 'rollback') {
      throw WalletError.badRequest(`transactions[${i}].type: must be "rollback"`)
    }
    return {
      id_provider: requireString(t, 'id_provider'),
      type,
      original_id_provider: requireString(t, 'original_id_provider'),
    }
  })

  const sessionId = optionalString(body, 'session_id')
  return {
    account_id: requireString(body, 'account_id'),
    currency: requireCurrency(body),
    // Liberal: the contract requires game_id and the platform always sends it,
    // but refusing a request we could serve helps nobody.
    game_id: optionalString(body, 'game_id') ?? '',
    round_id_provider: requireString(body, 'round_id_provider'),
    finished: requireBool(body, 'finished', false),
    transactions,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  }
}

function parseFinishRequest(body: Record<string, unknown>): FinishRequest {
  const sessionId = optionalString(body, 'session_id')
  return {
    account_id: requireString(body, 'account_id'),
    currency: requireCurrency(body),
    round_id: requireString(body, 'round_id'),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  }
}

/**
 * Turns the four callbacks into one pure function.
 *
 * `dispatch` takes bytes and a signature and returns a status and a body. No
 * framework type crosses this boundary, and it never sees a parsed body from
 * the outside — so signing the wrong thing is not expressible.
 */
export class WalletServer {
  private readonly handler: WalletHandler
  private readonly apiSecret: string
  private readonly maxBodyBytes: number
  private readonly warn: (message: string) => void

  constructor(handler: WalletHandler, options: WalletServerOptions) {
    const secret = options.apiSecret
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      // The gateway treats an empty secret as an automatic verification
      // failure. Refusing it here turns a silent "nothing ever authenticates"
      // into a startup error.
      throw new TypeError('WalletServer: apiSecret is required and must be non-empty')
    }
    this.handler = handler
    this.apiSecret = secret
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
    this.warn = options.onWarning ?? ((m) => console.warn(`[beexar] ${m}`))
  }

  /** True for the four callback paths, ignoring any prefix you mounted at. */
  static isRoute(value: string): value is Route {
    return (ROUTES as readonly string[]).includes(value)
  }

  async dispatch(
    route: Route,
    rawBody: Uint8Array,
    signature: string | null | undefined,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<DispatchResponse> {
    try {
      if (!WalletServer.isRoute(route)) {
        throw WalletError.notFound(`unknown route: ${route}`)
      }
      if (!(rawBody instanceof Uint8Array)) {
        // A string here means something already decoded the bytes, and a decode
        // is not always reversible. Refuse rather than verify a lossy copy.
        throw new TypeError('WalletServer.dispatch: rawBody must be a Uint8Array of the bytes as received')
      }
      if (rawBody.byteLength > this.maxBodyBytes) {
        throw WalletError.badRequest('request body too large')
      }
      if (!verify(rawBody, signature, this.apiSecret)) {
        this.explainSignatureFailure(rawBody, signature)
        throw WalletError.invalidSignature()
      }

      const text = Buffer.from(rawBody).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw WalletError.badRequest('malformed JSON body')
      }
      if (!isRecord(parsed)) throw WalletError.badRequest('body must be a JSON object')

      const ctx: RequestContext = { route, rawBody, headers }
      return await this.invoke(route, parsed, ctx)
    } catch (err) {
      return this.toErrorResponse(err)
    }
  }

  private async invoke(
    route: Route,
    body: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<DispatchResponse> {
    switch (route) {
      case '/balance': {
        const res = await this.handler.balance(parseBalanceRequest(body), ctx)
        return ok({ balance: res.balance.toString() })
      }
      case '/betwin': {
        const res = await this.handler.betWin(parseBetWinRequest(body), ctx)
        return ok({
          round_id: res.round_id,
          transactions: res.transactions.map((t) => ({
            id_provider: t.id_provider,
            id: t.id,
            bonus_amount: (t.bonus_amount ?? Money.ZERO).formatBonus(),
          })),
          balance: res.balance.toString(),
        })
      }
      case '/rollback': {
        const res = await this.handler.rollback(parseRollbackRequest(body), ctx)
        return ok({
          balance: res.balance.toString(),
          round_id: res.round_id,
          transactions: res.transactions.map((t) => ({ id_provider: t.id_provider, id: t.id })),
        })
      }
      case '/finish': {
        const res = await this.handler.finish(parseFinishRequest(body), ctx)
        return ok({ balance: res.balance.toString() })
      }
    }
  }

  /**
   * Says why a signature failed when the SDK can tell.
   *
   * Nearly every failed integration is the same bug: a body-parsing middleware
   * consumed the stream, and what reaches the SDK is a re-serialisation rather
   * than the bytes that were signed. That is unrecoverable — the original bytes
   * are gone — but it is recognisable, and naming it saves days.
   */
  private explainSignatureFailure(rawBody: Uint8Array, signature: string | null | undefined): void {
    if (!signature) {
      this.warn('X-REQUEST-SIGN header is missing from the request')
      return
    }
    if (rawBody.byteLength === 0) {
      this.warn(
        'the request body reaching the SDK is empty, which usually means a body-parsing ' +
          'middleware already consumed the stream. Mount the Beexar handler before any ' +
          'JSON body parser.',
      )
      return
    }
    const text = Buffer.from(rawBody).toString('utf8')
    let reserialised: string | null = null
    try {
      reserialised = JSON.stringify(JSON.parse(text))
    } catch {
      /* not JSON at all — nothing more to say */
    }
    if (reserialised !== null && reserialised === text) {
      this.warn(
        'the body reaching the SDK is byte-identical to a JSON re-serialisation. If your ' +
          'framework parsed the body before the SDK saw it, the bytes that were signed are ' +
          'already lost and the signature can never match. See the "raw body" section of the README.',
      )
      return
    }
    this.warn('signature mismatch: check that the API secret matches the one in the backoffice')
  }

  private toErrorResponse(err: unknown): DispatchResponse {
    if (err instanceof WalletError) {
      return { status: err.status, headers: { ...JSON_HEADERS }, body: JSON.stringify(err.toEnvelope()) }
    }
    if (err instanceof TypeError) {
      // A programming error in the calling code (bad rawBody type, a
      // funds-related error built without a balance). Surface it — swallowing
      // it would hide a bug that only ever produces wrong money.
      throw err
    }
    // Anything the handler threw: answer 500 and say nothing about it. The
    // platform retries 5xx with the same id_provider, so this is the retryable
    // shape, and the message never leaves the process.
    return {
      status: 500,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(WalletError.internal().toEnvelope()),
    }
  }
}

function ok(body: unknown): DispatchResponse {
  return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) }
}
