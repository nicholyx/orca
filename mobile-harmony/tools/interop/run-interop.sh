#!/usr/bin/env bash
#
# The full verification pipeline: wire-level interop, real end-to-end
# sessions, the UI view-model, and the static ArkTS/ArkUI checks.
#
#   ./run-interop.sh
#
# Nothing here is part of the shipped app. The oracles (the repo's own reference
# implementations, plus tweetnacl / @noble / zod) live in the isolated managed
# workspace so they never touch the repo's node_modules.
#
# Expect roughly 60-90 seconds: the end-to-end harnesses use real timers, because
# the reconnect backoff and handshake deadlines under test are real.
set -euo pipefail

NODE_BIN="${NODE_BIN:-node}"
ORACLE_NODE_MODULES="${ORACLE_NODE_MODULES:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "node executable '$NODE_BIN' not found (set NODE_BIN)" >&2
  exit 2
fi
if [ ! -d "$ORACLE_NODE_MODULES" ]; then
  echo "reference dependencies not found at $ORACLE_NODE_MODULES" >&2
  echo "install them with: npm install tweetnacl @noble/hashes@1.8.0 zod@4.5.4 esbuild" >&2
  exit 2
fi

export NODE_PATH="$ORACLE_NODE_MODULES"
export ORACLE_NODE_MODULES

banner() {
  echo
  echo "══════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════════════"
}

banner "build"
"$NODE_BIN" "$here/build.mjs"

# Layer-by-layer comparison against the repo's own reference implementations.
for entry in verify-interop verify-transport-interop verify-pairing-interop; do
  banner "$entry"
  if ! "$NODE_BIN" "$here/.build/$entry.cjs"; then failures=$((failures + 1)); fi
done

# The whole client stack against the real desktop session, over a socket.
banner "verify-e2e-interop  (client vs real desktop code)"
if ! "$NODE_BIN" "$here/.build/verify-e2e-interop.cjs"; then failures=$((failures + 1)); fi

# The shipped view-model, with only the @kit boundary substituted.
banner "verify-ui-state  (view-model)"
if ! "$NODE_BIN" "$here/.build/verify-ui-state.cjs"; then failures=$((failures + 1)); fi

# Static checks: these need no bundle.
banner "check-syntax  (imports, ArkTS subset, layering)"
if ! "$NODE_BIN" "$here/check-syntax.mjs"; then failures=$((failures + 1)); fi

banner "check-arkui  (pages, structs, resources, ForEach keys)"
if ! "$NODE_BIN" "$here/check-arkui.mjs"; then failures=$((failures + 1)); fi

echo
if [ "$failures" -eq 0 ]; then
  echo "ALL SUITES PASSED"
  exit 0
fi
echo "SUITES FAILED: $failures"
exit 1
