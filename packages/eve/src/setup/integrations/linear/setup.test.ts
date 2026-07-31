import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupLinear, type LinearSetupDeps } from "./setup.js";

function deps(): LinearSetupDeps {
  return {
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    openUrl: vi.fn(),
    provisionConnector: vi.fn(async () => ({ id: "scl_linear", uid: "linear/agent" })),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("Linear setup", () => {
  it("provisions Connect, routes Agent Session events, and scaffolds the channel", async () => {
    const fake = createFakePrompter();
    const effects = deps();

    await expect(
      setupLinear(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({
            asker: { ask: vi.fn(), askMany: vi.fn() },
            prompter: fake.prompter,
          }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/linear.ts",
      expect.stringContaining('connectLinearCredentials("linear/agent")'),
      { force: undefined },
    );
    expect(effects.openUrl).toHaveBeenCalledOnce();
  });

  it("requires an authenticated Vercel CLI", async () => {
    const fake = createFakePrompter();
    await expect(
      setupLinear({
        appRoot: "/project",
        environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: { ask: vi.fn(), askMany: vi.fn() },
          prompter: fake.prompter,
        }),
      }),
    ).rejects.toThrow("vercel login");
  });
});
