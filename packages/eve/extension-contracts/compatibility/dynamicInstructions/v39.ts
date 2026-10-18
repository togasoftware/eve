import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 39 dynamic instructions resolve at session or turn boundaries.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
