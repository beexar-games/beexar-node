// dist/cjs holds CommonJS output while the package itself is "type": "module".
// Without this marker Node reads dist/cjs/*.js as ESM and `require()` fails with
// ERR_REQUIRE_ESM — the classic dual-build trap.
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{"type":"commonjs"}\n')
