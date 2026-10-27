import {
  Money,
  WalletError,
  type BalanceRequest,
  type BalanceResult,
  type BetWinRequest,
  type BetWinResult,
  type BetWinTransactionResult,
  type FinishRequest,
  type FinishResult,
  type FreespinsFinishRequest,
  type FreespinsFinishResult,
  type RollbackRequest,
  type RollbackResult,
  type RollbackTransactionResult,
  type WalletHandler,
} from '@beexar/sdk'

/**
 * A complete, correct wallet in memory.
 *
 * Not durable, not shared between processes, not your ledger. It exists to show
 * the three rules that decide whether an integration is correct, in the order
 * they have to happen:
 *
 *   1. **Dedupe on `id_provider` first.** A repeat must return the transaction
 *      id and the balance you STORED the first time — not today's balance, not
 *      a fresh id. The platform retries, and a retry must be invisible.
 *   2. **Then check the tombstone.** A rollback can arrive before the bet it
 *      reverses. When that bet finally shows up it must be refused with
 *      api_code 409, not applied.
 *   3. **Then apply, atomically.** Either every transaction in the request
 *      lands or none does, and an insufficient-funds answer reports the balance
 *      as it was BEFORE the batch — because nothing moved.
 *
 * Freespins follow the same discipline with `issue_id` as the key: record the
 * issue before you send Freespins/Issue, credit its `/freespins/finish` once,
 * and answer a repeat with the balance you stored the first time.
 *
 * The single lock below stands in for your `BEGIN`/`COMMIT`. In a real wallet,
 * the dedupe read, the tombstone read and the balance update must all be in one
 * database transaction. That is the reason this SDK does not offer to do
 * idempotency for you: it cannot join your transaction, so it would only be
 * able to pretend.
 */

export interface StoredTransaction {
  /** Your transaction id. Empty when a rollback found nothing to reverse. */
  id: string
  /** The balance you reported after applying it. */
  balance_after: string
  /** Recorded only for transactions a rollback can reverse. */
  type?: 'bet' | 'win'
  amount?: string
}

export interface StoredAccount {
  currency: string
  balance: string
  /** Test hook: make this account answer api_code 105 instead of betting. */
  bet_limited?: boolean
}

/** Where a freespins issue stands on your side. */
export type FreespinsIssueStatus = 'issued' | 'canceled' | 'finished'

export interface StoredFreespinsIssue {
  /** Whose freespins these are — /freespins/finish does not say. */
  account_id: string
  currency: string
  status: FreespinsIssueStatus
  /** Recorded when /freespins/finish credits the issue. */
  amount?: string
  /** The balance you answered then; a repeat answers it again. */
  balance_after?: string
}

export interface LedgerState {
  accounts: Record<string, StoredAccount>
  transactions: Record<string, StoredTransaction>
  tombstones: string[]
  freespins_issues: Record<string, StoredFreespinsIssue>
}

export class InMemoryWallet implements WalletHandler {
  private readonly accounts = new Map<string, { currency: string; balance: Money; betLimited: boolean }>()
  private readonly transactions = new Map<string, StoredTransaction>()
  private readonly tombstones = new Set<string>()
  private readonly freespinsIssues = new Map<string, StoredFreespinsIssue>()
  private readonly rounds = new Map<string, string>()
  private nextTx: number
  private nextRound = 1

  constructor(state: LedgerState = { accounts: {}, transactions: {}, tombstones: [], freespins_issues: {} }) {
    for (const [id, a] of Object.entries(state.accounts)) {
      this.accounts.set(id, {
        currency: a.currency,
        balance: Money.parse(a.balance),
        betLimited: a.bet_limited === true,
      })
    }
    for (const [id, t] of Object.entries(state.transactions)) this.transactions.set(id, { ...t })
    for (const id of state.tombstones) this.tombstones.add(id)
    for (const [id, i] of Object.entries(state.freespins_issues)) this.freespinsIssues.set(id, { ...i })

    // Continue the id sequence rather than restarting it, so ids stay unique
    // across a restored state.
    let max = 0
    for (const t of this.transactions.values()) {
      const m = /^op-tx-(\d+)$/.exec(t.id)
      if (m?.[1]) max = Math.max(max, Number(m[1]))
    }
    this.nextTx = max + 1
  }

