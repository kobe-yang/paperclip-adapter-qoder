# Design and compatibility notes

Short record of what was measured, what was decided, and what is not supported.
Every version below was read off this machine, not from documentation.

## Measured versions

| Component | Version | How it was established |
| --- | --- | --- |
| Paperclip server/CLI | `2026.1023.0` (commit `1b4c803`) | `GET /api/health` on the running instance |
| `@paperclipai/adapter-utils` | `2026.1023.0` | the installed package this adapter builds against |
| Qoder CLI | `1.1.80` | `qoder --version` |
| Qoder stream-json wire protocol | `1.5.0` | `protocol_version` in a captured `system/init` line |
| Node.js (Paperclip host process) | `24.22.1` | the running server process |
| macOS | 25.6.0, arm64 | host |

The Qoder CLI is installed under Node 22's global bin while Paperclip runs on
Node 24. This works because the adapter resolves the command through the
server's PATH; it was verified from the launchd-managed instance, not only from
an interactive shell.

## Extension seam

Paperclip's **external adapter plugin** interface. The package exports a
zero-argument synchronous `createServerAdapter()` from its `"."` export, which
the host validates for `type`, `execute` and `testEnvironment`
(`@paperclipai/server/dist/adapters/plugin-loader.js`). Registration is
persisted in `~/.paperclip/adapter-plugins.json` by
`POST /api/adapters/install`.

No file inside the Paperclip install, its `node_modules`, or its database is
modified. Nothing is faked into a registry by hand.

## Documentation vs. observed behaviour

These are the differences that shaped the implementation.

1. **There is no display-name field, and the UI derives one.**
   `ServerAdapterModule` has `type` but no `name`/`displayName`/`label`; the
   server API returns `label: type`. The web UI, however, keeps a hardcoded
   label table for built-in types and falls back to a humanizer for anything
   else: it strips a `_local`/`_gateway` suffix, turns `_` into spaces and
   title-cases the words (`getAdapterLabel` → `humanizeType` in the UI bundle).

   So `qoder_local` is displayed as **"Qoder"** in the adapter picker, with the
   generic fallback icon shared by `paperclip_runner`, `process` and `http`.
   That is a usable name, but the intended "Qoder CLI (Local)" cannot be
   expressed, and no adapter-supplied icon is possible. Making the *type* a
   human-readable string was rejected: the type is an identifier stored on
   every agent row.

   Consequence for the type name: `qoder_local` reads well through the
   humanizer. A type like `qoder_cli_local` would have rendered as
   "Qoder Cli Local".

2. **A zero exit code does not mean success.** `qoder@1.1.80` exits `0` while
   emitting `{"type":"result","subtype":"success","is_error":true}`. The
   recorded fixture `tests/fixtures/auth-failure.jsonl` is exactly this case.
   Success therefore requires a clean exit **and** a terminal `result` that is
   not an error, with no assistant-level error and no abort
   (`isSuccessfulAttempt` in `src/outcome.ts`). `subtype` is not a success
   signal either.

3. **Unknown CLI flags are silently swallowed.** The CLI's parser runs with
   `allowUnknownOption(true)` and `allowExcessArguments(true)`, so a run
   succeeding is *not* evidence that a flag exists. Every flag used here was
   read out of the installed bundle's option registration. Consequences:
   `--max-turns` is real but `.hideHelp()`, so it is absent from `qoder --help`;
   and `--permission-mode` has no value validation, so `plan` parses fine and
   selects a mode that does not exist — the adapter rejects it with a warning.

4. **The host truncates captured stdout from the front.** `appendWithCap` caps
   the batched buffer at 4 MiB and drops the *oldest* bytes, so a long run
   loses the `system/init` line and with it the session id. The adapter
   therefore aggregates incrementally in `onLog` and never reads the final
   buffer for state (`src/jsonl.ts`, `src/aggregate.ts`).

5. **The stock helper decodes each chunk independently.** `runChildProcess`
   uses `String(chunk)`, which loses UTF-8 bytes split across pipe events. Once
   decoded, they cannot be recovered. The adapter captures its owned child
   during the spawn callback and enables streaming UTF-8 decoding on both
   pipes before their first data event. A byte-by-byte multilingual regression
   and independently installed host run verify exact output without patching
   the SDK. Damaged protocol lines are still counted and surfaced. The general
   helper bug remains tracked upstream in #7479 / PR #13225.

