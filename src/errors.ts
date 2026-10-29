/**
 * Failure classification for Qoder CLI runs.
 *
 * Deliberately conservative: when the evidence does not clearly indicate a
 * cause, `classifyFailure` returns `null` and the caller keeps the raw error
 * summary rather than attaching a guessed code.
 */

import type { AggregateState } from "./aggregate.js";

export type QoderErrorCode =
  | "qoder_cli_not_found"
  | "qoder_cwd_invalid"
  | "qoder_auth_required"
  | "qoder_permission_denied"
  | "qoder_quota_exceeded"
  | "qoder_network_unavailable"
  | "qoder_session_unrecoverable"
  | "qoder_protocol_violation"
  | "qoder_max_turns"
  | "qoder_max_budget"
  | "qoder_timeout"
  | "qoder_cancelled"
  | "qoder_run_failed";

/** Maps to Paperclip's `AdapterExecutionErrorFamily`. */
export type QoderErrorFamily =
  | "configuration"
  | "transient_upstream"
  | "provider_quota"
  | "model_refusal";

export type Classification = {
  errorCode: QoderErrorCode;
  errorFamily?: QoderErrorFamily;
  errorMessage: string;
};

const AUTH_RE =
  /not\s+logged\s+in|please\s+run\s+\/?login|\bqoder(?:cli)?\s+login\b|unauthorized|\b401\b|authentication[\s_]*failed|invalid\s+api[_\s-]?key|token\s+(?:expired|invalid)/i;

const QUOTA_RE =
  /quota|insufficient\s+credit|out\s+of\s+credit|rate[\s_-]?limit|\b429\b|billing|payment\s+required|\b402\b|subscription\s+(?:expired|required)|usage\s+limit/i;

const NETWORK_RE =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|fetch\s+failed|socket\s+hang\s*up|network\s+error|tunnel(?:ing)?\s+socket|proxy\s+(?:error|connection)|certificate|\b50[0234]\b/i;

const SESSION_RE =
  /session\s+(?:[^\n]{0,40}\s)?not\s+found|unknown\s+session|cannot\s+resume|failed\s+to\s+resume|invalid\s+session|no\s+such\s+session|session\s+(?:id\s+)?(?:is\s+)?(?:invalid|expired)/i;

const CLI_MISSING_RE =
  /ENOENT|command\s+not\s+found|no\s+such\s+file\s+or\s+directory|is\s+not\s+recognized\s+as/i;

const CWD_RE = /ENOTDIR|chdir|working\s+director(?:y|ies)\s+[^\n]{0,40}(?:invalid|not\s+found)/i;

