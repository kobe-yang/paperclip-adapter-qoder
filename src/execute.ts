/**
 * Runs one Qoder CLI invocation for one Paperclip run.
 *
 * Shape of the invocation (every flag read out of `qoder@1.1.80`'s own option
 * registration — see `args.ts`):
 *
 *   qoder --print --input-format stream-json --output-format stream-json \
 *         -w <cwd> --permission-mode <mode> [...]            # prompt on stdin
 *
 * Three decisions are worth knowing before changing anything here.
 *
 * 1. Output is aggregated incrementally in `onLog`, never from
 *    `RunProcessResult.stdout`. The host caps its batched capture at 4 MiB and
 *    truncates from the front, so a long run loses `system/init` — and with it
 *    the session id — from the final buffer.
 * 2. Success is decided by the terminal `result` event, not by the exit code.
 *    `qoder@1.1.80` exits 0 while reporting `is_error: true`.
 * 3. Remote execution targets are refused rather than approximated. Running
 *    there would need the operator's Qoder credential synced into the remote
 *    environment, which this adapter does not do.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  adapterExecutionTargetIsRemote,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeout,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isForbiddenConfigEnvKey,
  isPaperclipRecoveryWakePayload,
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "@paperclipai/adapter-utils/types";

import { QoderStreamAggregator } from "./aggregate.js";
import { buildQoderArgs, buildQoderStdinPayload, describeArgsForLogs } from "./args.js";
import {
  DEFAULT_COMMAND,
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  getExtraArgsError,
  parseArgList,
  parsePositiveInt,
  parseStringList,
  resolvePermissionMode,
} from "./config.js";
import {
  buildQoderChildEnv,
  describeNeutralizedEnvKeys,
  renderApiAccessNote,
  renderPaperclipEnvNote,
} from "./env.js";
import { isSessionUnrecoverable, normalizeHaystack } from "./errors.js";
import { LineSplitter } from "./jsonl.js";
import { buildExecutionResult } from "./outcome.js";
import { buildSessionParams, decideSessionResume, readStoredSession } from "./session.js";

export const QODER_ADAPTER_TYPE = "qoder_local";

/** Stdout tail kept for failure classification when no protocol error exists. */
const STDERR_SCAN_CHARS = 8_000;

/** Grace after the terminal result before the host stops a lingering CLI. */
const TERMINAL_RESULT_GRACE_MS = 5_000;

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  try {
    return await runQoder(ctx, providerStop);
  } finally {
    await providerStop.collectBeforeRestore();
  }
}

type ProviderStopBoundary = ReturnType<typeof createProviderStoppedBoundary>;

