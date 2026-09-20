import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ content: `Review evidence for session ${ctx.session.id}.` }),
  },
});