/** Joins and normalizes output for regex scanning. */
export function normalizeHaystack(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function isAuthFailure(haystack: string): boolean {
  return AUTH_RE.test(haystack);
}

export function isQuotaFailure(haystack: string): boolean {
  return QUOTA_RE.test(haystack);
}

export function isNetworkFailure(haystack: string): boolean {
  return NETWORK_RE.test(haystack);
}

export function isSessionUnrecoverable(haystack: string): boolean {
  return SESSION_RE.test(haystack);
}

export function isCliMissing(haystack: string): boolean {
  return CLI_MISSING_RE.test(haystack);
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** First meaningful line of evidence, preferring structured protocol fields. */
export function describeFailure(input: {
  state: AggregateState;
  stderr?: string | null;
  transportError?: string | null;
}): string | null {
  const { state } = input;
  const candidates: Array<string | null | undefined> = [
    state.resultErrors[0],
    state.resultText,
    input.transportError,
    ...(input.stderr ?? "").split(/\r?\n/),
  ];
  for (const candidate of candidates) {
    const text = typeof candidate === "string" ? candidate.trim() : "";
    if (text) return clip(text);
  }
  return null;
}

/**
 * Classifies a failed run.
 *
 * `null` means the cause could not be determined from available evidence; the
 * caller keeps the raw summary instead of inventing a code.
 */
export function classifyFailure(input: {
  state: AggregateState;
  stdoutTail?: string | null;
  stderr?: string | null;
  transportError?: string | null;
  transportErrorCode?: string | null;
  attemptedResume: boolean;
}): Classification | null {
  const { state } = input;
  const detail = describeFailure(input);
  const haystack = normalizeHaystack(
    state.resultText,
    state.resultErrors.join("\n"),
    state.assistantError,
    input.stdoutTail,
    input.stderr,
    input.transportError,
    input.transportErrorCode,
  );

  // Transport-level failures outrank protocol content: if the CLI never ran,
  // nothing it "said" is trustworthy.
  if (!state.initSeen && isCliMissing(normalizeHaystack(input.transportError, input.stderr))) {
    return {
      errorCode: "qoder_cli_not_found",
      errorFamily: "configuration",
      errorMessage:
        detail ??
        "Qoder CLI could not be started. Set the executable path in the adapter config.",
    };
  }
  if (!state.initSeen && CWD_RE.test(haystack)) {
    return {
      errorCode: "qoder_cwd_invalid",
      errorFamily: "configuration",
      errorMessage: detail ?? "Working directory is not a usable directory.",
    };
  }

  // Explicit protocol codes outrank incidental numbers and keywords in logs.
  if (state.assistantError === "authentication_failed") {
    return {
      errorCode: "qoder_auth_required",
      errorFamily: "configuration",
      errorMessage: detail ?? "Qoder CLI is not authenticated. Run `qoder login`.",
    };
  }
  if (state.assistantError === "billing_error" || state.assistantError === "rate_limit") {
    return {
      errorCode: "qoder_quota_exceeded",
      errorFamily: "provider_quota",
      errorMessage: detail ?? "Qoder reported a quota, rate limit or billing problem.",
    };
  }
  if (state.assistantError === "server_error") {
    return {
      errorCode: "qoder_network_unavailable",
      errorFamily: "transient_upstream",
      errorMessage: detail ?? "Qoder could not reach its model backend.",
    };
  }
  if (state.resultSubtype === "error_max_turns") {
    return {
      errorCode: "qoder_max_turns",
      errorMessage: detail ?? "Qoder stopped after reaching its turn limit.",
    };
  }
  if (state.resultSubtype === "error_max_budget_usd") {
    return {
      errorCode: "qoder_max_budget",
      errorFamily: "provider_quota",
      errorMessage: detail ?? "Qoder stopped after reaching its budget limit.",
    };
  }

  // Without a known structured code, retain the original regex precedence.
  if (isAuthFailure(haystack)) {
    return {
      errorCode: "qoder_auth_required",
      errorFamily: "configuration",
      errorMessage: detail ?? "Qoder CLI is not authenticated. Run `qoder login`.",
    };
  }
  if (isQuotaFailure(haystack)) {
    return {
      errorCode: "qoder_quota_exceeded",
      errorFamily: "provider_quota",
      errorMessage: detail ?? "Qoder reported a quota, rate limit or billing problem.",
    };
  }
  if (isNetworkFailure(haystack)) {
    return {
      errorCode: "qoder_network_unavailable",
      errorFamily: "transient_upstream",
      errorMessage: detail ?? "Qoder could not reach its model backend.",
    };
  }
  if (input.attemptedResume && isSessionUnrecoverable(haystack)) {
    return {
      errorCode: "qoder_session_unrecoverable",
      errorMessage: detail ?? "The stored Qoder session could not be resumed.",
    };
  }

  // A run that produced no terminal `result` violated the stream-json contract.
  if (!state.resultSeen) {
    // Unless the output was damaged in transit: the host decodes each stdout
    // chunk on its own, so a multi-byte character on a chunk boundary corrupts
    // the line it lands in. Blaming the CLI's protocol for that would send
    // whoever reads this to the wrong place.
    if (state.decodeDamagedLines > 0) {
      return {
        errorCode: "qoder_protocol_violation",
        errorMessage:
          detail ??
          `${state.decodeDamagedLines} output line(s) were corrupted by the host's per-chunk UTF-8 decoding, ` +
            "so the terminal result could not be read. The run may have succeeded; its outcome is unknown.",
      };
    }
    return {
      errorCode: "qoder_protocol_violation",
      errorMessage:
        detail ??
        "Qoder exited without emitting a terminal result event; the run outcome is unknown.",
    };
  }

  // Every permission request was denied and nothing else explains the failure.
  if (state.permissionDenials.length > 0 && state.resultIsError) {
    const first = state.permissionDenials[0];
    return {
      errorCode: "qoder_permission_denied",
      errorFamily: "configuration",
      errorMessage:
        detail ??
        `Qoder was denied permission to use ${first?.toolName ?? "a required tool"}.`,
    };
  }

  if (detail) {
    return { errorCode: "qoder_run_failed", errorMessage: detail };
  }
  return null;
}
