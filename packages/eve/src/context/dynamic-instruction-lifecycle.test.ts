import { describe, expect, it, vi } from "vitest";

import { defineInstructions } from "#public/definitions/instructions.js";

vi.mock("#context/build-callback-context.js", () => ({
  buildCallbackContext: () => ({
    session: { id: "test", auth: { current: null, initiator: null }, turn: {} },
  }),
}));

const {
  buildDynamicInstructionMessages,
  dispatchDynamicInstructionEvent,
  drainDynamicInstructionUserMessages,
  prepareDynamicInstructionPreamble,
} = await import("#context/dynamic-instruction-lifecycle.js");

import { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  LiveStepDynamicInstructionsKey,
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
  SessionIdKey,
} from "#context/keys.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { DynamicResolveContext } from "#shared/dynamic-tool-definition.js";

function createResolver(
  slug: string,
  eventNames: readonly string[],
  handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>,
): ResolvedDynamicInstructionsResolver {
  const events: Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>> = {};
  for (const name of eventNames) {
    events[name] = handler;
  }
  return {
    slug,
    eventNames,
    events,
    sourceId: `test:${slug}`,
    sourceKind: "module",
    logicalPath: `agent/instructions/${slug}.ts`,
  };
}

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "test-session");
  return ctx;
}

function makeEvent(type: string): UnstampedMessageStreamEvent {
  return { type, data: {} } as UnstampedMessageStreamEvent;
}