  /** The current state, in the same shape the constructor takes. */
  snapshot(): LedgerState {
    const accounts: Record<string, StoredAccount> = {}
    for (const [id, a] of this.accounts) {
      accounts[id] = {
        currency: a.currency,
        balance: a.balance.toString(),
        ...(a.betLimited ? { bet_limited: true } : {}),
      }
    }
    const transactions: Record<string, StoredTransaction> = {}
    for (const [id, t] of this.transactions) transactions[id] = { ...t }
    const freespinsIssues: Record<string, StoredFreespinsIssue> = {}
    for (const [id, i] of this.freespinsIssues) freespinsIssues[id] = { ...i }
    return {
      accounts,
      transactions,
      tombstones: [...this.tombstones],
      freespins_issues: freespinsIssues,
    }
  }

  // ------------------------------------------------------------------ /balance

  balance(req: BalanceRequest): BalanceResult {
    return { balance: this.account(req.account_id).balance }
  }

  // ------------------------------------------------------------------- /betwin

  betWin(req: BetWinRequest): BetWinResult {
    const account = this.account(req.account_id)
    const balanceBefore = account.balance

    // Everything is computed against a working copy first. Nothing touches the
    // stored state until the whole batch is known to succeed.
    let running = balanceBefore
    let replayedBalance: Money | null = null
    const applied: Array<{ idProvider: string; stored: StoredTransaction }> = []
    const results: BetWinTransactionResult[] = []

    for (const tx of req.transactions) {
      const seen = this.transactions.get(tx.id_provider)
      if (seen) {
        // 1. Replay: answer with what we stored, and change nothing. The stored
        //    balance is the answer even if the account has moved on since —
        //    that is what makes the repeat invisible to the platform.
        results.push({ id_provider: tx.id_provider, id: seen.id })
        replayedBalance = Money.parse(seen.balance_after)
        continue
      }
      if (this.tombstones.has(tx.id_provider)) {
        // 2. Its rollback got here first.
        throw WalletError.alreadyRolledBack()
      }
      if (tx.type === 'bet' && account.betLimited) {
        throw WalletError.betLimitReached(balanceBefore)
      }

      // 3. Apply on the working copy.
      if (tx.type === 'bet') {
        const after = running.sub(tx.amount)
        if (after.isNegative()) {
          // Report the balance as it stands — nothing in this batch was applied.
          throw WalletError.insufficientFunds(balanceBefore)
        }
        running = after
      } else {
        running = running.add(tx.amount)
      }

      const id = this.allocateTxId()
      applied.push({
        idProvider: tx.id_provider,
        stored: {
          id,
          balance_after: running.toString(),
          type: tx.type,
          amount: tx.amount.toString(),
        },
      })
      results.push({ id_provider: tx.id_provider, id })
    }

    // Commit only if something was actually applied. A request made entirely of
    // repeats must leave the ledger exactly as it found it.
    let balance = running
    if (applied.length > 0) {
      for (const a of applied) this.transactions.set(a.idProvider, a.stored)
      account.balance = running
    } else if (replayedBalance !== null) {
      balance = replayedBalance
    }

    return { round_id: this.roundIdFor(req.round_id), balance, transactions: results }
  }

  // ----------------------------------------------------------------- /rollback

