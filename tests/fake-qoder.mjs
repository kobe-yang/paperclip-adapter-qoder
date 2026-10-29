#!/usr/bin/env node
/**
 * Stand-in for the Qoder CLI, used by the adapter's integration tests.
 *
 * It speaks the same stream-json protocol on the same flags as
 * `qoder@1.1.80`, but deterministically and without a network or an account.
 * The scenario comes from FAKE_QODER_SCENARIO; everything the adapter sent
 * (argv, cwd, stdin, selected env) is written to FAKE_QODER_RECORD so the
 * tests can assert on the invocation itself.
 */

import fs from "node:fs";

const scenario = process.env.FAKE_QODER_SCENARIO ?? "ok";
const recordPath = process.env.FAKE_QODER_RECORD ?? "";
const argv = process.argv.slice(2);

function flagValue(name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

function flagValues(name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  }
  return values;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const sessionId = flagValue("-r") ?? "fake-session-0001";

function write(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function initLine() {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "subscription",
    qodercli_version: process.env.FAKE_QODER_VERSION ?? "1.1.80",
    protocol_version: "1.5.0",
    cwd: process.cwd(),
    tools: ["Bash", "Edit", "Read", "Write"],
    model: flagValue("-m") ?? "fake-model",
    permissionMode: flagValue("--permission-mode") ?? "default",
    session_id: sessionId,
  };
}

function assistantText(text) {
  return {
    type: "assistant",
    message: {
      id: "msg-fake",
      model: flagValue("-m") ?? "fake-model",
      role: "assistant",
      type: "message",
      usage: {
        input_tokens: 120,
        output_tokens: 18,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 400,
      },
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function resultLine(overrides) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    num_turns: 1,
    result: "done",
    session_id: sessionId,
    total_cost_usd: 0.002,
    total_credits: 2,
    usage: {
      input_tokens: 120,
      output_tokens: 18,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 400,
    },
    permission_denials: [],
    terminal_reason: "completed",
    ...overrides,
  };
}

const stdin = await readStdin();

if (recordPath) {
  fs.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        stdin,
        resumeSessionId: flagValue("-r"),
        permissionMode: flagValue("--permission-mode"),
        model: flagValue("-m"),
        workDir: flagValue("-w"),
        addDirs: flagValues("--add-dir"),
        allowedTools: flagValues("--allowed-tools"),
        disallowedTools: flagValues("--disallowed-tools"),
        env: {
          CI: process.env.CI ?? null,
          NO_COLOR: process.env.NO_COLOR ?? null,
          TERM: process.env.TERM ?? null,
          QODER_AGENT_SDK_ENTRYPOINT: process.env.QODER_AGENT_SDK_ENTRYPOINT ?? null,
          QODER_SDK_AUTH_PAYLOAD_FILE: process.env.QODER_SDK_AUTH_PAYLOAD_FILE ?? null,
          QODER_SESSION_ID: process.env.QODER_SESSION_ID ?? null,
          QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH:
            process.env.QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH ?? null,
          PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID ?? null,
          PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID ?? null,
          PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY ?? null,
          PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID ?? null,
          HOST_ONLY_SECRET: process.env.HOST_ONLY_SECRET ?? null,
          OPERATOR_SETTING: process.env.OPERATOR_SETTING ?? null,
        },
      },
      null,
      2,
    ),
  );
}

