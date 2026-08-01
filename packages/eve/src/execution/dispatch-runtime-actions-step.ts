/**
 * Starts or continues every pending runtime action for the parked parent
 * session.
 *
 * The batch is classified into a dispatch plan first (reject / resume /
 * start), then each entry dispatches and emits one
 * parent `subagent.called` control-plane event through a single tail.
 * Every start commits an agent handle (`starting`) before its side effect
 * and confirms it (`running`) once the child reports coordinates, so the
 * returned snapshot-bearing state owns every child it may have created.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  dispatchToAgentHandle,
  isAgentHandleAction,
  type DispatchOutcome,
  type RuntimeAgentHandleAction,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
  RuntimeToolCallActionRequest,
} from "#runtime/actions/types.js";
import {
  beginDelegatedTask,
  executeTaskControlAction,
  failDelegatedDispatch,
  isTaskControlAction,
  settleDelegatedDispatch,
} from "#execution/tasks/dispatch.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import type { SubagentInputSource } from "#execution/subagent-tool.js";
import { startSubagent, type DispatchStartTarget } from "#execution/subagent-start.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { readSessionTraceContext } from "#tracing/agent-trace-context-store.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";

const log = createLogger("execution.dispatch-runtime-actions");

type DispatchPlanEntry =
  | {
      readonly kind: "resume";
      readonly action: RuntimeAgentHandleAction;
      readonly agentId: string;
    }
  | { readonly kind: "reject"; readonly result: RuntimeSubagentDispatchFailure }
  | { readonly kind: "start"; readonly target: DispatchStartTarget }
  | { readonly kind: "task-control"; readonly action: RuntimeToolCallActionRequest };

export async function dispatchRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);

  if (batch === undefined || batch.actions.length === 0) {
    return { results: [], sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;

  const adapterCtx = buildAdapterContext(adapter, ctx);
  // Read here, not in the child: trace state is scoped to one session's
  // context, so this is the last place the parent's window is visible.
  const parentTraceContext = readSessionTraceContext(input.serializedContext, session.sessionId);
  const tasksEnabled = bundle.resolvedAgent.config.experimental?.tasks === true;
  // Background tasks require resumable children: the flag implies
  // conversation-mode dispatch so `experimental.tasks` and
  // `experimental.subagentPersistentSessions` never produce a third mode.
  const persistentSessions =
    tasksEnabled || bundle.resolvedAgent.config.experimental?.subagentPersistentSessions === true;
  // A corrupt handle store throws; surface that before anything dispatches.
  // A mid-loop throw after a sibling started would durably replay the whole
  // batch and re-dispatch that sibling.
  getAgentHandleStore(durableSession.state);
  const plan = planDispatch({ actions: batch.actions, bundle, session });
  // Acquired only once preflight can no longer throw, so a planning failure
  // never leaks the writer lock.
  const writer = input.parentWritable.getWriter();
  // Split the parent's remaining token quota across the batch's freshly
  // started local subagents, the children that actually receive an enforced
  // cap. Continuations already run under their own budget, and remote agents
  // run on their own deployment under their own limits, so neither dilutes
  // the local shares.
  const fanoutSize = plan.filter(
    (entry) => entry.kind === "start" && entry.target.kind === "local",
  ).length;

  let nextSession = session;
  const results: RuntimeActionResult[] = [];

  try {
    for (const entry of plan) {
      if (entry.kind === "reject") {
        results.push(entry.result);
        continue;
      }

      if (entry.kind === "task-control") {
        const control = await executeTaskControlAction({
          action: entry.action,
          bundle,
          parentContinuationToken: input.parentContinuationToken,
          parentTurnId: batch.event.turnId,
          session: nextSession,
        });
        nextSession = control.session;
        if (control.result !== undefined) {
          results.push(control.result);
        }
        continue;
      }

      // Delegated execution: the durable task record exists before the
      // child dispatch side effect, and the child's reply address is the
      // task run's private hook instead of the parent turn's inbox.
      const delegated = tasksEnabled
        ? await beginDelegatedTask({
            ...describeDelegatedEntry(entry),
            parentSessionId: session.sessionId,
            parentTurnId: batch.event.turnId,
            session: nextSession,
          })
        : undefined;
      const delegatedParentToken = delegated?.commandToken;

      let outcome: DispatchOutcome;
      switch (entry.kind) {
        case "resume":
          outcome = await dispatchToAgentHandle({
            action: entry.action,
            agentId: entry.agentId,
            bundle,
            currentSession: nextSession,
            parentToken:
              delegatedParentToken ?? input.parentContinuationToken ?? session.continuationToken,
            parentTurnId: batch.event.turnId,
          });
          break;
        case "start":
          outcome = await startSubagent({
            auth,
            batchEvent: batch.event,
            bundle,
            callbackBaseUrl: input.callbackBaseUrl,
            capabilities,
            channelMetadata,
            currentSession: nextSession,
            fanoutSize,
            initiatorAuth,
            parentContinuationToken: delegatedParentToken ?? input.parentContinuationToken,
            parentTraceContext,
            persistentSessions,
            session,
            target: entry.target,
          });
          break;
      }

      nextSession = outcome.session;
      if (outcome.kind === "error") {
        if (delegated !== undefined) {
          await failDelegatedDispatch({ error: outcome.result.output, task: delegated });
        }
        results.push(outcome.result);
        continue;
      }

      if (delegated !== undefined) {
        const settled = await settleDelegatedDispatch({
          callId: outcome.callId,
          childSessionId: outcome.childSessionId,
          session: nextSession,
          subagentName: outcome.toolName,
          task: delegated,
        });
        nextSession = settled.session;
        results.push(settled.receipt);
      }

      // Emission is observability, not control flow: a failure here must not
      // escape the loop, because a durable-step retry would re-dispatch the
      // children that already started.
      try {
        const parentEvent = await callAdapterEventHandler(
          adapter,
          createSubagentCalledEvent({
            callId: outcome.callId,
            childSessionId: outcome.childSessionId,
            name: outcome.name,
            remote: outcome.remote,
            sequence: batch.event.sequence,
            sessionId: session.sessionId,
            toolName: outcome.toolName,
            turnId: batch.event.turnId,
            workflowId: workflowEntryReference.workflowId,
          }),
          adapterCtx,
        );
        await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(parentEvent)));
      } catch (error) {
        logError(log, "subagent.called emission failed", error, {
          callId: outcome.callId,
          childSessionId: outcome.childSessionId,
          toolName: outcome.toolName,
        });
      }
    }
  } finally {
    writer.releaseLock();
  }

  const nextState =
    nextSession === session
      ? input.sessionState
      : createDurableSessionState({ session: nextSession });

  return {
    results,
    sessionState: nextState,
  };
}

/**
 * Classifies every batch action before anything dispatches, so invalid
 * batches fail without starting children and rejections never interleave
 * with dispatch work.
 *
 * This is the single place that decides fresh start vs. continuation:
 * an omitted, null, empty, or whitespace-only agentId is a fresh start
 * (strict tool-calling providers force every schema property to be present,
 * so models emit `""`/`null` when they mean "no continuation"), and an
 * agentId that matches no stored handle also falls back to a fresh start —
 * models sometimes pass a hallucinated or stale id, and hard-failing made
 * them conclude the subagent itself was unavailable. Only an id that
 * resolves to a stored handle becomes a resume.
 */