async function runQoder(
  ctx: AdapterExecutionContext,
  providerStop: ProviderStopBoundary,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } =
    ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "qoder_remote_unsupported",
      errorFamily: "configuration",
      errorMessage:
        `Qoder CLI (Local) executes only on the Paperclip host, but this agent is assigned to ` +
        `${describeAdapterExecutionTarget(executionTarget)}. Assign it a local execution ` +
        `environment, or use an adapter that provisions its CLI remotely.`,
      // No provider work started, so the host may safely retry bootstrap.
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }

  const command = asString(config.command, DEFAULT_COMMAND);
  const model = asString(config.model, "").trim();
  const permission = resolvePermissionMode(config.permissionMode);
  const allowedTools = parseStringList(config.allowedTools);
  const disallowedTools = parseStringList(config.disallowedTools);
  const configuredAddDirs = parseStringList(config.addDirs);
  const extraArgs = parseArgList(config.extraArgs);
  const extraArgsError = getExtraArgsError(extraArgs);
  if (extraArgsError) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "qoder_extra_args_invalid",
      errorFamily: "configuration",
      errorMessage: extraArgsError,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }
  const maxTurns = parsePositiveInt(config.maxTurns);
  const maxOutputTokens = parsePositiveInt(config.maxOutputTokens);
  const maxModelRequestRetries = parsePositiveInt(config.maxModelRequestRetries);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];

  // An agent whose workspace is just its home directory is the one case where a
  // configured cwd is more specific than what the host supplied. Otherwise the
  // Paperclip workspace always wins, because that is the tree the host staged.
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  paperclipEnv.PAPERCLIP_RUN_ID = runId;
  applyWakeEnv(paperclipEnv, context);
  refreshPaperclipWorkspaceEnvForExecution({
    env: paperclipEnv,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value !== "string") continue;
    // The run token is minted per run; a config-supplied credential is never
    // accepted, and a PAPERCLIP_* variable the host already assigned wins.
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in paperclipEnv) continue;
    paperclipEnv[key] = value;
  }
  if (authToken && !paperclipEnv.PAPERCLIP_API_KEY) {
    paperclipEnv.PAPERCLIP_API_KEY = authToken;
  }

  const childEnv = buildQoderChildEnv(paperclipEnv);
  const neutralizedEnvKeys = describeNeutralizedEnvKeys(process.env);
  const commandResolutionEnv = ensurePathInEnv({ ...process.env, ...childEnv });

  const timeout = resolveAdapterExecutionTargetTimeout(
    executionTarget,
    asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC),
  );
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      executionTarget,
      cwd,
      commandResolutionEnv,
      { timeoutSec: timeout.timeoutSec },
    );
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "qoder_cli_not_found",
      errorFamily: "configuration",
      errorMessage:
        `Could not resolve the Qoder CLI command "${command}" on the Paperclip host: ` +
        `${errorText(error)} Install it (\`npm i -g @qoder-ai/qodercli\`) or set an absolute ` +
        `path in the adapter's "Qoder CLI command" field.`,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    cwd,
    commandResolutionEnv,
  );

  if (permission.warning) {
    await onLog("stderr", `[paperclip] ${permission.warning}\n`);
  }
  if (neutralizedEnvKeys.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Neutralized inherited Qoder SDK handshake variables so the CLI runs as a ` +
        `plain headless process: ${neutralizedEnvKeys.join(", ")}.\n`,
    );
  }
  await onLog("stdout", `[paperclip] ${formatAdapterExecutionTimeoutStartLogLine(timeout)}\n`);

  const instructions = await readInstructions(config, onLog);
  const addDirs = instructions.addDir
    ? [...configuredAddDirs, instructions.addDir]
    : configuredAddDirs;

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(childEnv);
  const apiAccessNote = renderApiAccessNote(childEnv);

  const stored = readStoredSession(runtime.sessionParams, runtime.sessionId);
  const resumeDecision = decideSessionResume({
    stored, cwd, workspaceId, repoUrl: workspaceRepoUrl, repoRef: workspaceRepoRef,
  });
  if (resumeDecision.refusalReason) {
    await onLog("stdout", `[paperclip] ${resumeDecision.refusalReason}\n`);
  }

  const commandNotes = [
    "Prompt is delivered as a stream-json user message on stdin, so it never appears in argv or a process listing.",
    "Added --print --input-format stream-json --output-format stream-json for structured headless output.",
    `Working directory passed as -w ${cwd}.`,
    `Permission mode: ${permission.mode}.`,
    "Set headless env (CI=1, NO_COLOR=1, TERM=dumb) so the CLI skips interactive and theme detection.",
    "Success is read from the terminal stream-json result event; the CLI can exit 0 on failure.",
    "--continue is never used: it resumes whichever session ran most recently on this machine.",
  ];
  if (neutralizedEnvKeys.length > 0) {
    commandNotes.push(
      `Neutralized inherited Qoder SDK handshake variables: ${neutralizedEnvKeys.join(", ")}.`,
    );
  }
  if (instructions.note) commandNotes.push(instructions.note);

  type Attempt = {
    proc: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
    aggregator: QoderStreamAggregator;
    droppedOutputLines: number;
    nonResultOutputSeen: boolean;
  };

  const runAttempt = async (resumeSessionId: string | null): Promise<Attempt> => {
    const resumedSession = Boolean(resumeSessionId);
    await hydrateFreshSessionHandoff(ctx, { resumedSession });
    const sections = selectPaperclipPromptSections(context, {
      resumedSession,
      includeCommunicationGuidance: false,
    });
    // On a resumed session the wake prompt already carries the current event;
    // re-rendering the agent template would re-introduce the agent to itself.
    const renderedPrompt =
      (resumedSession && sections.wakePrompt.length > 0) ||
      isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession }),
      instructions.prefix,
      sections.wakePrompt,
      sections.taskContextNote,
      sessionHandoffNote,
      paperclipEnvNote,
      apiAccessNote,
      renderedPrompt,
    ]);

    const args = buildQoderArgs({
      resumeSessionId,
      cwd,
      model,
      permissionMode: permission.mode,
      addDirs,
      allowedTools,
      disallowedTools,
      maxTurns,
      maxOutputTokens,
      maxModelRequestRetries,
      appendSystemPrompt: asString(config.appendSystemPrompt, ""),
      extraArgs,
    });

    if (onMeta) {
      await onMeta({
        adapterType: QODER_ADAPTER_TYPE,
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: describeArgsForLogs(args),
        env: buildInvocationEnvForLogs(childEnv, {
          runtimeEnv: commandResolutionEnv,
          includeRuntimeKeys: ["HOME", "PATH"],
          resolvedCommand,
        }),
        prompt,
        promptMetrics: {
          promptChars: prompt.length,
          instructionsChars: instructions.prefix.length,
          wakePromptChars: sections.wakePrompt.length,
          taskContextChars: sections.taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
          agentTemplateChars: renderedPrompt.length,
        },
        context,
      });
    }

    const aggregator = new QoderStreamAggregator();
    const splitter = new LineSplitter();
    let nonResultOutputSeen = false;
    const emitLine = async (line: string): Promise<void> => {
      const events = aggregator.ingestLine(line);
      if (line.trim() && (events.length === 0 || events.some((event) => event.eventType !== "result"))) {
        nonResultOutputSeen = true;
      }
      for (const event of events) {
        await forwardEvent(onEvent, event);
      }
    };

    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      onProcessStopped: providerStop.beginInvocation(),
      cwd,
      env: childEnv,
      stdin: buildQoderStdinPayload(prompt),
      timeoutSec: timeout.timeoutSec,
      graceSec,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: async (stream, chunk) => {
        await onLog(stream, chunk);
        if (stream !== "stdout") return;
        for (const line of splitter.push(chunk)) await emitLine(line);
      },
      // The CLI can own background tasks that outlive its answer. Once the
      // terminal result is in, a still-running child only holds the run open.
      terminalResultCleanup: {
        hasTerminalResult: () => aggregator.state.resultSeen,
        graceMs: TERMINAL_RESULT_GRACE_MS,
      },
    });
    for (const line of splitter.flush()) await emitLine(line);

    if (aggregator.state.decodeDamagedLines > 0) {
      await onLog(
        "stderr",
        `[qoder-adapter] ${aggregator.state.decodeDamagedLines} output line(s) arrived with ` +
          "replacement characters and could not be parsed. The Paperclip host decodes each stdout " +
          "chunk separately, so a multi-byte character on a chunk boundary is lost before the " +
          "adapter sees it. Transcript content from those lines is missing.\n",
      );
    }
    if (splitter.droppedLineCount > 0) {
      await onLog(
        "stderr",
        `[qoder-adapter] ${splitter.droppedLineCount} oversized output line(s) were dropped to ` +
          "keep the adapter's line buffer bounded.\n",
      );
    }

    return { proc, aggregator, droppedOutputLines: splitter.droppedLineCount, nonResultOutputSeen };
  };

  const toResult = (
    attempt: Attempt,
    options: { attemptedResume: boolean; clearSessionOnMissingSession: boolean },
  ): AdapterExecutionResult => {
    const state = attempt.aggregator.state;
    // A resumed attempt that died before `system/init` still belongs to the
    // stored session; dropping the id would discard usable context.
    const resolvedSessionId =
      state.sessionId ?? (options.attemptedResume ? stored?.sessionId ?? null : null);
    return buildExecutionResult({
      state,
      proc: {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: attempt.proc.timedOut,
        errorCode: attempt.proc.errorCode ?? null,
        stdoutTail: tail(attempt.proc.stdout),
        stderr: tail(attempt.proc.stderr),
        terminalResultCleanup: attempt.proc.terminalResultCleanup ?? null,
      },
      configuredModel: model,
      attemptedResume: options.attemptedResume,
      sessionParams: buildSessionParams({
        sessionId: resolvedSessionId,
        cwd,
        workspaceId,
        repoUrl: workspaceRepoUrl,
        repoRef: workspaceRepoRef,
      }),
      resolvedSessionId,
      clearSession: options.clearSessionOnMissingSession && !resolvedSessionId,
      timeoutMessage: formatAdapterExecutionTimeoutErrorMessage(timeout),
      diagnostics: {
        qoderAdapter: {
          permissionMode: permission.mode,
          permissionModeWarning: permission.warning,
          resumeRefusal: resumeDecision.refusalReason,
          neutralizedEnvKeys,
          droppedOutputLines: attempt.droppedOutputLines,
          timeoutSec: timeout.timeoutSec,
          timeoutSource: timeout.source,
        },
      },
    });
  };

  const first = await runAttempt(resumeDecision.resumeSessionId);
  const firstState = first.aggregator.state;
  const resumeFailed = firstState.resultSeen
    ? firstState.resultIsError
    : first.proc.exitCode !== null && first.proc.exitCode !== 0;
  if (
    resumeDecision.resumeSessionId &&
    resumeFailed &&
    !first.nonResultOutputSeen &&
    first.droppedOutputLines === 0 &&
    !first.proc.timedOut &&
    !first.proc.signal &&
    !first.proc.errorCode &&
    !firstState.aborted &&
    !ctx.signal?.aborted &&
    isSessionUnrecoverable(
      normalizeHaystack(
        firstState.resultText,
        firstState.resultErrors.join("\n"),
        tail(first.proc.stderr),
      ),
    )
  ) {
    await onLog(
      "stdout",
      `[paperclip] Qoder session "${resumeDecision.resumeSessionId}" could not be resumed; ` +
        `retrying once with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, { attemptedResume: false, clearSessionOnMissingSession: true });
  }
  return toResult(first, {
    attemptedResume: Boolean(resumeDecision.resumeSessionId),
    clearSessionOnMissingSession: false,
  });
}

