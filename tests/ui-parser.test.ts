import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parserPath = path.join(projectDir, "ui-parser.cjs");
const source = fs.readFileSync(parserPath, "utf8");

type Entry = Record<string, any>;
type ParseStdoutLine = (line: string, ts: string) => Entry[];

/**
 * Loads the parser the way the host does: evaluated with `new Function` inside
 * a worker where fetch/WebSocket/Worker/Blob are nulled. `require` throws so a
 * stray Node dependency fails here instead of in the browser.
 */
function loadParser(): ParseStdoutLine {
  const factory = new Function("module", "exports", "require", `${source}\nreturn module.exports;`);
  const moduleObj = { exports: {} as { parseStdoutLine?: ParseStdoutLine } };
  const exported = factory(moduleObj, moduleObj.exports, () => {
    throw new Error("ui-parser must not call require()");
  }) as { parseStdoutLine?: ParseStdoutLine };
  if (typeof exported.parseStdoutLine !== "function") {
    throw new Error("ui-parser did not export parseStdoutLine");
  }
  return exported.parseStdoutLine;
}

const parse = loadParser();
const TS = "2026-10-29T12:00:00.000Z";
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * Code with comments removed. The file's own header documents the sandbox it
 * runs in, so it legitimately mentions `new Function` and "no Node API";
 * scanning the raw text would flag the explanation instead of the code.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

function kinds(entries: Entry[]): string[] {
  return entries.map((entry) => entry.kind);
}

describe("ui-parser module contract", () => {
  it("is a CommonJS module with no Node dependency", () => {
    for (const forbidden of [
      "require(",
      "import ",
      "import(",
      "process.",
      "__dirname",
      "__filename",
      "Buffer",
      "node:",
    ]) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("is declared in package.json under the host's parser contract", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
    expect(pkg.exports["./ui-parser"]).toBe("./ui-parser.cjs");
    expect(String(pkg.paperclip.adapterUiParser).split(".")[0]).toBe("1");
    expect(pkg.files).toContain("ui-parser.cjs");
  });

  it("never evaluates CLI output", () => {
    // Output is untrusted data. A parser that evaluated it would hand the
    // browser arbitrary code from whatever the agent happened to print.
    expect(code.includes("eval(")).toBe(false);
    expect(code.includes("new Function")).toBe(false);
    expect(code.includes("innerHTML")).toBe(false);
  });
});

describe("ui-parser — protocol lines", () => {
  it("turns system/init into an init entry plus a readable note", () => {
    const entries = parse(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "qoder-x",
        qodercli_version: "1.1.80",
        protocol_version: "1.5.0",
        permissionMode: "auto",
        apiKeySource: "none",
      }),
      TS,
    );
    expect(kinds(entries)).toEqual(["init", "system"]);
    expect(entries[0]).toMatchObject({ model: "qoder-x", sessionId: "sess-1", ts: TS });
    // `apiKeySource: none` is the thing that explains an auth failure further
    // down the transcript, so it must be visible.
    expect(entries[1]?.text).toContain("credential source none");
    expect(entries[1]?.text).toContain("CLI 1.1.80");
  });

  it("renders assistant text and thinking on separate channels", () => {
    const entries = parse(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先确认文件内容" },
            { type: "text", text: "我修好了 calc.js。" },
          ],
        },
      }),
      TS,
    );
    expect(kinds(entries)).toEqual(["thinking", "assistant"]);
    expect(entries[0]?.text).toBe("先确认文件内容");
    expect(entries[1]?.text).toBe("我修好了 calc.js。");
  });

  it("renders a tool call with its input", () => {
    const entries = parse(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/tmp/a.js" } },
          ],
        },
      }),
      TS,
    );
    expect(entries[0]).toMatchObject({
      kind: "tool_call",
      name: "Edit",
      toolUseId: "toolu_1",
      input: { file_path: "/tmp/a.js" },
    });
  });

  it("handles both tool_result content encodings", () => {
    const asBlocks = parse(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: false,
              content: [{ type: "text", text: "file contents" }],
            },
          ],
        },
      }),
      TS,
    );
    expect(asBlocks[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "toolu_1",
      content: "file contents",
      isError: false,
    });

    const asString = parse(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "boom" },
          ],
        },
      }),
      TS,
    );
    expect(asString[0]).toMatchObject({ content: "boom", isError: true });
  });

  it("does not render the prompt echo as a user message", () => {
    // The prompt travels on stdin, so a `user` line with no tool_result is
    // bookkeeping and would just duplicate the task brief in the transcript.
    expect(
      parse(JSON.stringify({ type: "user", message: { role: "user", content: "the prompt" } }), TS),
    ).toEqual([]);
  });

  it("maps the terminal result with tokens and cost", () => {
    const entries = parse(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0.0412,
        usage: { input_tokens: 1800, output_tokens: 90, cache_read_input_tokens: 8192 },
        terminal_reason: "completed",
      }),
      TS,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "result",
      text: "done",
      inputTokens: 1800,
      outputTokens: 90,
      cachedTokens: 8192,
      costUsd: 0.0412,
      isError: false,
      errors: [],
    });
  });

  it("surfaces a non-completed terminal reason, which can explain an exit 0 failure", () => {
    const entries = parse(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        total_cost_usd: 0,
        usage: ZERO_USAGE,
        terminal_reason: "auth_payload_invalid",
        errors: ["SDK auth payload file not found"],
        error_code: "auth_failed",
      }),
      TS,
    );
    expect(kinds(entries)).toEqual(["result", "system"]);
    expect(entries[0]?.isError).toBe(true);
    expect(entries[0]?.errors).toEqual([
      "SDK auth payload file not found",
      "error_code: auth_failed",
    ]);
    expect(entries[1]?.text).toContain("auth_payload_invalid");
  });

  it("renders permission denials and retries as provider activity", () => {
    const denied = parse(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        message: "command not pre-approved",
        decision_reason_type: "auto_deny",
      }),
      TS,
    );
    expect(denied[0]).toMatchObject({
      kind: "provider_activity",
      family: "safety",
      status: "failed",
      title: "Permission denied: Bash",
      summary: "command not pre-approved",
    });

    const retry = parse(
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 3,
        error_status: 503,
        error: "upstream unavailable",
      }),
      TS,
    );
    expect(retry[0]).toMatchObject({ family: "provider_notice", status: "running" });
    expect(retry[0]?.title).toBe("Retrying model request (attempt 2/3)");

    const compacted = parse(
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 120_000 },
      }),
      TS,
    );
    expect(compacted[0]).toMatchObject({ family: "context", status: "informational" });
    expect(compacted[0]?.summary).toContain("auto");
  });
});

