/**
 * Command-line and stdin construction for one Qoder CLI attempt.
 *
 * Kept pure so the exact argv and stdin payload can be asserted in tests
 * without spawning anything.
 *
 * Shape verified against the CLI's option registration in
 * `@qoder-ai/qodercli@1.1.80`:
 *   - `--allowed-tools`, `--disallowed-tools` and `--add-dir` are registered
 *     with a collector, so repeating them accumulates values.
 *   - `--max-turns` is registered but `.hideHelp()`, so it is absent from
 *     `qoder --help` while still being honoured.
 *   - the parser runs with `allowUnknownOption(true)`, so a misspelled flag is
 *     dropped silently instead of failing the run. Nothing here is speculative.
 */

import { getExtraArgsError, type QoderPermissionMode } from "./config.js";

export type QoderArgsInput = {
  /** Resume target. Never pass `-c/--continue`; see the note below. */
  resumeSessionId?: string | null;
  cwd: string;
  model?: string;
  permissionMode: QoderPermissionMode;
  addDirs?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number | null;
  maxOutputTokens?: number | null;
  maxModelRequestRetries?: number | null;
  appendSystemPrompt?: string;
  extraArgs?: string[];
};

/**
 * Builds the argv for one attempt.
 *
 * `-c/--continue` is deliberately never emitted. It resumes "the most recent
 * session on this machine", which for a multi-agent host means one agent can
 * silently inherit another agent's conversation. Resume is always by explicit
 * session id or not at all.
 */
export function buildQoderArgs(input: QoderArgsInput): string[] {
  const args: string[] = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];

  args.push("-w", input.cwd);
  args.push("--permission-mode", input.permissionMode);

  const model = input.model?.trim();
  if (model) args.push("-m", model);

  const resumeSessionId = input.resumeSessionId?.trim();
  if (resumeSessionId) args.push("-r", resumeSessionId);

  for (const dir of dedupe(input.addDirs)) args.push("--add-dir", dir);
  for (const tool of dedupe(input.allowedTools)) args.push("--allowed-tools", tool);
  for (const tool of dedupe(input.disallowedTools)) args.push("--disallowed-tools", tool);

  if (input.maxTurns != null) args.push("--max-turns", String(input.maxTurns));
  if (input.maxOutputTokens != null) {
    args.push("--max-output-tokens", String(input.maxOutputTokens));
  }
  if (input.maxModelRequestRetries != null) {
    args.push("--max-model-request-retries", String(input.maxModelRequestRetries));
  }

  const appendSystemPrompt = input.appendSystemPrompt?.trim();
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  const extraArgs = (input.extraArgs ?? []).filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  const extraArgsError = getExtraArgsError(extraArgs);
  if (extraArgsError) throw new Error(extraArgsError);
  if (extraArgs.length > 0) args.push(...extraArgs);

  return args;
}

/**
 * Encodes the prompt as the single stream-json user message the CLI reads from
 * stdin, terminated by a newline.
 *
 * The prompt travels on stdin rather than argv so it never reaches a process
 * listing, an `execve` argument limit, or a shell quoting layer. The CLI
 * finishes the turn on stdin EOF, which the host provides by closing the pipe
 * after writing.
 */
export function buildQoderStdinPayload(prompt: string): string {
  const message = {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  };
  return `${JSON.stringify(message)}\n`;
}

/**
 * argv for the invocation record. The prompt is not in argv, so only
 * `--append-system-prompt` can carry operator-authored free text; it is
 * replaced with a length so a long block does not bury the real flags.
 */
export function describeArgsForLogs(args: string[]): string[] {
  const described: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    described.push(value);
    if (value !== "--append-system-prompt") continue;
    const next = args[index + 1];
    if (next === undefined) continue;
    described.push(`<append-system-prompt ${next.length} chars>`);
    index += 1;
  }
  return described;
}

function dedupe(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}
