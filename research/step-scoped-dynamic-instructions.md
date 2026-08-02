---
issue: https://github.com/vercel/eve/issues/1541
status: proposed
last_updated: "2026-08-02"
---

# Step-scoped dynamic instructions

This plan is attached to [vercel/eve#1541](https://github.com/vercel/eve/issues/1541). The semantics below are proposed pending maintainer agreement.

## Problem

A tool can commit workflow state that changes which procedure should govern the next model continuation in the same turn. Dynamic instructions currently resolve only at `session.started` and `turn.started`, so that continuation still receives the source procedure. A [public test-only reproduction](https://github.com/togasoftware/eve/blob/c5b41008dc2f4b06c9128e67b3b5d102de8a0179/packages/eve/src/context/dynamic-instruction-lifecycle.test.ts#L280-L305) demonstrates the missing lifecycle behavior on an otherwise unchanged upstream revision.

## Authoring API

Instruction resolvers may opt into `step.started` using the existing `defineDynamic` event shape:

```ts
export default defineDynamic({
  events: {
    "step.started": () => defineInstructions({ markdown: procedureForFlow(flowState.get()) }),
  },
});
```

The resolver runs after the preceding tool result and its state mutation are durable, but before the next model prompt is assembled.

## Semantics

```text
tool result + state commit
          |
          v
     step.started
          |
          v
step instruction layer
          |
          v
  model prompt assembly
```

- A step result shadows session and turn results from the same instruction file for that model call.
- Instructions from other files remain present.
- A `null` step result intentionally shadows that file with no instructions; a resolver error leaves its wider-scope instructions in place.
- The step layer is virtual context: it is cleared at every workflow-step boundary and is never serialized into session state or replay payloads.
- Retries within the same workflow step reuse or recompute the current step layer without reintroducing a stale wider-scope value.
- Agents without a `step.started` instruction handler retain the existing prompt-assembly order and cache-stable behavior.

## Prompt caching

Step-scoped instructions can change the system prompt within one turn and reduce prompt-cache hits. Documentation should recommend session or turn scope unless a same-turn state transition requires the next model call to observe new instructions.

## Verification

Tests cover a tool-driven source-to-destination transition, same-file replacement, preservation of unrelated instructions, `null`, resolver errors, retries, replay/non-serialization, later steps, and compatibility for session/turn-only agents.

## Non-goals

This does not add a FrontIQ-specific refresh API, persist step instructions across replay, or change the lifecycle of dynamic tools, models, skills, or subagents.
