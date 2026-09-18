/**
 * Money — a decimal amount in a currency's main unit, never a float.
 *
 * Every amount and balance on this contract is a decimal STRING in the
 * currency's main unit: `"0.90"` is ninety cents, not ninety. The platform
 * produces them with a fixed scale and reads them back the same way, so the
 * safe representation on this side is an integer number of units plus a scale.
 *
 * There is deliberately no way to build a Money from a `number`. IEEE-754
 * cannot hold `0.1`, and a wallet that rounds a player's balance by a hundredth
 * of a cent per round is a reconciliation incident, not a rounding detail.
 */

/** Thrown when a string is not a valid amount on this contract. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * Upper bound on fractional digits, mirroring the platform's NUMERIC(38,16)
 * storage. A currency config with more decimals is rejected upstream.
 */
export const MAX_SCALE = 16

/**
 * Length cap on an untrusted decimal string, mirroring the `maxLength: 40` the
 * OpenAPI contract puts on amount fields.
 */
export const MAX_CLIENT_DECIMAL_LEN = 40

/**
 * The shape the contract accepts: a non-negative plain decimal, at most
 * MAX_SCALE fractional digits, and NO scientific notation.
 *
 * Rejecting the exponent form is the load-bearing part, not a style choice.
 * `"1E2000000000"` parses in microseconds in every bignum library on earth and
 * costs nothing until the first rescale, at which point it asks for a
 * multi-gigabyte integer and takes the process with it. The guard has to run on
 * shape, before any arithmetic touches the value.
 */
const CLIENT_DECIMAL = /^\d+(\.\d{1,16})?$/

const TEN = 10n

function pow10(n: number): bigint {
  let r = 1n
  for (let i = 0; i < n; i++) r *= TEN
  return r
}

export class Money {
  /** Unscaled integer value. May be negative after subtraction. */
  private readonly units: bigint
  /** Number of fractional digits `units` is expressed in. */
  readonly scale: number

  private constructor(units: bigint, scale: number) {
    this.units = units
    this.scale = scale
    Object.freeze(this)
  }

  /** Zero at scale 2 — the scale the wallet contract's examples use. */
  static readonly ZERO = new Money(0n, 2)

  /**
   * Parses a decimal string from the wire. Throws MoneyError on anything
   * outside the contract shape.
   */
  static parse(value: string): Money {
    const m = Money.tryParse(value)
    if (m === null) throw new MoneyError(`not a valid decimal amount: ${JSON.stringify(value)}`)
    return m
  }

  /** Like {@link Money.parse} but returns null instead of throwing. */
  static tryParse(value: unknown): Money | null {
    if (typeof value !== 'string') return null
    if (value.length === 0 || value.length > MAX_CLIENT_DECIMAL_LEN) return null
    if (!CLIENT_DECIMAL.test(value)) return null

    const dot = value.indexOf('.')
    if (dot < 0) return new Money(BigInt(value), 0)
    const scale = value.length - dot - 1
    return new Money(BigInt(value.slice(0, dot) + value.slice(dot + 1)), scale)
  }

  /**
   * Builds a Money from an integer number of minor units, e.g. cents.
   * `Money.fromMinorUnits(12345n, 2)` is `"123.45"`.
   *
   * This is the bridge for a ledger that stores integers. It takes a bigint,
   * not a number, so a value past 2^53 cannot silently lose its low digits.
   */
  static fromMinorUnits(units: bigint, scale: number): Money {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new MoneyError(`scale must be an integer in [0, ${MAX_SCALE}], got ${scale}`)
    }
    return new Money(units, scale)
  }

  /** The unscaled integer value at {@link Money.scale}. */
  toMinorUnits(): bigint {
    return this.units
  }

  private rescale(target: number): bigint {
    if (target === this.scale) return this.units
    if (target > this.scale) return this.units * pow10(target - this.scale)
    // Truncate toward zero — the same direction as the platform's Truncate, so
    // a rounding step can never inflate what the operator owes.
    const d = pow10(this.scale - target)
    const q = this.units / d
    return q
  }

  /**
   * Renders with exactly `scale` fractional digits, truncating toward zero.
   * This is the canonical wire form.
   */
  format(scale: number): string {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new MoneyError(`scale must be an integer in [0, ${MAX_SCALE}], got ${scale}`)
    }
    const u = this.rescale(scale)
    const neg = u < 0n
    const digits = (neg ? -u : u).toString().padStart(scale + 1, '0')
    const int = digits.slice(0, digits.length - scale)
    const frac = scale === 0 ? '' : '.' + digits.slice(digits.length - scale)
    return (neg ? '-' : '') + int + frac
  }

  /**
   * Renders `bonus_amount`, which the wallet contract caps at 12 fractional
   * digits (`^\d{1,18}(\.\d{1,12})?$`) while platform money allows 16. Clamping
   * here keeps a 16-decimal currency from emitting a bonus value the contract
   * would reject.
   */
  formatBonus(): string {
    return this.format(Math.min(this.scale, 12))
  }

  toString(): string {
    return this.format(this.scale)
  }

  toJSON(): string {
    return this.toString()
  }

  /**
   * Guards against `money + 1` and `` `${money}` `` silently producing numbers.
   * Use {@link Money.add} and {@link Money.toString}.
   */
  valueOf(): never {
    throw new MoneyError('Money has no numeric value — use .toString() or .add()/.sub()')
  }

  add(other: Money): Money {
    const s = Math.max(this.scale, other.scale)
    return new Money(this.rescale(s) + other.rescale(s), s)
  }

  sub(other: Money): Money {
    const s = Math.max(this.scale, other.scale)
    return new Money(this.rescale(s) - other.rescale(s), s)
  }

  /** -1, 0 or 1. */
  compare(other: Money): -1 | 0 | 1 {
    const s = Math.max(this.scale, other.scale)
    const a = this.rescale(s)
    const b = other.rescale(s)
    return a < b ? -1 : a > b ? 1 : 0
  }

  equals(other: Money): boolean {
    return this.compare(other) === 0
  }

  isZero(): boolean {
    return this.units === 0n
  }

  isNegative(): boolean {
    return this.units < 0n
  }

  isPositive(): boolean {
    return this.units > 0n
  }

  /** Returns this, or zero when this is negative. */
  clampToZero(): Money {
    return this.isNegative() ? new Money(0n, this.scale) : this
  }
}

/**
 * Currency codes on this contract: ISO-4217 fiat, a crypto ticker, or an
 * operator's custom code prefixed `CUSTOM_`. Lowercase is REJECTED, never
 * normalised — the platform's own schema does the same, and quietly upcasing
 * here would hide an operator bug until it reached settlement.
 */
const CURRENCY = /^[A-Z][A-Z0-9_]{2,31}$/

export const Currency = {
  pattern: CURRENCY.source,
  isValid(code: unknown): code is string {
    return typeof code === 'string' && CURRENCY.test(code)
  },
}
