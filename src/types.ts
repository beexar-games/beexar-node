import type { Money } from './money.js'

/**
 * Wire field names are kept verbatim — `account_id`, `id_provider`,
 * `round_id_provider`, `bonus_amount`. They are not camel-cased.
 *
 * That is a deliberate choice. What you read in the docs, what you see in a
 * request log, and what you type in your handler are then the same string, and
 * the SDK carries no name-mapping table that could drift from the contract. It
 * also keeps all four Beexar SDKs literally identical in shape.
 */

/** The four callback routes, exactly as the contract names them. */
export type Route = '/balance' | '/betwin' | '/rollback' | '/finish'

export const ROUTES: readonly Route[] = ['/balance', '/betwin', '/rollback', '/finish']

/** Everything about the request that is not part of the parsed body. */
export interface RequestContext {
  route: Route
  /** The exact bytes the signature was verified against. */
  rawBody: Uint8Array
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------- /balance

export interface BalanceRequest {
  account_id: string
  currency: string
  game_id: string
  session_id?: string
}

export interface BalanceResult {
  balance: Money
}

// ----------------------------------------------------------------- /betwin

export type BetWinTransactionType = 'bet' | 'win'

export interface BetWinTransaction {
  id_provider: string
  type: BetWinTransactionType
  /** Always greater than zero — the SDK rejects `0` before your code runs. */
  amount: Money
}

export interface BetWinRequest {
  account_id: string
  currency: string
  game_id: string
  round_id: string
  finished: boolean
  /** In request order. Apply them in this order, atomically. */
  transactions: BetWinTransaction[]
  session_id?: string
}

export interface BetWinTransactionResult {
  /** Echo the platform's id back unchanged. */
  id_provider: string
  /** YOUR transaction id. On a replay, return the one you stored the first time. */
  id: string
  /**
   * Bonus balance moved by this transaction. Required by the contract in every
   * transaction; defaults to `"0.00"` when you omit it.
   */
  bonus_amount?: Money
}

export interface BetWinResult {
  /** YOUR round id. */
  round_id: string
  /** Balance after all transactions in this request. */
  balance: Money
  /** One entry per request transaction, in the same order. */
  transactions: BetWinTransactionResult[]
}

// --------------------------------------------------------------- /rollback

export interface RollbackTransaction {
  id_provider: string
  type: 'rollback'
  /** The `id_provider` of the transaction being reversed. */
  original_id_provider: string
}

export interface RollbackRequest {
  account_id: string
  currency: string
  /**
   * The contract marks this required and the platform always sends it, but the
   * SDK accepts its absence and gives you `""` rather than rejecting a request
   * it could have served. Liberal in, strict out.
   */
  game_id: string
  /** Note the name: rollback uses `round_id_provider`, betwin/finish use `round_id`. */
  round_id_provider: string
  finished: boolean
  transactions: RollbackTransaction[]
  session_id?: string
}

export interface RollbackTransactionResult {
  id_provider: string
  /** Your transaction id, or `""` when there was nothing to reverse. */
  id: string
}

export interface RollbackResult {
  balance: Money
  round_id: string
  transactions: RollbackTransactionResult[]
}

// ----------------------------------------------------------------- /finish

export interface FinishRequest {
  account_id: string
  currency: string
  round_id: string
  /** `/finish` carries no `game_id`. */
  session_id?: string
}

export interface FinishResult {
  balance: Money
}

// ----------------------------------------------------------------- handler

/**
 * The four methods you implement against your own ledger. Everything else —
 * signature verification, parsing, validation, the Twirp error envelope — is
 * the SDK's job.
 */
export interface WalletHandler {
  balance(req: BalanceRequest, ctx: RequestContext): BalanceResult | Promise<BalanceResult>
  betWin(req: BetWinRequest, ctx: RequestContext): BetWinResult | Promise<BetWinResult>
  rollback(req: RollbackRequest, ctx: RequestContext): RollbackResult | Promise<RollbackResult>
  finish(req: FinishRequest, ctx: RequestContext): FinishResult | Promise<FinishResult>
}

// ---------------------------------------------------------------- launcher

export interface LaunchAccount {
  id: string
  currency: string
  firstname?: string
  lastname?: string
  nickname?: string
  email?: string
  country?: string
  date_of_birth?: string
  registered_at?: string
  tags?: string[]
}

export interface LaunchUrls {
  return_url?: string
  deposit_url?: string
}

export interface LaunchRealRequest {
  game: string
  account: LaunchAccount
  locale?: string
  ip?: string
  client_type?: 'mobile' | 'desktop'
  urls?: LaunchUrls
  jurisdiction?: string
  session_id?: string
  session_payload?: string
  [extra: string]: unknown
}

export interface LaunchDemoRequest {
  game: string
  currency?: string
  balance?: string
  player_id?: string
  locale?: string
  ip?: string
  client_type?: 'mobile' | 'desktop'
  urls?: Pick<LaunchUrls, 'return_url'>
  jurisdiction?: string
  [extra: string]: unknown
}

export interface LaunchResult {
  launch_url: string
}

/**
 * The catalogue fields the contract declares.
 *
 * Kept separate from {@link GameInfo} because `GameInfo` carries an index
 * signature for forward compatibility, and an index signature would make a
 * "does this cover the spec?" assertion pass vacuously — `keyof` includes
 * `string`, so nothing can ever be missing. The assertion runs against this
 * type instead, where a new catalogue field is a real compile error.
 */
export interface GameInfoKnown {
  title?: string
  identifier?: string
  category?: string
  feature_group?: string
  payout?: number
  volatility_rating?: string
  has_freespins?: boolean
  bonus_buy?: boolean
  demo_available?: boolean
  thumbnail?: string
  currencies?: string[]
  restrictions?: {
    default?: {
      /** ISO country codes the game must not be offered in. */
      blacklist?: string[]
    }
  }
}

export interface GameInfo extends GameInfoKnown {
  [extra: string]: unknown
}

export interface ListGamesQuery {
  /** Defaults to the client's `casinoId`. */
  operator?: string
  active?: boolean
}
