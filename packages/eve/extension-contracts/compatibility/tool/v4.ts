import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Look up the owner of a service",
  inputSchema: { properties: { service: { type: "string" } }, type: "object" },
  async execute(input, ctx) {
    return {
      owner: "platform-team",
      service: (input as { service: string }).service,
      sessionId: ctx.session.id,
    };
  },
});
