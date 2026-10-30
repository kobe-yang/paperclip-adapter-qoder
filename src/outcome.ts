/**
 * Maps a finished attempt onto Paperclip's `AdapterExecutionResult`.
 *
 * Pure, so the rules below are asserted directly in tests.
 *
 * The central rule: **a zero exit code is not success.** `qoder@1.1.80` exits 0
 * while emitting `{"type":"result","is_error":true}` — an unauthenticated run
 * does exactly that. Success therefore requires a terminal `result` event that
 * is not an error, on top of a clean process exit.
 */

import type {
  AdapterBillingType,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils/types";

import type { AggregateState } from "./aggregate.js";
import { classifyFailure, describeFailure } from "./errors.js";

export const QODER_PROVIDER = "qoder";

export type AttemptProcess = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Transport-level error code from the host's run-disposition seam. */
  errorCode?: string | null;
  stdoutTail?: string | null;
  stderr?: string | null;
  /**
   * Host evidence that it stopped a process which had already delivered its
   * terminal result, because this adapter asked it to
   * (`terminalResultCleanup`). Present only when that cleanup actually fired.
   */
  terminalResultCleanup?: unknown;
};

export type OutcomeInput = {
  state: AggregateState;
  proc: AttemptProcess;
  /** Model from config, used only when the CLI reported none. */
  configuredModel: string;
  attemptedResume: boolean;
  sessionParams: Record<string, unknown> | null;
  resolvedSessionId: string | null;
  /** True when a stored session was refused or proved unusable. */
  clearSession: boolean;
  timeoutMessage: string;
  cancelled?: boolean;
  /** Extra diagnostics for the workbench; must never contain credentials. */
  diagnostics?: Record<string, unknown>;
};

/**
 * Converts the Qoder usage block to Paperclip's shape.
 *
 * `UsageSummary.inputTokens` is documented as uncached input *plus cache
 * writes*, with cache reads counted separately, so the cache-creation count is
 * added into `inputTokens` and also reported as `cacheWriteTokens` (a subset,
 * not an extra total).
 */
export function toUsageSummary(state: AggregateState): UsageSummary | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function totalReportedTokens(usage: UsageSummary | undefined): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens + (usage.cachedInputTokens ?? 0);
}

export type CostResolution = {
  costUsd: number | null;
  costStatus: "reported" | "estimated" | "unpriced";
};

/**
 * Resolves cost without inventing a number.
 *
 * A reported `0` is only passed through when the run also consumed nothing.
 * A credits-plan run reports `total_cost_usd: 0` next to a real
 * `total_credits` value and all-zero token counters, so credits are checked
 * too — otherwise a run that genuinely cost 11.6 credits would be recorded as
 * a free run.
 */
export function resolveCost(
  state: AggregateState,
  usage: UsageSummary | undefined,
): CostResolution {
  if (!state.resultSeen || state.totalCostUsd === null) {
    return { costUsd: null, costStatus: "unpriced" };
  }
  if (state.totalCostUsd > 0) {
    return { costUsd: state.totalCostUsd, costStatus: "reported" };
  }
  const consumedCredits = (state.totalCredits ?? 0) > 0;
  if (totalReportedTokens(usage) === 0 && !consumedCredits) {
    return { costUsd: 0, costStatus: "reported" };
  }
  return { costUsd: null, costStatus: "unpriced" };
}

/** Billing type, only when the evidence names one. */
export function resolveBillingType(state: AggregateState): AdapterBillingType {
  if (state.totalCredits !== null && state.totalCredits > 0) return "credits";
  if (state.apiKeySource === "user" || state.apiKeySource === "project") return "api";
  return "unknown";
}

/**
 * True only for a run that reported a clean terminal result and did not fail
 * at the process level.
 *
 * The terminal `result` event is the authority, not the exit code. The CLI
 * routinely stays alive after answering (background tasks, telemetry flush),
 * so this adapter asks the host to stop it once the result is in
 * (`terminalResultCleanup`). That cleanup leaves `exitCode: null` and
 * `signal: "SIGTERM"` on a perfectly successful run, so neither a null exit
 * code nor a signal can disqualify one. A *non-zero* exit code still does:
 * the process reported its own failure.
 */
export function isSuccessfulAttempt(input: {
  state: AggregateState;
  proc: AttemptProcess;
  cancelled?: boolean;
}): boolean {
  const { state, proc } = input;
  if (input.cancelled) return false;
  if (proc.timedOut) return false;
  if (proc.errorCode) return false;
  if (proc.exitCode !== null && proc.exitCode !== 0) return false;
  if (!state.resultSeen) return false;
  if (state.resultIsError) return false;
  if (state.assistantError) return false;
  if (state.aborted) return false;
  return true;
}

/**
 * True when the host stopped a process that had already delivered its terminal
 * result, i.e. the signal came from this adapter's own `terminalResultCleanup`
 * request rather than from anything going wrong.
 */
export function wasStoppedAfterTerminalResult(proc: AttemptProcess): boolean {
  const evidence = proc.terminalResultCleanup;
  if (typeof evidence !== "object" || evidence === null) return false;
  const record = evidence as { kind?: unknown; stopped?: unknown };
  return record.kind === "terminal_result_cleanup" && record.stopped === true;
}

