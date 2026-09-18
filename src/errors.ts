import { Money } from './money.js'

/**
 * SoftSwiss API codes, ported verbatim from the platform's own registry.
 *
 * Two things about this contract surprise everyone once:
 *
 *  1. There are only two HTTP statuses (400 and 500) and two `code` values
 *     (`invalid_argument` and `internal`). All meaning lives in
 *     `meta.api_code`. Branch on that, never on the status.
 *  2. A *signature* failure is HTTP 400 with api_code `403`, not HTTP 403.
 *     Answering 403 breaks the contract.
 */
export const ApiCode = {
  INSUFFICIENT_FUNDS: '100',
  INVALID_PLAYER: '101',
  BET_LIMIT_REACHED: '105',
  MAX_BET_EXCEEDED: '106',
  GAME_FORBIDDEN: '107',
  PLAYER_DISABLED: '110',
  COUNTRY_RESTRICTED: '153',
  CURRENCY_NOT_ALLOWED: '154',
  FIELD_IMMUTABLE: '155',

  BAD_REQUEST: '400',
  FORBIDDEN: '403',
  NOT_FOUND: '404',
  /**
   * Beexar extension. Returned from /betwin to reject a transaction whose
   * `id_provider` was already rolled back — including a rollback that arrived
   * BEFORE the bet it reverses. See the tombstone rules in the README.
   */
  ALREADY_ROLLED_BACK: '409',

  GAME_NOT_AVAILABLE: '405',
  CASINO_DISABLED: '410',

  UNKNOWN_ERROR: '500',
  SERVICE_UNAVAILABLE: '503',
  REQUEST_TIMEOUT: '504',
} as const

export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode] | (string & {})

export const TwirpCode = {
  INVALID_ARGUMENT: 'invalid_argument',
  INTERNAL: 'internal',
} as const

export type TwirpCodeValue = (typeof TwirpCode)[keyof typeof TwirpCode]

/**
 * Codes that MUST carry the player's balance in `meta.balance`.
 *
 * The platform will not complain if you omit it — it reads the field with the
 * error swallowed — so the player just sees a wrong balance. That is exactly
 * why this SDK refuses to build such an error without one.
 */
export function isFundsRelatedCode(code: string): boolean {
  return (
    code === ApiCode.INSUFFICIENT_FUNDS ||
    code === ApiCode.BET_LIMIT_REACHED ||
    code === ApiCode.MAX_BET_EXCEEDED
  )
}

export interface ErrorEnvelope {
  code: TwirpCodeValue
  msg: string
  meta: {
    api_code: string
    api_message: string
    balance?: string
  }
}

/**
 * An error your wallet handler throws to answer the platform with a specific
 * api_code. Anything else you throw becomes an opaque 500 — your message is
 * never echoed to the platform.
 */
export class WalletError extends Error {
  readonly status: number
  readonly twirpCode: TwirpCodeValue
  readonly apiCode: string
  readonly balance: Money | undefined

  constructor(opts: {
    status: number
    twirpCode: TwirpCodeValue
    apiCode: string
    message: string
    balance?: Money
  }) {
    super(opts.message)
    this.name = 'WalletError'
    this.status = opts.status
    this.twirpCode = opts.twirpCode
    this.apiCode = opts.apiCode
    this.balance = opts.balance

    if (isFundsRelatedCode(opts.apiCode) && opts.balance === undefined) {
      throw new TypeError(
        `api_code ${opts.apiCode} must carry the player's balance; use the ` +
          `dedicated constructor (insufficientFunds / betLimitReached / maxBetExceeded)`,
      )
    }
  }

  private static clientError(apiCode: string, message: string, balance?: Money): WalletError {
    return new WalletError({
      status: 400,
      twirpCode: TwirpCode.INVALID_ARGUMENT,
      apiCode,
      message,
      ...(balance !== undefined ? { balance } : {}),
    })
  }

  private static serverError(apiCode: string, message: string): WalletError {
    return new WalletError({
      status: 500,
      twirpCode: TwirpCode.INTERNAL,
      apiCode,
      message,
    })
  }

  // --- funds-related: balance is a required argument, by design ------------

  static insufficientFunds(balance: Money, message = 'insufficient funds'): WalletError {
    return WalletError.clientError(ApiCode.INSUFFICIENT_FUNDS, message, balance)
  }

  static betLimitReached(balance: Money, message = 'bet limit reached'): WalletError {
    return WalletError.clientError(ApiCode.BET_LIMIT_REACHED, message, balance)
  }