  rollback(req: RollbackRequest): RollbackResult {
    const account = this.account(req.account_id)
    let running = account.balance
    let replayedBalance: Money | null = null
    let changed = false
    const results: RollbackTransactionResult[] = []

    for (const tx of req.transactions) {
      const seen = this.transactions.get(tx.id_provider)
      if (seen) {
        results.push({ id_provider: tx.id_provider, id: seen.id })
        replayedBalance = Money.parse(seen.balance_after)
        continue
      }

      // The tombstone goes down whether or not the original ever arrived. That
      // is what makes an out-of-order rollback safe: when the bet turns up, the
      // tombstone is already there to refuse it.
      this.tombstones.add(tx.original_id_provider)
      changed = true

      const original = this.transactions.get(tx.original_id_provider)
      let id = ''
      if (original?.type !== undefined && original.amount !== undefined) {
        const amount = Money.parse(original.amount)
        running =
          original.type === 'bet'
            ? running.add(amount)
            : // Reversing a win can only take back what is there. Clamping at
              // zero keeps a player from going negative because of our bookkeeping.
              running.sub(amount).clampToZero()
        id = this.allocateTxId()
      }

      this.transactions.set(tx.id_provider, { id, balance_after: running.toString() })
      results.push({ id_provider: tx.id_provider, id })
    }

    let balance = running
    if (changed) {
      account.balance = running
    } else if (replayedBalance !== null) {
      balance = replayedBalance
    }

    return { balance, round_id: this.roundIdFor(req.round_id_provider), transactions: results }
  }

  // ------------------------------------------------------------------- /finish

  finish(req: FinishRequest): FinishResult {
    // Nothing to settle: the round's money already moved through /betwin.
    // Answering the current balance and staying idempotent is the whole job.
    return { balance: this.account(req.account_id).balance }
  }

  // --------------------------------------------------------- freespins issue

  /**
   * Records an issue BEFORE you send it with `Client.issueFreespins`.
   * /freespins/finish names only the `issue_id`, so this record is what says
   * whose wallet, in which currency, to credit — and a Finish can never arrive
   * for an issue you do not know.
   */
  recordFreespinsIssue(issueId: string, accountId: string, currency: string): void {
    if (!this.freespinsIssues.has(issueId)) {
      this.freespinsIssues.set(issueId, { account_id: accountId, currency, status: 'issued' })
    }
  }

  /**
   * Marks an issue canceled once Beexar ACCEPTED your `Client.cancelFreespins`.
   * A refused cancel (620: already played out) leaves it issued, because its
   * /freespins/finish is on its way.
   */
  cancelFreespinsIssue(issueId: string): void {
    const issue = this.freespinsIssues.get(issueId)
    if (issue?.status === 'issued') issue.status = 'canceled'
  }

  // -------------------------------------------------------- /freespins/finish

  freespinsFinish(req: FreespinsFinishRequest): FreespinsFinishResult {
    const issue = this.freespinsIssues.get(req.issue_id)
    if (!issue) throw WalletError.invalidFreespinsIssue(`unknown freespins issue ${req.issue_id}`)

    // 1. Replay first, exactly as for id_provider: the platform retries until
    //    it gets a 200, and the retry must credit nothing and answer the
    //    balance stored the first time.
    if (issue.status === 'finished') {
      if (issue.balance_after === undefined) {
        // Never credit a finished issue again; a 500 makes the platform retry.
        throw new Error(`freespins issue ${req.issue_id} is finished but has no stored balance`)
      }
      return { balance: Money.parse(issue.balance_after) }
    }
    // 2. A canceled issue has no result to take.
    if (issue.status === 'canceled') {
      throw WalletError.freespinsStateTransition(`freespins issue ${req.issue_id} was canceled`)
    }

    // 3. Credit, and record the answer with the issue — one transaction in a
    //    real ledger, like everything else here. Zero is a valid result.
    const account = this.account(issue.account_id)
    account.balance = account.balance.add(req.amount)
    issue.status = 'finished'
    issue.amount = req.amount.toString()
    issue.balance_after = account.balance.toString()
    return { balance: account.balance }
  }

  // -------------------------------------------------------------------- utils

  private account(accountId: string): { currency: string; balance: Money; betLimited: boolean } {
    const a = this.accounts.get(accountId)
    if (!a) throw WalletError.invalidPlayer(`unknown account ${accountId}`)
    return a
  }

  private allocateTxId(): string {
    return `op-tx-${this.nextTx++}`
  }

  private roundIdFor(providerRoundId: string): string {
    let own = this.rounds.get(providerRoundId)
    if (own === undefined) {
      own = `op-round-${this.nextRound++}`
      this.rounds.set(providerRoundId, own)
    }
    return own
  }
}
