/**
 * Environment test for the Qoder adapter.
 *
 * Deliberately spends zero model calls. Both CLI probes used here were run
 * against the installed `qoder@1.1.80` and confirmed to stop before any model
 * request:
 *
 * - `qoder --version`      → prints `1.1.80`, exit 0.
 * - `qoder --list-models`  → unauthenticated: `Not logged in. Run `qodercli
 *   login` to authenticate.`, exit 1.
 *
 * A `--print` probe with an empty prompt was tried and rejected: the CLI still
 * reported `num_turns: 1`, so on an authenticated account it could start a real
 * turn just to answer "is auth working".
 *
 * The probes run with the same neutralized environment as a real run. Without
 * it, a Paperclip server that was itself launched from inside a Qoder session
 * makes the child fail with `auth_payload_invalid` — which would be reported
 * here as a broken install rather than as the nesting artifact it is.
 */

import path from "node:path";

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils/types";
import {
  asString,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";

import {
  DEFAULT_COMMAND,
  DEFAULT_PERMISSION_MODE,
  QODER_PERMISSION_MODES,
  getExtraArgsError,
  parseArgList,
  resolvePermissionMode,
} from "./config.js";
import { buildQoderChildEnv, describeNeutralizedEnvKeys } from "./env.js";
import { isAuthFailure, isQuotaFailure, normalizeHaystack } from "./errors.js";
import { QODER_CLI_VERIFIED } from "./protocol.js";

const PROBE_TIMEOUT_SEC = 30;
const PROBE_GRACE_SEC = 5;

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function result(
  adapterType: string,
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult {
  return {
    adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

/** Operator `env` config, minus keys the host forbids adapters from accepting. */
function readConfigEnv(config: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(config.env))) {
    if (typeof value !== "string") continue;
    if (isForbiddenConfigEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const adapterType = ctx.adapterType;
  const config = parseObject(ctx.config);
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });

  // Remote execution is refused rather than approximated: this adapter drives a
  // CLI that must already be installed and logged in on the executing host, and
  // nothing here can verify that for a remote target.
  if (adapterExecutionTargetIsRemote(target)) {
    return result(adapterType, [
      {
        code: "qoder_remote_unsupported",
        level: "error",
        message: `This adapter runs the Qoder CLI on the Paperclip host only, but this agent is assigned to ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}.`,
        hint: "Assign the agent to local execution, or use an adapter built for remote environments.",
      },
    ]);
  }

  const extraArgsError = getExtraArgsError(parseArgList(config.extraArgs));
  if (extraArgsError) {
    return result(adapterType, [{
      code: "qoder_extra_args_invalid",
      level: "error",
      message: extraArgsError,
    }]);
  }

  const checks: AdapterEnvironmentCheck[] = [];
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = configuredCwd || process.cwd();

  const permission = resolvePermissionMode(config.permissionMode);
  if (permission.warning) {
    checks.push({
      code: "qoder_permission_mode_invalid",
      level: "warn",
      message: permission.warning,
      hint: `Valid values: ${QODER_PERMISSION_MODES.join(", ")}.`,
    });
  } else if (permission.mode === "bypass_permissions") {
    checks.push({
      code: "qoder_permission_mode_bypassed",
      level: "warn",
      message:
        "Permission mode is `bypass_permissions`, which removes every permission check from the run.",
      hint: `Use \`${DEFAULT_PERMISSION_MODE}\` unless the working directory is disposable. A working directory is not an OS sandbox.`,
    });
  } else {
    checks.push({
      code: "qoder_permission_mode",
      level: "info",
      message: `Permission mode: ${permission.mode}.`,
    });
  }

  let cwdUsable = true;
  if (configuredCwd && !path.isAbsolute(configuredCwd)) {
    cwdUsable = false;
    checks.push({
      code: "qoder_cwd_not_absolute",
      level: "error",
      message: `Working directory must be an absolute path: ${configuredCwd}`,
    });
  } else {
    try {
      // No `createIfMissing`: an environment test should not create directories
      // on the host. A real run creates the directory when it needs it.
      await ensureAbsoluteDirectory(cwd);
      checks.push({
        code: "qoder_cwd",
        level: "info",
        message: `Working directory is usable: ${cwd}`,
        ...(configuredCwd
          ? {
              detail:
                "A Paperclip workspace assigned to the agent overrides this configured directory.",
            }
          : {}),
      });
    } catch (err) {
      cwdUsable = false;
      checks.push({
        code: "qoder_cwd_invalid",
        level: "error",
        message: err instanceof Error ? err.message : "Working directory is not usable.",
        detail: cwd,
      });
    }
  }

  const neutralized = describeNeutralizedEnvKeys(process.env);
  if (neutralized.length > 0) {
    checks.push({
      code: "qoder_sdk_env_neutralized",
      level: "info",
      message: `Paperclip is running inside a Qoder session; ${neutralized.length} inherited SDK handshake variable(s) will be neutralized for each run.`,
      detail: neutralized.join(", "),
    });
  }

  const probeEnv = buildQoderChildEnv(readConfigEnv(config));
  const commandResolutionEnv = ensurePathInEnv({ ...process.env, ...probeEnv });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      target,
      cwd,
      commandResolutionEnv,
    );
  } catch (err) {
    checks.push({
      code: "qoder_cli_not_found",
      level: "error",
      message: err instanceof Error ? err.message : `Command is not executable: ${command}`,
      detail: command,
      hint: "Install the CLI with `npm i -g @qoder-ai/qodercli`, or set the adapter's command field to its absolute path.",
    });
    return result(adapterType, checks);
  }

  // Every probe runs *in* the working directory, so probing with an unusable
  // one would only reproduce the directory error as a confusing spawn failure.
  if (!cwdUsable) return result(adapterType, checks);

  const runId = `qoder-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probe = async (args: string[]) =>
    runAdapterExecutionTargetProcess(runId, target, command, args, {
      cwd,
      env: probeEnv,
      timeoutSec: PROBE_TIMEOUT_SEC,
      graceSec: PROBE_GRACE_SEC,
      onLog: async () => {},
    });

  let version: Awaited<ReturnType<typeof probe>>;
  try {
    version = await probe(["--version"]);
  } catch (err) {
    // A spawn-level failure is a finding, not a reason for the whole
    // environment test to throw at the caller.
    checks.push({
      code: "qoder_cli_unusable",
      level: "error",
      message: `\`${command} --version\` could not be started.`,
      detail: err instanceof Error ? clip(err.message) : String(err),
    });
    return result(adapterType, checks);
  }

  const versionLine = firstNonEmptyLine(version.stdout) || firstNonEmptyLine(version.stderr);
  if (version.timedOut || (version.exitCode ?? 1) !== 0) {
    checks.push({
      code: "qoder_cli_unusable",
      level: "error",
      message: version.timedOut
        ? `\`${command} --version\` timed out after ${PROBE_TIMEOUT_SEC}s.`
        : `\`${command} --version\` did not exit cleanly.`,
      ...(versionLine ? { detail: clip(versionLine) } : {}),
      hint: "Run the command manually in this working directory to see what it reports.",
    });
    return result(adapterType, checks);
  }

  if (versionLine === QODER_CLI_VERIFIED) {
    checks.push({
      code: "qoder_cli_version",
      level: "info",
      message: `Qoder CLI ${versionLine} detected; this is the version the adapter was verified against.`,
    });
  } else {
    checks.push({
      code: "qoder_cli_version_unverified",
      level: "warn",
      message: `Qoder CLI reports ${clip(versionLine, 60) || "an unreadable version"}; the adapter was verified against ${QODER_CLI_VERIFIED}.`,
      hint: "The stream-json flags and permission modes used here were read out of the verified build. Check the run log for unknown events after upgrading.",
    });
  }

  const models = await probe(["--list-models"]).catch((err: unknown) => {
    // Mirrors the version probe: a start failure becomes an unknown-auth
    // finding rather than a thrown error.
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: null as number | null,
      timedOut: false,
    };
  });
  const modelsText = normalizeHaystack(models.stdout, models.stderr);
  const modelsLine = firstNonEmptyLine(models.stdout) || firstNonEmptyLine(models.stderr);
  if (!models.timedOut && (models.exitCode ?? 1) === 0) {
    checks.push({
      code: "qoder_auth",
      level: "info",
      message: "Qoder CLI is authenticated.",
      detail: "Verified with `--list-models`, which does not call a model.",
    });
  } else if (isAuthFailure(modelsText)) {
    checks.push({
      code: "qoder_auth_required",
      level: "error",
      message: "Qoder CLI is installed but not logged in, so no task can run.",
      ...(modelsLine ? { detail: clip(modelsLine) } : {}),
      hint: "Run `qoder login` in a terminal on this host, complete the browser sign-in, then test again.",
    });
  } else if (isQuotaFailure(modelsText)) {
    checks.push({
      code: "qoder_quota_exceeded",
      level: "error",
      message: "Qoder reported a quota, rate limit or billing problem.",
      ...(modelsLine ? { detail: clip(modelsLine) } : {}),
    });
  } else {
    checks.push({
      code: "qoder_auth_unknown",
      level: "warn",
      message: models.timedOut
        ? `\`${command} --list-models\` timed out after ${PROBE_TIMEOUT_SEC}s, so authentication could not be confirmed.`
        : `\`${command} --list-models\` failed for a reason the adapter cannot classify, so authentication could not be confirmed.`,
      ...(modelsLine ? { detail: clip(modelsLine) } : {}),
      hint: "Run the command manually to see the full output.",
    });
  }

  const model = asString(config.model, "").trim();
  if (model) {
    checks.push({
      code: "qoder_model_unverified",
      level: "info",
      message: `Model \`${model}\` is passed to the CLI as configured; the adapter does not validate model names.`,
      hint: "Run `qoder --list-models` while logged in to see the names this CLI accepts.",
    });
  }

  return result(adapterType, checks);
}
