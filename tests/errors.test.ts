import { describe, expect, it } from "vitest";

import { QoderStreamAggregator, type AggregateState } from "../src/aggregate.js";
import {
  classifyFailure,
  describeFailure,
  isAuthFailure,
  isCliMissing,
  isNetworkFailure,
  isQuotaFailure,
  isSessionUnrecoverable,
  normalizeHaystack,
} from "../src/errors.js";

function stateWith(overrides: Partial<AggregateState> = {}): AggregateState {
  const base = new QoderStreamAggregator().state;
  return { ...base, ...overrides };
}

describe("signal detectors", () => {
  it("recognizes real authentication wording from this CLI", () => {
    expect(isAuthFailure("Not logged in · Please run /login")).toBe(true);
    expect(isAuthFailure("Not logged in. Run `qodercli login` to authenticate.")).toBe(true);
    expect(isAuthFailure("HTTP 401 Unauthorized")).toBe(true);
    expect(isAuthFailure("everything is fine")).toBe(false);
  });

  it("recognizes quota and billing wording", () => {
    for (const text of [
      "429 Too Many Requests",
      "rate limit exceeded",
      "insufficient credits",
      "Payment Required",
      "usage limit reached",
    ]) {
      expect(isQuotaFailure(text), text).toBe(true);
    }
    expect(isQuotaFailure("compilation failed")).toBe(false);
  });

  it("recognizes transport failures", () => {
    for (const text of ["getaddrinfo ENOTFOUND api.example", "fetch failed", "socket hang up", "503"]) {
      expect(isNetworkFailure(text), text).toBe(true);
    }
    expect(isNetworkFailure("test assertion failed")).toBe(false);
  });

  it("recognizes an unusable session id", () => {
    for (const text of [
      "session abc-123 not found",
      "cannot resume session",
      "invalid session",
      "session id is expired",
    ]) {
      expect(isSessionUnrecoverable(text), text).toBe(true);
    }
    expect(isSessionUnrecoverable("session started")).toBe(false);
  });

  it("recognizes a missing executable", () => {
    expect(isCliMissing("spawn qoder ENOENT")).toBe(true);
    expect(isCliMissing("zsh: command not found: qoder")).toBe(true);
    expect(isCliMissing("permission denied")).toBe(false);
  });

  it("normalizes multi-line noise into a scannable haystack", () => {
    expect(normalizeHaystack("  a  ", null, "", "\n b \n\n c\n", undefined)).toBe("a\nb\nc");
  });
});

describe("describeFailure", () => {
  it("prefers the structured protocol error over raw stderr", () => {
    expect(
      describeFailure({
        state: stateWith({ resultErrors: ["model refused the request"] }),
        stderr: "npm notice something irrelevant",
      }),
    ).toBe("model refused the request");
  });

  it("falls back through result text, transport error, then stderr", () => {
    expect(describeFailure({ state: stateWith({ resultText: "boom" }) })).toBe("boom");
    expect(
      describeFailure({ state: stateWith(), transportError: "spawn ENOENT" }),
    ).toBe("spawn ENOENT");
    expect(describeFailure({ state: stateWith(), stderr: "\n\nreal error\n" })).toBe("real error");
  });

  it("returns null when there is no evidence to quote", () => {
    expect(describeFailure({ state: stateWith(), stderr: "   \n\n" })).toBeNull();
  });

  it("clips a very long line", () => {
    const detail = describeFailure({ state: stateWith({ resultText: "x".repeat(5_000) }) });
    expect(detail?.length).toBeLessThanOrEqual(240);
  });
});

