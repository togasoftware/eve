import type { SessionAuthContext } from "#channel/types.js";
import type { SessionParent, SessionTurn } from "#context/keys.js";
import type { ToolAuthOptions, ToolAuthProvider } from "#public/definitions/tool.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { TokenResult } from "#runtime/connections/types.js";

type ApprovalToolInput<TInput> = TInput extends object ? Readonly<TInput> : TInput;

/**
 * Context passed to an {@link ApprovalPolicy} function.
 *
 * Extends {@link SessionContext} so approval policies can make decisions from
 * the active session, current caller, and turn.
 */
export interface ApprovalContext<TInput = Record<string, unknown>> extends SessionContext {
  readonly approvedTools: ReadonlySet<string>;
  readonly callId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/** Request-time approval decision returned by an {@link ApprovalPolicy}. */
export type ApprovalStatus =
  | undefined
  | boolean
  | "not-applicable"
  | "approved"
  | "denied"
  | "user-approval"
  | { readonly type: "not-applicable"; readonly reason?: never }
  | { readonly type: "approved"; readonly reason?: string }
  | { readonly type: "denied"; readonly reason?: string }
  | { readonly type: "user-approval"; readonly reason?: never };

/** Request-time approval policy shared by authored tools and connections. */
export type ApprovalPolicy<TInput = Record<string, unknown>> = (
  ctx: ApprovalContext<TInput>,
) => ApprovalStatus | Promise<ApprovalStatus>;

/** Stable tool request passed to a response authorizer. */
export interface ApprovalResponseRequest<TInput = Record<string, unknown>> {
  readonly callId: string;
  readonly requestId: string;
  readonly toolInput?: ApprovalToolInput<TInput>;
  readonly toolName: string;
}

/** Read-only session identity and lineage available to a response authorizer. */
export interface ApprovalResponseSession {
  readonly id: string;
  readonly initiator: SessionAuthContext | null;
  readonly parent?: SessionParent;
  readonly turn: SessionTurn;
}

/** Narrow authorization capability available while validating a responder. */
export interface ApprovalResponseAuth {
  getToken(provider: ToolAuthProvider, options?: ToolAuthOptions): Promise<TokenResult>;
  requireAuth(provider: ToolAuthProvider, options?: ToolAuthOptions): never;
}

/** Context passed to a response-time approval authorizer. */
export interface ApprovalResponseContext<TInput = Record<string, unknown>> {
  readonly auth: ApprovalResponseAuth;
  readonly request: ApprovalResponseRequest<TInput>;
  readonly responder: SessionAuthContext;
  readonly session: ApprovalResponseSession;
}

/** Response authorization outcome. Rejection keeps the shared request pending. */
export type ApprovalResponseAuthorization =
  | "allowed"
  | { readonly safeReason: string; readonly status: "rejected" };

/** Authorizes whether the authenticated responder may approve one request. */
export type ApprovalResponseAuthorizer<TInput = Record<string, unknown>> = (
  ctx: ApprovalResponseContext<TInput>,
) => ApprovalResponseAuthorization | Promise<ApprovalResponseAuthorization>;

/** Approval definition with request-time policy and optional responder authorization. */
export interface ApprovalConfiguration<TInput = Record<string, unknown>> {
  readonly authorizeResponse?: ApprovalResponseAuthorizer<TInput>;
  readonly policy: ApprovalPolicy<TInput>;
}

/** Shared approval definition used by authored tools and connections. */
export type Approval<TInput = Record<string, unknown>> =
  | ApprovalPolicy<TInput>
  | ApprovalConfiguration<TInput>;

/** Returns the request-time policy from either approval authoring shape. */
export function resolveApprovalPolicy<TInput>(approval: Approval<TInput>): ApprovalPolicy<TInput> {
  return typeof approval === "function" ? approval : approval.policy;
}
