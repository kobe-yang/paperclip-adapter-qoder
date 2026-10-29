#!/usr/bin/env bash
#
# Standalone Qoder CLI smoke test, runnable from an ordinary terminal.
#
# Why this exists: when Paperclip (or this adapter's test suite) is started from
# inside a Qoder session, the Qoder SDK handshake variables are inherited and
# the CLI switches into SDK/daemon mode instead of running as a plain headless
# CLI. On this machine that produced:
#
#   terminal_reason: "auth_payload_invalid"
#   errors: ["SDK auth payload file not found: …/payload.json"]
#
# with no `system/init` line at all. This script neutralizes exactly the
# variables the adapter neutralizes (`src/env.ts`), so you can reproduce what
# the adapter does without Paperclip in the loop.
#
# The subagent spawn-depth guard and the Qoder config dirs are deliberately
# left untouched — they are protections, not plumbing.
#
# Usage:
#   scripts/qoder-smoke.sh                       # auth/protocol probe, no model call
#   scripts/qoder-smoke.sh "your prompt here"    # one real run (costs a model call)
#
# With no argument it runs `--version` and `--list-models` only. Both were
# verified to stop before any model request, so the no-argument form cannot
# spend quota.

set -uo pipefail

QODER_BIN="${QODER_BIN:-qoder}"
WORK_DIR="${QODER_SMOKE_CWD:-$(pwd)}"

# Keep this list in sync with QODER_SDK_HANDSHAKE_ENV_KEYS in src/env.ts.
for key in \
  QODER_AGENT_SDK_ENTRYPOINT \
  QODER_AGENT_SDK_DAEMON \
  QODER_AGENT_SDK_VERSION \
  QODER_AGENT_SDK_LANGUAGE \
  QODER_SDK_AUTH_PAYLOAD_FILE \
  QODER_SDK_AUTH_CONFIG_DIR \
  QODER_SDK_ACCESS_TOKEN \
  QODER_SDK_CUSTOM_BASE_URL_BYOK \
  QODER_SESSION_TYPE \
  QODER_SESSION_ID \
  QODER_SEARCH_HOST_PID \
  QODER_REMOTE_WORKER \
  QODER_RUNTIME_ROLE \
  QODER_CLI \
  QODERCLI_RUNTIME_PACKAGING \
  QODER_WORKER_RUNTIME_ASSET_ROOT
do
  export "${key}="
done

export CI=1 NO_COLOR=1 TERM=dumb

if ! command -v "${QODER_BIN}" >/dev/null 2>&1; then
  echo "Qoder CLI not found on PATH as '${QODER_BIN}'." >&2
  echo "Install it with: npm i -g @qoder-ai/qodercli" >&2
  exit 1
fi

echo "== which"
command -v "${QODER_BIN}"

echo
echo "== ${QODER_BIN} --version"
"${QODER_BIN}" --version
echo "exit=$?"

echo
echo "== ${QODER_BIN} --list-models   (exit 1 + 'Not logged in' means: run \`qoder login\`)"
"${QODER_BIN}" --list-models
echo "exit=$?"

if [ "$#" -eq 0 ]; then
  echo
  echo "No prompt given, so no model call was made."
  echo "To run one real headless turn:  $0 \"Reply with the single word ok.\""
  exit 0
fi

PROMPT="$1"
echo
echo "== one headless stream-json run in ${WORK_DIR}"
echo "   (this costs one real model call)"

# Same invocation shape the adapter uses: prompt on stdin as a single
# stream-json user message, never in argv.
printf '%s\n' "$(PROMPT="${PROMPT}" node -e 'process.stdout.write(JSON.stringify({type:"user",message:{role:"user",content:process.env.PROMPT},parent_tool_use_id:null}))')" \
  | "${QODER_BIN}" \
      --print \
      --input-format stream-json \
      --output-format stream-json \
      -w "${WORK_DIR}" \
      --permission-mode auto \
      --max-turns 8

echo "exit=$?"
echo
echo "Reminder: the CLI can exit 0 on a failed run. Read the terminal"
echo "{\"type\":\"result\"} line and check is_error, not just the exit code."
