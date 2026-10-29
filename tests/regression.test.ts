/**
 * Regression suite for the failure modes that reached production.
 *
 * Four bugs got past the original suite because they only appear with the real
 * CLI's behaviour: it stays alive after answering, it bills in credits with
 * zero token counters, it emits hook/artifact events every turn, and it needs
 * an agent credential to attribute its own comments. Each is locked down here,
 * driven by output recorded from the run that exposed them.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { QoderStreamAggregator, type AggregateState } from "../src/aggregate.js";
import { LineSplitter } from "../src/jsonl.js";
import {
  buildExecutionResult,
  isSuccessfulAttempt,
  resolveBillingType,
  resolveCost,
  type AttemptProcess,
} from "../src/outcome.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const RECORDED = fs.readFileSync(path.join(fixturesDir, "successful-run-recorded.jsonl"), "utf8");

/** Replays recorded stdout through the splitter, as the host delivers it. */
function replay(raw: string, chunkSize = raw.length): QoderStreamAggregator {
  const aggregator = new QoderStreamAggregator();
  const splitter = new LineSplitter();
  for (let at = 0; at < raw.length; at += chunkSize) {
    for (const line of splitter.push(raw.slice(at, at + chunkSize))) aggregator.ingestLine(line);
  }
  for (const line of splitter.flush()) aggregator.ingestLine(line);
  return aggregator;
}

function resultFor(state: AggregateState, proc: AttemptProcess) {
  return buildExecutionResult({
    state,
    proc,
    configuredModel: "",
    attemptedResume: true,
    sessionParams: null,
    resolvedSessionId: state.sessionId,
    clearSession: false,
    timeoutMessage: "timed out",
  });
}

/** How the host actually ends a run of this CLI: killed after its result. */
const STOPPED_AFTER_RESULT: AttemptProcess = {
  exitCode: null,
  signal: "SIGTERM",
  timedOut: false,
};

