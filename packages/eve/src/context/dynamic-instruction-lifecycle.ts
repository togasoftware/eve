import type { ModelMessage, SystemModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  isBrandedInstructionsEntry,
} from "#shared/dynamic-tool-definition.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  LiveStepDynamicInstructionsKey,
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-instructions");

type SlugMessageMap = Record<string, readonly SystemModelMessage[]>;

function lowerToSystemMessage(definition: InstructionsDefinition): SystemModelMessage | undefined {
  const trimmed = definition.markdown.trim();
  if (trimmed.length === 0) return undefined;
  return { role: "system", content: trimmed };
}

function durableKeyForEvent(eventType: string): ContextKey<SlugMessageMap> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicInstructionsKey;
    case "turn.started":
      return TurnDynamicInstructionsKey;
    default:
      return undefined;
  }
}

/**
 * Builds the flattened system messages from session, turn, and step keys.
 * A step entry shadows the same resolver's durable session and turn entries
 * for one model call. Existing session + turn composition remains additive.
 * Entries retain scope order: session first, then turn, then step.
 */
export function buildDynamicInstructionMessages(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): SystemModelMessage[] {
  const session = ctx.get(SessionDynamicInstructionsKey) ?? {};
  const turn = ctx.get(TurnDynamicInstructionsKey) ?? {};
  const step = ctx.get(LiveStepDynamicInstructionsKey) ?? {};
  const stepSlugs = new Set(Object.keys(step));

  return [
    ...Object.entries(session)
      .filter(([slug]) => !stepSlugs.has(slug))
      .flatMap(([, messages]) => messages),
    ...Object.entries(turn)
      .filter(([slug]) => !stepSlugs.has(slug))
      .flatMap(([, messages]) => messages),
    ...Object.values(step).flatMap((messages) => messages ?? []),
  ];
}

/**
 * Dispatches a stream event to dynamic instruction resolvers.
 *
 * Each resolver's output replaces its own slot (keyed by slug) in the
 * scope-appropriate key. Session and turn values are durable; step values
 * are virtual and shadow the same resolver's wider-scope value for one model
 * call. The tool-loop calls
 * {@link buildDynamicInstructionMessages} to assemble the flattened
 * result for the model call.
 */
export async function dispatchDynamicInstructionEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicInstructionsResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, message: undefined };

      if (!isBrandedInstructionsEntry(rawResult)) {
        log.error(
          `Dynamic instructions resolver "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
        );
        return null;
      }

      return { resolver, message: lowerToSystemMessage(rawResult as InstructionsDefinition) };
    }),
  );

  const resolved = new Map<string, readonly SystemModelMessage[] | null>();

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic instructions resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    const { resolver, message } = outcome.value;
    if (message !== undefined) {
      resolved.set(resolver.slug, [message]);
    } else {
      resolved.set(resolver.slug, null);
    }
  }

  if (event.type === "step.started") {
    ctx.setVirtualContext(LiveStepDynamicInstructionsKey, Object.fromEntries(resolved));
    return;
  }

  const durableKey = durableKeyForEvent(event.type);
  if (durableKey === undefined) return;
  const durable = { ...ctx.get(durableKey) };
  for (const [slug, messagesForResolver] of resolved) {
    if (messagesForResolver !== null) {
      durable[slug] = messagesForResolver;
    } else {
      delete durable[slug];
    }
  }

  ctx.set(durableKey, durable);
}
