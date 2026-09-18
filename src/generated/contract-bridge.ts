/**
 * The link that makes "generated from OpenAPI" a fact rather than a promise.
 *
 * `*.d.ts` in this directory is produced by `openapi-typescript` straight from
 * the four specs and is never edited. The hand-written types in `../types.ts`
 * exist only for ergonomics — `Money` instead of `string`, a couple of fields
 * the SDK guarantees are present — and this file proves the two still describe
 * the same contract.
 *
 * Nothing here runs. Every declaration is a type-level assertion: if a field is
 * added to `wallet.yaml`, renamed, or changes type, and the hand-written DTO
 * does not follow, **this file stops compiling** and the SDK cannot be built or
 * published. That is the whole mechanism.
 *
 * Each deviation from the generated shape is listed below with its reason.
 * There is no other way to introduce one.
 */
import type { components as WalletComponents } from './wallet.js'
import type { components as LauncherComponents } from './launcher.js'
import type { components as CatalogComponents } from './catalog.js'
import type { Money } from '../money.js'
import type {
  BalanceRequest,
  BalanceResult,
  BetWinRequest,
  BetWinResult,
  FinishRequest,
  FinishResult,
  GameInfoKnown,
  LaunchResult,
  RollbackRequest,
  RollbackResult,
} from '../types.js'

type W = WalletComponents['schemas']
type L = LauncherComponents['schemas']
type C = CatalogComponents['schemas']

/** Compiles only when `T` is exactly `true`. */
type Assert<T extends true> = T

/**
 * Mutual assignability — equality for this purpose.
 *
 * It still catches everything that matters: a field the spec has and we lost
 * (we stop being assignable to it), a field we invented (it stops being
 * assignable to us), a changed type, and a required/optional flip in either
 * direction. Unlike the stricter function-identity trick it does not trip over
 * `Omit<…> & {…}`, which is how the deviations below have to be written.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Keys the spec has and the hand-written type lost. */
type Missing<Gen, Hand> = Exclude<keyof Gen, keyof Hand>
/** Keys the hand-written type invented. */
type Extra<Hand, Gen> = Exclude<keyof Hand, keyof Gen>
type SameKeys<Gen, Hand> = Exact<Missing<Gen, Hand> | Extra<Hand, Gen>, never>

// ----------------------------------------------------------------- /balance
// No money on the request side, so the shapes are identical.

export type _BalanceRequestKeys = Assert<SameKeys<W['PlayerBalanceRequest'], BalanceRequest>>
export type _BalanceRequest = Assert<Exact<BalanceRequest, W['PlayerBalanceRequest']>>
export type _BalanceResultKeys = Assert<SameKeys<W['PlayerBalanceResponse'], BalanceResult>>
export type _BalanceResult = Assert<Exact<BalanceResult, { balance: Money }>>

// ------------------------------------------------------------------ /betwin
// Deviations:
//   `finished`  optional in the spec, always present here — the SDK defaults it
//               to false so a handler never has to write `?? false`.
//   `amount`    Money instead of string; validated before the handler runs.
type BetWinTxFromSpec = Omit<W['RoundBetWinRequestTransaction'], 'amount'> & { amount: Money }
type BetWinRequestFromSpec = Omit<W['RoundBetWinRequest'], 'finished' | 'transactions'> & {
  finished: boolean
  transactions: BetWinTxFromSpec[]
}
export type _BetWinTxKeys = Assert<
  SameKeys<W['RoundBetWinRequestTransaction'], BetWinRequest['transactions'][number]>
>
export type _BetWinRequestKeys = Assert<SameKeys<W['RoundBetWinRequest'], BetWinRequest>>
export type _BetWinRequest = Assert<Exact<BetWinRequest, BetWinRequestFromSpec>>

// Deviations:
//   `balance`       Money instead of string.
//   `bonus_amount`  optional here; the SDK emits "0.00" when you omit it, so the
//                   field is always present on the wire as the spec requires.
type BetWinTxResultFromSpec = Omit<W['RoundBetWinResponseTransaction'], 'bonus_amount'> & {
  bonus_amount?: Money
}
type BetWinResultFromSpec = Omit<W['RoundBetWinResponse'], 'balance' | 'transactions'> & {
  balance: Money
  transactions: BetWinTxResultFromSpec[]
}
export type _BetWinTxResultKeys = Assert<
  SameKeys<W['RoundBetWinResponseTransaction'], BetWinResult['transactions'][number]>
>
export type _BetWinResultKeys = Assert<SameKeys<W['RoundBetWinResponse'], BetWinResult>>
export type _BetWinResult = Assert<Exact<BetWinResult, BetWinResultFromSpec>>

// ---------------------------------------------------------------- /rollback
// Deviations:
//   `game_id`   required in the spec and always sent by the platform, but the
//               SDK accepts its absence and gives you "". Liberal in, strict out.
//   `finished`  same defaulting as /betwin.
type RollbackRequestFromSpec = Omit<W['RoundRollbackRequest'], 'finished' | 'game_id'> & {
  finished: boolean
  game_id: string
}
export type _RollbackTxKeys = Assert<
  SameKeys<W['RoundRollbackRequestTransaction'], RollbackRequest['transactions'][number]>
>
export type _RollbackTx = Assert<
  Exact<RollbackRequest['transactions'][number], W['RoundRollbackRequestTransaction']>
>
export type _RollbackRequestKeys = Assert<SameKeys<W['RoundRollbackRequest'], RollbackRequest>>
export type _RollbackRequest = Assert<Exact<RollbackRequest, RollbackRequestFromSpec>>

type RollbackResultFromSpec = Omit<W['RoundRollbackResponse'], 'balance'> & { balance: Money }
export type _RollbackTxResultKeys = Assert<
  SameKeys<W['RoundRollbackResponseTransaction'], RollbackResult['transactions'][number]>
>
export type _RollbackTxResult = Assert<
  Exact<RollbackResult['transactions'][number], W['RoundRollbackResponseTransaction']>
>
export type _RollbackResultKeys = Assert<SameKeys<W['RoundRollbackResponse'], RollbackResult>>
export type _RollbackResult = Assert<Exact<RollbackResult, RollbackResultFromSpec>>

// ------------------------------------------------------------------ /finish
export type _FinishRequestKeys = Assert<SameKeys<W['RoundFinishRequest'], FinishRequest>>
export type _FinishRequest = Assert<Exact<FinishRequest, W['RoundFinishRequest']>>
export type _FinishResultKeys = Assert<SameKeys<W['RoundFinishResponse'], FinishResult>>
export type _FinishResult = Assert<Exact<FinishResult, { balance: Money }>>

// ---------------------------------------------------------------- launcher
export type _LaunchResultKeys = Assert<SameKeys<L['LauncherResponse'], LaunchResult>>
export type _LaunchResult = Assert<Exact<LaunchResult, L['LauncherResponse']>>

// `GameInfo` and the launch requests are open bags by design — the contract
// declares `additionalProperties: true` and the catalogue grows fields without
// a version bump — so the assertion is one-way: everything the spec declares
// must be present here, and extra keys are allowed.
export type _GameInfoCoversSpec = Assert<Exact<Missing<C['GameInfo'], GameInfoKnown>, never>>
