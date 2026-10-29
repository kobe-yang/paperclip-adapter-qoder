/**
 * Incremental aggregator over the Qoder stream-json event sequence.
 *
 * Holds only bounded summary state, never the full transcript, so a long run
 * cannot grow adapter memory without limit.
 */

import {
  asNumber,
  asString,
  blockText,
  isRecord,
  parseQoderLine,
  toolResultText,
  type QoderAssistantError,
  type QoderContentBlock,
  type QoderMessage,
  type QoderResultSubtype,
  type QoderUsage,
} from "./protocol.js";

/** Retained assistant-text budget; the summary only needs the final message. */
const MAX_ASSISTANT_TEXTS = 40;
const MAX_ASSISTANT_TEXT_CHARS = 20_000;
const MAX_TOOL_NAMES = 200;
const MAX_DENIALS = 50;
const MAX_ERROR_CHARS = 4_000;

export type RuntimeEvent = {
  eventType: string;
  stream?: "system" | "stdout" | "stderr";
  level?: "info" | "warn" | "error";
  message?: string;
  payload?: Record<string, unknown>;
};

export type AggregateUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

export type AggregateState = {
  /** From `system/init`, then confirmed by `result`. */
  sessionId: string | null;
  initSeen: boolean;
  cwd: string | null;
  cliVersion: string | null;
  protocolVersion: string | null;
  apiKeySource: string | null;
  model: string | null;
  /** Terminal `result` event. Absent means the stream never completed. */
  resultSeen: boolean;
  resultSubtype: QoderResultSubtype | null;
  resultIsError: boolean;
  resultText: string | null;
  resultErrors: string[];
  errorCode: string | null;
  terminalReason: string | null;
  stopReason: string | null;
  numTurns: number | null;
  durationMs: number | null;
  /** `total_cost_usd` as reported. `null` means the CLI reported nothing. */
  totalCostUsd: number | null;
  totalCredits: number | null;
  usage: AggregateUsage | null;
  assistantError: QoderAssistantError | null;
  aborted: boolean;
  toolNames: string[];
  permissionDenials: Array<{ toolName: string; message: string }>;
  /** Count of lines that were not valid protocol JSON. */
  unparsedLines: number;
  /**
   * Subset of `unparsedLines` that contained U+FFFD, i.e. output the host's
   * per-chunk UTF-8 decoding damaged before the adapter received it.
   */
  decodeDamagedLines: number;
  /** Count of recognized `type` values this adapter does not model. */
  unknownEvents: number;
};

function emptyState(): AggregateState {
  return {
    sessionId: null,
    initSeen: false,
    cwd: null,
    cliVersion: null,
    protocolVersion: null,
    apiKeySource: null,
    model: null,
    resultSeen: false,
    resultSubtype: null,
    resultIsError: false,
    resultText: null,
    resultErrors: [],
    errorCode: null,
    terminalReason: null,
    stopReason: null,
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    totalCredits: null,
    usage: null,
    assistantError: null,
    aborted: false,
    toolNames: [],
    permissionDenials: [],
    unparsedLines: 0,
    decodeDamagedLines: 0,
    unknownEvents: 0,
  };
}

