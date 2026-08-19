import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: `Use session ${ctx.session.id} when correlating evidence.`,
        role: "user",
      }),
  },
});
