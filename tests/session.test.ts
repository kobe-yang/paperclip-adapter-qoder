import { describe, expect, it } from "vitest";

import { sessionCodec } from "../src/index.js";
import {
  buildSessionParams,
  decideSessionResume,
  readStoredSession,
} from "../src/session.js";

const stored = {
  sessionId: "sess-1",
  cwd: "/tmp/project-a",
  workspaceId: "ws-a",
  repoUrl: "",
  repoRef: "",
};

describe("readStoredSession", () => {
  it("prefers sessionParams, which carry the context the id is valid in", () => {
    expect(
      readStoredSession({ sessionId: "sess-1", cwd: "/tmp/a", workspaceId: "ws-a" }, "ignored"),
    ).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/a",
      workspaceId: "ws-a",
      repoUrl: "",
      repoRef: "",
    });
  });

  it("accepts a bare runtime session id but records no provenance", () => {
    expect(readStoredSession(null, "sess-bare")?.cwd).toBe("");
  });

  it("returns null when there is no session at all", () => {
    expect(readStoredSession(null, null)).toBeNull();
    expect(readStoredSession({}, "")).toBeNull();
    expect(readStoredSession({ sessionId: "   " }, "  ")).toBeNull();
  });

  it("ignores a non-object sessionParams instead of throwing", () => {
    expect(readStoredSession("garbage", "sess-x")?.sessionId).toBe("sess-x");
    expect(readStoredSession([1, 2], "sess-x")?.sessionId).toBe("sess-x");
  });
});

