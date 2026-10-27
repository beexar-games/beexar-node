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

/**
 * The callback routes, exactly as the contract names them: the four every
 * wallet serves, and `/freespins/finish`, which only a wallet that issues
 * freespins does (see {@link WalletHandler.freespinsFinish}).
 */
export type Route = '/balance' | '/betwin' | '/rollback' | '/finish' | '/freespins/finish'

export const ROUTES: readonly Route[] = ['/balance', '/betwin', '/rollback', '/finish', '/freespins/finish']

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

// ------------------------------------------------------- /freespins/finish

/**
 * The result of a freespins issue: what its freespins won in total, for you to
 * credit to the player you issued them to.
 */
export interface FreespinsFinishRequest {
  /** YOUR id for the issue — the `issue_id` you sent to `Client.issueFreespins`. */
  issue_id: string
  /**
   * The total won, in the issue's currency at its scale. Zero or more — zero
   * (`"0.00"` in EUR, `"0"` in JPY) is a valid result, not an error: the
   * freespins were played and won nothing.
   */
  amount: Money
}

export interface FreespinsFinishResult {
  /** The balance after the credit. On a repeat, the one you returned the first time. */
  balance: Money
}

// ----------------------------------------------------------------- handler

/**
 * The methods you implement against your own ledger. Everything else —
 * signature verification, parsing, validation, the Twirp error envelope — is
 * the SDK's job.
 */
export interface WalletHandler {
  balance(req: BalanceRequest, ctx: RequestContext): BalanceResult | Promise<BalanceResult>
  betWin(req: BetWinRequest, ctx: RequestContext): BetWinResult | Promise<BetWinResult>
  rollback(req: RollbackRequest, ctx: RequestContext): RollbackResult | Promise<RollbackResult>
  finish(req: FinishRequest, ctx: RequestContext): FinishResult | Promise<FinishResult>
  /**
   * `/freespins/finish` — only if you issue freespins. Credit `amount` to the
   * player of the issue, once per `issue_id`: the platform sends it once and
   * retries the same body until it gets a 200, so a repeat must answer the
   * balance you stored the first time and credit nothing.
   *
   * Leave it out and the route answers like an unknown one (api_code 404).
   */
  freespinsFinish?(
    req: FreespinsFinishRequest,
    ctx: RequestContext,
  ): FreespinsFinishResult | Promise<FreespinsFinishResult>
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
  /**
   * Every catalog image the game has, one per format, the square tile first:
   * `square_640` (640×640), `portrait_3x4` (600×800), `landscape_16x9`
   * (1280×720), `social_1200x630` (1200×630 link-preview card). Empty when
   * the game has none — `thumbnail` then carries the platform default.
   */
  images?: GameImage[]
  currencies?: string[]
  restrictions?: {
    default?: {
      /** ISO country codes the game must not be offered in. */
      blacklist?: string[]
    }
  }
}

/** One catalog image of a game (a PNG, with a WebP copy when available). */
export interface GameImage {
  type?: string
  width?: number
  height?: number
  url?: string
  webp_url?: string
}

export interface GameInfo extends GameInfoKnown {
  [extra: string]: unknown
}

export interface ListGamesQuery {
  /** Defaults to the client's `casinoId`. */
  operator?: string
  active?: boolean
}

// --------------------------------------------------------------- freespins

/**
 * Freespins/Issue: `freespins_quantity` free rounds for one player, at one bet
 * level, in one or more games. The client adds `casino_id`.
 *
 * Record the issue in your own ledger BEFORE sending it: the result arrives
 * later on `/freespins/finish` carrying only `issue_id` and `amount`, so your
 * record is what says whose wallet, in which currency, to credit.
 */
export interface FreespinsIssueRequest {
  /**
   * YOUR id for this issue, at most 255 characters. Repeating it with the same
   * terms answers like the first call; with other terms it is refused (610).
   */
  issue_id: string
  /** Game slugs. The quantity is shared by all of them, not given in each. */
  games: string[]
  /** At most 10000. */
  freespins_quantity: number
  /** A `bet_level` from {@link Client.betLevels} — the total bet of every free round. */
  bet_level: number
  /**
   * When the freespins stop being playable, at most one month ahead, in UTC
   * with a `Z`: `new Date(Date.now() + 7 * 86400e3).toISOString()`.
   */
  valid_until: string
  /** The player, as in a launch. `id` and `currency` decide whose freespins these are. */
  account: LaunchAccount
}

/** Freespins/Cancel. The client adds `casino_id`. */
export interface FreespinsCancelRequest {
  /** The `issue_id` you issued, or one you are about to: a cancel can come first. */
  issue_id: string
}

/** Bet/Levels filters. Unknown values are ignored; leave one out for all of them. */
export interface BetLevelsRequest {
  /** Game slugs. */
  games?: string[]
  /** Currency codes. */
  currencies?: string[]
}

/** One bet level: what `bet_level` costs per round in one currency. */
export interface BetLevel {
  bet_level: number
  /**
   * The TOTAL bet of one round, a decimal string in the currency's main unit —
   * `Money.parse(level.amount)` for arithmetic.
   */
  amount: string
}

export interface CurrencyBetLevels {
  currency: string
  /** Levels 1..N without gaps, amounts strictly ascending. */
  bet_levels: BetLevel[]
}

/** The games that share the same bet levels in every currency. Each game appears once. */
export interface BetLevelData {
  games: string[]
  currencies: CurrencyBetLevels[]
}
