import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "@paperclipai/adapter-utils/types";

import { QODER_ADAPTER_TYPE, execute } from "../src/execute.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(testsDir, "fake-qoder.mjs");

type Harness = {
  ctx: AdapterExecutionContext;
  logs: Array<{ stream: string; chunk: string }>;
  events: AdapterRuntimeEvent[];
  meta: Record<string, unknown>[];
  spawns: Array<{ pid: number }>;
  recordPath: string;
  cwd: string;
  stdoutText: () => string;
  readRecord: () => Record<string, any>;
};

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-adapter-exec-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function harness(options: {
  scenario?: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  env?: Record<string, string>;
  authToken?: string;
} = {}): Harness {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, "workspace-"));
  const recordPath = path.join(tmpRoot, `record-${Math.random().toString(16).slice(2)}.json`);

  const logs: Harness["logs"] = [];
  const events: AdapterRuntimeEvent[] = [];
  const meta: Record<string, unknown>[] = [];
  const spawns: Array<{ pid: number }> = [];

  const ctx = {
    runId: "run-test-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Qoder Tester" },
    runtime: { sessionId: null, sessionParams: null, ...(options.runtime ?? {}) },
    config: {
      command: FAKE_CLI,
      cwd,
      timeoutSec: 30,
      graceSec: 1,
      env: {
        FAKE_QODER_SCENARIO: options.scenario ?? "ok",
        FAKE_QODER_RECORD: recordPath,
        ...(options.env ?? {}),
      },
      ...(options.config ?? {}),
    },
    context: { ...(options.context ?? {}) },
    onLog: async (stream: string, chunk: string) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (value: Record<string, unknown>) => {
      meta.push(value);
    },
    onEvent: async (event: AdapterRuntimeEvent) => {
      events.push(event);
    },
    onSpawn: async (info: { pid: number }) => {
      spawns.push(info);
    },
    onUsage: async () => {},
    onRuntimeProgress: async () => {},
    authToken: options.authToken ?? "paperclip-run-token",
    agentIdentity: undefined,
    runtimeTools: undefined,
  } as unknown as AdapterExecutionContext;

  return {
    ctx,
    logs,
    events,
    meta,
    spawns,
    recordPath,
    cwd,
    stdoutText: () =>
      logs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.chunk)
        .join(""),
    readRecord: () => JSON.parse(fs.readFileSync(recordPath, "utf8")),
  };
}

describe("execute — successful run", () => {
  it("reports success, usage, cost and the session id", async () => {
    const h = harness({ scenario: "ok" });
    const result = await execute(h.ctx);

    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("修复完成，测试通过。");
    expect(result.sessionId).toBe("fake-session-0001");
    expect(result.sessionParams).toMatchObject({ sessionId: "fake-session-0001", cwd: h.cwd });
    expect(result.usage).toEqual({
      inputTokens: 130,
      outputTokens: 18,
      cachedInputTokens: 400,
      cacheWriteTokens: 10,
    });
    expect(result.costUsd).toBeCloseTo(0.002);
    expect(result.costStatus).toBe("reported");
    expect(result.provider).toBe("qoder");
  });

  it("delivers the prompt on stdin as one stream-json line, not in argv", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const record = h.readRecord();

    const lines = String(record.stdin).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const message = JSON.parse(lines[0] as string);
    expect(message.type).toBe("user");
    expect(typeof message.message.content).toBe("string");
    expect(message.message.content.length).toBeGreaterThan(0);

    // Nothing resembling the prompt body is in argv.
    expect(record.argv.join(" ")).not.toContain(message.message.content.slice(0, 40));
  });

  it("passes the headless protocol flags and the working directory", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const record = h.readRecord();

    expect(record.argv.slice(0, 5)).toEqual([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ]);
    expect(record.workDir).toBe(h.cwd);
    expect(record.cwd).toBe(fs.realpathSync(h.cwd));
    expect(record.permissionMode).toBe("auto");
  });

  it("forwards workbench events for the init, answer and result", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const types = h.events.map((event) => event.eventType);
    expect(types).toContain("init");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  it("publishes an invocation record without the API token's value", async () => {
    const h = harness({ scenario: "ok", authToken: "pk-super-secret-token" });
    await execute(h.ctx);

    expect(h.meta).toHaveLength(1);
    const record = h.meta[0] as Record<string, any>;
    expect(record.adapterType).toBe(QODER_ADAPTER_TYPE);
    expect(record.cwd).toBe(h.cwd);
    expect(record.commandNotes.join(" ")).toContain("stdin");
    expect(JSON.stringify(record)).not.toContain("pk-super-secret-token");
  });

  it("records the child pid so the host can manage the process", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    expect(h.spawns.length).toBe(1);
    expect(h.spawns[0]?.pid).toBeGreaterThan(0);
  });
});