describe("ui-parser — USD pricing receipts", () => {
  it.each([
    { name: "observed credits with all-zero tokens", total_cost_usd: 0, total_credits: 3.931968, usage: ZERO_USAGE },
    { name: "credits and tokens with zero USD", total_cost_usd: 0, total_credits: 3.931968, usage: { ...ZERO_USAGE, input_tokens: 10 } },
    { name: "missing USD and usage" },
    { name: "missing USD with explicit zero usage", usage: ZERO_USAGE },
    { name: "input tokens with zero USD", total_cost_usd: 0, usage: { input_tokens: 10 } },
    { name: "output tokens with zero USD", total_cost_usd: 0, usage: { output_tokens: 5 } },
    { name: "cache reads with zero USD", total_cost_usd: 0, usage: { cache_read_input_tokens: 5 } },
    { name: "cache writes with zero USD", total_cost_usd: 0, usage: { cache_creation_input_tokens: 5 } },
  ])("avoids a free result badge: $name", ({ name: _name, ...fields }) => {
    const entries = parse(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "completed work",
      ...fields,
    }), TS);
    expect(kinds(entries)).toEqual(["provider_activity"]);
    expect(entries[0]).toMatchObject({
      ts: TS,
      family: "terminal",
      eventType: "result",
      status: "completed",
      summary: "completed work",
      payload: { subtype: "success", isError: false, errors: [], costUsd: null, costStatus: "unpriced" },
    });
    expect(entries[0]?.title).toContain("USD cost unavailable");
    if ("total_credits" in fields) {
      expect(entries[0]?.title).toContain("Qoder credits");
      expect(entries[0]?.title).toContain(String(fields.total_credits));
      expect(entries[0]?.payload.totalCredits).toBe(fields.total_credits);
    }
    expect(entries[0]).not.toHaveProperty("costUsd");
    expect(entries[0]).not.toHaveProperty("inputTokens");
  });

  it.each([null, -1, "0", "0.25"])("does not treat invalid USD %j as reported", (usd) => {
    const [entry] = parse(JSON.stringify({ type: "result", total_cost_usd: usd, usage: ZERO_USAGE }), TS);
    expect(entry?.kind).toBe("provider_activity");
    expect(entry?.payload).toMatchObject({ costUsd: null, costStatus: "unpriced" });
  });

  it("does not treat a non-finite JSON number as reported USD", () => {
    const [entry] = parse('{"type":"result","total_cost_usd":1e400}', TS);
    expect(entry?.kind).toBe("provider_activity");
    expect(entry?.payload.costUsd).toBeNull();
  });

  it("preserves only known usage without inventing zero counters", () => {
    const [entry] = parse(JSON.stringify({
      type: "result",
      usage: { input_tokens: 10, output_tokens: "5", cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
    }), TS);
    expect(entry?.payload.usage).toEqual({ inputTokens: 10, cachedInputTokens: 7, cacheWriteTokens: 3 });
    expect(entry?.payload.totalCredits).toBeNull();
    const [missing] = parse(JSON.stringify({ type: "result" }), TS);
    expect(missing?.payload.usage).toEqual({});
  });

  it("keeps positive USD as a result even when credits are also reported", () => {
    const entries = parse(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "done",
      total_cost_usd: 0.25, total_credits: 3.931968,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
    }), TS);
    expect(entries).toEqual([{
      kind: "result", ts: TS, text: "done", inputTokens: 10, outputTokens: 5,
      cachedTokens: 7, costUsd: 0.25, subtype: "success", isError: false, errors: [],
    }]);
  });

  it.each([
    { usage: ZERO_USAGE, total_credits: 0 },
    { usage: ZERO_USAGE },
    {},
  ])("keeps explicit zero USD with no consumption as a numeric result: %j", (fields) => {
    const entries = parse(JSON.stringify({ type: "result", total_cost_usd: 0, ...fields }), TS);
    expect(kinds(entries)).toEqual(["result"]);
    expect(entries[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });
  });

  it("preserves unpriced failure errors and the terminal reason", () => {
    const entries = parse(JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true,
      result: "Request failed", total_cost_usd: 0, total_credits: 3.931968,
      terminal_reason: "auth_payload_invalid",
      errors: [" SDK auth payload file not found ", "", 7], error_code: "auth_failed",
    }), TS);
    expect(kinds(entries)).toEqual(["provider_activity", "system"]);
    expect(entries[0]).toMatchObject({
      family: "terminal", eventType: "result", status: "failed", summary: "Request failed",
      payload: {
        subtype: "error_during_execution", isError: true,
        errors: ["SDK auth payload file not found", "error_code: auth_failed"],
        costUsd: null, costStatus: "unpriced", totalCredits: 3.931968, usage: {},
      },
    });
    expect(entries[0]?.title).toContain("USD cost unavailable");
    expect(entries[0]?.title).toContain("Qoder credits");
    expect(entries[1]).toEqual({ kind: "system", ts: TS, text: "Qoder stopped: auth_payload_invalid" });
  });

  it("clips the unpriced receipt summary", () => {
    const [entry] = parse(JSON.stringify({ type: "result", result: "x".repeat(100_000) }), TS);
    expect(entry?.summary.length).toBeLessThan(21_000);
    expect(entry?.summary).toContain("truncated");
  });
});

