"use strict";

/**
 * Browser-side transcript parser for Qoder CLI stdout.
 *
 * Loaded by the Paperclip UI inside a sandboxed Web Worker (fetch, WebSocket,
 * Worker and Blob are nulled there), so this file:
 *
 *   - is CommonJS, because the host evaluates it with `new Function`;
 *   - uses no Node API and no import of any kind;
 *   - treats every line as untrusted data. Output is parsed and copied into
 *     transcript fields, never evaluated, and never used to build a URL.
 *
 * It mirrors `src/aggregate.ts` on purpose: the server aggregate decides the
 * run outcome, this one decides what the transcript shows. Keeping them
 * separate avoids shipping server code into the browser sandbox.
 */

var MAX_TEXT_CHARS = 20000;
var MAX_TOOL_RESULT_CHARS = 8000;
var MAX_BLOCKS = 200;

function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function clip(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? text.slice(0, max) + "\n… (truncated)" : text;
}

function blockList(message) {
  if (!message) return [];
  var content = message.content;
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_BLOCKS);
}

/** Tool results arrive as a string, or as an array of text blocks. */
function toolResultText(block) {
  var content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length && i < MAX_BLOCKS; i += 1) {
    var entry = asRecord(content[i]);
    if (!entry) continue;
    var text = asString(entry.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function parseInit(record, ts) {
  var entries = [
    {
      kind: "init",
      ts: ts,
      model: asString(record.model),
      sessionId: asString(record.session_id),
    },
  ];
  var notes = [];
  var cliVersion = asString(record.qodercli_version);
  var protocolVersion = asString(record.protocol_version);
  var permissionMode = asString(record.permissionMode) || asString(record.permission_mode);
  var apiKeySource = asString(record.apiKeySource) || asString(record.api_key_source);
  if (cliVersion) notes.push("CLI " + cliVersion);
  if (protocolVersion) notes.push("protocol " + protocolVersion);
  if (permissionMode) notes.push("permission mode " + permissionMode);
  // `none` means the CLI found no credential; surfacing it here explains an
  // otherwise opaque authentication failure a few lines later.
  if (apiKeySource) notes.push("credential source " + apiKeySource);
  if (notes.length > 0) {
    entries.push({ kind: "system", ts: ts, text: "Qoder session started: " + notes.join(", ") });
  }
  return entries;
}

function parseSystem(record, ts) {
  var subtype = asString(record.subtype);
  if (subtype === "init") return parseInit(record, ts);

  if (subtype === "permission_denied") {
    var toolName = asString(record.tool_name) || "a tool";
    var reason =
      asString(record.message) || asString(record.decision_reason) || asString(record.content);
    return [
      {
        kind: "provider_activity",
        ts: ts,
        family: "safety",
        eventType: "permission_denied",
        status: "failed",
        title: "Permission denied: " + toolName,
        summary: reason || "The run was not allowed to use this tool.",
        payload: {
          toolName: toolName,
          reason: reason,
          decisionReasonType: asString(record.decision_reason_type),
        },
      },
    ];
  }

  if (subtype === "api_retry") {
    var attempt = asNumber(record.attempt);
    var maxRetries = asNumber(record.max_retries);
    var retryMessage = asString(record.error) || asString(record.content);
    return [
      {
        kind: "provider_activity",
        ts: ts,
        family: "provider_notice",
        eventType: "api_retry",
        status: "running",
        title: attempt
          ? "Retrying model request (attempt " + attempt + (maxRetries ? "/" + maxRetries : "") + ")"
          : "Retrying model request",
        summary: retryMessage || "The CLI is retrying a failed model request.",
        payload: {
          attempt: attempt,
          maxRetries: maxRetries,
          errorStatus: record.error_status === undefined ? null : record.error_status,
          message: retryMessage,
        },
      },
    ];
  }

  if (subtype === "compact_boundary") {
    var compactMetadata = asRecord(record.compact_metadata) || {};
    var trigger = asString(compactMetadata.trigger);
    var preTokens = asNumber(compactMetadata.pre_tokens);
    return [
      {
        kind: "provider_activity",
        ts: ts,
        family: "context",
        eventType: "compact_boundary",
        status: "informational",
        title: "Conversation compacted",
        summary: trigger
          ? "Context was compacted (" + trigger + ")."
          : "Earlier context was summarized to free room.",
        payload: { trigger: trigger, preTokens: preTokens },
      },
    ];
  }

  // Hook lifecycle and artifact updates. A real run emits these every turn.
  if (subtype === "hook_started" || subtype === "hook_response") {
    var hookName = asString(record.hook_name) || asString(record.hook_id) || "hook";
    var hookDone = subtype === "hook_response";
    var hookExit = hookDone ? asNumber(record.exit_code) : 0;
    return [
      {
        kind: "provider_activity",
        ts: ts,
        family: "hook",
        eventType: subtype,
        status: hookDone ? (hookExit === 0 ? "completed" : "failed") : "running",
        title: (hookDone ? "Hook finished: " : "Hook started: ") + hookName,
        summary:
          asString(record.hook_event) ||
          asString(record.outcome) ||
          "Qoder ran a configured hook.",
        payload: {
          hookEvent: asString(record.hook_event),
          outcome: asString(record.outcome),
          exitCode: hookDone ? hookExit : null,
          durationMs: hookDone ? asNumber(record.duration_ms) : null,
        },
      },
    ];
  }

  if (subtype === "hook_diagnostics") {
    return [
      {
        kind: "system",
        ts: ts,
        text: "Hook configuration " + (asString(record.read_status) || "checked") + ".",
      },
    ];
  }

  if (subtype === "artifacts_update") {
    var artifactCount = Array.isArray(record.artifacts) ? record.artifacts.length : null;
    return [
      {
        kind: "provider_activity",
        ts: ts,
        family: "artifact",
        eventType: "artifacts_update",
        status: "informational",
        title: "Artifacts updated",
        summary:
          artifactCount === null
            ? "The run reported an artifact update."
            : "The run reported " + artifactCount + " artifact(s).",
        payload: { count: artifactCount },
      },
    ];
  }

  var text = asString(record.message) || asString(record.text);
  return [{ kind: "system", ts: ts, text: text || "Qoder system event: " + (subtype || "unknown") }];
}

function parseAssistant(record, ts) {
  var entries = [];
  var error = asString(record.error);
  var blocks = blockList(asRecord(record.message));

  for (var i = 0; i < blocks.length; i += 1) {
    var block = asRecord(blocks[i]);
    if (!block) continue;
    var type = asString(block.type);

    if (type === "text") {
      var text = asString(block.text);
      if (text.trim()) {
        entries.push({ kind: "assistant", ts: ts, text: clip(text, MAX_TEXT_CHARS) });
      }
      continue;
    }

    if (type === "thinking" || type === "redacted_thinking") {
      var thinking = asString(block.thinking) || asString(block.text);
      if (thinking.trim()) {
        entries.push({ kind: "thinking", ts: ts, text: clip(thinking, MAX_TEXT_CHARS) });
      }
      continue;
    }

    if (type === "tool_use") {
      var toolCall = {
        kind: "tool_call",
        ts: ts,
        name: asString(block.name) || "unknown_tool",
        input: block.input,
      };
      var toolUseId = asString(block.id);
      if (toolUseId) toolCall.toolUseId = toolUseId;
      entries.push(toolCall);
    }
  }

  if (error) {
    entries.push({ kind: "stderr", ts: ts, text: "Qoder reported an error: " + error });
  }
  return entries;
}

/**
 * `user` lines are the CLI echoing tool results back into the conversation.
 * The prompt itself is sent on stdin and never appears on stdout, so a `user`
 * line with no tool_result block carries nothing worth rendering.
 */
function parseUser(record, ts) {
  var entries = [];
  var blocks = blockList(asRecord(record.message));
  for (var i = 0; i < blocks.length; i += 1) {
    var block = asRecord(blocks[i]);
    if (!block || asString(block.type) !== "tool_result") continue;
    entries.push({
      kind: "tool_result",
      ts: ts,
      toolUseId: asString(block.tool_use_id),
      content: clip(toolResultText(block), MAX_TOOL_RESULT_CHARS),
      isError: block.is_error === true,
    });
  }
  return entries;
}

function parseResult(record, ts) {
  var usage = asRecord(record.usage) || {};
  var errors = [];
  if (Array.isArray(record.errors)) {
    for (var i = 0; i < record.errors.length; i += 1) {
      var entry = record.errors[i];
      if (typeof entry === "string" && entry.trim()) errors.push(entry.trim());
    }
  }
  var errorCode = asString(record.error_code);
  if (errorCode) errors.push("error_code: " + errorCode);

  var entries = [
    {
      kind: "result",
      ts: ts,
      text: clip(asString(record.result), MAX_TEXT_CHARS),
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedTokens: asNumber(usage.cache_read_input_tokens),
      costUsd: asNumber(record.total_cost_usd),
      subtype: asString(record.subtype),
      isError: record.is_error === true,
      errors: errors,
    },
  ];

  // The CLI can exit 0 on a failed run, so the terminal reason is the only
  // place some stop causes (auth, budget, turn limit) are named.
  var terminalReason = asString(record.terminal_reason);
  if (terminalReason && terminalReason !== "completed") {
    entries.push({ kind: "system", ts: ts, text: "Qoder stopped: " + terminalReason });
  }
  return entries;
}

function parseStdoutLine(line, ts) {
  var cleaned = stripAnsi(typeof line === "string" ? line : "");
  var trimmed = cleaned.trim();
  if (!trimmed) return [];

  // Anything that is not a JSONL object is CLI chatter (a banner, a warning).
  if (trimmed.charAt(0) !== "{") {
    return [{ kind: "stdout", ts: ts, text: cleaned }];
  }

  var record = asRecord(safeJsonParse(trimmed));
  if (!record) {
    return [{ kind: "stdout", ts: ts, text: cleaned }];
  }

  var type = asString(record.type);
  if (type === "system") return parseSystem(record, ts);
  if (type === "assistant") return parseAssistant(record, ts);
  if (type === "user") return parseUser(record, ts);
  if (type === "result") return parseResult(record, ts);

  // `stream_event` carries the raw provider deltas that the `assistant` lines
  // already contain in assembled form; rendering both would duplicate every
  // sentence.
  if (type === "stream_event") return [];

  return [
    {
      kind: "system",
      ts: ts,
      text: "Unhandled Qoder event: " + (type || "missing type"),
    },
  ];
}

module.exports = { parseStdoutLine };
