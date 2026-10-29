import { describe, expect, it } from "vitest";

import { QoderStreamAggregator, type AggregateState } from "../src/aggregate.js";
import {
  buildExecutionResult,
  isSuccessfulAttempt,
  resolveBillingType,
  resolveCost,
  toUsageSummary,
  type AttemptProcess,
} from "../src/outcome.js";

function stateWith(overrides: Partial<AggregateState> = {}): AggregateState {
  return { ...new QoderStreamAggregator().state, ...overrides };
}

const cleanExit: AttemptProcess = { exitCode: 0, signal: null, timedOut: false };

function build(
  state: AggregateState,
  proc: AttemptProcess = cleanExit,
  overrides: Partial<Parameters<typeof buildExecutionResult>[0]> = {},
) {
  return buildExecutionResult({
    state,
    proc,
    configuredModel: "",
    attemptedResume: false,
    sessionParams: null,
    resolvedSessionId: null,
    clearSession: false,
    timeoutMessage: "timed out after 30s",
    ...overrides,
  });
}

const okResult = {
  resultSeen: true,
  resultIsError: false,
  resultText: "完成了修复。",
} satisfies Partial<AggregateState>;

describe("isSuccessfulAttempt", () => {
  it("requires both a clean exit and a non-error terminal result", () => {
    expect(isSuccessfulAttempt({ state: stateWith(okResult), proc: cleanExit })).toBe(true);
  });

  it("rejects the CLI's exit-0-with-error case", () => {
    // Verified against qoder@1.1.80: an unauthenticated run exits 0 and emits
    // {"subtype":"success","is_error":true}.
    expect(
      isSuccessfulAttempt({
        state: stateWith({ resultSeen: true, resultIsError: true }),
        proc: cleanExit,
      }),
    ).toBe(false);
  });

  it("rejects a run that never reported a result, however clean the exit", () => {
    expect(isSuccessfulAttempt({ state: stateWith(), proc: cleanExit })).toBe(false);
  });

  it("rejects timeouts, non-zero exits and transport errors", () => {
    const state = stateWith(okResult);
    expect(isSuccessfulAttempt({ state, proc: { ...cleanExit, timedOut: true } })).toBe(false);
    expect(isSuccessfulAttempt({ state, proc: { ...cleanExit, exitCode: 1 } })).toBe(false);
    expect(
      isSuccessfulAttempt({ state, proc: { ...cleanExit, errorCode: "bridge_lost" } }),
    ).toBe(false);
  });

  it("accepts a run the host stopped after its terminal result", () => {
    // Regression: this adapter asks the host to stop the CLI once the terminal
    // result is in (`terminalResultCleanup`), because the CLI stays alive after
    // answering. That leaves exitCode null and signal SIGTERM on a run that
    // fully succeeded. Requiring exitCode === 0 marked every such run failed
    // and surfaced the agent's own answer as an error message.
    expect(
      isSuccessfulAttempt({
        state: stateWith(okResult),
        proc: { exitCode: null, signal: "SIGTERM", timedOut: false },
      }),
    ).toBe(true);
  });

  it("rejects a non-zero exit even after a clean result", () => {
    expect(
      isSuccessfulAttempt({
        state: stateWith(okResult),
        proc: { exitCode: 3, signal: null, timedOut: false },
      }),
    ).toBe(false);
  });

  it("rejects a run the CLI itself flagged as errored or aborted", () => {
    expect(
      isSuccessfulAttempt({
        state: stateWith({ ...okResult, assistantError: "authentication_failed" }),
        proc: cleanExit,
      }),
    ).toBe(false);
    expect(
      isSuccessfulAttempt({ state: stateWith({ ...okResult, aborted: true }), proc: cleanExit }),
    ).toBe(false);
  });
});

describe("usage reporting", () => {
  it("returns undefined rather than zeros when the CLI reported no usage", () => {
    expect(toUsageSummary(stateWith())).toBeUndefined();
  });

  it("folds cache writes into inputTokens and keeps cache reads separate", () => {
    // UsageSummary.inputTokens is documented as uncached input plus cache
    // writes; cacheWriteTokens is a subset of it, not an extra total.
    const usage = toUsageSummary(
      stateWith({
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          cachedInputTokens: 8000,
          cacheWriteTokens: 200,
        },
      }),
    );
    expect(usage).toEqual({
      inputTokens: 1200,
      outputTokens: 50,
      cachedInputTokens: 8000,
      cacheWriteTokens: 200,
    });
  });
});

