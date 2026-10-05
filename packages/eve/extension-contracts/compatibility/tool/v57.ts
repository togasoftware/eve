import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 57 tools did not have to declare a runtime-authored assistant message.
// Their existing execute and model-output projections keep the normal tool loop.
export default defineTool({
  description: "Look up a saved answer.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) {
    return { answer: `Saved answer for ${query}`, query };
  },
  toModelOutput({ answer }) {
    return { type: "text", value: answer };
  },
});
