/*
 * Interop verification for the HarmonyOS RPC/transport core.
 *
 * Same idea as verify-interop.ts: every ported module is compared against the
 * repo's own reference implementation, on identical inputs, byte for byte or
 * event for event. Nothing here is part of the shipped app.
 */

import { finish } from './harness'

import { runFramingSections } from './verify-transport-framing'
import { runRpcShapeSections } from './verify-transport-rpc'
import { runPolicySections } from './verify-transport-policy'
import { runRegistrySections } from './verify-transport-registry'

// The sections live in their own modules; this entry point runs them in order
// so every assertion still reports through one counter and one summary.
runFramingSections()
runRpcShapeSections()
runPolicySections()
runRegistrySections()

finish('the ArkTS RPC/transport core matches the reference implementation.')
