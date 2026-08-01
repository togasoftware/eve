import {
  dispatchToAgentHandle,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  createPendingTaskView,
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  findAddressableHandle,
} from "#execution/tasks/control-shared.js";
import {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
} from "#execution/tasks/delegate.js";
import { readLatestTaskSnapshot, sendTaskCommand } from "#execution/tasks/run-control.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { AGENT_BUSY, AGENT_UNREACHABLE } from "#harness/agent-handle-errors.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { settleAgentTurn } from "#harness/handles/transitions.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { findSessionTaskEntry, type SessionTaskIndexEntry } from "#tasks/session-index.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import type { TaskView } from "#tasks/types.js";

const log = createLogger("execution.tasks.send");

/**
 * Routes one `task_send`:
 *
 * - `working` tasks are busy — the send surfaces `AGENT_BUSY` instead
 *   of queueing (settled decision; queueing is the reversible follow-up);
 * - `input_required` tasks accept an `inputResponses` batch, delivered
 *   to the parked child session, and return to `working`;
 * - terminal tasks accept a `message` follow-up, which starts a new
 *   task bound to the same child session and returns its receipt.
 */
export async function executeTaskSend(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult | undefined;
  readonly session: RuntimeSession;
}> {
  const { action, session } = input;
  const send = readTaskSendInput(action.input);
  if (send.kind === "invalid") {
    return { result: createTaskControlError(action, send.message), session };
  }

  const entry = findSessionTaskEntry(session.state, send.taskId);
  if (entry === undefined) {
    return { result: createUnknownTasksError(action, [send.taskId]), session };
  }

  const view =
    (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ??
    createPendingTaskView(entry.taskId);

  if (view.status === "working") {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_BUSY}: task "${view.taskId}" is still working. Wait for it with task_await, or cancel it first.`,
      ),
      session,
    };
  }

  if (view.status === "input_required") {
    if (send.body.kind !== "input-responses") {
      return {
        result: createTaskControlError(
          action,
          `Task "${view.taskId}" is waiting on input; answer it with inputResponses.`,
        ),
        session,
      };
    }
    return answerBlockedTask({
      action,
      bundle: input.bundle,
      entry,
      responses: send.body.inputResponses,
      session,
      view,
    });
  }

  if (send.body.kind !== "message") {
    return {
      result: createTaskControlError(
        action,
        `Task "${view.taskId}" is ${view.status}; send a follow-up message to continue its agent.`,
      ),
      session,
    };
  }
  return followUpTerminalTask({
    action,
    bundle: input.bundle,
    message: send.body.message,
    parentTurnId: input.parentTurnId,
    session,
    view,
  });
}

async function answerBlockedTask(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly responses: readonly { readonly requestId: string }[];
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<{ readonly result: RuntimeActionResult; readonly session: RuntimeSession }> {
  const { action, session, view } = input;
  const handle = findAddressableHandle(session, view.metadata.childSessionId);
  if (handle === undefined || handle.address.kind === "agent/remote") {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_UNREACHABLE}: task "${view.taskId}" has no reachable child session for input responses.`,
      ),
      session,
    };
  }

  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    nodeId: handle.identity.nodeId,
  });
  try {
    // The child parked waiting on this batch; its next settled turn
    // reports to the same task run through the caller reply token.
    await childRuntime.deliver({
      caller: {
        callId: action.callId,
        replyTo: { kind: "hook", token: input.entry.commandToken },
        subagentName: handle.identity.name,
      },
      continuationToken: handle.address.continuationToken,
      payload: { inputResponses: [...input.responses] },
    });
  } catch (error) {
    logError(log, "task_send input-response delivery failed", error, {
      childSessionId: handle.address.sessionId,
      taskId: view.taskId,
    });
    return {
      result: createTaskControlError(
        action,
        `${AGENT_UNREACHABLE}: task "${view.taskId}"'s child session did not accept the responses.`,
      ),
      session,
    };
  }

  await sendTaskCommand({
    command: { kind: "resume-working" },
    commandToken: input.entry.commandToken,
  });
  const resumed = applyTaskTransition(view, { kind: "resume-working" });
  return { result: createTaskViewsResult(action, [resumed.view]), session };
}

