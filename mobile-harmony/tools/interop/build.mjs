/*
 * Builds the interop / end-to-end harnesses into single CJS bundles.
 *
 * esbuild's CLI has no `nodePaths` flag, so the oracle dependencies (tweetnacl,
 * @noble/hashes, zod) are resolved from the isolated managed workspace through
 * the JS API. That keeps the repo's own node_modules — which are not installed
 * for this worktree — out of the picture entirely.
 *
 * The `@kit.*` alias is what lets the end-to-end harnesses run the REAL
 * `platform/*` adapters and `OrcaConnection`: every HarmonyOS kit specifier is
 * rewritten to `kit-stub.ts`, so the shipped code executes unchanged against a
 * controllable double. See kit-stub.ts for why that is the whole point.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const here = import.meta.dirname
const oracleModules = process.env.ORACLE_NODE_MODULES
if (!oracleModules) {
  console.error(
    'ORACLE_NODE_MODULES is not set — point it at a directory containing\n' +
      'tweetnacl, @noble/hashes, zod and esbuild, e.g.:\n' +
      '  npm install --prefix ~/.orca-harmony-oracle tweetnacl @noble/hashes@1.8.0 zod@4.5.4 esbuild\n' +
      '  export ORACLE_NODE_MODULES=~/.orca-harmony-oracle/node_modules'
  )
  process.exit(2)
}

// Resolve esbuild from the oracle workspace by path rather than through
// NODE_PATH. Only run-interop.sh exports NODE_PATH, so a bare `node build.mjs`
// used to die here — and, worse, die *before* rewriting `.build/`, leaving the
// previous bundle in place for whatever ran next to load. A verifier that can
// silently test a stale artifact is worse than one that fails loudly.
const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [oracleModules] }))

/** Rewrites every HarmonyOS kit import to the controllable stub. */
const kitStubPlugin = {
  name: 'harmonyos-kit-stub',
  setup(build) {
    build.onResolve({ filter: /^@(kit|ohos)[./]/ }, () => ({
      path: join(here, 'kit-stub.ts')
    }))
  }
}

const entries = [
  'verify-interop',
  'verify-transport-interop',
  'verify-pairing-interop',
  'verify-e2e-interop',
  'verify-ui-state'
]

for (const entry of entries) {
  const outfile = join(here, `.build/${entry}.cjs`)
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [join(here, `${entry}.ts`)],
    bundle: true,
    platform: 'node',
    // CJS, not ESM: tweetnacl's node build calls require('crypto') for its RNG,
    // and a bundled ESM output cannot service that dynamic require.
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
    outfile,
    nodePaths: [oracleModules],
    resolveExtensions: ['.ets', '.ts', '.js', '.mjs', '.json'],
    loader: { '.ets': 'ts' },
    plugins: [kitStubPlugin],
    // The reference modules live under mobile/ and src/, whose tsconfigs extend
    // presets that are not installed in this worktree; type-checking is not needed.
    tsconfigRaw: { compilerOptions: {} }
  })
}
