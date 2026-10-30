# paperclip-adapter-qoder

External Paperclip adapter that runs the locally installed **Qoder CLI** as an
agent execution runtime.

- Adapter type: `qoder_local`
- Verified against: Paperclip `2026.1023.0`, `@paperclipai/adapter-utils@2026.1023.0`, Qoder CLI `1.1.80` (stream-json wire protocol `1.5.0`), Node.js `24.22.1`
- "Local" means the host where the Paperclip **server** runs, not the machine with the browser.
- Release candidate: local execution is verified. Typed transcripts passed conditional qualification in an isolated host copy with the Worker fix (#16143 / PR #8806); the unmodified verified host still has that blocker. No core fixes are shipped by this plugin. See `ACCEPTANCE.md` for the exact test conditions and remaining release limits.

The adapter drives `qoder --print --input-format stream-json --output-format
stream-json`, delivers the task prompt on stdin, parses the JSONL event stream
into the Paperclip workbench, and reports the run outcome from the terminal
`result` event.

> Paperclip's adapter contract has no display-name field, so the name you see
> is derived from the type. The UI strips a `_local` suffix and title-cases the
> rest, which shows this adapter as **"Qoder"** in the adapter picker, with the
> generic fallback icon. The intended "Qoder CLI (Local)" is not expressible.
> The server API still reports `label: "qoder_local"`.

## Requirements

1. **Qoder CLI on the Paperclip host.**
   ```bash
   npm i -g @qoder-ai/qodercli
   qoder --version    # expect 1.1.80
   ```
   The CLI must be resolvable from the PATH the Paperclip *server process* has,
   which is not necessarily your shell's PATH. If Paperclip runs as a
   background service, either confirm it resolves (the adapter's environment
   test tells you) or set an absolute path in the **Qoder CLI command** field.

2. **A logged-in Qoder CLI.** Paperclip cannot do this for you:
   ```bash
   qoder login
   ```
   Until this is done, the adapter's environment test fails with
   `qoder_auth_required` and Paperclip refuses to activate the agent.

3. **Node.js ≥ 24.11** (matching Paperclip's own requirement).

## Install

```bash
cd paperclip-adapter-qoder
npm install
npm run verify              # typecheck + automated tests + build + artifact checks
./scripts/paperclip-adapter.sh install
```

`install` calls Paperclip's own `POST /api/adapters/install` with
`isLocalPath: true`, pointed at this directory. Nothing is written into the
Paperclip install tree or its database.

Point it at a different instance with a second argument:

```bash
./scripts/paperclip-adapter.sh install http://127.0.0.1:3101/api
```

Confirm it registered:

```bash
./scripts/paperclip-adapter.sh status
# {"type":"qoder_local","source":"external","loaded":true,"disabled":false,...}
```

Paperclip records the registration in `~/.paperclip/adapter-plugins.json` and
loads it on every startup.

## Create an agent

In the Paperclip UI: **Settings → Adapters** lists `qoder_local`; create or edit
an agent and select it as the harness. Then run the adapter's
**environment test** before assigning work — it costs no model calls.

By API:

```bash
curl -X POST http://127.0.0.1:3100/api/companies/<companyId>/agents \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "Qoder Local",
        "adapterType": "qoder_local",
        "adapterConfig": {
          "command": "qoder",
          "cwd": "/abs/path/to/project",
          "permissionMode": "auto",
          "timeoutSec": 1800,
          "maxTurns": 12
        }
      }'
```

## Configuration

| Field | Key | Notes |
| --- | --- | --- |
| Qoder CLI command | `command` | Name or absolute path. Default `qoder`. |
| Working directory | `cwd` | Absolute. **A Paperclip workspace assigned to the agent always wins**; this is the fallback. Leaving it empty falls back to the Paperclip server's own directory, which is usually your home directory — set it explicitly. |
| Permission mode | `permissionMode` | `auto` (default), `accept_edits`, `dont_ask`, `default`, `bypass_permissions`. |
| Pre-approved tools | `allowedTools` | Comma/newline separated. Auto-approves; does not restrict. |
| Denied tools | `disallowedTools` | Comma/newline separated. Removed from the session's tool list. |
| Additional directories | `addDirs` | Absolute paths added alongside the working directory. |
| Run timeout (seconds) | `timeoutSec` | Default 1800. `0` disables the adapter timeout. |
| Termination grace (seconds) | `graceSec` | Default 20. SIGTERM → SIGKILL gap. |
| Max turns per run | `maxTurns` | Passed to `--max-turns` (registered but hidden from `qoder --help`). |
| Max output tokens | `maxOutputTokens` | Passed to `--max-output-tokens`. |
| Max model request retries | `maxModelRequestRetries` | Passed to `--max-model-request-retries`. |
| Append to system prompt | `appendSystemPrompt` | Passed to `--append-system-prompt`. Do not put secrets here; its length is recorded in the invocation metadata. |
| Extra CLI arguments | `extraArgs` | **One argument per line**. Only `--debug`/`-d`, `--reasoning-effort`, `--thinking`, `--thinking-budget`, `--context-window`, `--output-style`, `--name`/`-n` are accepted. Managed protocol, session, cwd, permissions and credentials cannot be overridden. |

The **model** is not in this list on purpose: Paperclip renders its own
"Model ID" control, and this adapter feeds it by running
`qoder --list-models` (`listModels`), so you pick from the real list instead of
typing a name. The result is cached for 5 minutes; the UI's refresh re-probes.
If the CLI cannot be asked — not logged in, or not on the server's PATH — the
list comes back empty and the field stays free text rather than showing names
that might not exist.

`env` is also honoured. A `PAPERCLIP_API_KEY` supplied through `env` is
rejected — the run token is minted per run — and any `PAPERCLIP_*` variable the
host already assigned wins over a configured one.

### Usage and cost

Credits consumption is reported as credits, not converted into an invented USD
amount. A run with missing USD pricing, or with consumed credits/tokens and
`total_cost_usd: 0`, is `unpriced`. Its browser transcript shows a terminal
activity receipt with the known usage/credits instead of a misleading `$0`
badge. Positive reported USD and genuine zero-consumption receipts retain the
normal result display.

### Working-directory precedence

1. `context.paperclipWorkspace.cwd` — the tree Paperclip staged for the run.
2. The configured `cwd` — used when the workspace is only the agent's home
   directory (`source: "agent_home"`), because then the configured path is the
   more specific one.
3. `process.cwd()` of the server, as a last resort.

### Permissions

`auto` is the CLI's designed unattended mode: a classifier rules on each
request and no verdict means deny. `default` turns every prompt into a denial
in headless mode, so an agent will stall on its first tool request.

`bypass_permissions` removes the permission checks entirely. **A working
directory is not an operating-system sandbox** — the agent is *pointed* at that
directory, not confined to it. Use `bypass_permissions` only in a throwaway
tree.

`plan` is rejected with a warning: the CLI's `--permission-mode` has no
value validation, so an unlisted mode is passed straight through to a mode that
does not exist.

## Update

```bash
git pull                                  # or edit the source
npm run verify
./scripts/paperclip-adapter.sh reload
```

The build bundles all internal adapter modules into `dist/index.js`, so
`reload` refreshes execution, configuration, session handling and model discovery
together. The artifact gate checks that these hooks are fresh after an
entry-point reload. `npm pack` builds automatically; `npm run pack:local` creates
the output directory before writing the tarball.

A change to shared runtime dependencies, such as `@paperclipai/adapter-utils`,
still needs a server restart because those packages remain external to the
bundle.

To restart the background service:

```bash
paperclipai service restart   # hot restart, preserves active agent runs
paperclipai service status
```

If that reports *"supervisor did not report a server pid"*, the instance was
not registered by `paperclipai service install` and runs under its own launchd
label. Find it and restart it directly:

```bash
launchctl list | rg -i paperclip                     # e.g. local.paperclip.session
launchctl kickstart -k gui/$(id -u)/<that-label>     # stop + start under launchd
curl -s http://127.0.0.1:3100/api/health
```

The adapter re-registers itself on startup from
`~/.paperclip/adapter-plugins.json`, so no reinstall is needed after a restart.

Use `install` again instead of `reload` if the package path or version changed.

## Disable and uninstall

```bash
./scripts/paperclip-adapter.sh disable    # keep it installed, stop offering it
./scripts/paperclip-adapter.sh enable
./scripts/paperclip-adapter.sh uninstall  # remove the registration
```

Disabling writes to `~/.paperclip/adapter-settings.json` (`disabledTypes`);
uninstalling removes the entry from `~/.paperclip/adapter-plugins.json`.
Neither touches other adapters, your projects, or the database. Agents already
configured with `qoder_local` keep their rows and simply have no harness until
it is installed again.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `qoder_auth_required` | CLI is installed but not logged in | `qoder login` on the Paperclip host, then re-run the environment test |
| UI banner says "Couldn't connect — check your model and provider connection" | Generic wrapper text for any failed harness test; it is usually *not* a model or network problem | Expand **Test details** and read the one red check |
| `qoder_cli_not_found` | Server's PATH differs from your shell's | Set an absolute path in **Qoder CLI command** |
| Agent stuck in `verifying`, log says `harness_test_failed` | The environment test returns `fail` | Run the environment test and fix what it reports — usually login |
| Agent's replies show up as **your own** messages in a thread | The agent called the Paperclip API without an agent credential, so a `local_trusted` instance attributed it to the board user | Fixed in 0.1.0 by declaring `supportsLocalAgentJwt`; make sure `PAPERCLIP_AGENT_JWT_SECRET` is set on the instance (`paperclipai doctor` checks it) |
| Working directory reported as your home directory | **Working directory** was left blank, so it fell back to the server process's cwd | Set an explicit absolute project path |
| `qoder_protocol_violation`, "outcome is unknown" | CLI exited without a terminal `result` | Check the run log; reproduce with `scripts/qoder-smoke.sh` |
| Same error mentioning "per-chunk UTF-8 decoding" | Damaged output arrived from an old/unverified runtime path | Rebuild the current adapter, which enables streaming UTF-8 on its owned pipes; inspect `DESIGN.md` and the run evidence rather than assuming success |
| `terminal_reason: auth_payload_invalid`, no `system/init` | Paperclip was started from inside a Qoder session and the SDK handshake variables leaked in | The adapter neutralizes these automatically; reproduce the raw behaviour with `scripts/qoder-smoke.sh` |
| Agent stalls on its first tool use | `permissionMode: default` in headless mode denies every prompt | Use `auto` |
| `qoder_extra_args_invalid` | An unsupported, incomplete or adapter-managed option was supplied through `extraArgs` | Use a dedicated config field or one of the documented advanced options; arbitrary CLI/session/permission flags are not accepted |
| `qoder_remote_unsupported` | The agent is assigned a remote execution environment | Assign local execution; this adapter runs the CLI on the Paperclip host only |
| `qoder_provider_stop_unverified` | The owned process group could not be proven stopped | Inspect the recorded process/stop evidence; collection and cancellation acknowledgement are withheld. Windows descendant termination is not qualified. |

## Repeatable local entry points

```bash
npm run verify                  # typecheck, tests, build, artifact gate
npm test                        # automated regressions, no account needed
./scripts/qoder-smoke.sh        # CLI + auth probe in your own terminal, no model call
./scripts/qoder-smoke.sh "Reply with the single word ok."   # one real run
./scripts/paperclip-adapter.sh status
```

`scripts/qoder-smoke.sh` neutralizes the same environment variables the adapter
does, so it reproduces adapter behaviour without Paperclip in the loop. This is
the entry point to use when the test suite itself is running inside a Qoder
session.

`fixtures/sample-repo/` is a tiny Node project (`npm test` passes) for a first
real task.

## Not supported in this version

- **Remote execution targets.** Refused with `qoder_remote_unsupported` rather
  than approximated; the CLI must already be installed and logged in on the
  executing host.
- **Skills sync** (`listSkills` / `syncSkills`) and **ACP**.
- **`qoder --continue`.** Never used: it resumes whichever session ran most
  recently on the machine, which on a multi-agent host can hand one agent
  another agent's conversation.

See `DESIGN.md` for the compatibility notes and `ACCEPTANCE.md` for what was
actually executed and what remains unverified.
