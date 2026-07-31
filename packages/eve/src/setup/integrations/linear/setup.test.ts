import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { linearSafeConnectorSlug, setupLinear, type LinearSetupDeps } from "./setup.js";

function deps(): LinearSetupDeps {
  return {
    attachConnector: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    findConnector: vi.fn(async () => undefined),
    openUrl: vi.fn(),
    provisionConnector: vi.fn(async () => ({ id: "scl_linear", uid: "linear/agent" })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function recommendedAsker() {
  return {
    ask: vi.fn(async (question: { recommended?: unknown }) => question.recommended),
    askMany: vi.fn(),
  };
}

describe("Linear setup", () => {
  it("removes Linear from managed app names", () => {
    expect(linearSafeConnectorSlug("eve-linear-agent")).toBe("eve-agent");
    expect(linearSafeConnectorSlug("linear")).toBe("agent");
  });

  it("provisions Connect, routes Agent Session events, and scaffolds the channel", async () => {
    const fake = createFakePrompter();
    const effects = deps();

    await expect(
      setupLinear(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({ asker: recommendedAsker(), prompter: fake.prompter }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "agent" }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/linear.ts",
      expect.stringContaining('connectLinearCredentials("linear/agent")'),
      { force: undefined },
    );
    expect(effects.openUrl).toHaveBeenCalledOnce();
  });

  it("reuses an existing connector when selected", async () => {
    const fake = createFakePrompter();
    const effects = deps();
    vi.mocked(effects.findConnector).mockResolvedValue({ id: "scl_existing", uid: "linear/agent" });
    const asker = recommendedAsker();

    await expect(
      setupLinear(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({ asker, prompter: fake.prompter }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.attachConnector).toHaveBeenCalledWith(
      expect.objectContaining({ connector: { id: "scl_existing", uid: "linear/agent" } }),
    );
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("requires an authenticated Vercel CLI", async () => {
    const fake = createFakePrompter();
    await expect(
      setupLinear({
        appRoot: "/project",
        environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({ asker: recommendedAsker(), prompter: fake.prompter }),
      }),
    ).rejects.toThrow("vercel login");
  });
});
