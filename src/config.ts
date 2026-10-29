/**
 * Adapter configuration surface.
 *
 * Every field maps to a flag that was read out of the installed CLI's own
 * option registration (`qoder@1.1.80`), not out of documentation. The CLI calls
 * `allowUnknownOption(true)`, so an invented flag is silently swallowed instead
 * of rejected — that is why nothing here is guessed.
 */

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils/types";

/**
 * The CLI's own list, verbatim. `plan` is accepted by the parser but is not in
 * it: `--permission-mode` has no `.choices()` validation, so an unlisted value
 * is passed straight through to a mode that does not exist.
 */
export const QODER_PERMISSION_MODES = [
  "default",
  "accept_edits",
  "auto",
  "dont_ask",
  "bypass_permissions",
] as const;

export type QoderPermissionMode = (typeof QODER_PERMISSION_MODES)[number];

/**
 * `auto` is the CLI's designed unattended mode: an AI classifier rules on each
 * request and no verdict means deny. `default` turns every permission prompt
 * into a denial in headless mode, and `bypass_permissions` removes the checks
 * entirely, so neither is a safe default for a background runner.
 */
export const DEFAULT_PERMISSION_MODE: QoderPermissionMode = "auto";

export const DEFAULT_COMMAND = "qoder";
export const DEFAULT_TIMEOUT_SEC = 1_800;
export const DEFAULT_GRACE_SEC = 20;

export function isQoderPermissionMode(value: unknown): value is QoderPermissionMode {
  return (
    typeof value === "string" &&
    (QODER_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export type PermissionModeResolution = {
  mode: QoderPermissionMode;
  /** Set when a configured value was rejected, so the run log can say so. */
  warning: string | null;
};

export function resolvePermissionMode(value: unknown): PermissionModeResolution {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { mode: DEFAULT_PERMISSION_MODE, warning: null };
  if (isQoderPermissionMode(raw)) return { mode: raw, warning: null };
  return {
    mode: DEFAULT_PERMISSION_MODE,
    warning:
      `Permission mode "${raw}" is not one of ${QODER_PERMISSION_MODES.join(", ")}; ` +
      `falling back to "${DEFAULT_PERMISSION_MODE}".`,
  };
}

/** Accepts a JSON array, or a comma/newline separated list from a text field. */
export function parseStringList(value: unknown): string[] {
  return collect(value, /[,\n]/);
}

/**
 * Same, but newline-only.
 *
 * Used for raw CLI arguments, where a comma is a legitimate character inside a
 * single argument and splitting on it would silently cut the argument in half.
 */
export function parseArgList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n/) : [];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const EXTRA_ARG_OPTIONS = new Map<string, boolean>([
  ["--debug", false], ["-d", false],
  ["--reasoning-effort", true], ["--thinking", true], ["--thinking-budget", true],
  ["--context-window", true], ["--output-style", true], ["--name", true], ["-n", true],
]);

export function getExtraArgsError(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equalsAt = arg.indexOf("=");
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    const expectsValue = EXTRA_ARG_OPTIONS.get(flag);
    if (expectsValue === undefined) {
      return `Extra CLI arguments only support ${[...EXTRA_ARG_OPTIONS.keys()].join(", ")}. Use dedicated adapter fields for permissions, directories, model and limits; protocol and session controls cannot be overridden.`;
    }
    if (expectsValue) {
      const value = equalsAt === -1 ? args[++index] : arg.slice(equalsAt + 1);
      if (!value?.trim() || value.trim().startsWith("-")) {
        return `Extra CLI argument ${flag} requires a value.`;
      }
    } else if (equalsAt !== -1) {
      return `Extra CLI argument ${flag} does not accept a value.`;
    }
  }
  return null;
}

function collect(value: unknown, separator: RegExp): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(separator)
      : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** Positive integer, or null when unset/invalid. Zero means "leave unset". */
export function parsePositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : null;
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "command",
        label: "Qoder CLI command",
        type: "text",
        default: DEFAULT_COMMAND,
        hint: "Executable name or absolute path. Must be resolvable from the PATH Paperclip runs with.",
        group: "Runtime",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute path. Ignored when the agent already has a Paperclip workspace, which always wins. Leave empty only if you accept the Paperclip server's own directory.",
        group: "Runtime",
      },
      // No `model` field here on purpose. The host renders its own "Model ID"
      // control, which becomes a picker backed by this adapter's `listModels()`
      // (`qoder --list-models`). Declaring a second `model` field would bind two
      // inputs to the same config key.
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "select",
        default: DEFAULT_PERMISSION_MODE,
        options: [
          { value: "auto", label: "Auto (unattended, denies on no verdict)" },
          { value: "accept_edits", label: "Accept edits" },
          { value: "dont_ask", label: "Don't ask" },
          { value: "default", label: "Default (headless: denies every prompt)" },
          { value: "bypass_permissions", label: "Bypass permissions (no checks)" },
        ],
        hint: "Auto is the CLI's unattended mode. Bypass removes all permission checks — only use it in a throwaway working directory.",
        group: "Permissions",
      },
      {
        key: "allowedTools",
        label: "Pre-approved tools",
        type: "textarea",
        hint: "Comma or newline separated. These are auto-approved, not a restriction — the tool stays available either way.",
        group: "Permissions",
      },
      {
        key: "disallowedTools",
        label: "Denied tools",
        type: "textarea",
        hint: "Comma or newline separated. These are removed from the session's tool list outright.",
        group: "Permissions",
      },
      {
        key: "addDirs",
        label: "Additional directories",
        type: "textarea",
        hint: "Comma or newline separated absolute paths added to the workspace alongside the working directory.",
        group: "Permissions",
      },
      {
        key: "timeoutSec",
        label: "Run timeout (seconds)",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
        hint: "Wall-clock limit for one run. 0 disables the adapter timeout.",
        group: "Limits",
      },
      {
        key: "graceSec",
        label: "Termination grace (seconds)",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Time between SIGTERM and SIGKILL when a run is cancelled or times out.",
        group: "Limits",
      },
      {
        key: "maxTurns",
        label: "Max turns per run",
        type: "number",
        hint: "Passed to --max-turns. The flag is registered but hidden from `qoder --help`; leave empty to use the CLI default.",
        group: "Limits",
      },
      {
        key: "maxOutputTokens",
        label: "Max output tokens",
        type: "number",
        hint: "Passed to --max-output-tokens. Leave empty for the model default.",
        group: "Limits",
      },
      {
        key: "maxModelRequestRetries",
        label: "Max model request retries",
        type: "number",
        hint: "Passed to --max-model-request-retries.",
        group: "Limits",
      },
      {
        key: "appendSystemPrompt",
        label: "Append to system prompt",
        type: "textarea",
        hint: "Passed to --append-system-prompt. Do not put credentials here; it is recorded in the invocation metadata.",
        group: "Prompt",
      },
      {
        key: "extraArgs",
        label: "Extra CLI arguments",
        type: "textarea",
        hint: "One argument per line. Supports debug, reasoning/thinking, context-window, output-style and session name options. Protocol, session, directory and permission overrides are rejected.",
        group: "Advanced",
      },
    ],
  };
}
