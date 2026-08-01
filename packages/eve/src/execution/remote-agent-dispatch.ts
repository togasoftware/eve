import { z } from "#compiled/zod/index.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/message.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { createEveCallbackRoutePath, createEveCancelTurnRoutePath } from "#protocol/routes.js";
import type { CancelTurnResult, SessionAuthContext } from "#channel/types.js";
import type { ForwardedPrincipal } from "#channel/forwarded-principal.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  formatSubagentInput,
  normalizeRequestedOutputSchema,
} from "#execution/subagent-invocation.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { RuntimeSubagentRegistry } from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

const CreateSessionResponseSchema = z.object({
  continuationToken: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

type RemoteAgentSessionCoordinates = Readonly<
  Required<z.infer<typeof CreateSessionResponseSchema>>
>;

class RemoteAgentCancelRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { readonly retryable: boolean }) {
    super(message);
    this.name = "RemoteAgentCancelRequestError";
    this.retryable = options.retryable;
  }
}

export async function startRemoteAgentSession(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  /** The dispatching turn's session principal, forwarded when `remote.forwardPrincipal` is set. */
  readonly auth?: SessionAuthContext | null;
  readonly callbackBaseUrl: string | undefined;
  readonly callbackToken?: string;
  /** The root initiator's principal, forwarded alongside {@link auth}. */
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly session: HarnessSession;
}): Promise<RemoteAgentSessionCoordinates> {
  const callbackToken = input.callbackToken ?? input.session.continuationToken;
  if (!callbackToken) {
    throw new Error("Cannot dispatch remote agent without a parent continuation token.");
  }
  if (!input.callbackBaseUrl) {
    throw new Error("Cannot dispatch remote agent without a callback base URL.");
  }

  const forwardedPrincipal = buildForwardedPrincipalField(input);
  const requestBody: {
    capabilities: {};
    callback: {
      callId: string;
      subagentName: string;
      token: string;
      url: string;
    };
    forwardedPrincipal?: ForwardedPrincipal;
    message: string;
    mode: "conversation" | "task";
    outputSchema?: object;
  } = {
    capabilities: {},
    callback: {
      callId: input.action.callId,
      subagentName: input.action.remoteAgentName,
      token: callbackToken,
      url: createWorkflowCallbackUrl(
        input.callbackBaseUrl,
        createEveCallbackRoutePath(callbackToken),
      ),
    },
    message: formatRemoteAgentCallInputMessage({ action: input.action, remote: input.remote }),
    // Remote children run one turn per delivery in task mode; follow-ups
    // arrive as continuations against the child's agent handle.
    mode: "task",
    outputSchema:
      normalizeRequestedOutputSchema(input.action.input.outputSchema) ?? input.remote.outputSchema,
  };
  if (forwardedPrincipal !== undefined) {
    requestBody.forwardedPrincipal = forwardedPrincipal;
  }

  const headers = await resolveRemoteAgentRequestHeaders(input.remote);
  const response = await fetch(createRemoteAgentSessionUrl(input.remote), {
    body: JSON.stringify(requestBody),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session request failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session response was not valid JSON.`,
    );
  }

  const parsed = CreateSessionResponseSchema.safeParse(body);
  const sessionIdFromHeader = response.headers.get(EVE_SESSION_ID_HEADER);
  const sessionId =
    sessionIdFromHeader !== null && sessionIdFromHeader.length > 0
      ? sessionIdFromHeader
      : parsed.success
        ? parsed.data.sessionId
        : undefined;

  if (!parsed.success || sessionId === undefined) {
    const missing = parsed.success ? "a sessionId" : "a continuationToken";
    throw new Error(
      `Remote agent "${input.action.remoteAgentName}" create-session response did not include ${missing}. ` +
        "Older eve deployments return only a sessionId; the remote agent may need upgrading.",
    );
  }

  return { continuationToken: parsed.data.continuationToken, sessionId };
}

function buildForwardedPrincipalField(input: {
  readonly auth?: SessionAuthContext | null;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): ForwardedPrincipal | undefined {
  if (input.remote.forwardPrincipal !== true) {
    return undefined;
  }
  // No current principal (the request was accepted with no credentials):
  // proceed on transport trust alone.
  if (input.auth === null || input.auth === undefined) {
    return undefined;
  }
  const field: { current: SessionAuthContext; initiator?: SessionAuthContext } = {
    current: input.auth,
  };
  if (input.initiatorAuth !== null && input.initiatorAuth !== undefined) {
    field.initiator = input.initiatorAuth;
  }
  return field;
}

export async function cancelRemoteAgentTurn(input: {
  readonly remote: ResolvedRuntimeRemoteAgentNode;
  readonly sessionId: string;
}): Promise<CancelTurnResult> {
  const headers = await resolveRemoteAgentRequestHeaders(input.remote);
  const response = await fetch(createRemoteAgentCancelTurnUrl(input.remote, input.sessionId), {
    headers,
    method: "POST",
  });

  if (!response.ok) {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn request failed with HTTP ${response.status}.`,
      { retryable: isRetryableRemoteCancelStatus(response.status) },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn response was not valid JSON.`,
      { retryable: false },
    );
  }

  const result = CancelTurnResponseSchema.safeParse(body);
  if (!result.success || result.data.sessionId !== input.sessionId) {
    throw new RemoteAgentCancelRequestError(
      `Remote agent "${input.remote.name}" cancel-turn response was invalid.`,
      { retryable: false },
    );
  }

  return { status: result.data.status };
}

export function isRetryableRemoteAgentCancelError(error: unknown): boolean {
  return !(error instanceof RemoteAgentCancelRequestError) || error.retryable;
}

export function resolveRemoteAgentForAction(input: {
  readonly nodeId: string;
  readonly registry: RuntimeSubagentRegistry["subagentsByNodeId"];
  readonly remoteAgentName: string;
}): ResolvedRuntimeRemoteAgentNode {
  const registered = input.registry.get(input.nodeId);
  const definition = registered?.definition;
  if (definition?.kind !== "remote") {
    throw new Error(`Missing remote agent "${input.remoteAgentName}" in runtime registry.`);
  }
  return definition;
}

function createRemoteAgentSessionUrl(remote: ResolvedRuntimeRemoteAgentNode): string {
  return createRemoteAgentRouteUrl(remote.url, remote.path);
}

function createRemoteAgentCancelTurnUrl(
  remote: ResolvedRuntimeRemoteAgentNode,
  sessionId: string,
): string {
  return createRemoteAgentRouteUrl(remote.url, createEveCancelTurnRoutePath(sessionId));
}

function createRemoteAgentRouteUrl(baseUrl: string, routePath: string): string {
  return new URL(routePath.replace(/^\/+/, ""), `${trimTrailingSlash(baseUrl)}/`).toString();
}

function isRetryableRemoteCancelStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function resolveRemoteAgentRequestHeaders(
  remote: ResolvedRuntimeRemoteAgentNode,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (remote.headers !== undefined) {
    Object.assign(
      headers,
      typeof remote.headers === "function" ? await remote.headers() : remote.headers,
    );
  }
  if (remote.auth !== undefined) {
    Object.assign(headers, (await remote.auth()).headers);
  }
  return headers;
}

function formatRemoteAgentCallInputMessage(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly remote: ResolvedRuntimeRemoteAgentNode;
}): string {
  const message = typeof input.action.input.message === "string" ? input.action.input.message : "";
  return formatSubagentInput({
    description: input.remote.description,
    message,
    name: input.action.remoteAgentName,
    type: "remote",
  }).message;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
