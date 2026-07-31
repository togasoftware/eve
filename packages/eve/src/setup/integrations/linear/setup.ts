import { join } from "node:path";

import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { deriveSlackConnectorSlug, normalizeSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { WizardCancelledError } from "#setup/step.js";

import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
} from "../types.js";
import { provisionLinearConnector } from "./connect.js";

export interface LinearSetupDeps {
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  openUrl: typeof openUrl;
  provisionConnector: typeof provisionLinearConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: LinearSetupDeps = {
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  openUrl,
  provisionConnector: provisionLinearConnector,
  writeTextFile,
};

/** Linear does not allow its brand name in a managed app's name. */
export function linearSafeConnectorSlug(slug: string): string {
  const withoutLinear = slug.replaceAll(/linear/gi, "").replace(/[-_]{2,}/g, "-");
  return normalizeSlackConnectorSlug(withoutLinear || "agent");
}

function connectTemplate(uid: string): string {
  return `import { connectLinearCredentials } from "@vercel/connect/eve";
import { linearChannel } from "eve/channels/linear";

export default linearChannel({
  credentials: connectLinearCredentials(${JSON.stringify(uid)}),
});
`;
}

/** Runs guided Linear Agent Session connector and channel setup. */
export async function setupLinear(
  context: IntegrationSetupContext,
  deps: LinearSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Linear setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  try {
    context.ui.prompter.note(
      "Vercel Connect creates a Linear app with the Agent Session scopes and routes verified AgentSessionEvent webhooks to your deployed agent.",
      "Linear Agent",
    );
    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    const slug = linearSafeConnectorSlug(await deps.deriveConnectorSlug(context.appRoot));
    let connector;
    for (;;) {
      try {
        connector = await deps.provisionConnector({
          log: context.ui.prompter.log,
          project,
          projectRoot: context.appRoot,
          slug,
          signal: context.signal,
        });
        break;
      } catch (error) {
        if (error instanceof WizardCancelledError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        context.ui.prompter.log.warning(message);
        const retry = await context.ui.confirm({
          key: "linear.retry-connector",
          message: "Linear connector setup did not complete. Try again?",
          recommended: true,
        });
        if (!retry) return { kind: "cancelled" };
      }
    }
    await deps.writeTextFile(
      join(context.appRoot, "agent/channels/linear.ts"),
      connectTemplate(connector.uid),
      { force: context.force },
    );
    const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
    context.ui.nextSteps([
      "Deploy the agent, then open the Linear app in Vercel Connect and install it in the workspace where you want to delegate issues and comments.",
      "In Linear, delegate an issue or mention the agent in an Agent Session to start a conversation.",
    ]);
    deps.openUrl(dashboardUrl);
    return {
      kind: "done",
      facts: [{ label: "Vercel Connect", value: dashboardUrl, kind: "url" }],
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

/** Linear Agent Session setup registration. */
export const LINEAR_SETUP: SetupIntegration = {
  kind: "linear",
  label: "Linear Agent",
  hint: "Delegate Linear issues and comments",
  setup: setupLinear,
};
