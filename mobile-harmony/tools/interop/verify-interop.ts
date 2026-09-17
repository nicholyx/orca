/*
 * Interop verification for the HarmonyOS ArkTS E2EE core.
 *
 * The HarmonyOS client is a second implementation of a protocol the desktop and
 * the React Native client already speak. A porting bug here is invisible until a
 * real device fails to pair, so this harness pins every layer against an
 * independent oracle:
 *
 *   - tweetnacl / @noble hashes for the primitives
 *   - the repo's own reference modules for the handshake, transcript and framing
 *
 * Both sides are fed identical vectors and compared byte for byte. esbuild
 * bundles the .ets sources (see run-interop.sh); Node executes the result.
 */

import { finish } from './harness'

import { runByteSections } from './verify-e2ee-bytes'
import { runCryptoSections } from './verify-e2ee-crypto'
import { runProtocolSections } from './verify-e2ee-protocol'
import { runHandshakeSections } from './verify-e2ee-handshake'
import { runSessionSections } from './verify-e2ee-session'

// The layers live in their own modules; this entry point runs them in order so
// the interop summary still counts every assertion in one place.
runByteSections()
runCryptoSections()
runProtocolSections()
runHandshakeSections()
runSessionSections()

finish('the ArkTS core is byte-compatible across 11 layers.')
