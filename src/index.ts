/**
 * Plugin entry point.
 *
 * Paperclip's plugin loader requires a named export `createServerAdapter()`:
 * a zero-argument, synchronous factory on the package's `"."` export, whose
 * return value is validated for `type`, `execute` and `testEnvironment`.
 * There is no display-name field in the contract — `type` is what the host
 * shows and stores, so it is the user-visible identity of this adapter.
 *
 * Capabilities this adapter deliberately does NOT declare:
 *
 * - `getRuntimeCommandSpec`: that hook exists to provision the CLI inside a
 *   fresh remote environment. This adapter refuses remote targets outright
 *   rather than pretending it can set one up.
 * - `acp` / `runtimeToolDelivery`: the CLI speaks its own stream-json
 *   protocol, not ACP, and receives Paperclip's run-scoped tools through the
 *   environment, which is the default.
 */

import type {
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils/types";

import { getConfigSchema } from "./config.js";
import { QODER_ADAPTER_TYPE, execute } from "./execute.js";
import { listModels, refreshModels } from "./models.js";
import { testEnvironment } from "./test-environment.js";

export { QODER_ADAPTER_TYPE, execute } from "./execute.js";
export { testEnvironment } from "./test-environment.js";
export { getConfigSchema } from "./config.js";
export { listModels, refreshModels, parseModelList, clearModelCache } from "./models.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Persists the session id together with the context it is only valid in.
 *
 * A Qoder session id carries a whole conversation — file contents, decisions,
 * possibly private repository material. Resuming it in a different working
 * directory or workspace would leak one task into another, so the provenance
 * fields are stored alongside the id and checked on the way back in
 * (`decideSessionResume`). A record with no id is dropped rather than kept as
 * a half-usable handle.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    return normalizeSessionRecord(raw);
  },
  serialize(params) {
    return normalizeSessionRecord(params);
  },
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

function normalizeSessionRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId =
    readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
  if (!sessionId) return null;

  const cwd = readNonEmptyString(record.cwd);
  const workspaceId =
    readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
  const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);

  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
  };
}

const AGENT_CONFIGURATION_DOC = `# Qoder CLI (Local)

Runs the locally installed Qoder CLI (\`qoder\`, verified against 1.1.80) as the
agent's execution runtime, on the same host as the Paperclip server.

## Before the first task

1. Install the CLI: \`npm i -g @qoder-ai/qodercli\`.
2. Log in once per host: \`qoder login\`. Paperclip cannot do this for you, and
   an agent assigned to this adapter fails immediately without it.
3. Run the adapter's environment test. It checks the CLI, its version and the
   login state without spending a single model call.

## Working directory

A Paperclip workspace assigned to the agent always wins. The configured
**Working directory** is the fallback for an agent with no workspace.

The working directory bounds where the agent is *pointed*, not what it is
*able* to touch: it is not an operating-system sandbox. Keep
\`bypass_permissions\` for throwaway directories only.

## Permission mode

\`auto\` is the CLI's unattended mode and the default here. \`default\` turns
every permission prompt into a denial in headless mode, so the agent will stall
on its first tool request.

## Sessions

The host selects the stored session and may reuse it across tasks for one
agent. Recorded directory and workspace contradictions start a fresh session;
a bare legacy session id is accepted on the host's authority. Use separate
agents/workspaces for confidential task boundaries. The CLI's "resume the most
recent session on this machine" shortcut is never used.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: QODER_ADAPTER_TYPE,
    execute,
    testEnvironment,
    getConfigSchema,
    sessionCodec,
    agentConfigurationDoc: AGENT_CONFIGURATION_DOC,
    // Discovered by running `qoder --list-models`, which spends no model calls.
    // Returns [] when the CLI cannot be asked, so the UI falls back to the
    // free-text model field rather than showing an invented list.
    listModels,
    refreshModels,
    // The CLI reads AGENTS.md from the directories it is given, so the bundle is
    // injected as prompt text plus an `--add-dir` for its folder.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    // Without this the host passes `authToken: null`, so no PAPERCLIP_API_KEY
    // reaches the CLI. The agent then calls the Paperclip API unauthenticated,
    // which on a local_trusted instance is accepted as the *board user* — its
    // comments end up attributed to a human instead of to itself. Declaring it
    // makes the host mint a run-scoped agent JWT.
    supportsLocalAgentJwt: true,
  };
}
