import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 41 dynamic instructions resolve at session or turn boundaries; epoch 42 adds step scope.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