describe("execute — environment handling", () => {
  it("rejects unsafe extra arguments before spawning or creating the configured cwd", async () => {
    const target = path.join(tmpRoot, "should-not-appear");
    const h = harness({ config: { cwd: target, extraArgs: "--continue" } });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBe("qoder_extra_args_invalid");
    expect(result.errorFamily).toBe("configuration");
    expect(h.spawns).toHaveLength(0);
    expect(h.meta).toHaveLength(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(h.recordPath)).toBe(false);
  });

  it("neutralizes inherited SDK handshake variables", async () => {
    // Reproduces the live failure: with these inherited, the real CLI aborts
    // with `auth_payload_invalid` and never emits system/init.
    const previous = {
      QODER_AGENT_SDK_ENTRYPOINT: process.env.QODER_AGENT_SDK_ENTRYPOINT,
      QODER_SDK_AUTH_PAYLOAD_FILE: process.env.QODER_SDK_AUTH_PAYLOAD_FILE,
      QODER_SESSION_ID: process.env.QODER_SESSION_ID,
      QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH: process.env.QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH,
    };
    process.env.QODER_AGENT_SDK_ENTRYPOINT = "sdk";
    process.env.QODER_SDK_AUTH_PAYLOAD_FILE = "/tmp/parent-payload.json";
    process.env.QODER_SESSION_ID = "parent-session";
    process.env.QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH = "2";

    try {
      const h = harness({ scenario: "ok" });
      const result = await execute(h.ctx);
      const record = h.readRecord();

      expect(record.env.QODER_AGENT_SDK_ENTRYPOINT).toBe("");
      expect(record.env.QODER_SDK_AUTH_PAYLOAD_FILE).toBe("");
      expect(record.env.QODER_SESSION_ID).toBe("");

      // The nesting guard is a protection mechanism, so it is left alone.
      expect(record.env.QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH).toBe("2");

      // And the run log says what was changed.
      expect(h.stdoutText()).toContain("QODER_AGENT_SDK_ENTRYPOINT");
      expect(
        (result.resultJson as any).qoderAdapter.neutralizedEnvKeys,
      ).toContain("QODER_SDK_AUTH_PAYLOAD_FILE");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("sets the headless terminal variables", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const record = h.readRecord();
    expect(record.env.CI).toBe("1");
    expect(record.env.NO_COLOR).toBe("1");
    expect(record.env.TERM).toBe("dumb");
  });

  it("passes Paperclip run identity to the child", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const record = h.readRecord();
    expect(record.env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(record.env.PAPERCLIP_RUN_ID).toBe("run-test-1");
    expect(record.env.PAPERCLIP_API_KEY).toBe("paperclip-run-token");
  });

  it("exports the task id when the host supplied one", async () => {
    const h = harness({ scenario: "ok", context: { taskId: "task-77" } });
    await execute(h.ctx);
    expect(h.readRecord().env.PAPERCLIP_TASK_ID).toBe("task-77");
  });

  it("refuses a config-supplied Paperclip credential", async () => {
    const h = harness({
      scenario: "ok",
      env: { PAPERCLIP_API_KEY: "attacker-supplied-key" },
    });
    await execute(h.ctx);
    // The run token is minted per run; a config value must not replace it.
    expect(h.readRecord().env.PAPERCLIP_API_KEY).toBe("paperclip-run-token");
  });

  it("passes through an operator's own environment setting", async () => {
    const h = harness({ scenario: "ok", env: { OPERATOR_SETTING: "on" } });
    await execute(h.ctx);
    expect(h.readRecord().env.OPERATOR_SETTING).toBe("on");
  });
});

describe("execute — failure classification", () => {
  it("does not call an exit-0 authentication failure a success", async () => {
    const h = harness({ scenario: "exit0-error" });
    const result = await execute(h.ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBe("qoder_auth_required");
    expect(result.errorFamily).toBe("configuration");
    expect(result.errorMessage).toContain("Not logged in");
    // A zero cost next to zero tokens is a real zero, not an invented one.
    expect(result.costStatus).toBe("reported");
    expect(result.costUsd).toBe(0);
  });

  it("reports a non-zero exit with the CLI's own stderr", async () => {
    const h = harness({ scenario: "nonzero" });
    const result = await execute(h.ctx);
    expect(result.exitCode).toBe(3);
    expect(result.errorMessage).toBeTruthy();
  });

  it("flags a run that produced no terminal result", async () => {
    const h = harness({ scenario: "no-result" });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBe("qoder_protocol_violation");
    expect(result.errorMessage).toContain("outcome is unknown");
  });

  it("reports a permission denial with the denied tool", async () => {
    const h = harness({ scenario: "permission-denied" });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBe("qoder_permission_denied");
    expect((result.resultJson as any).qoder.permissionDenials).toEqual([
      { toolName: "Bash", message: "command not pre-approved" },
    ]);
  });

  it("reports a missing CLI as a configuration problem, not a crash", async () => {
    const h = harness({ scenario: "ok", config: { command: "/nonexistent/qoder-binary" } });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBe("qoder_cli_not_found");
    expect(result.errorFamily).toBe("configuration");
    expect(result.errorMessage).toContain("npm i -g @qoder-ai/qodercli");
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
  });

  it("survives a CLI that dies before printing anything", async () => {
    const h = harness({ scenario: "crash-before-output" });
    const result = await execute(h.ctx);
    expect(result.exitCode).toBe(9);
    expect(result.errorMessage).toContain("unexpected internal error");
  });
});

describe("execute — streaming robustness", () => {
  it("reassembles the protocol when written three characters at a time", async () => {
    const h = harness({ scenario: "chunked" });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBeNull();
    expect(result.summary).toBe("分块输出也要能正确解析");
    expect(result.sessionId).toBe("fake-session-0001");
  });

  it("keeps going through unknown events and non-JSON noise", async () => {
    const h = harness({ scenario: "unknown-events" });
    const result = await execute(h.ctx);

    expect(result.errorCode).toBeNull();
    expect(result.summary).toBe("survived the noise");
    const diagnostics = (result.resultJson as any).qoder;
    expect(diagnostics.unknownEvents).toBe(1);
    expect(diagnostics.unparsedLines).toBe(2);
    // The ignored stream_event text never reaches the workbench.
    expect(JSON.stringify(h.events)).not.toContain("should not render");
  });
});

describe("execute — timeout and cancellation", () => {
  it("times out a hung CLI and reports it as a timeout", async () => {
    const h = harness({ scenario: "hang", config: { timeoutSec: 2, graceSec: 1 } });
    const result = await execute(h.ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("qoder_timeout");
    expect(result.summary).toBeNull();
  }, 30_000);

  it("force-kills a CLI that ignores SIGTERM", async () => {
    const h = harness({
      scenario: "hang",
      config: { timeoutSec: 2, graceSec: 1 },
      env: { FAKE_QODER_IGNORE_SIGTERM: "1" },
    });
    const result = await execute(h.ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("qoder_timeout");
  }, 30_000);

  it("stops a CLI that lingers after reporting its result, keeping the answer", async () => {
    const h = harness({ scenario: "linger-after-result", config: { timeoutSec: 60, graceSec: 1 } });
    const started = Date.now();
    const result = await execute(h.ctx);

    // Finished because the terminal result arrived, not because of the timeout.
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(result.timedOut).toBe(false);
    expect(result.summary).toBe("answered then lingered");

    // The CLI stays alive after answering, so the host's post-result cleanup
    // signals it. The adapter must not pass that signal on: the host treats any
    // signal as a failed run, which would turn every real run into a failure.
    // The stop stays auditable in resultJson instead.
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect((result.resultJson as Record<string, unknown>).unmanagedBackgroundTask).toMatchObject({
      kind: "terminal_result_cleanup",
      stopped: true,
    });
  }, 60_000);

  it("leaves no descendant process behind after a timeout", async () => {
    const h = harness({ scenario: "hang-with-child", config: { timeoutSec: 2, graceSec: 1 } });
    const result = await execute(h.ctx);
    expect(result.timedOut).toBe(true);

    const childPid = (() => {
      const match = h.stdoutText().match(/"subtype":"child","pid":(\d+)/);
      return match ? Number(match[1]) : null;
    })();
    expect(childPid).toBeGreaterThan(0);

    // Give the group signal a moment to land, then confirm the grandchild went
    // away with its parent rather than being orphaned.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let alive = true;
    try {
      process.kill(childPid as number, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 40_000);
});

describe("execute — session continuity and isolation", () => {
  it("resumes a bare legacy session or one recorded for the same directory", async () => {
    const h = harness({
      scenario: "ok",
      runtime: { sessionId: "stored-session", sessionParams: null },
    });
    await execute(h.ctx);
    expect(h.readRecord().resumeSessionId).toBe("stored-session");

    const h2 = harness({
      scenario: "ok",
      runtime: {
        sessionId: "stored-session",
        sessionParams: { sessionId: "stored-session", cwd: h.cwd },
      },
      config: { cwd: h.cwd },
    });
    await execute(h2.ctx);
    expect(h2.readRecord().resumeSessionId).toBe("stored-session");
  });

  it("refuses a session recorded for a different directory", async () => {
    const otherDir = fs.mkdtempSync(path.join(tmpRoot, "other-"));
    const h = harness({
      scenario: "ok",
      runtime: {
        sessionId: "foreign-session",
        sessionParams: { sessionId: "foreign-session", cwd: otherDir },
      },
    });
    const result = await execute(h.ctx);

    expect(h.readRecord().resumeSessionId).toBeNull();
    expect((result.resultJson as any).qoderAdapter.resumeRefusal).toContain(otherDir);
    expect(h.stdoutText()).toContain("will not be resumed");
  });

  it("refuses a conflicting workspace even without a stored cwd", async () => {
    const h = harness({
      runtime: {
        sessionId: "foreign-session",
        sessionParams: { sessionId: "foreign-session", workspaceId: "ws-a" },
      },
      context: { paperclipWorkspace: { workspaceId: "ws-b" } },
    });
    const result = await execute(h.ctx);

    expect(h.spawns).toHaveLength(1);
    expect(h.readRecord().resumeSessionId).toBeNull();
    expect((result.resultJson as any).qoderAdapter.resumeRefusal).toContain("ws-a");
    expect((result.resultJson as any).qoderAdapter.resumeRefusal).toContain("ws-b");
  });

  it("never passes --continue, which would inherit another agent's session", async () => {
    const h = harness({ scenario: "ok" });
    await execute(h.ctx);
    const argv: string[] = h.readRecord().argv;
    expect(argv).not.toContain("-c");
    expect(argv).not.toContain("--continue");
  });

  it("retries once with a fresh session when the stored one is gone", async () => {
    const h = harness({
      scenario: "session-missing",
      runtime: {
        sessionId: "dead-session",
        sessionParams: { sessionId: "dead-session", cwd: "" },
      },
      config: {},
    });
    // Give the stored session a provable cwd so the resume is actually tried.
    (h.ctx.runtime as any).sessionParams = { sessionId: "dead-session", cwd: h.cwd };

    const result = await execute(h.ctx);

    expect(h.stdoutText()).toContain("retrying once with a fresh session");
    expect(h.spawns).toHaveLength(2);
    expect(h.meta.map((entry) => (entry.commandArgs as string[]).includes("-r"))).toEqual([
      true,
      false,
    ]);
    const firstResult = h.events.findIndex((event) => event.eventType === "result");
    expect(firstResult).toBe(0);
    expect(h.events[firstResult]).toMatchObject({ level: "error", payload: { isError: true } });
    expect(h.events[firstResult + 1]?.eventType).toBe("init");
    expect(result.errorCode).toBeNull();
    expect(result.summary).toBe("fresh session answer");
    // The final record is from the retry, which asked for no resume.
    expect(h.readRecord().resumeSessionId).toBeNull();
    expect((result.resultJson as any).qoder.resumed).toBe(false);
  }, 30_000);

  it.each(["result", "errors", "stderr"])(
    "does not retry a successful result mentioning session not found in %s",
    async (source) => {
      const h = harness({
        scenario: "session-not-found-success",
        runtime: { sessionId: "stored-session" },
        env: { FAKE_QODER_MISSING_SOURCE: source },
      });
      const result = await execute(h.ctx);

      expect(h.spawns).toHaveLength(1);
      expect(h.meta).toHaveLength(1);
      expect(h.readRecord().resumeSessionId).toBe("stored-session");
      expect(h.stdoutText()).not.toContain("retrying once");
      expect(h.events.map((event) => event.eventType)).toEqual(["result"]);
      expect(result.errorCode).toBeNull();
      expect(result.summary).toBe(
        source === "result" ? "Explained session not found successfully." : "successful answer",
      );
      expect((result.resultJson as any).qoder.resumed).toBe(true);
    },
  );

  it("does not retry cancellation with session not found on stderr before init", async () => {
    const h = harness({
      scenario: "session-missing-hang",
      runtime: { sessionId: "stored-session" },
    });
    const onLog = h.ctx.onLog;
    h.ctx.onLog = async (stream, chunk) => {
      await onLog(stream, chunk);
      if (stream === "stderr" && chunk.includes("session stored-session not found")) {
        process.kill(h.spawns[0]!.pid, "SIGTERM");
      }
    };
    const result = await execute(h.ctx);

    expect(h.spawns).toHaveLength(1);
    expect(h.readRecord().resumeSessionId).toBe("stored-session");
    expect(h.stdoutText()).not.toContain("retrying once");
    expect(h.events).toHaveLength(0);
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("qoder_cancelled");
  });

  it("does not retry a timed-out resume with session not found on stderr", async () => {
    const h = harness({
      scenario: "session-missing-hang",
      runtime: { sessionId: "stored-session" },
      config: { timeoutSec: 1, graceSec: 1 },
    });
    const result = await execute(h.ctx);

    expect(h.spawns).toHaveLength(1);
    expect(h.stdoutText()).not.toContain("retrying once");
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("qoder_timeout");
  }, 10_000);

  it("does not retry after a host abort even with a pre-init missing-session error", async () => {
    const h = harness({
      scenario: "session-missing",
      runtime: { sessionId: "stored-session" },
    });
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const onEvent = h.ctx.onEvent;
    h.ctx.onEvent = async (event) => {
      await onEvent?.(event);
      if (event.eventType === "result") controller.abort();
    };
    const result = await execute(h.ctx);

    expect(controller.signal.aborted).toBe(true);
    expect(h.spawns).toHaveLength(1);
    expect(h.readRecord().resumeSessionId).toBe("stored-session");
    expect(h.stdoutText()).not.toContain("retrying once");
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.errorCode).toBe("qoder_session_unrecoverable");
  });

  it.each(["init", "tool-call", "tool-result"])(
    "does not retry a missing-session failure after %s activity",
    async (activity) => {
      const h = harness({
        scenario: `session-missing-after-${activity}`,
        runtime: { sessionId: "stored-session" },
      });
      const result = await execute(h.ctx);

      expect(h.spawns).toHaveLength(1);
      expect(h.meta).toHaveLength(1);
      expect(h.readRecord().resumeSessionId).toBe("stored-session");
      expect(h.stdoutText()).not.toContain("retrying once");
      expect(h.events[0]?.eventType).toBe(activity.replace("-", "_"));
      expect(result.errorCode).toBe("qoder_session_unrecoverable");
      expect((result.resultJson as any).qoder.resumed).toBe(true);
      if (activity !== "init") {
        expect(fs.readFileSync(`${h.recordPath}.effect`, "utf8")).toBe("mutation\n");
        expect(h.events.some((event) => event.eventType === "init")).toBe(false);
      }
    },
  );

  it("does not retry an exit-0 stderr diagnostic without an explicit failed result", async () => {
    const h = harness({
      scenario: "session-not-found-no-result",
      runtime: { sessionId: "stored-session" },
    });
    const result = await execute(h.ctx);

    expect(h.spawns).toHaveLength(1);
    expect(h.stdoutText()).not.toContain("retrying once");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBeNull();
    expect(result.errorCode).toBe("qoder_session_unrecoverable");
  });

  it.each(["session-missing-exit0-error", "session-missing-stderr"])(
    "retries a genuine pre-init resume failure in %s once",
    async (scenario) => {
      const h = harness({ scenario, runtime: { sessionId: "stored-session" } });
      const result = await execute(h.ctx);

      expect(h.spawns).toHaveLength(2);
      expect(h.readRecord().resumeSessionId).toBeNull();
      expect(h.stdoutText().split("retrying once with a fresh session")).toHaveLength(2);
      expect(result.errorCode).toBeNull();
      expect(result.summary).toBe("fresh session answer");
    },
  );

  it("does not retry more than once", async () => {
    // `session-missing` fails only while resuming, so a second retry would
    // show up as a second "retrying" log line.
    const h = harness({
      scenario: "session-missing",
      runtime: { sessionId: "dead", sessionParams: { sessionId: "dead", cwd: "" } },
    });
    (h.ctx.runtime as any).sessionParams = { sessionId: "dead", cwd: h.cwd };
    await execute(h.ctx);
    const occurrences = h.stdoutText().split("retrying once with a fresh session").length - 1;
    expect(occurrences).toBe(1);
  }, 30_000);
});

describe("execute — configuration surface", () => {
  it("passes model, permission mode, tool lists and extra directories", async () => {
    const extraDir = fs.mkdtempSync(path.join(tmpRoot, "extra-"));
    const h = harness({
      scenario: "ok",
      config: {
        model: "qoder-test-model",
        permissionMode: "accept_edits",
        allowedTools: "Read, Glob",
        disallowedTools: ["Bash"],
        addDirs: extraDir,
        maxTurns: 5,
      },
    });
    await execute(h.ctx);
    const record = h.readRecord();

    expect(record.model).toBe("qoder-test-model");
    expect(record.permissionMode).toBe("accept_edits");
    expect(record.allowedTools).toEqual(["Read", "Glob"]);
    expect(record.disallowedTools).toEqual(["Bash"]);
    expect(record.addDirs).toEqual([extraDir]);
    expect(record.argv).toContain("--max-turns");
  });

  it("falls back to the safe default when the permission mode is invalid", async () => {
    const h = harness({ scenario: "ok", config: { permissionMode: "plan" } });
    const result = await execute(h.ctx);

    expect(h.readRecord().permissionMode).toBe("auto");
    expect((result.resultJson as any).qoderAdapter.permissionModeWarning).toContain("plan");
    const stderrText = h.logs
      .filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.chunk)
      .join("");
    expect(stderrText).toContain("plan");
  });

  it("prefers the Paperclip workspace over the configured directory", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpRoot, "paperclip-ws-"));
    const configured = fs.mkdtempSync(path.join(tmpRoot, "configured-"));
    const h = harness({
      scenario: "ok",
      config: { cwd: configured },
      context: { paperclipWorkspace: { cwd: workspace, source: "clone", workspaceId: "ws-1" } },
    });
    await execute(h.ctx);
    expect(h.readRecord().workDir).toBe(workspace);
  });

  it("uses the configured directory when the workspace is only the agent home", async () => {
    const agentHome = fs.mkdtempSync(path.join(tmpRoot, "agent-home-"));
    const configured = fs.mkdtempSync(path.join(tmpRoot, "project-"));
    const h = harness({
      scenario: "ok",
      config: { cwd: configured },
      context: {
        paperclipWorkspace: { cwd: agentHome, source: "agent_home", workspaceId: "ws-1" },
      },
    });
    await execute(h.ctx);
    expect(h.readRecord().workDir).toBe(configured);
  });

  it("creates a configured directory that does not exist yet", async () => {
    const target = path.join(tmpRoot, "not-created-yet", "nested");
    const h = harness({ scenario: "ok", config: { cwd: target } });
    const result = await execute(h.ctx);
    expect(result.errorCode).toBeNull();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("refuses a remote execution target instead of pretending to support it", async () => {
    const h = harness({ scenario: "ok" });
    // A real, parseable remote target: this adapter drives a CLI that has to be
    // installed and logged in on the executing host, which it cannot verify or
    // provision remotely.
    (h.ctx as any).executionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
      environmentId: "env-1",
    };
    const result = (await execute(h.ctx)) as AdapterExecutionResult;

    expect(result.errorCode).toBe("qoder_remote_unsupported");
    expect(result.errorFamily).toBe("configuration");
    expect(result.exitCode).toBeNull();
    // It refused before spawning anything.
    expect(fs.existsSync(h.recordPath)).toBe(false);
  });

  it("refuses an ssh execution target as well", async () => {
    const h = harness({ scenario: "ok" });
    (h.ctx as any).executionTarget = {
      kind: "remote",
      transport: "ssh",
      spec: {
        host: "build-box.invalid",
        port: 22,
        username: "ci",
        remoteCwd: "/srv/project",
      },
    };
    const result = await execute(h.ctx);
    expect(result.errorCode).toBe("qoder_remote_unsupported");
    expect(fs.existsSync(h.recordPath)).toBe(false);
  });
});

describe("execute — instructions bundle", () => {
  it("injects the AGENTS.md bundle and grants access to its directory", async () => {
    const bundleDir = fs.mkdtempSync(path.join(tmpRoot, "instructions-"));
    const bundlePath = path.join(bundleDir, "AGENTS.md");
    fs.writeFileSync(bundlePath, "# 项目约定\n\n提交前运行 npm test。\n");

    const h = harness({ scenario: "ok", config: { instructionsFilePath: bundlePath } });
    await execute(h.ctx);
    const record = h.readRecord();

    expect(JSON.parse(record.stdin).message.content).toContain("提交前运行 npm test");
    expect(record.addDirs).toContain(bundleDir);
  });

  it("warns but still runs when the bundle cannot be read", async () => {
    const missing = path.join(tmpRoot, "missing", "AGENTS.md");
    const h = harness({ scenario: "ok", config: { instructionsFilePath: missing } });
    const result = await execute(h.ctx);

    expect(result.errorCode).toBeNull();
    const stderrText = h.logs
      .filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.chunk)
      .join("");
    expect(stderrText).toContain("could not");
  });
});
