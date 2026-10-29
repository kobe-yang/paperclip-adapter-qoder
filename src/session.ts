/**
 * Session continuity and workspace isolation.
 *
 * The CLI's `-c/--continue` ("most recent session on this machine") is never
 * used anywhere in this adapter, because on a multi-agent host "most recent"
 * belongs to whichever agent happened to run last.
 */

import path from "node:path";

export type StoredQoderSession = {
  sessionId: string;
  cwd: string;
  workspaceId: string;
  repoUrl: string;
  repoRef: string;
};

export type SessionResumeDecision = {
  resumeSessionId: string | null;
  /** Human-readable reason a stored session was refused, for the run log. */
  refusalReason: string | null;
};

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the session Paperclip stored for this agent. */
export function readStoredSession(
  sessionParams: unknown,
  fallbackSessionId: string | null | undefined,
): StoredQoderSession | null {
  const params = isRecord(sessionParams) ? sessionParams : {};
  const sessionId =
    readString(params, "sessionId") ||
    (typeof fallbackSessionId === "string" ? fallbackSessionId.trim() : "");
  if (!sessionId) return null;
  return {
    sessionId,
    cwd: readString(params, "cwd"),
    workspaceId: readString(params, "workspaceId"),
    repoUrl: readString(params, "repoUrl"),
    repoRef: readString(params, "repoRef"),
  };
}

export type SessionResumeInput = {
  stored: StoredQoderSession | null;
  cwd: string;
  workspaceId: string;
  repoUrl?: string;
  repoRef?: string;
  /** Remote execution is out of scope for this adapter; see execute.ts. */
  executionTargetIsRemote?: boolean;
};

/** Decides whether the stored session may be resumed. */
export function decideSessionResume(input: SessionResumeInput): SessionResumeDecision {
  const { stored } = input;
  if (!stored) return { resumeSessionId: null, refusalReason: null };

  if (input.executionTargetIsRemote) {
    return {
      resumeSessionId: null,
      refusalReason: `Session "${stored.sessionId}" was recorded for local execution and will not be resumed on a remote execution target.`,
    };
  }

  if (stored.cwd && path.resolve(stored.cwd) !== path.resolve(input.cwd)) {
    return {
      resumeSessionId: null,
      refusalReason: `Session "${stored.sessionId}" was created in "${stored.cwd}" and will not be resumed in "${input.cwd}".`,
    };
  }

  if (stored.workspaceId && input.workspaceId && stored.workspaceId !== input.workspaceId) {
    return {
      resumeSessionId: null,
      refusalReason: `Session "${stored.sessionId}" belongs to workspace "${stored.workspaceId}", not "${input.workspaceId}".`,
    };
  }

  if (stored.repoUrl && input.repoUrl && stored.repoUrl !== input.repoUrl) {
    return {
      resumeSessionId: null,
      refusalReason: `Session "${stored.sessionId}" belongs to a different repository and will not be resumed.`,
    };
  }
  if (stored.repoRef && input.repoRef && stored.repoRef !== input.repoRef) {
    return {
      resumeSessionId: null,
      refusalReason: `Session "${stored.sessionId}" belongs to a different repository revision and will not be resumed.`,
    };
  }

  return { resumeSessionId: stored.sessionId, refusalReason: null };
}

export type SessionParamsInput = {
  sessionId: string | null;
  cwd: string;
  workspaceId?: string;
  repoUrl?: string;
  repoRef?: string;
};

/** Builds the `sessionParams` to persist, recording the context for next time. */
export function buildSessionParams(
  input: SessionParamsInput,
): Record<string, string> | null {
  if (!input.sessionId) return null;
  const params: Record<string, string> = {
    sessionId: input.sessionId,
    cwd: input.cwd,
  };
  if (input.workspaceId) params.workspaceId = input.workspaceId;
  if (input.repoUrl) params.repoUrl = input.repoUrl;
  if (input.repoRef) params.repoRef = input.repoRef;
  return params;
}
