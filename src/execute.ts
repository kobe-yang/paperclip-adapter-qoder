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

import type { ChildProcess } from "node:child_process";
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
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
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
  runningProcesses,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  signalRunningProcess,
  type TerminalResultCleanupEvidence,
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
  const cancellation = createCancellationScope(ctx.signal);
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  try {
    await ctx.onCancellationReady?.();
    if (!cancellation.prepareAttempt()) return cancelledBeforeSpawn(ctx);
    return await runQoder(ctx, providerStop, cancellation);
  } finally {
    try {
      await cancellation.dispose();
    } finally {
      await providerStop.collectBeforeRestore();
    }
  }
}

type ProviderStopBoundary = ReturnType<typeof createProviderStoppedBoundary>;
type CancellationScope = ReturnType<typeof createCancellationScope>;
type ProcessResult = Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>;
type SpawnInfo = Parameters<NonNullable<AdapterExecutionContext["onSpawn"]>>[0];

function cancelledBeforeSpawn(ctx: AdapterExecutionContext): AdapterExecutionResult {
  const stored = readStoredSession(ctx.runtime.sessionParams, ctx.runtime.sessionId);
  return buildExecutionResult({
    state: new QoderStreamAggregator().state,
    proc: { exitCode: null, signal: null, timedOut: false },
    configuredModel: asString(ctx.config.model, ""),
    attemptedResume: false,
    sessionParams: ctx.runtime.sessionParams ?? null,
    resolvedSessionId: stored?.sessionId ?? null,
    clearSession: false,
    timeoutMessage: "",
    cancelled: true,
  });
}