6. **Adapters cannot delete an inherited environment variable.** The host
   builds the child env as `{...sanitizeInheritedPaperclipEnv(process.env),
   ...options.env}`. Omitting a key lets the inherited value through, so the
   Qoder SDK handshake variables are overridden to `""`, which the CLI treats as
   unset. This is load-bearing, not theoretical: with them inherited, a live
   probe failed with `terminal_reason: "auth_payload_invalid"` and
   `errors: ["SDK auth payload file not found: …/payload.json"]` and emitted no
   `system/init` at all. The environment test reported 10 such inherited
   variables when the server was started from inside a Qoder session, and none
   when started by launchd.

   The subagent spawn-depth guard (`QODER_CLI_MAX_SUBAGENT_SPAWN_DEPTH`) and the
   credential roots (`QODER_CONFIG_DIR`, `QODERCN_CONFIG_DIR`) are deliberately
   **not** touched — they are protections, not plumbing.

7. **The exit code says nothing, and the process outlives the answer.** The CLI
   stays alive after emitting its terminal `result` (background tasks,
   telemetry flush), so this adapter asks the host to stop it once the result
   is in. The consequence is that a *fully successful* run ends with
   `exitCode: null` and `signal: "SIGTERM"`. The first real runs exposed this:
   `isSuccessfulAttempt` required `exitCode === 0`, so every successful run was
   reported as `qoder_run_failed` with the agent's own answer as the error
   message. The terminal `result` event is now the sole authority; only a
   *non-zero* exit code can override it.

8. **`total_cost_usd: 0` does not mean free.** A real run reported
   `total_cost_usd: 0`, `total_credits: 11.62` and every token counter `0` —
   the account bills in credits and does not populate token fields at all.
   Cost resolution therefore treats a positive `total_credits` as consumption
   and reports `unpriced`, not a $0 run.

9. **`terminal_reason` is optional.** It was present on the auth-failure path
   and absent on a successful run, so it is read as nullable and never used as
   a success signal.

10. **An agent credential is only issued if the adapter asks.** The host mints
    a run-scoped agent JWT only when the adapter declares
    `supportsLocalAgentJwt` (`services/heartbeat/runtime-execution.js`).
    Without it `ctx.authToken` is `null`, no `PAPERCLIP_API_KEY` reaches the
    CLI, and the agent's Paperclip API calls fall back to unauthenticated
    loopback access — which a `local_trusted` instance accepts as the **board
    user**. Comments written that way are stored with `authorType: "user"` and
    only a `derivedAuthorAgentId` pointing back at the agent, so the agent's
    own replies render as if a human wrote them. The flag is now declared.

11. **Normal runs emit `system` subtypes beyond the documented four.** Real
    runs carry `hook_started`, `hook_response`, `hook_diagnostics` and
    `artifacts_update` on top of `init`, `permission_denied`, `api_retry` and
    `compact_boundary`. Their field names were read off the installed bundle
    and they are mapped to workbench events; before that, every successful run
    reported `unknownEvents: 4`, which reads like a protocol mismatch.

12. **`reload` only refreshes the entry module.** The reload route cache-busts
    the package entry with `?t=${Date.now()}`, but the modules that entry
    imports resolve to their plain file URLs and stay in Node's ESM cache.
    Verified: after rebuilding with a config field removed, the host kept
    serving the old 14-field schema (and kept the stale schema even past its
    own 30-second schema cache), while a change made directly in
    `src/index.ts` took effect immediately. Any change outside the entry
    module needs `paperclipai service restart` in an unbundled package.
    The adapter now bundles its internal modules into the entry point; the
    artifact gate verifies that an entry-URL reload creates fresh execution,
    environment, configuration and model hooks. Shared runtime dependencies
    remain external and still require a restart when changed. Upstream already
    tracks this in issue #11530 and PR #15146.

## Implementation decisions