function mergeUsage(
  previous: AggregateUsage | null,
  usage: QoderUsage | undefined,
): AggregateUsage | null {
  if (!usage || !isRecord(usage)) return previous;
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) {
    return previous;
  }
  // The `result` usage block is turn-cumulative, so replace rather than add.
  return {
    inputTokens: input ?? previous?.inputTokens ?? 0,
    outputTokens: output ?? previous?.outputTokens ?? 0,
    cachedInputTokens: cacheRead ?? previous?.cachedInputTokens ?? 0,
    cacheWriteTokens: cacheWrite ?? previous?.cacheWriteTokens ?? 0,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Accumulates run state and emits workbench events as lines arrive.
 *
 * Assistant texts are kept in a small ring because only the last non-empty one
 * becomes the run summary; keeping every intermediate "Let me check…" line would
 * balloon both memory and the posted issue comment.
 */
export class QoderStreamAggregator {
  readonly state: AggregateState = emptyState();
  private assistantTexts: string[] = [];

  /** Consumes one stdout line. Returns events to forward to the workbench. */
  ingestLine(line: string): RuntimeEvent[] {
    const message = parseQoderLine(line);
    if (!message) {
      if (!line.trim()) return [];
      this.state.unparsedLines += 1;
      // The host decodes each stdout chunk independently (`String(chunk)` in
      // runChildProcess), so a multi-byte character landing on a chunk
      // boundary becomes U+FFFD before any adapter sees it. The bytes are
      // already gone — this counter exists so the damage is reported as a
      // decode loss instead of being blamed on the CLI's protocol.
      if (line.includes("\uFFFD")) this.state.decodeDamagedLines += 1;
      return [];
    }
    return this.ingestMessage(message);
  }

  private ingestMessage(message: QoderMessage): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const type = asString((message as { type?: unknown }).type);
    const subtype = asString((message as { subtype?: unknown }).subtype);
    const sessionId = asString((message as { session_id?: unknown }).session_id).trim();
    if (sessionId) this.state.sessionId = sessionId;

    switch (type) {
      case "system":
        this.ingestSystem(subtype, message, events);
        return events;
      case "assistant":
        this.ingestAssistant(message, events);
        return events;
      case "user":
        this.ingestUser(message, events);
        return events;
      case "result":
        this.ingestResult(message, events);
        return events;
      case "stream_event":
        // Token-level deltas. Intentionally not forwarded: the complete
        // `assistant` message always follows and would duplicate the text.
        return events;
      default:
        this.state.unknownEvents += 1;
        return events;
    }
  }

  private ingestSystem(
    subtype: string,
    message: QoderMessage,
    events: RuntimeEvent[],
  ): void {
    const record = message as Record<string, unknown>;
    if (subtype === "init") {
      this.state.initSeen = true;
      this.state.cwd = asString(record.cwd) || null;
      this.state.cliVersion = asString(record.qodercli_version) || null;
      this.state.protocolVersion = asString(record.protocol_version) || null;
      this.state.apiKeySource = asString(record.apiKeySource) || null;
      this.state.model = asString(record.model) || null;
      events.push({
        eventType: "init",
        stream: "system",
        level: "info",
        message: `Qoder CLI ${this.state.cliVersion ?? "?"} session started`,
        payload: {
          model: this.state.model,
          cwd: this.state.cwd,
          protocolVersion: this.state.protocolVersion,
        },
      });
      return;
    }
    if (subtype === "permission_denied") {
      const toolName = asString(record.tool_name) || "unknown tool";
      const detail =
        asString(record.message) || asString(record.decision_reason) || "denied";
      if (this.state.permissionDenials.length < MAX_DENIALS) {
        this.state.permissionDenials.push({ toolName, message: detail });
      }
      events.push({
        eventType: "permission_denied",
        stream: "system",
        level: "warn",
        message: `Permission denied: ${toolName}`,
        payload: { toolName, detail },
      });
      return;
    }
    if (subtype === "api_retry") {
      events.push({
        eventType: "api_retry",
        stream: "system",
        level: "warn",
        message: `Model request retry ${asNumber(record.attempt) ?? "?"}/${
          asNumber(record.max_retries) ?? "?"
        }`,
        payload: { errorStatus: record.error_status ?? null },
      });
      return;
    }
    if (subtype === "compact_boundary") {
      events.push({
        eventType: "compact_boundary",
        stream: "system",
        level: "info",
        message: "Context compacted",
      });
      return;
    }

    // Hook lifecycle. Field names read off the installed CLI bundle; a real run
    // emits these on every turn, so counting them as unknown would make normal
    // operation look like a protocol mismatch.
    if (subtype === "hook_started") {
      const hookName = asString(record.hook_name) || asString(record.hook_id) || "hook";
      events.push({
        eventType: "hook_started",
        stream: "system",
        level: "info",
        message: `Hook started: ${hookName}`,
        payload: { hookEvent: asString(record.hook_event) || null },
      });
      return;
    }
    if (subtype === "hook_response") {
      const hookName = asString(record.hook_name) || asString(record.hook_id) || "hook";
      const exitCode = asNumber(record.exit_code);
      const failed = exitCode !== null && exitCode !== 0;
      events.push({
        eventType: "hook_response",
        stream: failed ? "stderr" : "system",
        level: failed ? "warn" : "info",
        message: `Hook ${hookName} finished${exitCode === null ? "" : ` with exit ${exitCode}`}`,
        payload: {
          hookEvent: asString(record.hook_event) || null,
          outcome: asString(record.outcome) || null,
          durationMs: asNumber(record.duration_ms),
        },
      });
      return;
    }
    if (subtype === "hook_diagnostics") {
      events.push({
        eventType: "hook_diagnostics",
        stream: "system",
        level: "info",
        message: `Hook configuration ${asString(record.read_status) || "checked"}`,
      });
      return;
    }
    if (subtype === "artifacts_update") {
      const count = Array.isArray(record.artifacts) ? record.artifacts.length : null;
      events.push({
        eventType: "artifacts_update",
        stream: "system",
        level: "info",
        message: count === null ? "Artifacts updated" : `Artifacts updated (${count})`,
      });
      return;
    }

    this.state.unknownEvents += 1;
  }

  private ingestAssistant(message: QoderMessage, events: RuntimeEvent[]): void {
    const record = message as Record<string, unknown>;
    const error = asString(record.error);
    if (error) this.state.assistantError = error as QoderAssistantError;
    if (record.aborted === true) this.state.aborted = true;

    const inner = isRecord(record.message) ? record.message : {};
    this.state.usage = mergeUsage(this.state.usage, inner.usage as QoderUsage | undefined);
    const model = asString(inner.model);
    if (model && model !== "<synthetic>") this.state.model = model;

    const blocks = Array.isArray(inner.content) ? (inner.content as QoderContentBlock[]) : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" || block.type === "thinking") {
        const text = blockText(block).trim();
        if (!text) continue;
        if (block.type === "text") this.pushAssistantText(text);
        events.push({
          eventType: block.type === "thinking" ? "thinking" : "assistant",
          stream: "stdout",
          level: "info",
          message: clip(text, 2_000),
        });
        continue;
      }
      if (block.type === "tool_use") {
        const name = asString(block.name).trim();
        if (!name) continue;
        if (this.state.toolNames.length < MAX_TOOL_NAMES) {
          this.state.toolNames.push(name);
        }
        events.push({
          eventType: "tool_call",
          stream: "stdout",
          level: "info",
          message: `Using ${name}`,
          payload: { toolName: name, toolUseId: asString(block.id) || null },
        });
      }
    }
  }

  private ingestUser(message: QoderMessage, events: RuntimeEvent[]): void {
    const record = message as Record<string, unknown>;
    const inner = isRecord(record.message) ? record.message : {};
    const blocks = Array.isArray(inner.content) ? (inner.content as QoderContentBlock[]) : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const failed = block.is_error === true;
      events.push({
        eventType: "tool_result",
        stream: failed ? "stderr" : "stdout",
        level: failed ? "warn" : "info",
        message: clip(toolResultText(block.content).trim() || "(no output)", 600),
        payload: { isError: failed },
      });
    }
  }

  private ingestResult(message: QoderMessage, events: RuntimeEvent[]): void {
    const record = message as Record<string, unknown>;
    this.state.resultSeen = true;
    const subtype = asString(record.subtype);
    this.state.resultSubtype = (subtype || null) as QoderResultSubtype | null;
    this.state.resultIsError = record.is_error === true;
    this.state.resultText = asString(record.result) || null;
    this.state.terminalReason = asString(record.terminal_reason) || null;
    this.state.stopReason = asString(record.stop_reason) || null;
    this.state.numTurns = asNumber(record.num_turns);
    this.state.durationMs = asNumber(record.duration_ms);
    this.state.totalCostUsd = asNumber(record.total_cost_usd);
    this.state.totalCredits = asNumber(record.total_credits);
    this.state.usage = mergeUsage(this.state.usage, record.usage as QoderUsage | undefined);

    const rawCode = record.error_code;
    if (typeof rawCode === "string" && rawCode.trim()) this.state.errorCode = rawCode.trim();
    else if (typeof rawCode === "number") this.state.errorCode = String(rawCode);

    if (Array.isArray(record.errors)) {
      this.state.resultErrors = record.errors
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .slice(0, 20)
        .map((entry) => clip(entry.trim(), MAX_ERROR_CHARS));
    }

    if (Array.isArray(record.permission_denials)) {
      for (const denial of record.permission_denials) {
        if (!isRecord(denial)) continue;
        if (this.state.permissionDenials.length >= MAX_DENIALS) break;
        this.state.permissionDenials.push({
          toolName: asString(denial.tool_name) || "unknown tool",
          message: asString(denial.message) || "denied",
        });
      }
    }

    events.push({
      eventType: "result",
      stream: "system",
      level: this.state.resultIsError ? "error" : "info",
      message: clip(this.state.resultText ?? subtype, 2_000),
      payload: {
        subtype,
        isError: this.state.resultIsError,
        numTurns: this.state.numTurns,
      },
    });
  }

  private pushAssistantText(text: string): void {
    this.assistantTexts.push(clip(text, MAX_ASSISTANT_TEXT_CHARS));
    if (this.assistantTexts.length > MAX_ASSISTANT_TEXTS) this.assistantTexts.shift();
  }

  /**
   * The run summary.
   *
   * Prefers the CLI's own terminal `result` text, then the last non-empty
   * assistant message. Joining every assistant turn would produce huge issue
   * comments and bury the actual conclusion.
   */
  buildSummary(): string {
    const resultText = this.state.resultText?.trim();
    if (resultText) return resultText;
    for (let index = this.assistantTexts.length - 1; index >= 0; index -= 1) {
      const text = this.assistantTexts[index]?.trim();
      if (text) return text;
    }
    return "";
  }
}