function createCancellationScope(signal: AbortSignal | undefined) {
  let cancelled = false;
  let preparing = true;
  let disposed = false;
  let active: OwnedInvocation | null = null;
  const invocations: OwnedInvocation[] = [];
  const abort = () => {
    if (disposed || (!preparing && !active) || active?.isStopped()) return;
    cancelled = true;
    active?.stop();
  };
  signal?.addEventListener("abort", abort);
  return {
    get cancelled() { return cancelled; },
    prepareAttempt() {
      preparing = true;
      if (signal?.aborted) abort();
      return !cancelled;
    },
    own(invocation: OwnedInvocation) {
      active = invocation;
      preparing = false;
      invocations.push(invocation);
      if (signal?.aborted) abort();
    },
    finish(invocation: OwnedInvocation) {
      if (active === invocation) {
        active = null;
        preparing = false;
      }
    },
    async dispose() {
      try {
        await Promise.all(invocations.map((invocation) => invocation.settle()));
      } finally {
        disposed = true;
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

class OwnedInvocation {
  private owned: { pid: number; processGroupId: number | null; startedAt: string; child: ChildProcess | null } | null = null;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private helperSettlement: Promise<void> = Promise.resolve();
  private resolveStopFailure!: () => void;
  private stopFailure = new Promise<void>((resolve) => { this.resolveStopFailure = resolve; });
  private spawnSettlements: Promise<void>[] = [];
  private settlement: Promise<void> | null = null;
  helperSettled = false;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private verified = false;
  private escalated = false;
  private probeError: string | null = null;
  timedOut = false;
  stopError: string | null = null;
  private cleanup: (Omit<TerminalResultCleanupEvidence, "stopped"> & { stopped: boolean }) | null = null;

  get terminalResultCleanup(): TerminalResultCleanupEvidence | null {
    return this.cleanup?.stopped ? { ...this.cleanup, stopped: true } : null;
  }

  constructor(
    private runId: string,
    private graceSec: number,
    private timeoutSec: number,
    private confirmStopped: () => void,
  ) {}

  private groupGone(): boolean {
    if (this.verified) return true;
    const owned = this.owned;
    if (!owned) return false;
    if (process.platform === "win32" || !owned.processGroupId) {
      this.probeError = "No owned POSIX process group is available; descendant termination is unverified.";
      return false;
    }
    try {
      process.kill(-owned.processGroupId, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        this.verified = true;
        return true;
      }
      this.probeError = `Owned process group ${owned.processGroupId} liveness check failed: ${errorText(error)}`;
      return false;
    }
  }

  isStopped(): boolean {
    return this.verified || this.groupGone();
  }

  async capture(info: SpawnInfo): Promise<void> {
    // The SDK publishes its entry only after calling onSpawn, before this microtask resumes.
    await Promise.resolve();
    const entry = runningProcesses.get(this.runId);
    const child = entry?.child.pid === info.pid && entry.processGroupId === info.processGroupId
      ? entry.child : null;
    child?.stdout?.setEncoding("utf8");
    child?.stderr?.setEncoding("utf8");
    this.owned = {
      pid: info.pid,
      processGroupId: info.processGroupId === info.pid && info.pid > 0 ? info.pid : null,
      startedAt: info.startedAt,
      child,
    };
    child?.once("exit", this.stopOnExit);
    child?.once("close", this.stopOnExit);
    child?.once("error", this.stopOnExit);
    if (this.stopRequested) {
      this.stop();
    } else if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.stop();
    } else if (this.timeoutSec > 0) {
      this.timeoutTimer = setTimeout(() => {
        if (this.isStopped()) return;
        this.timedOut = true;
        this.stop();
      }, this.timeoutSec * 1000);
    }
    if (!child) await this.stopPromise;
  }

  trackSpawn(callback: Promise<void>): void {
    this.spawnSettlements.push(callback.then(() => {}, () => {}));
  }

  trackHelper(helper: Promise<ProcessResult>): void {
    const settled = () => { this.helperSettled = true; this.stop(); };
    this.helperSettlement = helper.then(settled, settled);
  }

  waitForHelper(helper: Promise<ProcessResult>): Promise<ProcessResult | null> {
    return Promise.race([helper, this.stopFailure.then(() => null)]);
  }

  unverifiedSnapshot(stdout: string, stderr: string): ProcessResult {
    return {
      exitCode: this.owned?.child?.exitCode ?? null,
      signal: this.owned?.child?.signalCode ?? null,
      timedOut: this.timedOut,
      errorCode: "qoder_provider_stop_unverified",
      stdout,
      stderr,
      pid: this.owned?.pid ?? null,
      startedAt: this.owned?.startedAt ?? null,
    };
  }

  noteTerminalResult(): void {
    if (this.stopRequested || this.terminalTimer || this.isStopped()) return;
    this.terminalTimer = setTimeout(() => {
      this.terminalTimer = null;
      if (this.stopRequested || this.isStopped()) return;
      this.cleanup = {
        kind: "terminal_result_cleanup",
        stopped: false,
        stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
        reason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
        terminalResultSeen: true,
        signal: "SIGTERM",
        forceKilled: false,
      };
      this.stop();
    }, TERMINAL_RESULT_GRACE_MS);
  }

  private stopOnExit = (): void => { this.stop(); };

  private clearWorkTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.timeoutTimer = null;
    this.terminalTimer = null;
  }

  private send(signal: NodeJS.Signals): void {
    const owned = this.owned;
    if (!owned || this.groupGone()) return;
    try {
      if (owned.child) signalRunningProcess({ child: owned.child, processGroupId: owned.processGroupId }, signal);
      else if (process.platform !== "win32" && owned.processGroupId) process.kill(-owned.processGroupId, signal);
    } catch (error) {
      this.probeError = `Owned provider signal ${signal} failed: ${errorText(error)}`;
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.owned?.child?.stdin?.destroy();
    this.clearWorkTimers();
    if (!this.owned || this.stopPromise) return;
    const graceMs = Math.max(0, Number.isFinite(this.graceSec) ? this.graceSec : DEFAULT_GRACE_SEC) * 1000;
    const killAt = Date.now() + graceMs;
    const deadline = killAt + 5_000;
    this.send("SIGTERM");
    this.stopPromise = new Promise<void>((resolve) => {
      const probe = () => {
        this.pollTimer = null;
        if (this.groupGone()) {
          this.verified = true;
          if (this.cleanup) this.cleanup.stopped = true;
          resolve();
          return;
        }
        if (!this.escalated && Date.now() >= killAt) {
          this.escalated = true;
          if (this.cleanup) {
            this.cleanup.signal = "SIGKILL";
            this.cleanup.forceKilled = true;
          }
          this.send("SIGKILL");
        }
        if (Date.now() >= deadline) {
          this.stopError = this.probeError ?? `Owned process group ${this.owned?.processGroupId} still exists after SIGKILL; provider stop is unverified.`;
          this.resolveStopFailure();
          resolve();
          return;
        }
        this.pollTimer = setTimeout(probe, 20);
      };
      probe();
    });
  }

  settle(): Promise<void> {
    this.settlement ??= (async () => {
      try {
        await Promise.race([this.helperSettlement, this.stopFailure]);
        await Promise.race([Promise.all(this.spawnSettlements), this.stopFailure]);
        this.stop();
        await this.stopPromise;
        if (!this.owned) this.stopError = "No owned child metadata was captured; provider termination is unverified.";
        if (this.verified && this.helperSettled) this.confirmStopped();
      } finally {
        this.clearWorkTimers();
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.owned?.child?.removeListener("exit", this.stopOnExit);
        this.owned?.child?.removeListener("close", this.stopOnExit);
        this.owned?.child?.removeListener("error", this.stopOnExit);
      }
    })();
    return this.settlement;
  }
}

async function runQoder(
  ctx: AdapterExecutionContext,
  providerStop: ProviderStopBoundary,
  cancellation: CancellationScope,
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
    stopError: string | null;
    helperSettled: boolean;
  };

  const runAttempt = async (resumeSessionId: string | null): Promise<Attempt | null> => {
    if (!cancellation.prepareAttempt()) return null;
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

    if (!cancellation.prepareAttempt()) return null;
    const invocation = new OwnedInvocation(runId, graceSec, timeout.timeoutSec, providerStop.beginInvocation());
    cancellation.own(invocation);
    const aggregator = new QoderStreamAggregator();
    const splitter = new LineSplitter();
    let acceptingOutput = true;
    let stdoutTail = "";
    let stderrTail = "";
    let nonResultOutputSeen = false;
    const emitLine = async (line: string): Promise<void> => {
      const events = aggregator.ingestLine(line);
      if (aggregator.state.resultSeen) invocation.noteTerminalResult();
      if (line.trim() && (events.length === 0 || events.some((event) => event.eventType !== "result"))) {
        nonResultOutputSeen = true;
      }
      for (const event of events) {
        await forwardEvent(onEvent, event);
      }
    };

    const helper = runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env: childEnv,
      stdin: buildQoderStdinPayload(prompt),
      timeoutSec: 0,
      graceSec,
      onSpawn: (info) => {
        const callback = (async () => {
          await invocation.capture(info);
          await onSpawn?.(info);
        })();
        invocation.trackSpawn(callback);
        return callback;
      },
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: async (stream, chunk) => {
        if (!acceptingOutput) return;
        if (stream === "stdout") stdoutTail = tail(stdoutTail + chunk) ?? "";
        else stderrTail = tail(stderrTail + chunk) ?? "";
        await onLog(stream, chunk);
        if (!acceptingOutput || stream !== "stdout") return;
        for (const line of splitter.push(chunk)) {
          if (!acceptingOutput) return;
          await emitLine(line);
        }
      },
    });
    invocation.trackHelper(helper);
    let proc: ProcessResult;
    try {
      const result = await invocation.waitForHelper(helper);
      proc = result ?? invocation.unverifiedSnapshot(stdoutTail, stderrTail);
    } finally {
      await invocation.settle();
      acceptingOutput = false;
      cancellation.finish(invocation);
    }
    proc = {
      ...proc,
      timedOut: invocation.timedOut,
      errorCode: invocation.stopError ? "qoder_provider_stop_unverified" : proc.errorCode,
      terminalResultCleanup: invocation.terminalResultCleanup,
    };
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

    return {
      proc,
      aggregator,
      droppedOutputLines: splitter.droppedLineCount,
      nonResultOutputSeen,
      stopError: invocation.stopError,
      helperSettled: invocation.helperSettled,
    };
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
      cancelled: cancellation.cancelled,
      diagnostics: {
        qoderAdapter: {
          cancelled: cancellation.cancelled,
          providerStopVerified: !attempt.stopError,
          providerStopError: attempt.stopError,
          helperSettled: attempt.helperSettled,
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
  if (!first) return cancelledBeforeSpawn(ctx);
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
    !cancellation.cancelled &&
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
    if (retry) return toResult(retry, { attemptedResume: false, clearSessionOnMissingSession: true });
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