describe("resolveCost", () => {
  it("passes through a reported positive cost", () => {
    expect(resolveCost(stateWith({ resultSeen: true, totalCostUsd: 0.25 }), undefined)).toEqual({
      costUsd: 0.25,
      costStatus: "reported",
    });
  });

  it("accepts a genuine zero when nothing was consumed", () => {
    expect(
      resolveCost(stateWith({ resultSeen: true, totalCostUsd: 0 }), {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
    ).toEqual({ costUsd: 0, costStatus: "reported" });
  });

  it("refuses to call a token-consuming run free", () => {
    // A credits-plan run reports $0 next to real token counts. Reporting that
    // as a $0 cost would be a fabricated number, so it is unpriced instead.
    expect(
      resolveCost(stateWith({ resultSeen: true, totalCostUsd: 0 }), {
        inputTokens: 1800,
        outputTokens: 90,
        cachedInputTokens: 0,
      }),
    ).toEqual({ costUsd: null, costStatus: "unpriced" });
  });

  it("refuses to call a credits-consuming run free when tokens read zero", () => {
    // Observed on a real run: total_cost_usd 0, total_credits 11.62, and every
    // token counter 0. Credits are the billing unit, so USD is unknown here —
    // not zero.
    expect(
      resolveCost(
        stateWith({ resultSeen: true, totalCostUsd: 0, totalCredits: 11.62484788 }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      ),
    ).toEqual({ costUsd: null, costStatus: "unpriced" });
  });

  it("marks cost unknown when the CLI reported none or never finished", () => {
    expect(resolveCost(stateWith({ resultSeen: true }), undefined).costStatus).toBe("unpriced");
    expect(resolveCost(stateWith({ totalCostUsd: 5 }), undefined).costStatus).toBe("unpriced");
  });
});

describe("resolveBillingType", () => {
  it("only names a billing type the evidence supports", () => {
    expect(resolveBillingType(stateWith({ totalCredits: 41 }))).toBe("credits");
    expect(resolveBillingType(stateWith({ apiKeySource: "user" }))).toBe("api");
    expect(resolveBillingType(stateWith({ apiKeySource: "none" }))).toBe("unknown");
    expect(resolveBillingType(stateWith())).toBe("unknown");
  });
});

describe("buildExecutionResult", () => {
  it("reports success with the CLI's own closing text as the summary", () => {
    const result = build(stateWith({ ...okResult, model: "qoder-x" }));
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("完成了修复。");
    expect(result.model).toBe("qoder-x");
    expect(result.usageBasis).toBe("per_run");
    expect(result.provider).toBe("qoder");
  });

  it("does not let a zero exit code mark an errored run as successful", () => {
    const result = build(
      stateWith({
        resultSeen: true,
        resultIsError: true,
        resultText: "Not logged in · Please run /login",
        assistantError: "authentication_failed",
        totalCostUsd: 0,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("qoder_auth_required");
    expect(result.errorFamily).toBe("configuration");
  });

  it("reports a timeout with the host's own timeout message", () => {
    const result = build(stateWith(okResult), { exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("qoder_timeout");
    expect(result.errorMessage).toBe("timed out after 30s");
    expect(result.summary).toBeNull();
  });

  it("reports a cancelled run as cancelled, never as success", () => {
    const result = build(stateWith(), { exitCode: null, signal: "SIGTERM", timedOut: false });
    expect(result.errorCode).toBe("qoder_cancelled");
    expect(result.errorMessage).toContain("SIGTERM");
    expect(result.summary).toBeNull();
  });

  it("keeps the CLI's answer when it is stopped after reporting a result", () => {
    // The post-result cleanup signal must not turn a finished run into a
    // cancellation or a failure.
    const result = build(stateWith(okResult), {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
    });
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("完成了修复。");
  });

  it("reproduces the real run that was wrongly reported as failed", () => {
    // Exact shape of the terminal result from a real Qoder run on 2026-10-29:
    // subtype success, is_error false, a real answer, credits spent, all token
    // counters zero, no terminal_reason field — then SIGTERM from the
    // post-result cleanup. Text neutralized; see tests/fixtures/README.md.
    const answer = "已在 issue 线程上用中文回复并再次标记为 done。";
    const result = build(
      stateWith({
        initSeen: true,
        resultSeen: true,
        resultSubtype: "success",
        resultIsError: false,
        resultText: answer,
        stopReason: "end_turn",
        terminalReason: null,
        numTurns: 3,
        durationMs: 24641,
        totalCostUsd: 0,
        totalCredits: 11.62484788,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
      }),
      { exitCode: null, signal: "SIGTERM", timedOut: false },
    );

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe(answer);
    // Credits were spent, so USD is unknown rather than zero.
    expect(result.costStatus).toBe("unpriced");
    expect(result.costUsd).toBeNull();
    expect(result.billingType).toBe("credits");
  });

  it("prefers a host transport error code over its own classification", () => {
    const result = build(
      stateWith({ resultSeen: true, resultIsError: true, resultText: "Not logged in" }),
      { exitCode: 1, signal: null, timedOut: false, errorCode: "bridge_lost" },
    );
    expect(result.errorCode).toBe("bridge_lost");
  });

  it("keeps a raw summary when no cause can be proven", () => {
    const result = build(stateWith({ initSeen: true, resultSeen: true, resultIsError: true }), {
      exitCode: 3,
      signal: null,
      timedOut: false,
    });
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toContain("exited with code 3");
  });

  it("publishes diagnostics without leaking anything secret", () => {
    const result = build(stateWith(okResult), cleanExit, {
      diagnostics: { qoderAdapter: { permissionMode: "auto", neutralizedEnvKeys: ["QODER_CLI"] } },
    });
    const json = JSON.stringify(result.resultJson);
    expect(json).toContain("permissionMode");
    expect(json).toContain("cliVersion");
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  it("carries the session handle and the clear-session flag through", () => {
    const result = build(stateWith(okResult), cleanExit, {
      resolvedSessionId: "sess-9",
      sessionParams: { sessionId: "sess-9", cwd: "/tmp/a" },
      clearSession: false,
    });
    expect(result.sessionId).toBe("sess-9");
    expect(result.sessionDisplayId).toBe("sess-9");
    expect(result.sessionParams).toEqual({ sessionId: "sess-9", cwd: "/tmp/a" });

    const cleared = build(stateWith(okResult), cleanExit, { clearSession: true });
    expect(cleared.clearSession).toBe(true);
  });

  it("falls back to the configured model when the CLI reported a synthetic one", () => {
    const result = build(stateWith({ ...okResult, model: null }), cleanExit, {
      configuredModel: "qoder-configured",
    });
    expect(result.model).toBe("qoder-configured");
  });
});
