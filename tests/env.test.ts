import { describe, expect, it } from "vitest";

import {
  QODER_PRESERVED_ENV_KEYS,
  buildQoderChildEnv,
  describeNeutralizedEnvKeys,
  qoderSdkHandshakeEnvKeys,
  renderApiAccessNote,
  renderPaperclipEnvNote,
} from "../src/env.js";

describe("buildQoderChildEnv", () => {
  it("neutralizes every SDK handshake variable to an empty string", () => {
    // The host merges `{...process.env, ...opts.env}` and offers adapters no
    // delete channel, so omitting a key lets the inherited value through.
    // Overriding to "" is the only way to make the CLI see it as unset.
    const env = buildQoderChildEnv({});
    for (const key of qoderSdkHandshakeEnvKeys()) {
      expect(env[key], key).toBe("");
    }
  });

  it("covers the variable that actually broke a live run", () => {
    // A real probe failed with `auth_payload_invalid` because this was
    // inherited from the Qoder session that started the Paperclip server.
    expect(qoderSdkHandshakeEnvKeys()).toContain("QODER_SDK_AUTH_PAYLOAD_FILE");
    expect(qoderSdkHandshakeEnvKeys()).toContain("QODER_AGENT_SDK_ENTRYPOINT");
  });

  it("sets headless terminal hints", () => {
    const env = buildQoderChildEnv({});
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
    expect(env.TERM).toBe("dumb");
  });

  it("lets the caller's env win over the headless defaults", () => {
    const env = buildQoderChildEnv({ TERM: "xterm-256color", PAPERCLIP_AGENT_ID: "a1" });
    expect(env.TERM).toBe("xterm-256color");
    expect(env.PAPERCLIP_AGENT_ID).toBe("a1");
  });

  it("lets a deliberate operator override of a handshake key through", () => {
    const env = buildQoderChildEnv({ QODER_SESSION_TYPE: "explicit" });
    expect(env.QODER_SESSION_TYPE).toBe("explicit");
  });

  it("never touches the nesting-depth guard or the credential roots", () => {
    const env = buildQoderChildEnv({});
    for (const key of Object.keys(QODER_PRESERVED_ENV_KEYS)) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(Object.keys(QODER_PRESERVED_ENV_KEYS)).toContain(
      "QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH",
    );
  });

  it("ignores non-string values instead of stringifying them", () => {
    const env = buildQoderChildEnv({ GOOD: "1", BAD: undefined as unknown as string });
    expect(env.GOOD).toBe("1");
    expect(env).not.toHaveProperty("BAD");
  });
});

describe("describeNeutralizedEnvKeys", () => {
  it("reports only keys that were actually inherited with a value", () => {
    expect(
      describeNeutralizedEnvKeys({
        QODER_SESSION_ID: "abc",
        QODER_AGENT_SDK_DAEMON: "",
        PATH: "/usr/bin",
      }),
    ).toEqual(["QODER_SESSION_ID"]);
  });

  it("reports nothing on a clean environment", () => {
    expect(describeNeutralizedEnvKeys({ PATH: "/usr/bin" })).toEqual([]);
  });
});

describe("prompt notes", () => {
  it("names Paperclip variables but never prints a value", () => {
    const note = renderPaperclipEnvNote({
      PAPERCLIP_AGENT_ID: "agent-123",
      PAPERCLIP_RUN_ID: "run-456",
      PAPERCLIP_API_KEY: "pk-secret-value",
    });
    expect(note).toContain("PAPERCLIP_AGENT_ID");
    expect(note).not.toContain("agent-123");
    expect(note).not.toContain("run-456");
    expect(note).not.toContain("pk-secret-value");
  });

  it("is empty when there is nothing to report", () => {
    expect(renderPaperclipEnvNote({})).toBe("");
    expect(renderPaperclipEnvNote({ PAPERCLIP_AGENT_ID: "" })).toBe("");
  });

  it("mentions the API key variable without leaking the token", () => {
    const note = renderApiAccessNote({
      PAPERCLIP_API_KEY: "pk-live-super-secret",
      PAPERCLIP_API_URL: "https://paperclip.example/api",
    });
    expect(note).toContain("PAPERCLIP_API_KEY");
    expect(note).toContain("https://paperclip.example/api");
    expect(note).not.toContain("pk-live-super-secret");
    expect(note).toMatch(/[Nn]ever print/);
  });

  it("says nothing about API access when no token was issued", () => {
    expect(renderApiAccessNote({})).toBe("");
    expect(renderApiAccessNote({ PAPERCLIP_API_URL: "https://x" })).toBe("");
  });
});
