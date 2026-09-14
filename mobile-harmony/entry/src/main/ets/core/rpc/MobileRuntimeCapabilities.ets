/*
 * The runtime capabilities this client advertises to the host.
 *
 * The values are copied verbatim from
 * `src/shared/remote-runtime-client-capabilities.ts` plus the mobile-specific
 * additions in `mobile/src/transport/mobile-runtime-client-capabilities.ts`.
 * ArkTS cannot import from `src/shared` (it lives outside the module and uses
 * TypeScript features ArkTS rejects), so the list is duplicated — and the
 * duplication is guarded by a parity assertion in
 * tools/interop/verify-transport-interop.ts. If a capability is added upstream,
 * that assertion fails until the copy here is updated.
 *
 * Order matters: the host sees the array as written, and the reference builds it
 * as a de-duplicated insertion-ordered set.
 */
export const MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD = 'runtime.clientCapabilities.update';

export const MOBILE_RUNTIME_CLIENT_CAPABILITIES: string[] = [
  'agent-session.background-task-stop.v1',
  'agent-session.background-task-row-stop.v1',
  'agent-session.turn-item.v1',
  'session-tabs.close-intent.v1',
  'session-tabs.authoritative-inventory.v1',
  'agent-session.session-boundary.v1',
  'skills.install-result.v2',
  'worktree.github-pr-suppression.v1',
  'worktree.visibility-defaults.v1',
  'worktree.visibility-source-defaults.v1',
  'automation.owner-fencing.v1',
  'agent-session.structured.v1',
  'agent-session.pending-send-result.v1',
  'agent-session.structured.hold.v1',
  'agent-session.structured.claude.v1'
];

export function mobileRuntimeClientCapabilityUpdateParams(): Record<string, Object> {
  const params: Record<string, Object> = {};
  params.clientCapabilities = MOBILE_RUNTIME_CLIENT_CAPABILITIES.slice();
  return params;
}

/** Builds the advisory request sent once the channel authenticates. */
export function mobileRuntimeClientCapabilityUpdateRequest(args: {
  id: string;
  deviceToken: string;
}): Record<string, Object> {
  const request: Record<string, Object> = {};
  request.id = args.id;
  request.deviceToken = args.deviceToken;
  request.method = MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD;
  request.params = mobileRuntimeClientCapabilityUpdateParams();
  return request;
}
