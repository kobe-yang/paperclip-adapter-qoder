/**
 * Narrow view of the Qoder CLI `--output-format stream-json` wire protocol.
 *
 * Field names verified against `@qoder-ai/qoder-agent-sdk@1.0.56`
 * (`dist/protocol/messages.d.ts`, `dist/protocol/common.d.ts`) and against live
 * `qoder@1.1.80` output captured in `tests/fixtures/`. Only the fields this
 * adapter actually consumes are modelled; every parser below tolerates unknown
 * `type`/`subtype` values so a newer CLI cannot break a run.
 */

export const QODER_WIRE_PROTOCOL_VERIFIED = "1.5.0";
export const QODER_CLI_VERIFIED = "1.1.80";

export type QoderTextBlock = { type: "text"; text?: string };
export type QoderThinkingBlock = { type: "thinking"; thinking?: string };
export type QoderToolUseBlock = {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
};
export type QoderToolResultBlock = {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

export type QoderContentBlock =
  | QoderTextBlock
  | QoderThinkingBlock
  | QoderToolUseBlock
  | QoderToolResultBlock
  | { type: string; [key: string]: unknown };

/** `SDKAssistantMessageError` in the SDK. */
export type QoderAssistantError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export type QoderUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  credits?: number;
};

export type QoderResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd";

export type QoderInitMessage = {
  type: "system";
  subtype: "init";
  session_id?: string;
  cwd?: string;
  model?: string;
  qodercli_version?: string;
  protocol_version?: string;
  /** `'none'` means the CLI has no usable credential. */
  apiKeySource?: "none" | "user" | "project" | "org" | "temporary" | "oauth";
  permissionMode?: string;
  tools?: string[];
};

export type QoderAssistantMessage = {
  type: "assistant";
  session_id?: string;
  error?: QoderAssistantError;
  aborted?: true;
  isApiErrorMessage?: true;
  message?: {
    model?: string;
    stop_reason?: string | null;
    content?: QoderContentBlock[];
    usage?: QoderUsage;
  };
};

export type QoderUserMessage = {
  type: "user";
  session_id?: string;
  message?: { role?: string; content?: QoderContentBlock[] | string };
};

export type QoderResultMessage = {
  type: "result";
  subtype: QoderResultSubtype;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  error_code?: number | string;
  num_turns?: number;
  duration_ms?: number;
  stop_reason?: string | null;
  terminal_reason?: string | null;
  total_cost_usd?: number;
  total_credits?: number;
  usage?: QoderUsage;
  modelUsage?: Record<string, { costUSD?: number } & QoderUsage>;
  permission_denials?: Array<{ tool_name?: string; message?: string }>;
};

export type QoderPermissionDeniedMessage = {
  type: "system";
  subtype: "permission_denied";
  session_id?: string;
  tool_name?: string;
  message?: string;
  decision_reason?: string;
};

export type QoderGenericMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
};

export type QoderMessage =
  | QoderInitMessage
  | QoderAssistantMessage
  | QoderUserMessage
  | QoderResultMessage
  | QoderPermissionDeniedMessage
  | QoderGenericMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one JSONL line. Returns null for blank lines and non-JSON noise. */
export function parseQoderLine(line: string): QoderMessage | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  return parsed as QoderMessage;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Flattens a content block array into display text. */
export function blockText(block: QoderContentBlock): string {
  if (!isRecord(block)) return "";
  if (block.type === "text") return asString(block.text);
  if (block.type === "thinking") return asString(block.thinking);
  return "";
}

/** Normalizes a `tool_result` content payload, which may be string or blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => (isRecord(entry) ? blockText(entry as QoderContentBlock) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
