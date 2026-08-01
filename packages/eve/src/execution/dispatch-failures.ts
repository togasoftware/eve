/**
 * Parent-synthesized dispatch-failure results: the `origin: "dispatch"`
 * subagent results the dispatch step returns when no child was (or may be)
 * started. Lives in its own non-directive file to escape the workflow
 * step-proxy transform and keep the dispatch step focused on orchestration.
 */

import { REMOTE_AGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
} from "#runtime/actions/types.js";
import { toErrorMessage } from "#shared/errors.js";

/** Failure for a dynamic subagent the current session selection omits. */
export function createUnavailableDynamicSubagentResult(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): RuntimeSubagentDispatchFailure {
  const subagentName = getSubagentName(action);
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "SUBAGENT_UNAVAILABLE",
      message: `Subagent "${subagentName}" is not available in the current session context.`,
    },
    subagentName,
  };
}

/** Invoked subagent name of a local or remote agent call. */
export function getSubagentName(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): string {
  return action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
}

/** Failure for a remote agent whose create-session request did not succeed. */
export function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentDispatchFailure {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: REMOTE_AGENT_START_FAILED,
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

/** Failure for the built-in recursive `agent` tool outside the root session. */
export function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentDispatchFailure {
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "RECURSIVE_AGENT_ROOT_ONLY",
      message: 'The built-in "agent" tool is only available to the root session.',
    },
    subagentName: action.subagentName,
  };
}

/** Narrows an action to the built-in recursive `agent` tool call. */
export function isRecursiveAgentAction(
  action: RuntimeActionRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentCallActionRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
