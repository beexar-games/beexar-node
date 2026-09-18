import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CONFORMANCE_ROOT } from './conformance-root.js'
import { join } from 'node:path'
import { WalletServer } from '../src/wallet.js'
import { sign } from '../src/signature.js'
import type { Route, WalletHandler } from '../src/types.js'
import { InMemoryWallet, type LedgerState } from '../examples/inmemory-wallet.js'

/**
 * The cross-language conformance suite. The same fixtures are run by the Go,
 * PHP and Python SDKs, so behaviour cannot drift between languages while there
 * is only one set of cases.
 */
const ROOT = CONFORMANCE_ROOT

const read = (p: string) => readFileSync(join(ROOT, p))
const readJson = (p: string) => JSON.parse(read(p).toString('utf8'))

const manifest = readJson('manifest.json') as {
  fixture_version: number
  cases: Array<{ dir: string; endpoint: Route; kind: 'transport' | 'ledger' }>
}
const SECRET = read('secret.txt').toString('utf8')

describe(`wallet conformance (fixture_version ${manifest.fixture_version})`, () => {
  it('covers every case in the manifest', () => {
    expect(manifest.cases.length).toBeGreaterThan(20)
  })

  for (const c of manifest.cases) {
    it(c.dir, async () => {
      const body = read(`cases/${c.dir}/request.body`)
      const request = readJson(`cases/${c.dir}/request.json`) as {
        endpoint: Route
        headers: Record<string, string>
      }
      const before = readJson(`cases/${c.dir}/ledger.before.json`) as LedgerState
      const after = readJson(`cases/${c.dir}/ledger.after.json`) as LedgerState
      const expected = readJson(`cases/${c.dir}/response.json`) as { status: number; body: unknown }

      // A fixture whose stored signature does not match its own bytes would
      // quietly test nothing, so the suite re-derives it.
      const stored = request.headers['X-REQUEST-SIGN']
      if (stored !== undefined && stored !== '0'.repeat(64)) {
        expect(stored).toBe(sign(body, SECRET))
      }

      const wallet = new InMemoryWallet(before)
      const server = new WalletServer(explode(wallet), { apiSecret: SECRET, onWarning: () => {} })

      const out = await server.dispatch(request.endpoint, body, stored)

      expect(out.status).toBe(expected.status)
      expect(JSON.parse(out.body)).toEqual(expected.body)
      expect(wallet.snapshot()).toEqual(after)
    })
  }
})

/**
 * Makes the `boom` account throw something that is not a WalletError, so the
 * "handler raised the unexpected" path is exercised without putting a test hook
 * in the reference wallet itself.
 */
function explode(wallet: InMemoryWallet): WalletHandler {
  return {
    balance: (req) => {
      if (req.account_id === 'boom') throw new Error('simulated ledger outage')
      return wallet.balance(req)
    },
    betWin: (req) => wallet.betWin(req),
    rollback: (req) => wallet.rollback(req),
    finish: (req) => wallet.finish(req),
  }
}
