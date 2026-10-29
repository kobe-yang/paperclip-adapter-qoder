# Test fixtures

Provenance matters here, so each file says how it was obtained.

## `successful-run-recorded.jsonl` — recorded

Real stdout from the Qoder run that exposed four adapter bugs on 2026-10-29
(model `GLM-5.3`, 3 turns, 11.62 credits), pulled
back out of the Paperclip run log. All 13 protocol lines are present in order,
including the `hook_started` / `artifacts_update` / `hook_diagnostics` /
`hook_response` events and a terminal `result` with `is_error: false` and **no
`terminal_reason` field**.

Desensitized before committing:

- the working directory, which contained the user's home path and the agent id
  → `/tmp/sample-workspace`;
- the installed tool / skill / slash-command / agent / plugin / MCP inventory,
  which exposes private plugins and their paths under the user's home → trimmed
  to a few representative entries or emptied;
- session ids, message ids, tool-use ids, uuids and `request_id` → fixed
  placeholders;
- the issue key and the conversation text → generic equivalents, keeping the
  Chinese characters so the UTF-8 paths stay exercised;
- the two `Bash` commands → kept structurally identical, including the
  `paperclipai issue … "$PAPERCLIP_TASK_ID"` shape. They never contained a
  literal credential: the agent referenced the environment variable.

Everything load-bearing is as emitted: `subtype`, `is_error`, `stop_reason`,
`num_turns`, `total_cost_usd: 0`, `total_credits`, the all-zero token counters,
and `apiKeySource: "none"` **on a logged-in run** — which is why the
environment test asks the CLI rather than reading that field.

This is the primary fixture for `tests/regression.test.ts`.

## `list-models.txt` — recorded

Verbatim stdout of `qoder --list-models` on a logged-in account
(`qoder@1.1.80`, exit 0): a `MODEL` header followed by one model id per line.
Model names are public product names, so nothing needed redacting.

## `auth-failure.jsonl` — recorded

Real output from `qoder@1.1.80` on this machine, captured with:

```
printf '%s\n' '{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}' \
  | qoder --print --input-format stream-json --output-format stream-json -w <dir> --permission-mode auto
```

Exit code was 1. Desensitized before committing:

- the installed plugin / skill / slash-command / agent / tool inventory was
  trimmed to a few representative entries, because the full lists expose which
  private plugins this machine has installed, including absolute paths under
  the user's home directory;
- session/message ids and UUIDs use fixed placeholders; the working directory
  is generic. `apiKeySource`, `terminal_reason` and `usage` are as emitted.

This file is the evidence for two behaviours the adapter depends on:
`total_cost_usd: 0` next to a failed run (so zero cost must not be reported as
a priced free run), and `subtype: "success"` next to `is_error: true` (so the
subtype is not a success signal).

## `successful-run.jsonl` — constructed

**Not a recording.** Written before an account was available, from field names
read out of the installed CLI bundle. Values are invented.

Kept because it exercises combinations the recorded run does not:
`api_retry`, a `stream_event` that must be ignored, a priced result with
non-zero `total_cost_usd`, and both tool_result content encodings. For
anything about real-world behaviour, prefer
`successful-run-recorded.jsonl`.