async function followUpTerminalTask(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly message: string;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<{ readonly result: RuntimeActionResult; readonly session: RuntimeSession }> {
  const { action, view } = input;
  const handle = findAddressableHandle(input.session, view.metadata.childSessionId);
  if (handle === undefined) {
    return {
      result: createTaskControlError(
        action,
        `${AGENT_UNREACHABLE}: task "${view.taskId}"'s agent is no longer addressable.`,
      ),
      session: input.session,
    };
  }

  const continuation: RuntimeAgentHandleAction =
    handle.address.kind === "agent/remote"
      ? {
          callId: action.callId,
          description: "",
          input: { message: input.message },
          kind: "remote-agent-call",
          name: handle.identity.name,
          nodeId: handle.identity.nodeId,
          remoteAgentName: handle.identity.name,
        }
      : {
          callId: action.callId,
          description: "",
          input: { message: input.message },
          kind: "subagent-call",
          name: handle.identity.name,
          nodeId: handle.identity.nodeId,
          subagentName: handle.identity.name,
        };

  const task = await beginDelegatedTask({
    callId: action.callId,
    mode: handle.address.kind === "agent/remote" ? "remote" : "local",
    name: handle.identity.name,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.parentTurnId,
    session: input.session,
  });
  const outcome = await dispatchToAgentHandle({
    action: continuation,
    agentId: handle.identity.id,
    bundle: input.bundle,
    currentSession: input.session,
    parentToken: task.commandToken,
    parentTurnId: input.parentTurnId,
  });
  if (outcome.kind === "error") {
    await failDelegatedDispatch({ error: outcome.result.output, task });
    return {
      result: {
        callId: action.callId,
        isError: true,
        kind: "tool-result",
        output: outcome.result.output,
        toolName: action.toolName,
      },
      session: outcome.session,
    };
  }

  const settled = await settleDelegatedDispatch({
    callId: outcome.callId,
    childSessionId: outcome.childSessionId,
    session: outcome.session,
    subagentName: outcome.toolName,
    task,
  });
  // task_send's own result is a tool-result, so the receipt never flows
  // through the handle-settling resolve path; park the continued handle
  // here to keep it addressable for later sends.
  const operationId = deriveAgentOperationId({
    callId: action.callId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.parentTurnId,
  });
  const settledHandle = settleAgentTurn(settled.session, {
    operationId,
    outcome: {
      kind: "parked",
      result: {
        kind: "succeeded",
        output: `Delegated as background task ${task.taskId} (working).`,
      },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    sessionId: outcome.childSessionId,
  });
  return {
    result: {
      callId: action.callId,
      kind: "tool-result",
      output: { status: "working", taskId: task.taskId },
      toolName: action.toolName,
    },
    session: settledHandle.kind === "settled" ? settledHandle.session : settled.session,
  };
}

type TaskSendInput =
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly body:
        | { readonly kind: "message"; readonly message: string }
        | {
            readonly inputResponses: readonly { readonly requestId: string }[];
            readonly kind: "input-responses";
          };
      readonly kind: "send";
      readonly taskId: string;
    };

function readTaskSendInput(input: Record<string, unknown>): TaskSendInput {
  const taskId =
    typeof input.taskId === "string" && input.taskId.trim() !== "" ? input.taskId : undefined;
  if (taskId === undefined) {
    return { kind: "invalid", message: "Provide the `taskId` from a task receipt." };
  }
  const message =
    typeof input.message === "string" && input.message.trim() !== "" ? input.message : undefined;
  const responses = Array.isArray(input.inputResponses)
    ? input.inputResponses.filter(
        (candidate): candidate is { readonly requestId: string } =>
          typeof candidate === "object" &&
          candidate !== null &&
          typeof (candidate as { requestId?: unknown }).requestId === "string",
      )
    : undefined;
  if (message !== undefined && responses !== undefined) {
    return { kind: "invalid", message: "Provide either `message` or `inputResponses`, not both." };
  }
  if (message !== undefined) {
    return { body: { kind: "message", message }, kind: "send", taskId };
  }
  if (responses !== undefined && responses.length > 0) {
    return { body: { inputResponses: responses, kind: "input-responses" }, kind: "send", taskId };
  }
  return { kind: "invalid", message: "Provide either `message` or a non-empty `inputResponses`." };
}
