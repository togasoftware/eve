import { defineTool } from "#public/tools/index.js";

// Epoch 86 tools had no runtime-authored assistant-message projection.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
