/**
 * Child-process environment for a Qoder CLI run.
 *
 * Two things matter here.
 *
 * 1. Nested-session hazard. When the Paperclip server itself was started from
 *    inside a Qoder session, the SDK host handshake variables are in
 *    `process.env`. The CLI reads them and switches into SDK/daemon entrypoint
 *    mode, or borrows the parent session's injected credential, instead of
 *    running as a plain headless CLI.
 *
 *    The host builds the child env as
 *    `{ ...sanitizeInheritedPaperclipEnv(process.env), ...options.env }`, so an
 *    adapter cannot *delete* an inherited variable — omitting it just lets the
 *    inherited value through. They are therefore overridden to the empty
 *    string, which the CLI treats as unset. Verified against `qoder@1.1.80`:
 *    with every key below set to `""`, the child starts as a normal headless
 *    CLI (`system/init` with the configured permission mode).
 *
 * 2. The subagent spawn-depth guard is deliberately left alone. It is a
 *    protection mechanism, not plumbing, so the adapter does not clear it.
 */

const QODER_SDK_HANDSHAKE_ENV_KEYS = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_DAEMON",
  "QODER_AGENT_SDK_VERSION",
  "QODER_AGENT_SDK_LANGUAGE",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_SDK_AUTH_CONFIG_DIR",
  "QODER_SDK_ACCESS_TOKEN",
  "QODER_SDK_CUSTOM_BASE_URL_BYOK",
  "QODER_SESSION_TYPE",
  "QODER_SESSION_ID",
  "QODER_SEARCH_HOST_PID",
  "QODER_REMOTE_WORKER",
  "QODER_RUNTIME_ROLE",
  "QODER_CLI",
  "QODERCLI_RUNTIME_PACKAGING",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
] as const;

/**
 * Variables an inherited Qoder session may set that this adapter must NOT
 * touch, with the reason. Exported so the intent is testable.
 */
export const QODER_PRESERVED_ENV_KEYS: Readonly<Record<string, string>> = {
  QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH:
    "nesting protection; clearing it would bypass a safety limit",
  QODER_CONFIG_DIR: "points at the operator's credential and settings root",
  QODERCN_CONFIG_DIR: "regional variant of the credential and settings root",
};

export function qoderSdkHandshakeEnvKeys(): string[] {
  return [...QODER_SDK_HANDSHAKE_ENV_KEYS];
}

/**
 * Headless env for the child.
 *
 * `base` is the Paperclip-built env (agent identity, API token, workspace
 * hints) plus any operator `env` config, which always wins: an operator who
 * sets `TERM` on purpose keeps it.
 */
export function buildQoderChildEnv(base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  // Neutralize the inherited SDK handshake before anything else so an operator
  // override of the same key still takes precedence below.
  for (const key of QODER_SDK_HANDSHAKE_ENV_KEYS) env[key] = "";

  env.CI = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";

  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== "string") continue;
    env[key] = value;
  }
  return env;
}

/** Keys that were actually present in the inherited env and got neutralized. */
export function describeNeutralizedEnvKeys(inherited: NodeJS.ProcessEnv): string[] {
  return QODER_SDK_HANDSHAKE_ENV_KEYS.filter((key) => {
    const value = inherited[key];
    return typeof value === "string" && value !== "";
  });
}

/**
 * Prompt note telling the agent which Paperclip variables it can rely on.
 *
 * Values are never interpolated — only names — so a token cannot end up in the
 * prompt, the run log, or an issue comment.
 */
export function renderPaperclipEnvNote(env: Record<string, string>): string {
  const interesting = [
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_ISSUE_WORK_MODE",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WORKSPACE_CWD",
  ].filter((key) => typeof env[key] === "string" && env[key] !== "");
  if (interesting.length === 0) return "";
  return [
    "## Paperclip runtime environment",
    "",
    "These environment variables are set for this run:",
    ...interesting.map((key) => `- \`${key}\``),
  ].join("\n");
}

/** Prompt note about API access. Mentions the variable, never its value. */
export function renderApiAccessNote(env: Record<string, string>): string {
  const hasToken = typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY !== "";
  const baseUrl = env.PAPERCLIP_API_URL ?? env.PAPERCLIP_BASE_URL ?? "";
  if (!hasToken) return "";
  return [
    "## Paperclip API access",
    "",
    "`PAPERCLIP_API_KEY` is set in your environment and authenticates you to the",
    baseUrl
      ? `Paperclip API at \`${baseUrl}\`.`
      : "Paperclip API. Read the base URL from the environment rather than guessing it.",
    "Never print the value of that variable, and never copy it into a file you create.",
  ].join("\n");
}