describe("dispatchDynamicInstructionEvent", () => {
  it("stores session-scoped instructions on durable key", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () =>
      defineInstructions({ markdown: "You are a helpful assistant." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(ctx.get(SessionDynamicInstructionsKey)).toEqual({
      context: [{ role: "system", content: "You are a helpful assistant." }],
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "You are a helpful assistant." },
    ]);
  });

  it("stores turn-scoped instructions on turn durable key", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["turn.started"], () =>
      defineInstructions({ markdown: "Turn context." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(ctx.get(TurnDynamicInstructionsKey)).toEqual({
      context: [{ role: "system", content: "Turn context." }],
    });
  });

  it("queues user-role instructions for durable history instead of system context", async () => {
    const ctx = createCtx();
    prepareDynamicInstructionPreamble(ctx, [{ content: "Static user context.", role: "user" }]);
    const resolver = createResolver("context", ["session.started"], () =>
      defineInstructions({ content: "Dynamic user context.", role: "user" }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([
      { role: "user", content: "Dynamic user context." },
    ]);
    expect([...ctx.entries()].map(([key]) => key.name)).not.toContain(
      "eve.pendingDynamicInstructionUserMessages",
    );
  });

  it("exposes static and session-start user history to the correct lifecycle snapshots", async () => {
    const ctx = createCtx();
    const snapshots: string[][] = [];
    prepareDynamicInstructionPreamble(ctx, [{ content: "Static user.", role: "user" }]);
    const sessionResolver = createResolver("session", ["session.started"], (_event, rawCtx) => {
      const resolveCtx = rawCtx as DynamicResolveContext;
      snapshots.push(resolveCtx.messages.map((message) => String(message.content)));
      return defineInstructions({ content: "Session user.", role: "user" });
    });
    const turnResolver = createResolver("turn", ["turn.started"], (_event, rawCtx) => {
      const resolveCtx = rawCtx as DynamicResolveContext;
      snapshots.push(resolveCtx.messages.map((message) => String(message.content)));
      return defineInstructions({ content: "Turn user.", role: "user" });
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [sessionResolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [turnResolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(snapshots).toEqual([["Static user."], ["Static user.", "Session user."]]);
    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([
      { content: "Session user.", role: "user" },
      { content: "Turn user.", role: "user" },
    ]);
  });

  it("skips resolvers that do not match the event type", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "nope" }));
    const resolver = createResolver("context", ["session.started"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips null returns without error", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () => null);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("logs and skips unbranded return values", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () => ({
      markdown: "not branded",
    }));

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("logs and skips throwing resolvers", async () => {
    const ctx = createCtx();
    const resolver = createResolver("broken", ["session.started"], () => {
      throw new Error("resolver exploded");
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("unions messages from different resolver slugs", async () => {
    const ctx = createCtx();
    const r1 = createResolver("a", ["turn.started"], () =>
      defineInstructions({ markdown: "From A." }),
    );
    const r2 = createResolver("b", ["turn.started"], () =>
      defineInstructions({ markdown: "From B." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [r1, r2],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "From A." },
      { role: "system", content: "From B." },
    ]);
  });

  it("replaces messages from the same resolver slug on re-dispatch", async () => {
    const ctx = createCtx();
    let version = "v1";
    const resolver = createResolver("context", ["turn.started"], () =>
      defineInstructions({ markdown: version }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([{ role: "system", content: "v1" }]);

    version = "v2";
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([{ role: "system", content: "v2" }]);
  });

  it("clears stale turn system instructions on role changes and resolver failures", async () => {
    const ctx = createCtx();
    let result: "system" | "user" | "throw" = "system";
    const resolver = createResolver("context", ["turn.started"], () => {
      if (result === "throw") throw new Error("failed");
      return defineInstructions({
        content: `${result} context`,
        role: result,
      });
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { content: "system context", role: "system" },
    ]);

    prepareDynamicInstructionPreamble(ctx, []);
    result = "user";
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([
      { content: "user context", role: "user" },
    ]);

    result = "throw";
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("keeps valid session system instructions when refresh resolution fails", async () => {
    const ctx = createCtx();
    let throws = false;
    const resolver = createResolver("context", ["session.started"], () => {
      if (throws) throw new Error("failed");
      return defineInstructions({ content: "Durable session context." });
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    throws = true;
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { content: "Durable session context.", role: "system" },
    ]);
  });

  it("materializes no message for blank user content", async () => {
    const ctx = createCtx();
    prepareDynamicInstructionPreamble(ctx, []);
    const resolver = createResolver("context", ["turn.started"], () =>
      defineInstructions({ content: "  \n", role: "user" }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(drainDynamicInstructionUserMessages(ctx)).toEqual([]);
    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("null return clears the resolver's slot", async () => {
    const ctx = createCtx();
    let enabled = true;
    const resolver = createResolver("context", ["turn.started"], () =>
      enabled ? defineInstructions({ markdown: "Instructions." }) : null,
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toHaveLength(1);

    enabled = false;
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
    expect(ctx.get(TurnDynamicInstructionsKey)).toEqual({});
  });

  it("session instructions survive step boundary (durable)", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started"], () =>
      defineInstructions({ markdown: "Session context." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    // Simulate step boundary: clear virtual context.
    ctx.clearVirtualContext();

    // Durable key survives — buildDynamicInstructionMessages reads from durable.
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session context." },
    ]);
  });

  it("session + turn instructions are ordered session first", async () => {
    const ctx = createCtx();
    const sessionResolver = createResolver("session-ctx", ["session.started"], () =>
      defineInstructions({ markdown: "Session." }),
    );
    const turnResolver = createResolver("turn-ctx", ["turn.started"], () =>
      defineInstructions({ markdown: "Turn." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [sessionResolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [turnResolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session." },
      { role: "system", content: "Turn." },
    ]);
  });

  it("preserves existing session + turn composition for the same resolver", async () => {
    const ctx = createCtx();
    const resolver = createResolver("context", ["session.started", "turn.started"], (event) =>
      defineInstructions({
        markdown:
          (event as UnstampedMessageStreamEvent).type === "session.started" ? "Session." : "Turn.",
      }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("turn.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session." },
      { role: "system", content: "Turn." },
    ]);
  });

  it("stores step-scoped instructions in virtual context", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "Step context." }));
    const resolver = createResolver("context", ["step.started"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(ctx.get(LiveStepDynamicInstructionsKey)).toEqual({
      context: [{ role: "system", content: "Step context." }],
    });
    expect([...ctx.entries()].map(([key]) => key.name)).not.toContain(
      "eve.liveStepDynamicInstructions",
    );
  });

  it("step instructions replace the same resolver's wider-scope value", async () => {
    const ctx = createCtx();
    ctx.set(SessionDynamicInstructionsKey, {
      context: [{ role: "system", content: "Session context." }],
      sessionOnly: [{ role: "system", content: "Session only." }],
    });
    ctx.set(TurnDynamicInstructionsKey, {
      context: [{ role: "system", content: "Turn context." }],
      turnOnly: [{ role: "system", content: "Turn only." }],
    });
    const resolver = createResolver("context", ["step.started"], () =>
      defineInstructions({ markdown: "Step context." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Session only." },
      { role: "system", content: "Turn only." },
      { role: "system", content: "Step context." },
    ]);
  });

  it("null step result omits the same resolver's wider-scope value", async () => {
    const ctx = createCtx();
    ctx.set(TurnDynamicInstructionsKey, {
      context: [{ role: "system", content: "Turn context." }],
    });
    const resolver = createResolver("context", ["step.started"], () => null);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(ctx.get(LiveStepDynamicInstructionsKey)).toEqual({ context: null });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([]);
  });

  it("step resolver failures retain the wider-scope value", async () => {
    const ctx = createCtx();
    ctx.set(TurnDynamicInstructionsKey, {
      context: [{ role: "system", content: "Turn context." }],
    });
    const resolver = createResolver("context", ["step.started"], () => {
      throw new Error("resolver exploded");
    });

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Turn context." },
    ]);
  });

  it("clears step instructions with virtual context", async () => {
    const ctx = createCtx();
    ctx.set(TurnDynamicInstructionsKey, {
      context: [{ role: "system", content: "Turn context." }],
    });
    ctx.setVirtualContext(LiveStepDynamicInstructionsKey, {
      context: [{ role: "system", content: "Step context." }],
    });

    ctx.clearVirtualContext();

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "Turn context." },
    ]);
  });

  it("does not restore a stale step layer during workflow replay", async () => {
    const ctx = createCtx();
    ctx.set(TurnDynamicInstructionsKey, {
      flow: [{ role: "system", content: "durable source procedure" }],
    });
    ctx.setVirtualContext(LiveStepDynamicInstructionsKey, {
      flow: [{ role: "system", content: "stale step procedure" }],
    });

    const replayed = await deserializeContext(serializeContext(ctx));

    expect(buildDynamicInstructionMessages(replayed)).toEqual([
      { role: "system", content: "durable source procedure" },
    ]);
    expect(replayed.get(LiveStepDynamicInstructionsKey)).toBeUndefined();
  });

  it("re-resolves the step layer without leaking the previous step", async () => {
    const ctx = createCtx();
    let flow = "source";
    const resolver = createResolver("flow", ["step.started"], () =>
      defineInstructions({ markdown: `${flow} procedure` }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });
    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "source procedure" },
    ]);

    ctx.clearVirtualContext();
    flow = "destination";
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("step.started"),
    });

    expect(buildDynamicInstructionMessages(ctx)).toEqual([
      { role: "system", content: "destination procedure" },
    ]);
  });

  it("ignores events outside the allowed set", async () => {
    const ctx = createCtx();
    const handler = vi.fn(() => defineInstructions({ markdown: "nope" }));
    const resolver = createResolver("context", ["message.completed"], handler);

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("message.completed"),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("stores durable messages that survive serialization", async () => {
    const ctx = createCtx();
    const resolver = createResolver("ctx", ["session.started"], () =>
      defineInstructions({ markdown: "Durable." }),
    );

    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: [resolver],
      messages: [],
      event: makeEvent("session.started"),
    });

    const serializedKeys = [...ctx.entries()].map(([key]) => key.name);
    expect(serializedKeys).toContain("eve.sessionDynamicInstructions");
  });
});
