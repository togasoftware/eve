import { defineAgent } from "#public/index.js";

// Epoch 37 supports the prior agent fields without requiring the new catalog
// policy. Existing extensions therefore retain the default catalog behavior.
export default defineAgent({
  description: "Summarize a customer's open support tickets.",
  model: "anthropic/claude-sonnet-5",
  reasoning: "high",
});
