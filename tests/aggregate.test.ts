import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { QoderStreamAggregator } from "../src/aggregate.js";
import { LineSplitter } from "../src/jsonl.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

/** Feeds raw output through the splitter in fixed-size chunks, as the host does. */
function ingest(raw: string, chunkSize = raw.length): QoderStreamAggregator {
  const aggregator = new QoderStreamAggregator();
  const splitter = new LineSplitter();
  for (let at = 0; at < raw.length; at += chunkSize) {
    for (const line of splitter.push(raw.slice(at, at + chunkSize))) {
      aggregator.ingestLine(line);
    }
  }
  for (const line of splitter.flush()) aggregator.ingestLine(line);
  return aggregator;
}

describe("QoderStreamAggregator — recorded auth failure", () => {
  const raw = readFixture("auth-failure.jsonl");

  it("reads the session id and init metadata", () => {
    const { state } = ingest(raw);
    expect(state.initSeen).toBe(true);
    expect(state.sessionId).toBe("auth-fixture-session");
    expect(state.cliVersion).toBe("1.1.80");
    expect(state.protocolVersion).toBe("1.5.0");
    expect(state.apiKeySource).toBe("none");
  });

  it("treats subtype:success with is_error:true as a failure", () => {
    const { state } = ingest(raw);
    expect(state.resultSeen).toBe(true);
    expect(state.resultSubtype).toBe("success");
    expect(state.resultIsError).toBe(true);
    expect(state.assistantError).toBe("authentication_failed");
  });

  it("does not invent a cost from the reported zero", () => {
    const { state } = ingest(raw);
    expect(state.totalCostUsd).toBe(0);
    expect(state.usage?.inputTokens).toBe(0);
    expect(state.usage?.outputTokens).toBe(0);
  });

  it("produces identical state at every chunk size", () => {
    const whole = ingest(raw).state;
    for (const chunkSize of [1, 7, 64, 997, 4096]) {
      const chunked = ingest(raw, chunkSize).state;
      expect(chunked, `chunk size ${chunkSize}`).toEqual(whole);
    }
  });
});

describe("QoderStreamAggregator — constructed successful run", () => {
  const raw = readFixture("successful-run.jsonl");

  it("collects the terminal result, usage and cost", () => {
    const { state } = ingest(raw);
    expect(state.resultSeen).toBe(true);
    expect(state.resultIsError).toBe(false);
    expect(state.resultText).toContain("零除检查");
    expect(state.numTurns).toBe(4);
    expect(state.totalCostUsd).toBeCloseTo(0.0412);
    expect(state.totalCredits).toBe(41);
    expect(state.usage).toEqual({
      inputTokens: 1800,
      outputTokens: 90,
      cachedInputTokens: 8192,
      cacheWriteTokens: 200,
    });
  });

  it("records tool names in call order without duplicates", () => {
    const { state } = ingest(raw);
    expect(state.toolNames).toEqual(["Read", "Edit"]);
  });

  it("ignores stream_event deltas so text is not duplicated", () => {
    const aggregator = new QoderStreamAggregator();
    const events = [];
    for (const line of raw.split("\n")) {
      if (line.trim()) events.push(...aggregator.ingestLine(line));
    }
    expect(aggregator.state.unknownEvents).toBe(0);
    const assistantTexts = events.filter((event) => event.eventType === "assistant");
    expect(assistantTexts.length).toBe(2);
    expect(JSON.stringify(events)).not.toContain("ignored");
  });

  it("emits workbench events for thinking, tools and retries", () => {
    const aggregator = new QoderStreamAggregator();
    const eventTypes: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      for (const event of aggregator.ingestLine(line)) eventTypes.push(event.eventType);
    }
    expect(eventTypes).toContain("thinking");
    expect(eventTypes).toContain("tool_call");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("api_retry");
  });

  it("survives every chunk boundary identically", () => {
    const whole = ingest(raw).state;
    for (const chunkSize of [1, 3, 50, 512, 10_000]) {
      expect(ingest(raw, chunkSize).state, `chunk size ${chunkSize}`).toEqual(whole);
    }
  });
});

