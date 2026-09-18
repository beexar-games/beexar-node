import { describe, expect, it } from 'vitest'
import { Currency, MAX_CLIENT_DECIMAL_LEN, Money, MoneyError } from '../src/money.js'

describe('Money.parse', () => {
  it('keeps the scale it was given', () => {
    expect(Money.parse('0.90').toString()).toBe('0.90')
    expect(Money.parse('100').toString()).toBe('100')
    expect(Money.parse('1.2300').toString()).toBe('1.2300')
  })

  it('rejects the exponent form before any arithmetic happens', () => {
    // The whole point: this parses in microseconds in every bignum library and
    // then asks for a multi-gigabyte integer on the first rescale.
    const started = Date.now()
    expect(() => Money.parse('1E2000000000')).toThrow(MoneyError)
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('rejects more than 16 fractional digits', () => {
    expect(() => Money.parse('1.12345678901234567')).toThrow(MoneyError)
    expect(Money.parse('1.1234567890123456').toString()).toBe('1.1234567890123456')
  })

  it('rejects a string longer than the contract allows', () => {
    expect(() => Money.parse('1'.repeat(MAX_CLIENT_DECIMAL_LEN + 1))).toThrow(MoneyError)
  })

  it.each(['', ' 1.00', '1.00 ', '-1.00', '+1.00', '1,00', 'NaN', 'Infinity', '.5', '1.'])(
    'rejects %o',
    (bad) => {
      expect(Money.tryParse(bad)).toBeNull()
    },
  )

  it('rejects a number, so a float can never enter through the front door', () => {
    expect(Money.tryParse(1.1 as unknown as string)).toBeNull()
  })
})

describe('Money arithmetic', () => {
  it('adds and subtracts across different scales without losing digits', () => {
    expect(Money.parse('0.1').add(Money.parse('0.2')).toString()).toBe('0.3')
    expect(Money.parse('100.00').sub(Money.parse('0.005')).toString()).toBe('99.995')
  })

  it('goes negative rather than silently clamping, so a bet can be refused', () => {
    const after = Money.parse('10.00').sub(Money.parse('25.00'))
    expect(after.isNegative()).toBe(true)
    expect(after.clampToZero().toString()).toBe('0.00')
  })

  it('compares by value, not by string', () => {
    expect(Money.parse('1.5').compare(Money.parse('1.50'))).toBe(0)
    expect(Money.parse('1.5').equals(Money.parse('1.50'))).toBe(true)
    expect(Money.parse('2').compare(Money.parse('10'))).toBe(-1)
  })

  it('survives values past Number.MAX_SAFE_INTEGER', () => {
    const huge = Money.parse('90071992547409910.99')
    expect(huge.add(Money.parse('0.01')).toString()).toBe('90071992547409911.00')
  })
})

describe('Money formatting', () => {
  it('truncates toward zero rather than rounding up', () => {
    // Rounding up here would inflate what the operator owes.
    expect(Money.parse('1.999').format(2)).toBe('1.99')
    expect(Money.parse('1.001').format(2)).toBe('1.00')
  })

  it('pads to the requested scale', () => {
    expect(Money.parse('1').format(4)).toBe('1.0000')
    expect(Money.parse('1.5').format(0)).toBe('1')
  })

  it('clamps bonus_amount to the 12 digits the contract allows', () => {
    expect(Money.parse('1.1234567890123456').formatBonus()).toBe('1.123456789012')
    expect(Money.ZERO.formatBonus()).toBe('0.00')
  })

  it('refuses to be coerced to a number', () => {
    const m = Money.parse('1.00')
    expect(() => Number(m)).toThrow(MoneyError)
    // @ts-expect-error arithmetic on Money is a mistake we want to be loud
    expect(() => m + 1).toThrow(MoneyError)
  })

  it('serialises to its wire form inside JSON', () => {
    expect(JSON.stringify({ balance: Money.parse('12.30') })).toBe('{"balance":"12.30"}')
  })
})

describe('Currency', () => {
  it.each(['EUR', 'USD', 'BTC', 'CUSTOM_WIN', 'XBT1'])('accepts %s', (c) => {
    expect(Currency.isValid(c)).toBe(true)
  })

  it.each(['eur', 'Eur', 'EU', '1EUR', '_EUR', ''])('rejects %o without normalising it', (c) => {
    expect(Currency.isValid(c)).toBe(false)
  })
})
