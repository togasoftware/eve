import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 81 dynamic tools had no runtime-authored assistant-message projection.
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => ({
      model_id: defineTool({
        description: "Return the active model identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ modelId: ctx.model?.id ?? null }),
      }),
    }),
  },
});
