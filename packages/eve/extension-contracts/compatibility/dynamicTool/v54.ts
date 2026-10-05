import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 54 dynamic tools keep the normal model continuation when they do not
// opt into a runtime-authored assistant message.
export default defineDynamic({
  events: {
    "step.started": () => ({
      lookup: defineTool({
        description: "Look up a value.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ value: "saved" }),
        toModelOutput: ({ value }) => ({ type: "text", value }),
      }),
    }),
  },
});