describe("recorded successful run", () => {
  it("parses cleanly, with no unknown events and no damaged lines", () => {
    const { state } = replay(RECORDED);
    expect(state.unparsedLines).toBe(0);
    expect(state.decodeDamagedLines).toBe(0);
    // Was 4 before hook_started / hook_response / hook_diagnostics /
    // artifacts_update were modelled.
    expect(state.unknownEvents).toBe(0);
  });

  it("reads the terminal result as a success", () => {
    const { state } = replay(RECORDED);
    expect(state.resultSeen).toBe(true);
    expect(state.resultSubtype).toBe("success");
    expect(state.resultIsError).toBe(false);
    expect(state.stopReason).toBe("end_turn");
    expect(state.numTurns).toBe(3);
  });

  it("tolerates a result with no terminal_reason field", () => {
    // Present on the auth-failure path, absent here. It must never be required.
    const { state } = replay(RECORDED);
    expect(state.terminalReason).toBeNull();
  });

  it("does not mistake apiKeySource:none for a missing login", () => {
    // A logged-in subscription run still reports "none", which is why the
    // environment test asks the CLI instead of reading this field.
    const { state } = replay(RECORDED);
    expect(state.apiKeySource).toBe("none");
    expect(state.resultIsError).toBe(false);
  });

  it("reports the run as successful even though the host killed the CLI", () => {
    const { state } = replay(RECORDED);
    const result = resultFor(state, STOPPED_AFTER_RESULT);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe(state.resultText);
    expect(result.summary).toBeTruthy();
  });

  it("does not report a credits-billed run as costing nothing", () => {
    const { state } = replay(RECORDED);
    expect(state.totalCostUsd).toBe(0);
    expect(state.totalCredits).toBeGreaterThan(0);

    const result = resultFor(state, STOPPED_AFTER_RESULT);
    expect(result.costStatus).toBe("unpriced");
    expect(result.costUsd).toBeNull();
    expect(result.billingType).toBe("credits");
  });

  it("reports zero-token usage as zeros, not as missing", () => {
    // This provider populates credits and leaves every token counter at 0.
    const { state } = replay(RECORDED);
    const result = resultFor(state, STOPPED_AFTER_RESULT);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("surfaces the tools the agent used", () => {
    const { state } = replay(RECORDED);
    expect(state.toolNames).toEqual(["Bash", "Bash"]);
  });

  it("keeps the session id for the next run to resume", () => {
    const { state } = replay(RECORDED);
    expect(state.sessionId).toBeTruthy();
  });

  it("produces the same state at every chunk boundary", () => {
    const whole = replay(RECORDED).state;
    for (const chunkSize of [1, 2, 13, 97, 512, 4096]) {
      expect(replay(RECORDED, chunkSize).state, `chunk size ${chunkSize}`).toEqual(whole);
    }
  });

  it("emits the hook and artifact events to the workbench", () => {
    const aggregator = new QoderStreamAggregator();
    const seen: string[] = [];
    for (const line of RECORDED.split("\n")) {
      if (!line.trim()) continue;
      for (const event of aggregator.ingestLine(line)) seen.push(event.eventType);
    }
    for (const expected of [
      "hook_started",
      "hook_diagnostics",
      "hook_response",
      "artifacts_update",
      "init",
      "thinking",
      "tool_call",
      "tool_result",
      "assistant",
      "result",
    ]) {
      expect(seen, expected).toContain(expected);
    }
  });
});

describe("process-outcome decision table", () => {
  const withResult = (overrides: Partial<AggregateState> = {}) => ({
    ...new QoderStreamAggregator().state,
    resultSeen: true,
    resultIsError: false,
    resultText: "done",
    ...overrides,
  });

  // Locks the full matrix. Every row is a shape the real CLI or the host can
  // produce; the `expected` column is the contract.
  const rows: Array<{
    name: string;
    state: AggregateState;
    proc: AttemptProcess;
    expected: boolean;
  }> = [
    {
      name: "clean exit with a clean result",
      state: withResult(),
      proc: { exitCode: 0, signal: null, timedOut: false },
      expected: true,
    },
    {
      name: "killed after a clean result (the normal path)",
      state: withResult(),
      proc: { exitCode: null, signal: "SIGTERM", timedOut: false },
      expected: true,
    },
    {
      name: "force-killed after a clean result",
      state: withResult(),
      proc: { exitCode: null, signal: "SIGKILL", timedOut: false },
      expected: true,
    },
    {
      name: "non-zero exit after a clean result",
      state: withResult(),
      proc: { exitCode: 3, signal: null, timedOut: false },
      expected: false,
    },
    {
      name: "timeout, even with a result already in",
      state: withResult(),
      proc: { exitCode: null, signal: "SIGKILL", timedOut: true },
      expected: false,
    },
    {
      name: "killed before any result (cancellation)",
      state: withResult({ resultSeen: false, resultText: null }),
      proc: { exitCode: null, signal: "SIGTERM", timedOut: false },
      expected: false,
    },
    {
      name: "clean exit but no result (protocol violation)",
      state: withResult({ resultSeen: false, resultText: null }),
      proc: { exitCode: 0, signal: null, timedOut: false },
      expected: false,
    },
    {
      name: "exit 0 with is_error true (the CLI's auth-failure path)",
      state: withResult({ resultIsError: true }),
      proc: { exitCode: 0, signal: null, timedOut: false },
      expected: false,
    },
    {
      name: "assistant-level error",
      state: withResult({ assistantError: "authentication_failed" }),
      proc: { exitCode: 0, signal: null, timedOut: false },
      expected: false,
    },
    {
      name: "aborted mid-run",
      state: withResult({ aborted: true }),
      proc: { exitCode: 0, signal: null, timedOut: false },
      expected: false,
    },
    {
      name: "host transport error",
      state: withResult(),
      proc: { exitCode: 0, signal: null, timedOut: false, errorCode: "bridge_lost" },
      expected: false,
    },
  ];

  for (const row of rows) {
    it(`${row.expected ? "succeeds" : "fails"}: ${row.name}`, () => {
      expect(isSuccessfulAttempt({ state: row.state, proc: row.proc })).toBe(row.expected);
    });
  }

  it("never reports an error message on a successful row", () => {
    for (const row of rows.filter((entry) => entry.expected)) {
      const result = resultFor(row.state, row.proc);
      expect(result.errorCode, row.name).toBeNull();
      expect(result.errorMessage, row.name).toBeNull();
    }
  });

  it("never reports success as a summary-less failure on a failing row", () => {
    for (const row of rows.filter((entry) => !entry.expected)) {
      const result = resultFor(row.state, row.proc);
      // Something must explain the failure: a code, a message, or the timeout
      // flag. Silence would leave the workbench with nothing to show.
      const explained =
        Boolean(result.errorCode) || Boolean(result.errorMessage) || result.timedOut === true;
      expect(explained, row.name).toBe(true);
    }
  });
});

describe("cost decision table", () => {
  const base = { ...new QoderStreamAggregator().state, resultSeen: true };
  const tokens = (input: number, output: number, cached = 0) => ({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
  });

  it("reports a positive USD cost as given", () => {
    expect(resolveCost({ ...base, totalCostUsd: 0.25 }, tokens(10, 5))).toEqual({
      costUsd: 0.25,
      costStatus: "reported",
    });
  });

  it("reports a true zero only when nothing was consumed", () => {
    expect(
      resolveCost({ ...base, totalCostUsd: 0, totalCredits: 0 }, tokens(0, 0)),
    ).toEqual({ costUsd: 0, costStatus: "reported" });
  });

  it("marks USD unknown when credits were spent", () => {
    expect(
      resolveCost({ ...base, totalCostUsd: 0, totalCredits: 11.62 }, tokens(0, 0)),
    ).toEqual({ costUsd: null, costStatus: "unpriced" });
  });

  it("marks USD unknown when tokens were spent", () => {
    expect(resolveCost({ ...base, totalCostUsd: 0 }, tokens(1800, 90))).toEqual({
      costUsd: null,
      costStatus: "unpriced",
    });
  });

  it("marks USD unknown when the CLI reported no cost at all", () => {
    expect(resolveCost({ ...base, totalCostUsd: null }, tokens(10, 5)).costStatus).toBe(
      "unpriced",
    );
  });

  it("marks USD unknown when the run never produced a result", () => {
    expect(
      resolveCost({ ...base, resultSeen: false, totalCostUsd: 5 }, tokens(10, 5)).costStatus,
    ).toBe("unpriced");
  });

  it("names credits as the billing type when credits were spent", () => {
    expect(resolveBillingType({ ...base, totalCredits: 11.62 })).toBe("credits");
  });

  it("does not guess a billing type from apiKeySource:none", () => {
    expect(resolveBillingType({ ...base, apiKeySource: "none" })).toBe("unknown");
  });
});

describe("host success rule: signal must be clear on a successful run", () => {
  // The host decides the run outcome itself, in
  // services/heartbeat/run-completion.js:
  //
  //   (exitCode ?? 0) === 0 && !errorMessage && !signal && !cancellation.failed
  //     ? "succeeded" : "failed"
  //
  // A set `signal` overrides the adapter's own null errorCode, and the run is
  // then recorded as `adapter_failed` / "Adapter failed" with no summary.
  // Observed live: a run with subtype success, is_error false and 1.54 credits
  // spent was recorded as failed for exactly this reason.
  const hostWouldSucceed = (r: {
    exitCode: number | null;
    signal: string | null;
    errorMessage: string | null;
  }) => (r.exitCode ?? 0) === 0 && !r.errorMessage && !r.signal;

  const cleanupEvidence = {
    kind: "terminal_result_cleanup",
    stopped: true,
    stopReason: "unmanaged_background_task_stopped",
    reason: "unmanaged background task stopped; no durable live path",
    terminalResultSeen: true,
    signal: "SIGTERM",
    forceKilled: false,
  };

  it("suppresses the cleanup signal so the host records a success", () => {
    const { state } = replay(RECORDED);
    const result = resultFor(state, {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      terminalResultCleanup: cleanupEvidence,
    });

    expect(result.signal).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(
      hostWouldSucceed({
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        errorMessage: result.errorMessage ?? null,
      }),
    ).toBe(true);
  });

  it("keeps the stop auditable in resultJson rather than hiding it", () => {
    const { state } = replay(RECORDED);
    const result = resultFor(state, {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      terminalResultCleanup: cleanupEvidence,
    });
    expect((result.resultJson as Record<string, unknown>).unmanagedBackgroundTask).toEqual(
      cleanupEvidence,
    );
  });

  it("still reports a signal that was not the post-result cleanup", () => {
    // Cancelled mid-run: no terminal result, no cleanup evidence. The signal is
    // real information and must reach the host.
    const state = { ...new QoderStreamAggregator().state, initSeen: true };
    const result = resultFor(state, {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    });
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorCode).toBe("qoder_cancelled");
  });

  it("does not suppress the signal when the run failed despite cleanup", () => {
    // Terminal result present but flagged as an error: the run failed, so the
    // host should see the signal too.
    const state = {
      ...new QoderStreamAggregator().state,
      initSeen: true,
      resultSeen: true,
      resultIsError: true,
      resultText: "something went wrong",
    };
    const result = resultFor(state, {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      terminalResultCleanup: cleanupEvidence,
    });
    expect(result.signal).toBe("SIGTERM");
    expect(result.errorMessage).toBeTruthy();
  });

  it("does not invent cleanup evidence from a malformed field", () => {
    const { state } = replay(RECORDED);
    for (const bogus of [null, undefined, "stopped", 42, {}, { kind: "other", stopped: true }]) {
      const result = resultFor(state, {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        terminalResultCleanup: bogus,
      });
      expect(result.signal, String(bogus)).toBe("SIGTERM");
    }
  });
});