**Prompt on stdin.** The prompt is one stream-json `user` message written to
stdin, so it never reaches a process listing, an `execve` argument limit, or a
shell quoting layer. Arguments are always passed as an array; no shell is
involved.

**Logging.** Each stdout line is parsed as it arrives and mapped to workbench
events (`init`, `assistant`, `thinking`, `tool_call`, `tool_result`,
`permission_denied`, `api_retry`, `compact_boundary`, `result`).
`stream_event` deltas are dropped because the assembled `assistant` message
follows and would duplicate every sentence. Retained text is bounded
(40 messages, 20 000 chars each, 200 tool names, 50 denials) so a long run
cannot grow without limit. `ui-parser.cjs` repeats this mapping for the
browser: CommonJS, no Node API, and it never evaluates CLI output.

**Usage and cost are reported only when meaningful.** Missing usage is
`undefined`, not zeros. A reported `$0` is passed through only when the run also
reported zero tokens; a run that consumed tokens but reports `$0` is on a
credits plan where USD is not meaningful, so it is marked `unpriced` rather
than recorded as a free run. `billingType` is `unknown` unless the evidence
names one.

**Failure classification** (`src/errors.ts`) distinguishes: CLI missing,
invalid working directory, auth required, permission denied, quota/billing,
network, non-zero exit, protocol violation, unrecoverable session, max
turns/budget, timeout and cancellation. When the evidence does not name a
cause, `classifyFailure` returns `null` and the raw error summary is kept —
no guessed code. Transport-level failures outrank anything the CLI "said",
because if the CLI never started, nothing it printed is trustworthy.

**Cancellation and timeouts** use the SDK for spawning but retain run-scoped
ownership of the resulting POSIX process group. Independent npm installation
creates a separate SDK process registry, so host registry lookup alone cannot
stop the plugin's child. The adapter registers cancellation readiness and
handles the host's AbortSignal, blocks pending stdin, sends TERM then KILL,
and verifies group absence before collection or cancellation acknowledgement.
The leader exiting does not prove its descendants stopped. An unverified stop
is an explicit failure, with incomplete usage and no acknowledgement. Operator
cancellation outranks a successful result while work still runs; post-result
cleanup without cancellation preserves the answer. No global signal handler
or cross-run process search is used. Windows descendant termination is not
qualified because it lacks the owned POSIX-group contract.

**Sessions.** The Qoder session id is persisted through Paperclip's own session
contract (`sessionParams`), together with the working directory, workspace id
and repository provenance. Recorded cwd, workspace, repository URL or revision
contradictions veto resume independently, including a workspace conflict on a
record without cwd. A bare legacy id is accepted on the host's authority: this
is not a task-scoped privacy guarantee, and host-selected sessions may span
issues. Use separate agents/workspaces for confidential boundaries.
A confirmed pre-session resume failure can retry **once** with a fresh session.
Success, any prior activity, dropped output, timeout, signal, host transport error
or abort prevents retry, avoiding duplicate side effects and cancelled work
being restarted. `--continue` is never emitted, including via `extraArgs`.

**Environment test** spends zero model calls. It runs only `qoder --version`
and `qoder --list-models`, both verified to stop before any model request. A
`--print` probe with an empty prompt was tried and rejected: it still reported
`num_turns: 1`, so on an authenticated account it could start a real turn just
to answer "is auth working". Finding a credential file is not treated as proof
of a usable account — the CLI is asked.

## In this version

Included: execute with streaming logs and classified failures, environment
test, declarative config schema, browser UI parser, session persistence with
recorded workspace/repository isolation, instructions-bundle injection (`AGENTS.md` content plus
`--add-dir` for its folder), host-managed timeout/cancellation.

Not included, and why:

- **Remote execution targets** — refused with `qoder_remote_unsupported`. The
  adapter cannot verify or provision a logged-in CLI on another host, so
  `getRuntimeCommandSpec` is deliberately not declared.
- **Skills sync and ACP** — the CLI speaks its own stream-json protocol, not
  ACP, and no skills-sync behaviour was verified.
- **`detectModel`, `getQuotaWindows`, `loginCapability`** — each needs a
  verified local config or API shape that was not available without an account.