describe("decideSessionResume", () => {
  it("resumes when the working directory and workspace both match", () => {
    expect(
      decideSessionResume({ stored, cwd: "/tmp/project-a", workspaceId: "ws-a" }),
    ).toEqual({ resumeSessionId: "sess-1", refusalReason: null });
  });

  it("normalizes path spelling before comparing", () => {
    expect(
      decideSessionResume({
        stored: { ...stored, cwd: "/tmp/project-a/" },
        cwd: "/tmp/./project-a",
        workspaceId: "ws-a",
      }).resumeSessionId,
    ).toBe("sess-1");
  });

  it("starts fresh when there is no stored session", () => {
    expect(decideSessionResume({ stored: null, cwd: "/tmp/x", workspaceId: "" })).toEqual({
      resumeSessionId: null,
      refusalReason: null,
    });
  });

  it("refuses a session created in a different directory", () => {
    const decision = decideSessionResume({
      stored,
      cwd: "/tmp/project-b",
      workspaceId: "ws-a",
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("/tmp/project-a");
    expect(decision.refusalReason).toContain("/tmp/project-b");
  });

  it("refuses a session belonging to another workspace", () => {
    const decision = decideSessionResume({
      stored,
      cwd: "/tmp/project-a",
      workspaceId: "ws-b",
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("ws-a");
  });

  it.each(["repoUrl", "repoRef"] as const)("refuses contradictory %s even without recorded cwd", (key) => {
    const decision = decideSessionResume({
      stored: { ...stored, cwd: "", [key]: "recorded" },
      cwd: "/tmp/project-a",
      workspaceId: "ws-a",
      [key]: "different",
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("repository");
  });

  it("resumes a bare legacy session with no cwd or workspace, on the host's authority", () => {
    const decision = decideSessionResume({
      stored: readStoredSession(null, "sess-1"),
      cwd: "/tmp/project-a",
      workspaceId: "ws-a",
    });
    expect(decision.resumeSessionId).toBe("sess-1");
    expect(decision.refusalReason).toBeNull();
  });

  it("resumes without a cwd when the recorded workspace matches", () => {
    expect(
      decideSessionResume({
        stored: { ...stored, cwd: "" },
        cwd: "/tmp/project-a",
        workspaceId: "ws-a",
      }),
    ).toEqual({ resumeSessionId: "sess-1", refusalReason: null });
  });

  it.each([undefined, ""])("refuses a conflicting workspace even with cwd %s", (cwd) => {
    const decision = decideSessionResume({
      stored: readStoredSession({ sessionId: "sess-1", workspaceId: "ws-a", cwd }, null),
      cwd: "/tmp/project-a",
      workspaceId: "ws-b",
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("ws-a");
    expect(decision.refusalReason).toContain("ws-b");
  });

  it("still refuses when the recorded directory contradicts this run", () => {
    const decision = decideSessionResume({
      stored,
      cwd: "/tmp/project-b",
      workspaceId: "ws-a",
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("/tmp/project-a");
  });

  it("refuses to carry a local session onto a remote execution target", () => {
    const decision = decideSessionResume({
      stored,
      cwd: "/tmp/project-a",
      workspaceId: "ws-a",
      executionTargetIsRemote: true,
    });
    expect(decision.resumeSessionId).toBeNull();
    expect(decision.refusalReason).toContain("remote");
  });

  it("tolerates a missing workspace id on either side", () => {
    expect(
      decideSessionResume({
        stored: { ...stored, workspaceId: "" },
        cwd: "/tmp/project-a",
        workspaceId: "ws-a",
      }).resumeSessionId,
    ).toBe("sess-1");
    expect(
      decideSessionResume({ stored, cwd: "/tmp/project-a", workspaceId: "" }).resumeSessionId,
    ).toBe("sess-1");
  });

  it("keeps two tasks in different directories on separate sessions", () => {
    const taskA = decideSessionResume({ stored, cwd: "/tmp/project-a", workspaceId: "ws-a" });
    const taskB = decideSessionResume({ stored, cwd: "/tmp/project-b", workspaceId: "ws-b" });
    expect(taskA.resumeSessionId).toBe("sess-1");
    expect(taskB.resumeSessionId).toBeNull();
  });
});

describe("buildSessionParams", () => {
  it("records the context the id may be reused in", () => {
    expect(
      buildSessionParams({
        sessionId: "sess-1",
        cwd: "/tmp/project-a",
        workspaceId: "ws-a",
        repoUrl: "https://example.invalid/repo.git",
        repoRef: "main",
      }),
    ).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/project-a",
      workspaceId: "ws-a",
      repoUrl: "https://example.invalid/repo.git",
      repoRef: "main",
    });
  });

  it("omits empty provenance rather than storing blanks", () => {
    expect(buildSessionParams({ sessionId: "sess-1", cwd: "/tmp/a" })).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/a",
    });
  });

  it("stores nothing without a session id", () => {
    expect(buildSessionParams({ sessionId: null, cwd: "/tmp/a" })).toBeNull();
  });
});

describe("sessionCodec", () => {
  it("round-trips a stored record", () => {
    const params = {
      sessionId: "sess-1",
      cwd: "/tmp/project-a",
      workspaceId: "ws-a",
    };
    expect(sessionCodec.serialize(params)).toEqual(params);
    expect(sessionCodec.deserialize(params)).toEqual(params);
  });

  it("accepts snake_case keys from an older record", () => {
    expect(
      sessionCodec.deserialize({ session_id: "sess-2", cwd: "/tmp/b", workspace_id: "ws-b" }),
    ).toEqual({ sessionId: "sess-2", cwd: "/tmp/b", workspaceId: "ws-b" });
  });

  it("drops a record with no usable id", () => {
    expect(sessionCodec.deserialize({ cwd: "/tmp/b" })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("nope")).toBeNull();
    expect(sessionCodec.deserialize([])).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("exposes the session id for display", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "sess-1" })).toBe("sess-1");
    expect(sessionCodec.getDisplayId?.({})).toBeNull();
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });

  it("does not preserve unknown keys that could smuggle state across tasks", () => {
    const deserialized = sessionCodec.deserialize({
      sessionId: "sess-1",
      cwd: "/tmp/a",
      stolenToken: "secret",
    });
    expect(deserialized).not.toHaveProperty("stolenToken");
  });
});

describe("createServerAdapter capabilities", () => {
  it("requests a run-scoped agent JWT", async () => {
    // The host only mints one when the adapter declares this
    // (`runtime-execution.js`: authToken = … adapter.supportsLocalAgentJwt ? … : null).
    // Without it the CLI gets no PAPERCLIP_API_KEY and its Paperclip API calls
    // are attributed to the board user rather than to the agent.
    const { createServerAdapter } = await import("../src/index.js");
    expect(createServerAdapter().supportsLocalAgentJwt).toBe(true);
  });

  it("declares the instructions bundle so AGENTS.md reaches the CLI", async () => {
    const { createServerAdapter } = await import("../src/index.js");
    const adapter = createServerAdapter();
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  });

  it("does not claim remote provisioning it cannot honour", async () => {
    const { createServerAdapter } = await import("../src/index.js");
    const adapter = createServerAdapter();
    // No remote target support, so no runtime command spec.
    expect(adapter.getRuntimeCommandSpec).toBeUndefined();
    // Models are discovered by asking the CLI, never hardcoded.
    expect(adapter.models).toBeUndefined();
    expect(typeof adapter.listModels).toBe("function");
  });
});