describe("QoderStreamAggregator — malformed and unknown input", () => {
  it("counts unparseable lines without throwing", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine("not json at all");
    aggregator.ingestLine('{"type":"assistant"'); // truncated
    aggregator.ingestLine("");
    aggregator.ingestLine("   ");
    expect(aggregator.state.unparsedLines).toBe(2);
    expect(aggregator.state.decodeDamagedLines).toBe(0);
  });

  it("separates host decode damage from a protocol violation", () => {
    const aggregator = new QoderStreamAggregator();
    // What a CJK character split across two host stdout chunks becomes.
    aggregator.ingestLine('{"type":"assistant","text":"\uFFFD\uFFFD破损"}');
    expect(aggregator.state.unparsedLines).toBe(0);

    aggregator.ingestLine('{"type":"assistant","text":"\uFFFD\uFFFD');
    expect(aggregator.state.unparsedLines).toBe(1);
    expect(aggregator.state.decodeDamagedLines).toBe(1);
  });

  it("counts unknown top-level event types instead of failing", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine('{"type":"telemetry_v9","payload":{}}');
    expect(aggregator.state.unknownEvents).toBe(1);
    expect(aggregator.state.resultSeen).toBe(false);
  });

  it("accepts a JSON array or scalar line without treating it as a message", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine("[1,2,3]");
    aggregator.ingestLine("42");
    aggregator.ingestLine('"a string"');
    expect(aggregator.state.unparsedLines).toBe(3);
  });

  it("records permission denials from the system channel", () => {
    const aggregator = new QoderStreamAggregator();
    // Field names as the CLI emits them (verified in qoder-worker-runtime.mjs):
    // tool_name, message, decision_reason, decision_reason_type.
    aggregator.ingestLine(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        message: "command not pre-approved",
        decision_reason: "no verdict from the permission classifier",
        decision_reason_type: "auto_deny",
      }),
    );
    expect(aggregator.state.permissionDenials).toEqual([
      { toolName: "Bash", message: "command not pre-approved" },
    ]);
  });

  it("falls back to decision_reason when no message is attached", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        decision_reason: "path outside the allowed directories",
      }),
    );
    expect(aggregator.state.permissionDenials).toEqual([
      { toolName: "Write", message: "path outside the allowed directories" },
    ]);
  });

  it("keeps the last non-empty assistant text as the run summary", () => {
    const aggregator = new QoderStreamAggregator();
    const say = (text: string) =>
      aggregator.ingestLine(
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
      );
    say("先看看文件。");
    say("改好了。");
    say("   ");
    expect(aggregator.buildSummary()).toBe("改好了。");
  });

  it("bounds retained assistant text", () => {
    const aggregator = new QoderStreamAggregator();
    for (let i = 0; i < 200; i += 1) {
      aggregator.ingestLine(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5_000) }] },
        }),
      );
    }
    expect(aggregator.buildSummary().length).toBeLessThanOrEqual(20_001);
  });

  it("bounds the recorded tool-name list", () => {
    const aggregator = new QoderStreamAggregator();
    for (let i = 0; i < 500; i += 1) {
      aggregator.ingestLine(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `t${i}`, name: `Tool${i}`, input: {} }],
          },
        }),
      );
    }
    expect(aggregator.state.toolNames.length).toBeLessThanOrEqual(200);
  });
});

describe("QoderStreamAggregator — usage semantics", () => {
  it("replaces usage from the terminal result rather than summing turns", () => {
    const aggregator = new QoderStreamAggregator();
    const resultLine = (input: number, output: number) =>
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: { input_tokens: input, output_tokens: output },
        total_cost_usd: 0.01,
      });
    aggregator.ingestLine(resultLine(100, 10));
    aggregator.ingestLine(resultLine(250, 25));
    // The CLI reports turn-cumulative usage, so the later value is the total.
    expect(aggregator.state.usage?.inputTokens).toBe(250);
    expect(aggregator.state.usage?.outputTokens).toBe(25);
  });

  it("reports a missing usage block as null rather than zero", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
    );
    expect(aggregator.state.usage).toBeNull();
    expect(aggregator.state.totalCostUsd).toBeNull();
  });
});

describe("QoderStreamAggregator — hook and artifact events", () => {
  // Field names read off the installed CLI bundle. A real run emits all four
  // of these every turn; before they were modelled, every successful run
  // reported `unknownEvents: 4`.
  const lines = [
    { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "lint", hook_event: "PreToolUse" },
    { type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "lint", hook_event: "PreToolUse", exit_code: 0, duration_ms: 42, outcome: "allow" },
    { type: "system", subtype: "hook_diagnostics", read_status: "ok", checked_at: "2026-10-29T00:00:00Z" },
    { type: "system", subtype: "artifacts_update", artifacts: [{ id: "a" }, { id: "b" }] },
  ];

  it("models them instead of counting them as unknown", () => {
    const aggregator = new QoderStreamAggregator();
    const types: string[] = [];
    for (const line of lines) {
      for (const event of aggregator.ingestLine(JSON.stringify(line))) types.push(event.eventType);
    }
    expect(aggregator.state.unknownEvents).toBe(0);
    expect(types).toEqual([
      "hook_started",
      "hook_response",
      "hook_diagnostics",
      "artifacts_update",
    ]);
  });

  it("flags a hook that exited non-zero", () => {
    const aggregator = new QoderStreamAggregator();
    const [event] = aggregator.ingestLine(
      JSON.stringify({ ...lines[1], exit_code: 2, outcome: "deny" }),
    );
    expect(event?.level).toBe("warn");
    expect(event?.stream).toBe("stderr");
  });

  it("still counts a genuinely unmodelled subtype", () => {
    const aggregator = new QoderStreamAggregator();
    aggregator.ingestLine(JSON.stringify({ type: "system", subtype: "something_new_v9" }));
    expect(aggregator.state.unknownEvents).toBe(1);
  });
});
