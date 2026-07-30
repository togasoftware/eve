import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { EveAgentStore } from "#client/eve-agent-store.js";
import { MessageResponse } from "#client/message-response.js";
import type { EveAgentReducer } from "#client/reducer.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnStartedEvent,
  EVE_SESSION_ID_HEADER,
  type UnstampedMessageStreamEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";

function turnEvents(): MessageStreamEvent[] {
  return stampTestEvents([
    createMessageReceivedEvent({ message: "Hello", sequence: 0, turnId: "turn_1" }),
    createMessageCompletedEvent({
      finishReason: "stop",
      message: "Hi there.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    }),
    createSessionWaitingEvent("http:session_1"),
  ] as UnstampedMessageStreamEvent[]);
}

function startedResponse(): Response {
  return new Response(
    JSON.stringify({ continuationToken: "http:session_1", ok: true, sessionId: "session_1" }),
    {
      headers: { "content-type": "application/json", [EVE_SESSION_ID_HEADER]: "session_1" },
      status: 202,
    },
  );
}

function streamResponse(events: readonly MessageStreamEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
  );
}

function preV20MessageCompletedEvent(): MessageStreamEvent {
  return {
    ...createMessageCompletedEvent({
      finishReason: "stop",
      message: "Legacy response.",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_legacy",
    }),
    meta: { at: "2026-07-27T18:04:11.912Z" },
  } as MessageStreamEvent;
}

const eventCountReducer: EveAgentReducer<number> = {
  initial: () => 0,
  reduce: (count) => count + 1,
};

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createStoreHarness() {
  const turnStarted = createDeferred();
  const turnSettled = createDeferred();
  const events = stampTestEvents([
    createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
    createTurnCancelledEvent({ sequence: 1, turnId: "turn_1" }),
    createSessionWaitingEvent("eve:test"),
  ] as UnstampedMessageStreamEvent[]);
  const session = new Client({ host: "" }).session({
    continuationToken: "eve:test",
    sessionId: "session_test",
    streamIndex: 0,
  });
  const cancel = vi.spyOn(session, "cancel");
  const send = vi.spyOn(session, "send").mockResolvedValue(
    new MessageResponse({
      continuationToken: "eve:test",
      createStream: async function* () {
        await turnStarted.promise;
        yield events[0]!;
        await turnSettled.promise;
        yield events[1]!;
        yield events[2]!;
      },
      sessionId: "session_test",
    }),
  );
  const store = new EveAgentStore({
    optimistic: false,
    reducer: eventCountReducer,
    session,
  });

  return { cancel, send, store, turnSettled, turnStarted };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EveAgentStore stream overlap", () => {
  it("folds an initialEvents prefix that the live stream re-delivers in once", async () => {
    const events = turnEvents();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      // The server-rendered prefix is replayed ahead of the live tail.
      .mockResolvedValueOnce(streamResponse(events));

    const store = new EveAgentStore({
      initialEvents: events.slice(0, 2),
      reducer: defaultMessageReducer(),
    });

    const seen: MessageStreamEvent[] = [];
    store.setCallbacks({ onEvent: (event) => seen.push(event) });

    await store.send({ message: "Hello" });

    // Only the events the prefix did not already carry reach subscribers.
    expect(seen.map((event) => event.meta.id)).toEqual([events[2]?.meta.id]);
    expect(store.snapshot.events.map((event) => event.meta.id)).toEqual(
      events.map((event) => event.meta.id),
    );

    const assistant = store.snapshot.data.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.parts).toEqual([
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Hi there.", type: "text" },
    ]);
  });

  it("applies a pre-v20 event whose envelope has no id", async () => {
    const legacy = preV20MessageCompletedEvent();
    const boundary = stampTestEvents([createSessionWaitingEvent("http:session_1")])[0]!;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse([legacy, boundary]));

    const store = new EveAgentStore({ reducer: defaultMessageReducer() });
    const seen: MessageStreamEvent[] = [];
    store.setCallbacks({ onEvent: (event) => seen.push(event) });

    await store.send({ message: "Hello" });

    expect(seen).toEqual([legacy, boundary]);
    expect(store.snapshot.events).toEqual([legacy, boundary]);
    const assistant = store.snapshot.data.messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([
      { type: "step-start" },
      { state: "done", stepIndex: 0, text: "Legacy response.", type: "text" },
    ]);
  });

  it("re-admits events after reset clears the window", async () => {
    const events = turnEvents();
    const store = new EveAgentStore({
      initialEvents: events,
      reducer: defaultMessageReducer(),
    });
    expect(store.snapshot.events).toHaveLength(3);

    store.reset();
    expect(store.snapshot.events).toHaveLength(0);

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(startedResponse())
      .mockResolvedValueOnce(streamResponse(events));

    await store.send({ message: "Hello" });

    // A fresh session must not have the retired ids held against it.
    expect(store.snapshot.events.map((event) => event.meta.id)).toEqual(
      events.map((event) => event.meta.id),
    );
  });
});

describe("EveAgentStore", () => {
  it("queues Stop, retries admission, and keeps cancellation failures out of turn state", async () => {
    vi.useFakeTimers();
    const { cancel, store, turnSettled, turnStarted } = createStoreHarness();
    cancel.mockRejectedValueOnce(new Error("Cancel transport failed")).mockResolvedValueOnce({
      sessionId: "session_test",
      status: "accepted",
    });
    const onError = vi.fn();
    store.setCallbacks({ onError });

    const send = store.send({ message: "Hello" });
    store.stop();
    expect(cancel).not.toHaveBeenCalled();

    turnStarted.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenLastCalledWith({ turnId: "turn_1" });
    expect(store.snapshot.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(cancel).toHaveBeenCalledTimes(2);

    store.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(2);

    turnSettled.resolve();
    await send;
    expect(store.snapshot.error).toBeUndefined();
    expect(store.snapshot.status).toBe("ready");
  });

  it("detaches local transport without cancelling server work and remains reusable", async () => {
    const { cancel, send, store, turnSettled, turnStarted } = createStoreHarness();
    const sending = store.send({ message: "Hello" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const input = send.mock.calls[0]?.[0];
    if (input === undefined || typeof input === "string") {
      throw new Error("Expected an object send payload.");
    }

    store.detach();

    expect(input.signal?.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    turnStarted.resolve();
    turnSettled.resolve();
    await sending;

    await store.send({ message: "Hello again" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