  static maxBetExceeded(balance: Money, message = 'max bet exceeded'): WalletError {
    return WalletError.clientError(ApiCode.MAX_BET_EXCEEDED, message, balance)
  }

  // --- player / request ----------------------------------------------------

  static invalidPlayer(message = 'invalid player'): WalletError {
    return WalletError.clientError(ApiCode.INVALID_PLAYER, message)
  }

  static playerDisabled(message = 'player is disabled'): WalletError {
    return WalletError.clientError(ApiCode.PLAYER_DISABLED, message)
  }

  static gameForbidden(message = 'game is forbidden to the player'): WalletError {
    return WalletError.clientError(ApiCode.GAME_FORBIDDEN, message)
  }

  static countryRestricted(message = 'game is not available in the player country'): WalletError {
    return WalletError.clientError(ApiCode.COUNTRY_RESTRICTED, message)
  }

  static currencyNotAllowed(message = 'currency is not allowed for the player'): WalletError {
    return WalletError.clientError(ApiCode.CURRENCY_NOT_ALLOWED, message)
  }

  static badRequest(message = 'bad request'): WalletError {
    return WalletError.clientError(ApiCode.BAD_REQUEST, message)
  }

  static invalidSignature(message = 'invalid signature'): WalletError {
    return WalletError.clientError(ApiCode.FORBIDDEN, message)
  }

  static notFound(message = 'not found'): WalletError {
    return WalletError.clientError(ApiCode.NOT_FOUND, message)
  }

  /** The transaction's `id_provider` was already rolled back (tombstoned). */
  static alreadyRolledBack(message = 'action already rolled back'): WalletError {
    return WalletError.clientError(ApiCode.ALREADY_ROLLED_BACK, message)
  }

  // --- server --------------------------------------------------------------

  static internal(message = 'internal error'): WalletError {
    return WalletError.serverError(ApiCode.UNKNOWN_ERROR, message)
  }

  static serviceUnavailable(message = 'service unavailable'): WalletError {
    return WalletError.serverError(ApiCode.SERVICE_UNAVAILABLE, message)
  }

  static requestTimeout(message = 'request timed out'): WalletError {
    return WalletError.serverError(ApiCode.REQUEST_TIMEOUT, message)
  }

  /**
   * Escape hatch for an api_code without a dedicated constructor. It runs the
   * same balance check, so it cannot be used to bypass it.
   */
  static withApiCode(
    apiCode: string,
    message: string,
    opts: { status?: number; balance?: Money } = {},
  ): WalletError {
    const status = opts.status ?? (apiCode.startsWith('5') ? 500 : 400)
    return new WalletError({
      status,
      twirpCode: status >= 500 ? TwirpCode.INTERNAL : TwirpCode.INVALID_ARGUMENT,
      apiCode,
      message,
      ...(opts.balance !== undefined ? { balance: opts.balance } : {}),
    })
  }

  toEnvelope(): ErrorEnvelope {
    // Re-checked at encode time as well as at construction: `withApiCode` and
    // any future constructor go through exactly one gate.
    if (isFundsRelatedCode(this.apiCode) && this.balance === undefined) {
      throw new TypeError(`api_code ${this.apiCode} must carry meta.balance`)
    }
    return {
      code: this.twirpCode,
      msg: this.message,
      meta: {
        api_code: this.apiCode,
        api_message: this.message,
        ...(this.balance !== undefined ? { balance: this.balance.toString() } : {}),
      },
    }
  }
}

/**
 * An error answer from the Beexar gateway to one of YOUR calls
 * (launchReal / launchDemo / listGames).
 */
export class BeexarApiError extends Error {
  readonly httpStatus: number
  readonly code: string
  readonly apiCode: string
  readonly apiMessage: string

  constructor(httpStatus: number, envelope: Partial<ErrorEnvelope>) {
    const apiMessage = envelope.meta?.api_message ?? envelope.msg ?? 'unknown error'
    super(apiMessage)
    this.name = 'BeexarApiError'
    this.httpStatus = httpStatus
    this.code = envelope.code ?? 'internal'
    this.apiCode = envelope.meta?.api_code ?? String(httpStatus)
    this.apiMessage = apiMessage
  }

  /** 5xx only. A 400 on this contract is terminal — retrying it changes nothing. */
  isRetryable(): boolean {
    return this.httpStatus >= 500
  }

  /**
   * True when the gateway rejected the request signature. Keyed on api_code,
   * because the status alone is ambiguous.
   */
  isSignatureError(): boolean {
    return this.apiCode === ApiCode.FORBIDDEN
  }
}
