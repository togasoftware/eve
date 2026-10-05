---
issue: TBD
status: implemented
last_updated: "2026-10-05"
---

# Runtime-authored tool messages

## Summary

Some trusted tool results already contain the complete assistant message that
must be delivered before the conversation waits for another user message.
Sending that result through another model call adds latency and lets the model
alter the text or expose model-facing control data.

`defineTool` adds one narrow projection:

```ts
toAssistantMessage(output) {
  return output.waitForCustomer ? output.question : null;
}
```

A non-empty string tells eve to append a real assistant message to durable
history, emit `message.completed`, complete the current
turn, and park for the next user message. `null` or `undefined` keeps the normal
model continuation. The projection runs only for successful authored tool
results in conversation mode without a structured output contract.

The operation is declarative rather than an imperative event writer. eve keeps
ownership of tool-result ordering, model history, stream events, turn
completion, and durable replay. Dynamic tools persist the projection through
the same durable callback mechanism as `execute` and `toModelOutput`.

Only one tool result may provide a runtime-authored message in a model step.
Multiple messages or an empty value fail instead of selecting an arbitrary
customer-visible reply. Task mode, provider-executed tools, failed tool results,
and structured-output turns retain their existing behavior.

## Observable lifecycle

```text
assistant tool call
  -> action.result
  -> step.completed (tool-calls)
  -> message.completed (stop)
  -> turn.completed
  -> session.waiting
```

No second model step is created. The next model call sees the original
assistant tool call, its tool result, the runtime-authored assistant message,
and the next user message in canonical order.