describe("ui-parser — robustness", () => {
  it("drops blank lines", () => {
    expect(parse("", TS)).toEqual([]);
    expect(parse("   \t ", TS)).toEqual([]);
  });

  it("drops stream_event, which the assistant lines already carry", () => {
    expect(
      parse(JSON.stringify({ type: "stream_event", event: { delta: "partial" } }), TS),
    ).toEqual([]);
  });

  it("falls back to raw stdout for non-JSON chatter", () => {
    const entries = parse("npm warn something unrelated", TS);
    expect(entries[0]).toMatchObject({ kind: "stdout", text: "npm warn something unrelated" });
  });

  it("falls back to raw stdout for truncated JSON instead of throwing", () => {
    expect(parse('{"type":"assistant","message"', TS)[0]?.kind).toBe("stdout");
  });

  it("strips ANSI escapes", () => {
    const entries = parse("\u001B[31mred text\u001B[0m", TS);
    expect(entries[0]?.text).toBe("red text");
  });

  it("names an unhandled event type rather than silently dropping it", () => {
    const entries = parse(JSON.stringify({ type: "telemetry_v9" }), TS);
    expect(entries[0]).toMatchObject({ kind: "system" });
    expect(entries[0]?.text).toContain("telemetry_v9");
  });

  it("tolerates a JSON array or scalar line", () => {
    expect(parse("[1,2,3]", TS)[0]?.kind).toBe("stdout");
    expect(parse("42", TS)[0]?.kind).toBe("stdout");
  });

  it("survives missing and wrongly typed fields", () => {
    expect(() => parse(JSON.stringify({ type: "assistant" }), TS)).not.toThrow();
    expect(() => parse(JSON.stringify({ type: "assistant", message: 7 }), TS)).not.toThrow();
    expect(() =>
      parse(JSON.stringify({ type: "assistant", message: { content: "plain string" } }), TS),
    ).not.toThrow();
    expect(() => parse(JSON.stringify({ type: "result", usage: "nope" }), TS)).not.toThrow();
    expect(parse(JSON.stringify({ type: "result", usage: "nope" }), TS)[0]).toMatchObject({
      kind: "provider_activity", payload: { usage: {}, costUsd: null, costStatus: "unpriced" },
    });
  });

  it("clips very long text so one line cannot flood the transcript", () => {
    const entries = parse(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100_000) }] },
      }),
      TS,
    );
    expect(entries[0]?.text.length).toBeLessThan(21_000);
    expect(entries[0]?.text).toContain("truncated");
  });

  it("bounds the number of content blocks it will walk", () => {
    const content = Array.from({ length: 5_000 }, (_, i) => ({
      type: "text",
      text: `block ${i}`,
    }));
    const entries = parse(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content } }),
      TS,
    );
    expect(entries.length).toBeLessThanOrEqual(200);
  });

  it("passes the timestamp through unchanged on every entry", () => {
    const entries = parse(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
      TS,
    );
    for (const entry of entries) expect(entry.ts).toBe(TS);
  });
});
