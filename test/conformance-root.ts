import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Where the conformance fixtures live.
 *
 * Two layouts, because this package is developed in the Beexar monorepo and
 * published as a standalone repository. In the published repository the
 * fixtures sit at the root as `conformance/`; in the monorepo they are the
 * single copy under `api/`, shared with the Go, PHP and Python SDKs. The tests
 * that ship to operators therefore run unchanged in both places.
 */
const CANDIDATES = [
  '../conformance/', // published repository
  '../../../api/providers/softswiss/conformance/', // monorepo
]

function resolve(): string {
  for (const candidate of CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  throw new Error(
    'conformance fixtures not found — looked in ' + CANDIDATES.join(' and '),
  )
}

export const CONFORMANCE_ROOT = resolve()
