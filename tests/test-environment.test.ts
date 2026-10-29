import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
} from "@paperclipai/adapter-utils/types";

import { testEnvironment } from "../src/test-environment.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PROBE = path.join(testsDir, "fake-qoder-probe.mjs");

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-adapter-envtest-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function ctxWith(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    adapterType: "qoder_local",
    config,
    ...extra,
  } as unknown as AdapterEnvironmentTestContext;
}

function codes(checks: AdapterEnvironmentCheck[]): string[] {
  return checks.map((check) => check.code);
}

function find(checks: AdapterEnvironmentCheck[], code: string): AdapterEnvironmentCheck {
  const check = checks.find((entry) => entry.code === code);
  if (!check) throw new Error(`no check with code ${code}; got ${codes(checks).join(", ")}`);
  return check;
}

describe("testEnvironment — target and configuration", () => {
  it("fails a remote execution target up front", async () => {
    const result = await testEnvironment(
      ctxWith(
        { command: FAKE_PROBE },
        {
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            remoteCwd: "/workspace",
          },
          environmentName: "build-sandbox",
        },
      ),
    );
    expect(result.status).toBe("fail");
    expect(codes(result.checks)).toEqual(["qoder_remote_unsupported"]);
    expect(result.checks[0]?.message).toContain("build-sandbox");
  });

  it("rejects extra arguments before probing or creating directories", async () => {
    const target = path.join(tmpRoot, "should-not-appear");
    const recordPath = path.join(tmpRoot, "probe-argv.json");
    const result = await testEnvironment(ctxWith({
      command: FAKE_PROBE,
      cwd: target,
      extraArgs: "--continue",
      env: { FAKE_PROBE_AUTH: "ok", FAKE_PROBE_RECORD: recordPath },
    }));
    expect(result.status).toBe("fail");
    expect(codes(result.checks)).toEqual(["qoder_extra_args_invalid"]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it("rejects a relative working directory", async () => {
    const result = await testEnvironment(ctxWith({ command: FAKE_PROBE, cwd: "./relative" }));
    expect(result.status).toBe("fail");
    expect(codes(result.checks)).toContain("qoder_cwd_not_absolute");
  });

  it("reports a working directory that does not exist", async () => {
    const result = await testEnvironment(
      ctxWith({ command: FAKE_PROBE, cwd: path.join(tmpRoot, "nope") }),
    );
    expect(codes(result.checks)).toContain("qoder_cwd_invalid");
    expect(result.status).toBe("fail");
  });

  it("does not create the working directory as a side effect", async () => {
    const target = path.join(tmpRoot, "should-not-appear");
    await testEnvironment(ctxWith({ command: FAKE_PROBE, cwd: target }));
    expect(fs.existsSync(target)).toBe(false);
  });

  it("warns about an invalid permission mode and still runs the probes", async () => {
    const result = await testEnvironment(
      ctxWith({ command: FAKE_PROBE, cwd: tmpRoot, permissionMode: "plan" }),
    );
    expect(codes(result.checks)).toContain("qoder_permission_mode_invalid");
    expect(find(result.checks, "qoder_permission_mode_invalid").level).toBe("warn");
  });

  it("warns that bypass_permissions removes every check", async () => {
    const result = await testEnvironment(
      ctxWith({ command: FAKE_PROBE, cwd: tmpRoot, permissionMode: "bypass_permissions" }),
    );
    const check = find(result.checks, "qoder_permission_mode_bypassed");
    expect(check.level).toBe("warn");
    expect(check.hint).toContain("not an OS sandbox");
  });

  it("reports a missing CLI as an error with install guidance", async () => {
    const result = await testEnvironment(
      ctxWith({ command: "/definitely/not/here/qoder", cwd: tmpRoot }),
    );
    expect(result.status).toBe("fail");
    const check = find(result.checks, "qoder_cli_not_found");
    expect(check.hint).toContain("@qoder-ai/qodercli");
  });
});

describe("testEnvironment — CLI probes", () => {
  const base = { command: FAKE_PROBE, cwd: () => tmpRoot };

  it("passes when the CLI is the verified version and logged in", async () => {
    const result = await testEnvironment(
      ctxWith({
        ...base,
        cwd: tmpRoot,
        env: { FAKE_PROBE_VERSION: "1.1.80", FAKE_PROBE_AUTH: "ok" },
      }),
    );
    expect(result.status).toBe("pass");
    expect(codes(result.checks)).toContain("qoder_cli_version");
    expect(find(result.checks, "qoder_auth").detail).toContain("does not call a model");
  });

  it("warns, rather than fails, on an unverified CLI version", async () => {
    const result = await testEnvironment(
      ctxWith({
        ...base,
        cwd: tmpRoot,
        env: { FAKE_PROBE_VERSION: "2.0.0", FAKE_PROBE_AUTH: "ok" },
      }),
    );
    expect(result.status).toBe("warn");
    const check = find(result.checks, "qoder_cli_version_unverified");
    expect(check.message).toContain("2.0.0");
    expect(check.message).toContain("1.1.80");
  });

  it("fails with an actionable hint when the CLI is not logged in", async () => {
    const result = await testEnvironment(
      ctxWith({ ...base, cwd: tmpRoot, env: { FAKE_PROBE_AUTH: "not-logged-in" } }),
    );
    expect(result.status).toBe("fail");
    const check = find(result.checks, "qoder_auth_required");
    expect(check.hint).toContain("qoder login");
    expect(check.detail).toContain("Not logged in");
  });

  it("reports a quota problem separately from an auth problem", async () => {
    const result = await testEnvironment(
      ctxWith({ ...base, cwd: tmpRoot, env: { FAKE_PROBE_AUTH: "quota" } }),
    );
    expect(codes(result.checks)).toContain("qoder_quota_exceeded");
    expect(codes(result.checks)).not.toContain("qoder_auth_required");
  });

  it("says authentication is unknown instead of guessing", async () => {
    const result = await testEnvironment(
      ctxWith({ ...base, cwd: tmpRoot, env: { FAKE_PROBE_AUTH: "weird" } }),
    );
    expect(result.status).toBe("warn");
    const check = find(result.checks, "qoder_auth_unknown");
    expect(check.message).toContain("cannot classify");
  });

  it("fails when the CLI cannot even report its version", async () => {
    const result = await testEnvironment(
      ctxWith({ ...base, cwd: tmpRoot, env: { FAKE_PROBE_VERSION_FAIL: "1" } }),
    );
    expect(result.status).toBe("fail");
    expect(codes(result.checks)).toContain("qoder_cli_unusable");
    // Stops before the auth probe, since the CLI is not usable at all.
    expect(codes(result.checks)).not.toContain("qoder_auth_required");
  });

  it("never spends a model call: no probe passes a prompt", async () => {
    const recordPath = path.join(tmpRoot, "probe-argv.json");
    await testEnvironment(
      ctxWith({
        ...base,
        cwd: tmpRoot,
        env: { FAKE_PROBE_AUTH: "ok", FAKE_PROBE_RECORD: recordPath },
      }),
    );
    const invocations: string[][] = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    expect(invocations).toEqual([["--version"], ["--list-models"]]);
    for (const argv of invocations) {
      expect(argv).not.toContain("-p");
      expect(argv).not.toContain("--print");
    }
  });

  it("runs the probes with the SDK handshake variables neutralized", async () => {
    const previous = process.env.QODER_SDK_AUTH_PAYLOAD_FILE;
    process.env.QODER_SDK_AUTH_PAYLOAD_FILE = "/tmp/parent-payload.json";
    const envPath = path.join(tmpRoot, "probe-env.json");
    try {
      const result = await testEnvironment(
        ctxWith({
          ...base,
          cwd: tmpRoot,
          env: { FAKE_PROBE_AUTH: "ok", FAKE_PROBE_ENV_RECORD: envPath },
        }),
      );
      const recorded = JSON.parse(fs.readFileSync(envPath, "utf8"));
      expect(recorded.QODER_SDK_AUTH_PAYLOAD_FILE).toBe("");
      expect(codes(result.checks)).toContain("qoder_sdk_env_neutralized");
    } finally {
      if (previous === undefined) delete process.env.QODER_SDK_AUTH_PAYLOAD_FILE;
      else process.env.QODER_SDK_AUTH_PAYLOAD_FILE = previous;
    }
  });

  it("does not claim a configured model is valid", async () => {
    const result = await testEnvironment(
      ctxWith({
        ...base,
        cwd: tmpRoot,
        model: "made-up-model",
        env: { FAKE_PROBE_AUTH: "ok" },
      }),
    );
    const check = find(result.checks, "qoder_model_unverified");
    expect(check.level).toBe("info");
    expect(check.message).toContain("does not validate model names");
  });

  it("returns the adapter type and a timestamp", async () => {
    const result = await testEnvironment(
      ctxWith({ ...base, cwd: tmpRoot, env: { FAKE_PROBE_AUTH: "ok" } }),
    );
    expect(result.adapterType).toBe("qoder_local");
    expect(Number.isNaN(Date.parse(result.testedAt))).toBe(false);
  });
});
