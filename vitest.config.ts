import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // The examples import '@beexar/sdk' because that is what an operator
      // types. Locally that resolves to the source, so the example that ships
      // in the README is the same code the tests run.
      '@beexar/sdk/express': src('./src/adapters/express.ts'),
      '@beexar/sdk/fastify': src('./src/adapters/fastify.ts'),
      '@beexar/sdk/node-http': src('./src/adapters/node-http.ts'),
      '@beexar/sdk': src('./src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