async function forwardEvent(
  onEvent: AdapterExecutionContext["onEvent"],
  event: AdapterRuntimeEvent,
): Promise<void> {
  if (!onEvent) return;
  await onEvent(event);
}

function tail(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text === "") return null;
  return text.length > STDERR_SCAN_CHARS ? text.slice(-STDERR_SCAN_CHARS) : text;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "unknown error.";
}

function readTrimmedContextString(context: Record<string, unknown>, key: string): string | null {
  const value = context[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Mirrors the wake/approval variables the built-in local adapters export. */
function applyWakeEnv(env: Record<string, string>, context: Record<string, unknown>): void {
  const taskId =
    readTrimmedContextString(context, "taskId") ?? readTrimmedContextString(context, "issueId");
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;

  const wakeReason = readTrimmedContextString(context, "wakeReason");
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  const wakeCommentId =
    readTrimmedContextString(context, "wakeCommentId") ??
    readTrimmedContextString(context, "commentId");
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;

  const approvalId = readTrimmedContextString(context, "approvalId");
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;

  const approvalStatus = readTrimmedContextString(context, "approvalStatus");
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      )
    : [];
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
}

type ResolvedInstructions = {
  prefix: string;
  /** Directory to expose via --add-dir so sibling instruction files load. */
  addDir: string | null;
  note: string | null;
};

/**
 * Loads the managed instructions bundle (the agent's AGENTS.md).
 *
 * A missing or unreadable file is a warning, not a failure: the agent still has
 * the task brief, and failing the run would make a bad path look like a model
 * problem.
 */
async function readInstructions(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<ResolvedInstructions> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) return { prefix: "", addDir: null, note: null };

  const instructionsDir = path.dirname(instructionsFilePath);
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    return {
      prefix:
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve relative file references from ${instructionsDir}/, which is authoritative ` +
        `for sibling instruction files.`,
      addDir: instructionsDir,
      note: `Loaded agent instructions from ${instructionsFilePath} and added --add-dir ${instructionsDir}.`,
    };
  } catch (error) {
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file ` +
        `"${instructionsFilePath}": ${errorText(error)}\n`,
    );
    return {
      prefix: "",
      addDir: null,
      note: `Configured instructionsFilePath ${instructionsFilePath} could not be read; continuing without injected instructions.`,
    };
  }
}