describe("classifyFailure", () => {
  it("blames the missing CLI only when the process never started", () => {
    expect(
      classifyFailure({
        state: stateWith({ initSeen: false }),
        transportError: "spawn qoder ENOENT",
        attemptedResume: false,
      }),
    ).toMatchObject({ errorCode: "qoder_cli_not_found", errorFamily: "configuration" });

    // Once the CLI has started, an ENOENT in its own output is about a file the
    // agent touched, not about the CLI itself.
    expect(
      classifyFailure({
        state: stateWith({ initSeen: true, resultSeen: true, resultIsError: true }),
        stderr: "open /tmp/missing.txt: ENOENT",
        attemptedResume: false,
      })?.errorCode,
    ).not.toBe("qoder_cli_not_found");
  });

  it("maps the CLI's own error strings to families", () => {
    expect(
      classifyFailure({
        state: stateWith({ assistantError: "authentication_failed", resultSeen: true }),
        attemptedResume: false,
      }),
    ).toMatchObject({ errorCode: "qoder_auth_required", errorFamily: "configuration" });

    expect(
      classifyFailure({
        state: stateWith({ assistantError: "rate_limit", resultSeen: true }),
        attemptedResume: false,
      }),
    ).toMatchObject({ errorCode: "qoder_quota_exceeded", errorFamily: "provider_quota" });

    expect(
      classifyFailure({
        state: stateWith({ assistantError: "server_error", resultSeen: true }),
        attemptedResume: false,
      }),
    ).toMatchObject({ errorCode: "qoder_network_unavailable", errorFamily: "transient_upstream" });
  });

  it.each([
    {
      overrides: { assistantError: "authentication_failed" },
      log: "quota fixture, 429 rows and 503 samples",
      expected: { errorCode: "qoder_auth_required", errorFamily: "configuration" },
    },
    {
      overrides: { assistantError: "billing_error" },
      log: "Processed 401 rows. Example: token expired.",
      expected: { errorCode: "qoder_quota_exceeded", errorFamily: "provider_quota" },
    },
    {
      overrides: { assistantError: "rate_limit" },
      log: "Completed 401 checks",
      expected: { errorCode: "qoder_quota_exceeded", errorFamily: "provider_quota" },
    },
    {
      overrides: { assistantError: "server_error" },
      log: "401 assertions, 402 fixtures, quota and authentication_failed labels",
      expected: { errorCode: "qoder_network_unavailable", errorFamily: "transient_upstream" },
    },
    {
      overrides: { resultSubtype: "error_max_turns" },
      log: "401 checks, quota example, fetch failed fixture, invalid session sample",
      expected: { errorCode: "qoder_max_turns" },
    },
    {
      overrides: { resultSubtype: "error_max_budget_usd" },
      log: "401 checks, quota example, fetch failed fixture, invalid session sample",
      expected: { errorCode: "qoder_max_budget", errorFamily: "provider_quota" },
    },
  ] as const)("prefers structured $overrides over unrelated log signals", ({ overrides, log, expected }) => {
    for (const source of ["stdoutTail", "stderr", "resultText", "resultErrors"] as const) {
      const classification = classifyFailure({
        state: stateWith({
          initSeen: true,
          resultSeen: true,
          resultIsError: true,
          ...overrides,
          ...(source === "resultText" ? { resultText: log } : {}),
          ...(source === "resultErrors" ? { resultErrors: [log] } : {}),
        }),
        ...(source === "stdoutTail" ? { stdoutTail: log } : {}),
        ...(source === "stderr" ? { stderr: log } : {}),
        attemptedResume: true,
      });
      const fallbackMessages: Record<string, string> = {
        qoder_auth_required: "Qoder CLI is not authenticated. Run `qoder login`.",
        qoder_quota_exceeded: "Qoder reported a quota, rate limit or billing problem.",
        qoder_network_unavailable: "Qoder could not reach its model backend.",
        qoder_max_turns: "Qoder stopped after reaching its turn limit.",
        qoder_max_budget: "Qoder stopped after reaching its budget limit.",
      };
      expect(classification, source).toEqual({
        ...expected,
        errorMessage: source === "stdoutTail" ? fallbackMessages[expected.errorCode] : log,
      });
    }
  });

  it.each([
    { transportError: "spawn qoder ENOENT", errorCode: "qoder_cli_not_found" },
    { transportError: "spawn qoder ENOTDIR: chdir /bad", errorCode: "qoder_cwd_invalid" },
  ])("keeps transport precedence for $errorCode", ({ transportError, errorCode }) => {
    for (const overrides of [
      { assistantError: "authentication_failed" },
      { assistantError: "billing_error" },
      { assistantError: "rate_limit" },
      { assistantError: "server_error" },
      { resultSubtype: "error_max_turns" },
      { resultSubtype: "error_max_budget_usd" },
    ] as const) {
      expect(
        classifyFailure({
          state: stateWith({ initSeen: false, resultSeen: true, ...overrides }),
          transportError,
          attemptedResume: false,
        }),
      ).toEqual({ errorCode, errorFamily: "configuration", errorMessage: transportError });
    }
  });

  it.each([
    { log: "401 checks, quota sample, 503 rows, invalid session", errorCode: "qoder_auth_required" },
    { log: "429 checks, 503 rows, invalid session", errorCode: "qoder_quota_exceeded" },
    { log: "503 rows, invalid session", errorCode: "qoder_network_unavailable" },
    { log: "invalid session", errorCode: "qoder_session_unrecoverable" },
  ])("preserves regex fallback order for $errorCode", ({ log, errorCode }) => {
    expect(
      classifyFailure({
        state: stateWith({
          initSeen: true,
          resultSeen: true,
          assistantError: "invalid_request",
          resultSubtype: "error_during_execution",
        }),
        stdoutTail: log,
        attemptedResume: true,
      })?.errorCode,
    ).toBe(errorCode);
  });

  it("only reports an unrecoverable session when a resume was actually attempted", () => {
    const state = stateWith({ resultSeen: true, resultText: "session xyz not found" });
    expect(classifyFailure({ state, attemptedResume: true })?.errorCode).toBe(
      "qoder_session_unrecoverable",
    );
    expect(classifyFailure({ state, attemptedResume: false })?.errorCode).not.toBe(
      "qoder_session_unrecoverable",
    );
  });

  it("maps the CLI's limit subtypes", () => {
    expect(
      classifyFailure({
        state: stateWith({ resultSeen: true, resultSubtype: "error_max_turns" }),
        attemptedResume: false,
      })?.errorCode,
    ).toBe("qoder_max_turns");
    expect(
      classifyFailure({
        state: stateWith({ resultSeen: true, resultSubtype: "error_max_budget_usd" }),
        attemptedResume: false,
      }),
    ).toMatchObject({ errorCode: "qoder_max_budget", errorFamily: "provider_quota" });
  });

  it("calls a missing terminal result a protocol violation", () => {
    const classification = classifyFailure({
      state: stateWith({ initSeen: true, resultSeen: false }),
      attemptedResume: false,
    });
    expect(classification?.errorCode).toBe("qoder_protocol_violation");
    expect(classification?.errorMessage).toContain("outcome is unknown");
  });

  it("blames the host's decoding, not the CLI, when output arrived corrupted", () => {
    const classification = classifyFailure({
      state: stateWith({ initSeen: true, resultSeen: false, decodeDamagedLines: 3 }),
      attemptedResume: false,
    });
    expect(classification?.errorCode).toBe("qoder_protocol_violation");
    expect(classification?.errorMessage).toContain("UTF-8");
    expect(classification?.errorMessage).toContain("may have succeeded");
  });

  it("reports permission denial when nothing else explains the failure", () => {
    const classification = classifyFailure({
      state: stateWith({
        resultSeen: true,
        resultIsError: true,
        permissionDenials: [{ toolName: "Bash", message: "not pre-approved" }],
      }),
      attemptedResume: false,
    });
    expect(classification).toMatchObject({
      errorCode: "qoder_permission_denied",
      errorFamily: "configuration",
    });
  });

  it("keeps the raw summary when the cause cannot be determined", () => {
    const classification = classifyFailure({
      state: stateWith({ resultSeen: true, resultIsError: true, resultText: "something odd" }),
      attemptedResume: false,
    });
    expect(classification).toEqual({
      errorCode: "qoder_run_failed",
      errorMessage: "something odd",
    });
  });

  it("returns null rather than guessing when there is no evidence at all", () => {
    expect(
      classifyFailure({
        state: stateWith({ initSeen: true, resultSeen: true, resultIsError: true }),
        attemptedResume: false,
      }),
    ).toBeNull();
  });

  it("prefers the real auth failure over an unrelated quota word in the log", () => {
    const classification = classifyFailure({
      state: stateWith({
        resultSeen: true,
        resultIsError: true,
        resultText: "Not logged in · Please run /login",
      }),
      stdoutTail: "note: your plan has a usage limit",
      attemptedResume: false,
    });
    expect(classification?.errorCode).toBe("qoder_auth_required");
  });
});