function planDispatch(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly bundle: CompiledBundle;
  readonly session: RuntimeSession;
}): DispatchPlanEntry[] {
  const handles = getAgentHandleStore(input.session.state)?.handles ?? [];

  return input.actions.map((action): DispatchPlanEntry => {
    if (isTaskControlAction(action)) {
      return { action, kind: "task-control" };
    }

    const rawAgentId = action.input.agentId;
    const agentId =
      typeof rawAgentId === "string" && rawAgentId.trim() !== "" ? rawAgentId : undefined;
    if (agentId !== undefined && isAgentHandleAction(action)) {
      // Resume classification runs before the recursion guard: an agentId
      // continuation resumes an already-adopted child rather than starting
      // a new one. Unknown ids go through classifyFreshStart below, which
      // re-applies the guard the resume path bypasses.
      if (handles.some((handle) => handle.identity.id === agentId)) {
        return { action, agentId, kind: "resume" };
      }
      log.warn("unknown agentId on subagent call; starting a new agent", {
        agentId,
        callId: action.callId,
      });
    }

    return classifyFreshStart({ action, bundle: input.bundle, session: input.session });
  });
}

/**
 * Classifies one action for fresh dispatch: rejected by the recursion guard,
 * or started against a local/remote target. Shared by plain starts and the
 * unknown-agentId fallback, so both paths enforce the same guard.
 */
function classifyFreshStart(input: {
  readonly action: RuntimeActionRequest;
  readonly bundle: CompiledBundle;
  readonly session: RuntimeSession;
}): Extract<DispatchPlanEntry, { kind: "reject" | "start" }> {
  const { action } = input;
  const registry = input.bundle.subagentRegistry.subagentsByNodeId;
  const subagentDepth = resolveSubagentDepth(input.session);
  const rootOnly = input.session.rootSessionId !== undefined || subagentDepth.currentDepth > 0;

  if (isRecursiveAgentAction(action, registry) && rootOnly) {
    log.warn("recursive agent call blocked outside the root session", {
      callId: action.callId,
      currentDepth: subagentDepth.currentDepth,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return { kind: "reject", result: createRecursiveAgentRootOnlyResult(action) };
  }

  switch (action.kind) {
    case "subagent-call": {
      const registered = registry.get(action.nodeId);
      const source: SubagentInputSource =
        registered?.definition.kind === "subagent"
          ? { description: registered.definition.description, type: "local" }
          : { type: "runtime" };
      return { kind: "start", target: { action, kind: "local", source } };
    }
    case "remote-agent-call":
      return { kind: "start", target: { action, kind: "remote" } };
    default:
      throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
  }
}

/** Names one delegated dispatch for its task record, before any child exists. */
function describeDelegatedEntry(entry: Extract<DispatchPlanEntry, { kind: "resume" | "start" }>): {
  readonly callId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
} {
  const action = entry.kind === "resume" ? entry.action : entry.target.action;
  return action.kind === "remote-agent-call"
    ? { callId: action.callId, mode: "remote", name: action.remoteAgentName }
    : { callId: action.callId, mode: "local", name: action.subagentName };
}

function createRecursiveAgentRootOnlyResult(
  action: RuntimeSubagentCallActionRequest,
): RuntimeSubagentDispatchFailure {
  return {
    callId: action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "RECURSIVE_AGENT_ROOT_ONLY",
      message: 'The built-in "agent" tool is only available to the root session.',
    },
    subagentName: action.subagentName,
  };
}

function isRecursiveAgentAction(
  action: RuntimeActionRequest,
  subagentsByNodeId: ReadonlyMap<string, unknown>,
): action is RuntimeSubagentCallActionRequest {
  return (
    action.kind === "subagent-call" &&
    action.subagentName === "agent" &&
    !subagentsByNodeId.has(action.nodeId)
  );
}