export function buildExecutionResult(input: OutcomeInput): AdapterExecutionResult {
  const { state, proc } = input;
  const usage = toUsageSummary(state);
  const { costUsd, costStatus } = resolveCost(state, usage);
  const model = state.model && state.model !== "<synthetic>" ? state.model : input.configuredModel;
  const succeeded = isSuccessfulAttempt(input);
  const stoppedAfterResult = wasStoppedAfterTerminalResult(proc);

  const resultJson: Record<string, unknown> = {
    qoder: {
      cliVersion: state.cliVersion,
      protocolVersion: state.protocolVersion,
      resultSubtype: state.resultSubtype,
      terminalReason: state.terminalReason,
      stopReason: state.stopReason,
      numTurns: state.numTurns,
      durationMs: state.durationMs,
      totalCredits: state.totalCredits,
      toolNames: state.toolNames,
      permissionDenials: state.permissionDenials,
      unparsedLines: state.unparsedLines,
      decodeDamagedLines: state.decodeDamagedLines,
      unknownEvents: state.unknownEvents,
      resumed: input.attemptedResume,
    },
    // Keep the evidence even when the signal is suppressed below, so the stop
    // is auditable rather than hidden.
    ...(proc.terminalResultCleanup
      ? { unmanagedBackgroundTask: proc.terminalResultCleanup }
      : {}),
    ...(input.diagnostics ?? {}),
    ...(input.cancelled && proc.errorCode !== "qoder_provider_stop_unverified"
      ? { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } }
      : {}),
  };

  const base = {
    exitCode: proc.exitCode,
    // The host marks a run failed whenever `signal` is set
    // (`services/heartbeat/run-completion.js`), regardless of this adapter's
    // own errorCode. On a successful run the only signal is the one this
    // adapter asked the host to send once the answer was already in, so
    // reporting it would turn every successful Qoder run into a failure.
    // The evidence stays in `resultJson.unmanagedBackgroundTask`.
    signal: succeeded && stoppedAfterResult ? null : proc.signal,
    usage,
    usageBasis: "per_run" as const,
    // The stream-json protocol has no post-exit usage receipt to reconcile
    // against, so collection closes with this run.
    usageComplete: proc.errorCode !== "qoder_provider_stop_unverified",
    provider: QODER_PROVIDER,
    biller: QODER_PROVIDER,
    model: model || null,
    billingType: resolveBillingType(state),
    costUsd,
    costStatus,
    sessionId: input.resolvedSessionId,
    sessionParams: input.sessionParams,
    sessionDisplayId: input.resolvedSessionId,
    resultJson,
    clearSession: input.clearSession,
  } satisfies Partial<AdapterExecutionResult>;

  if (proc.timedOut) {
    return {
      ...base,
      timedOut: true,
      errorMessage: input.timeoutMessage,
      errorCode: "qoder_timeout",
      summary: null,
    };
  }

  if (proc.errorCode === "qoder_provider_stop_unverified") {
    return {
      ...base,
      timedOut: false,
      errorCode: proc.errorCode,
      errorMessage: "Qoder provider termination could not be verified; stop collection was withheld.",
      summary: null,
    };
  }

  if (input.cancelled) {
    return {
      ...base,
      timedOut: false,
      errorCode: "qoder_cancelled",
      errorMessage: "Qoder execution was cancelled by the run's operator cancellation signal.",
      summary: null,
    };
  }

  if (succeeded) {
    return {
      ...base,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      summary: buildSummaryOrNull(state),
    };
  }

  // A signal with no timeout and no terminal result means the process was
  // stopped from outside: Paperclip cancelling the run by id, or an operator
  // killing it. The post-result cleanup signal cannot land here, because by
  // then `resultSeen` is true and the branches above have already returned.
  if (proc.signal && !state.resultSeen) {
    return {
      ...base,
      timedOut: false,
      errorCode: "qoder_cancelled",
      errorMessage:
        `Qoder CLI was stopped by signal ${proc.signal} before it reported a result, ` +
        `so the run was cancelled rather than completed.`,
      summary: null,
    };
  }

  const classification = classifyFailure({
    state,
    stdoutTail: proc.stdoutTail ?? null,
    stderr: proc.stderr ?? null,
    transportError: null,
    transportErrorCode: proc.errorCode ?? null,
    attemptedResume: input.attemptedResume,
  });

  // No classification means the evidence did not name a cause. Keep the raw
  // summary rather than attaching a guessed code.
  const fallbackMessage =
    describeFailure({ state, stderr: proc.stderr ?? null }) ??
    (proc.signal
      ? `Qoder CLI was terminated by signal ${proc.signal}.`
      : `Qoder CLI exited with code ${proc.exitCode ?? -1} and no diagnosable error.`);

  return {
    ...base,
    timedOut: false,
    errorMessage: classification?.errorMessage ?? fallbackMessage,
    // The host's transport code outranks provider classification: a lost
    // control channel is a host fact, not something the CLI reported.
    errorCode: proc.errorCode ?? classification?.errorCode ?? null,
    ...(classification?.errorFamily ? { errorFamily: classification.errorFamily } : {}),
    summary: buildSummaryOrNull(state),
  };
}

function buildSummaryOrNull(state: AggregateState): string | null {
  const text = state.resultText?.trim();
  return text ? text : null;
}
