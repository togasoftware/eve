import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 38 dynamic instructions resolve at session or turn boundaries.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
