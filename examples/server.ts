/**
 * A complete Beexar wallet integration in one file.
 *
 *   node --experimental-strip-types examples/server.ts
 *   BEEXAR_API_SECRET=... node dist/examples/server.js
 *
 * Point the four callback URLs in the backoffice at
 * http://<host>/wallet/{balance,betwin,rollback,finish} and run the Integration
 * Test Game against it.
 */
import { createServer } from 'node:http'
import { WalletServer } from '@beexar/sdk'
import { nodeHttpWallet } from '@beexar/sdk/node-http'
import { InMemoryWallet } from './inmemory-wallet.js'

const apiSecret = process.env['BEEXAR_API_SECRET']
if (!apiSecret) {
  console.error('BEEXAR_API_SECRET is not set — refusing to start without a secret')
  process.exit(1)
}

const wallet = new InMemoryWallet({
  accounts: { player_1: { currency: 'EUR', balance: '1000.00' } },
  transactions: {},
  tombstones: [],
})

const server = new WalletServer(wallet, { apiSecret })
const port = Number(process.env['PORT'] ?? 8080)

createServer(nodeHttpWallet(server)).listen(port, () => {
  console.log(`beexar wallet listening on :${port}`)
  console.log(`  POST /balance  /betwin  /rollback  /finish`)
})
