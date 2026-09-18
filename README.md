# @beexar/sdk

Beexar operator SDK for Node.js. Launch game sessions, and serve the four
seamless-wallet callbacks the platform calls during play.

Zero runtime dependencies. ESM and CommonJS. Node 18+.

```bash
npm install @beexar/sdk
```

Full docs: **https://docs.beexar.com** · OpenAPI: **https://docs.beexar.com/api-reference/**

---

## The integration in one picture

There are two halves, and the second one is the work.

```
you  ──  POST /api/v1/softswiss/launcher/real  ──▶  Beexar     (Client)
                                                      │
player plays                                          │
                                                      ▼
your wallet  ◀──  POST /balance /betwin /rollback /finish  ──  Beexar   (WalletServer)
```

## Half 1 — launching a game

```ts
import { Client } from '@beexar/sdk'

const beexar = new Client({
  casinoId: process.env.BEEXAR_CASINO_ID!,   // your operator slug
  apiSecret: process.env.BEEXAR_API_SECRET!, // from the backoffice
})

const { launch_url } = await beexar.launchReal({
  game: 'dice',
  account: { id: 'player_123', currency: 'EUR' },
  locale: 'en',
})
// put launch_url in an iframe
```

`launchDemo()` does the same on a virtual balance and makes no wallet calls.
`listGames()` returns the catalogue enabled for you.

## Half 2 — serving the wallet

Implement four methods against your ledger. Everything else — signature
verification, parsing, validation, the error envelope — is handled.

```ts
import express from 'express'
import { WalletServer, WalletError, Money, type WalletHandler } from '@beexar/sdk'
import { beexarWallet } from '@beexar/sdk/express'

const handler: WalletHandler = {
  async balance(req) {
    return { balance: await ledger.balanceOf(req.account_id) }
  },

  async betWin(req) {
    return db.transaction(async (tx) => {
      // Everything below must be in ONE database transaction. See "The boundary".
      const results = []
      for (const t of req.transactions) {
        const seen = await tx.findTransaction(t.id_provider)
        if (seen) { results.push({ id_provider: t.id_provider, id: seen.id }); continue }
        if (await tx.isRolledBack(t.id_provider)) throw WalletError.alreadyRolledBack()

        if (t.type === 'bet' && (await tx.balance()).compare(t.amount) < 0) {
          throw WalletError.insufficientFunds(await tx.balance())
        }
        const id = await tx.apply(t)
        results.push({ id_provider: t.id_provider, id })
      }
      return { round_id: await tx.roundId(req.round_id), balance: await tx.balance(), transactions: results }
    })
  },

  async rollback(req) { /* … */ },
  async finish(req)   { return { balance: await ledger.balanceOf(req.account_id) } },
}

const app = express()
app.use('/wallet', beexarWallet(new WalletServer(handler, { apiSecret: process.env.BEEXAR_API_SECRET! })))
app.listen(8080)
```

Then point the four callback URLs in the backoffice at
`https://your-host/wallet/{balance,betwin,rollback,finish}` and run the
[Integration Test Game](https://docs.beexar.com/guides/testing/) — 29 scenarios
against your implementation.

A complete, correct wallet you can read in one sitting:
[`examples/inmemory-wallet.ts`](./examples/inmemory-wallet.ts).

## The raw body — read this one

The signature is an HMAC over the **exact bytes** of the request. If anything
parses the JSON and serialises it again before the SDK sees it, those bytes are
gone — key order, escaping and number rendering all change — and no signature
can ever match again.

| Your setup | What to do |
|---|---|
| Express, no body parser | `app.use('/wallet', beexarWallet(server))` — just works |
| Express with `express.json()` | `app.use(express.json({ verify: captureRawBody }))`, then mount as usual |
| Express with `express.raw()` | just works |
| Fastify | `await app.register(fastifyWallet, { server, prefix: '/wallet' })` — it swaps the JSON parser **inside its own scope** only |
| Plain `node:http` | `createServer(nodeHttpWallet(server))` |
| Anything else | call `server.dispatch(route, rawBodyBytes, signature)` yourself |

When a signature fails and the SDK can tell why, it says so in plain words
rather than leaving you with a 400. Silence it with `onWarning: () => {}`.

## Money

Amounts and balances are decimal strings in the currency's main unit — `"0.90"`
is ninety cents. The SDK wraps them in `Money`, which cannot be built from a
`number` and throws if you try to do arithmetic on it with `+`.

```ts
Money.parse('100.00').sub(Money.parse('0.30')).toString() // "99.70"
Money.fromMinorUnits(9970n, 2).toString()                 // "99.70"  ← from an integer ledger
```

`"1E2000000000"` and anything with more than 16 decimals is rejected on shape,
before any arithmetic touches it.

## Errors

Two HTTP statuses exist on this contract, 400 and 500, and the meaning lives in
`meta.api_code`. Throw a `WalletError` and the envelope is built for you:

```ts
throw WalletError.insufficientFunds(currentBalance)  // 400 / api_code 100
throw WalletError.alreadyRolledBack()                // 400 / api_code 409
throw WalletError.invalidPlayer()                    // 400 / api_code 101
```

Codes 100, 105 and 106 **must** carry the player's balance, so those
constructors take it as a required argument — there is no way to build one
without it. Anything else you throw becomes an opaque 500 and your message never
leaves the process.

## The boundary

The SDK does **not** do idempotency or tombstones for you, and it will not
pretend to. Both have to happen in the same database transaction as the balance
update, and no library can join your transaction. What you must do:

1. Store every `id_provider` with a unique index, and check it **inside** the
   transaction that moves the money.
2. Store the response you returned — a repeat must return the id and balance you
   gave the first time, not today's.
3. On rollback, record a tombstone for `original_id_provider` **whether or not**
   the original exists. Out-of-order delivery is normal; a later `/betwin` for a
   tombstoned id must be refused with `WalletError.alreadyRolledBack()`.

Your handler has **15 seconds**. The platform retries 5xx and timeouts for up to
30 seconds with the same `id_provider`; it does not retry insufficient funds,
bet limits, bad requests or signature failures.

## Types come from the spec

The types in this package are generated from the published OpenAPI documents
(`openapi/` in this repo) and pinned to them by compile-time assertions. A field
added to the contract breaks the SDK build — it cannot silently reach you as
`any`.

## License

MIT