switch (scenario) {
  case "ok": {
    write(initLine());
    write(assistantText("修复完成，测试通过。"));
    write(resultLine({ result: "修复完成，测试通过。" }));
    process.exit(0);
    break;
  }

  // The real CLI's unauthenticated path: exit 0 with is_error true.
  case "exit0-error": {
    write(initLine());
    write({ ...assistantText("Not logged in · Please run /login"), error: "authentication_failed" });
    write(
      resultLine({
        is_error: true,
        result: "Not logged in · Please run /login",
        total_cost_usd: 0,
        total_credits: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    process.exit(0);
    break;
  }

  case "nonzero": {
    write(initLine());
    process.stderr.write("fatal: something broke inside the CLI\n");
    write(resultLine({ is_error: true, result: "run failed", subtype: "error_during_execution" }));
    process.exit(3);
    break;
  }

  case "no-result": {
    write(initLine());
    write(assistantText("I was about to answer"));
    process.exit(0);
    break;
  }

  case "permission-denied": {
    write(initLine());
    write({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      message: "command not pre-approved",
      decision_reason: "no verdict from the permission classifier",
      decision_reason_type: "auto_deny",
      session_id: sessionId,
    });
    write(resultLine({ is_error: true, result: "could not run the required command" }));
    process.exit(0);
    break;
  }

  case "session-not-found-success": {
    const source = process.env.FAKE_QODER_MISSING_SOURCE ?? "result";
    if (source === "stderr") process.stderr.write("session not found\n");
    write(resultLine({
      result: source === "result" ? "Explained session not found successfully." : "successful answer",
      errors: source === "errors" ? ["session not found"] : [],
    }));
    process.exit(0);
    break;
  }

  case "session-missing":
  case "session-missing-exit0-error":
  case "session-missing-stderr":
  case "session-missing-hang":
  case "session-not-found-no-result":
  case "session-missing-after-init":
  case "session-missing-after-tool-call":
  case "session-missing-after-tool-result": {
    // Only fails when a resume was requested, so the adapter's one retry with a
    // fresh session can succeed.
    if (flagValue("-r")) {
      if (scenario === "session-missing-after-init") write(initLine());
      if (scenario === "session-missing-after-tool-call" || scenario === "session-missing-after-tool-result") {
        if (scenario === "session-missing-after-tool-call") {
          write({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tool-mutation", name: "Write", input: {} }],
            },
            session_id: sessionId,
          });
        }
        fs.appendFileSync(`${recordPath}.effect`, "mutation\n");
        write({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-mutation", content: "file written" }],
          },
          session_id: sessionId,
        });
      }
      if (scenario === "session-missing-stderr" || scenario === "session-missing-hang" || scenario === "session-not-found-no-result") {
        process.stderr.write(`session ${sessionId} not found\n`);
        if (scenario === "session-missing-hang") {
          setInterval(() => {}, 1000);
          break;
        }
        process.exit(scenario === "session-missing-stderr" ? 1 : 0);
      }
      write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `session ${flagValue("-r")} not found`,
        session_id: flagValue("-r"),
        terminal_reason: "completed",
      });
      process.exit(scenario === "session-missing-exit0-error" ? 0 : 1);
    }
    write(initLine());
    write(assistantText("fresh session answer"));
    write(resultLine({ result: "fresh session answer" }));
    process.exit(0);
    break;
  }

  case "unknown-events": {
    write(initLine());
    write({ type: "telemetry_v9", payload: { ignored: true }, session_id: sessionId });
    process.stdout.write("a plain log line that is not JSON\n");
    process.stdout.write("{truncated json\n");
    write({ type: "stream_event", event: { delta: "should not render" } });
    write(assistantText("survived the noise"));
    write(resultLine({ result: "survived the noise" }));
    process.exit(0);
    break;
  }

  // Emits the protocol one small write at a time, so the adapter's splitter has
  // to reassemble lines across chunk boundaries.
  case "chunked": {
    const payload =
      `${JSON.stringify(initLine())}\n` +
      `${JSON.stringify(assistantText("分块输出也要能正确解析"))}\n` +
      `${JSON.stringify(resultLine({ result: "分块输出也要能正确解析" }))}\n`;
    for (let at = 0; at < payload.length; at += 3) {
      process.stdout.write(payload.slice(at, at + 3));
    }
    process.exit(0);
    break;
  }

  // Never exits on its own: used for timeout and cancellation.
  case "hang": {
    write(initLine());
    if (process.env.FAKE_QODER_IGNORE_SIGTERM === "1") {
      process.on("SIGTERM", () => {
        process.stderr.write("ignoring SIGTERM\n");
      });
    }
    setInterval(() => {}, 1000);
    break;
  }

  // Spawns a child that outlives it, to check process-group cleanup.
  case "hang-with-child": {
    write(initLine());
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "child", pid: child.pid })}\n`);
    setInterval(() => {}, 1000);
    break;
  }

  // Reports its answer, then lingers. The host should stop it after the grace.
  case "linger-after-result": {
    write(initLine());
    write(assistantText("answered then lingered"));
    write(resultLine({ result: "answered then lingered" }));
    setInterval(() => {}, 1000);
    break;
  }

  case "crash-before-output": {
    process.stderr.write("qoder: unexpected internal error\n");
    process.exit(9);
    break;
  }

  default: {
    process.stderr.write(`fake-qoder: unknown scenario ${scenario}\n`);
    process.exit(64);
  }
}
