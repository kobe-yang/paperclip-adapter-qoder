# Release-candidate acceptance

Verification dates: 2026-10-29 through 2026-10-30. This report describes the
current local candidate. Independent installation, cancellation, UTF-8 output
and conditional patched-host transcripts are verified. The unmodified host
still has its external-parser Worker limitation; no upstream acceptance,
official-host certification or npm publication is claimed.

## Measured environment

| Component | Version |
| --- | --- |
| Paperclip / adapter-utils | 2026.1023.0 |
| Host commit | 1b4c803816e82b0265c8422e1a804327a7ed8c54 |
| Qoder CLI / stream-json protocol | 1.1.80 / 1.5.0 |
| Node.js | 24.22.1 |
| Platform | macOS 25.6.0, arm64 |
| Vitest | 4.1.12 |

Build/verification explicitly used the existing Node 24 rather than the shell's
Node 22; no global runtime was replaced.

## Automated and release checks

- `npm run verify`: **429 tests across 13 files**, typecheck, build and
  **7 artifact gates**, all passed. Initial baseline: 288 tests; the first
  public candidate passed 356.
- Full and production-only `npm audit`: **0 vulnerabilities** at checking time.
  Vitest development advisories were resolved by upgrading the test runner;
  the baseline runtime audit was already clean.
- `npm run pack:local`: creates its output directory; `prepack` rebuilds.
  `prepublishOnly` runs full verification. No npm publish was attempted.
- Independent extraction and production-only dependency installation with
  lifecycle scripts disabled: source-free adapter loading succeeds with
  13 fields and run-scoped JWT support, without linking project node_modules.
- Entry-URL reload produces fresh internal execution, environment, configuration
  and model hooks. Shared runtime dependencies remain external.
- Tarball exports, file allowlist, credential/private-home-path scan, shell
  syntax and CommonJS parser sandbox evaluation passed.

New regressions cover managed-flag overrides through extraArgs (aliases,
short combinations and equals syntax), repeated argument values, independent
workspace/repository resume checks without cwd, safe pre-session retry,
UTF-8 byte limits across chunk/CRLF boundaries, and structured error precedence.
Existing fake-CLI tests use real child processes for timeout, cancellation,
SIGTERM/SIGKILL escalation and descendant cleanup without model calls.
Additional regressions prevent concurrent model-probe duplication and stale
in-flight results overwriting refreshes, and keep browser cost receipts
consistent with server pricing: missing/credits-billed USD is not displayed as
free. Unpriced receipts use a supported terminal activity entry because the
host's numeric result-cost field cannot represent unknown USD.

## Isolated host integration

The user authorized an independent temporary instance and at most six real
Qoder executions. HTTP 3102, PostgreSQL 54331, separate state, no service or
autostart, heartbeat scheduler disabled, maxConcurrentRuns 1. The existing
instance retained its original process start time; its companies, agents and
tasks were not modified by this acceptance.

Official onboarding generated isolated configuration/secrets. The CLI shim's
managed-install check failed because the isolated home had no install manifest.
No manifest was fabricated and no existing installation was reinstalled.
The published server package's `startServer()` entry then ran that initialized
isolated configuration.

| Check | Result |
| --- | --- |
| Official adapter API installation of independently extracted package | passed, no restart required |
| Registration / capabilities | external, loaded, enabled, JWT supported |
| Model discovery | 15 authenticated models; no model call |
| Agent lifecycle | preparing to idle/ready; no lifecycle error |
| Managed instructions | host materialized and injected bundle |
| Unsafe extra arguments | qoder_extra_args_invalid before cwd creation |
| Reload | accepted; adapter remained loaded |
| Completion comment identity | authorType agent; agent and run matched |
| Accounting | costUsd null, costStatus unpriced, billingType credits |

## Real executions: 4 of 6 authorized

All runs used a disposable dependency-free calculator repository. Metrics were
independently reconstructed from persisted stdout protocol output.

| Scenario | Status | Seconds | Turns | Credits | Resume | Unparsed/unknown/decode-damaged |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Fix divide-by-zero for 0/-0 and add tests | succeeded | 62.851 | 7 | 3.931968 | no | 0/0/0 |
| Same-task negative/fractional regressions | succeeded | 41.562 | 5 | 7.527081 | same session | 0/0/0 |
| Independent usage note with Chinese text | succeeded | 92.790 | 8 | 4.645032 | fresh session | 0/0/0 |
| Final standalone cancellation-safe runtime, verify existing tests without edits | succeeded | 36.433 | 7 | 4.556609 | fresh session | 0/0/0 |

Total: **20.660690 credits**. No USD amount was inferred. The fourth execution
used the independently installed final package with its own stock SDK.

Code was independently reviewed and separate assertions verified both zero
forms, ordinary/negative division, zero numerator and unchanged addition.
Tests passed 4/4 after the first task, then 6/6 after follow-up and the
independent task. The accurate UTF-8 usage note left calculator source/tests
unchanged. Both tasks ended done; no unexpected tasks were created.

The issue-assignment path reused the same-issue session and selected a fresh
session for a new issue. Legacy/manual bare-session paths are not covered by
that task-isolation guarantee. Real cancellation and long-running soak tests
were not run; their evidence remains automated.

## Browser and production blockers

The actual in-app browser loaded the adapter overview, runtime form and
successful run page: model, cwd, events and completed status were present.
The model picker was opened by pointer interaction and offered the CLI models.
The runtime-test button was clicked and reported that checks passed; the run
inventory stayed at three, confirming the probe created no model execution.
An unsaved `--continue` value was entered in the advanced form and tested;
Test details displayed the managed-option rejection. It was discarded without
persisting the unsafe value. The UI requested the parser endpoint and received 200.

**Typed transcripts are blocked by the host Worker bootstrap**, not by a
missing parser export. In an actual browser Worker, the host's strict-mode
`self.caches = undefined` assignment was reproduced and returned:

```
TypeError: Cannot set property caches of #<WorkerGlobalScope> which has only a getter
```

The same assignment remains in the unmodified host bootstrap. Existing
upstream issue #16143 and PR #8806 track it. Structured transcripts were
unavailable on that baseline. Host avatar resources also returned 503.

### Conditional qualification with isolated host fixes

The user authorized a separate writable runtime/source validation copy,
never modifications to the existing installation. The Worker source was
fetched at the measured commit, changed using the fail-closed prototype-chain
shadowing approach from PR #8806, and compiled. An AST check found exactly one
bootstrap literal equal to the pinned unmodified source in the copied UI
asset; only that literal was replaced. The local process helper received the
two UTF-8 setEncoding lines corresponding to PR #13225's local scope.
**This was a targeted build, not a complete monorepo rebuild or official
release.** Unchanged runtime dependencies were reused through symlinks.

| Conditional check | Result |
| --- | --- |
| Original installed UI/helper integrity | unchanged, hashes/content compared |
| UTF-8 stdout and stderr at every real pipe byte cut | baseline 28/101 damaged; fixed 0/101; ASCII and log callbacks unchanged |
| Worker initialization and real parser | ready; exact Chinese/emoji text |
| Sandbox globals across four prototype levels | all 32 checks unavailable, non-writable and non-configurable |
| Persisted run page through actual registry/Worker/render pipeline | 29 typed entries; 28 parse requests/replies; init, assistant, tools and terminal receipt present |
| Corrected unpriced receipt on a real credits run | 3.9319680171428573 credits shown; no false $0.000000 badge |
| Concurrent model discovery through host API | four equal lists of 15 models, no model execution |
| Synthetic host cancellation | cancelled/cancelled; parent and descendant absent |
| Synthetic host timeout | timed_out/timeout; parent and descendant absent |

The initial shared-runtime termination cases used a deterministic fake CLI
and consumed no model calls. They were not evidence of independent npm
installation: that layout shares the host's utility instance. Separate
installation exposed a different module-scoped process registry; the old
cancellation API returned 200 while its synthetic parent/child still lived.
They were manually reaped. Its stock SDK also reproduced 28/101 UTF-8 byte-cut
failures despite the separate host helper being patched.

### Final independent-installation checks

The current tarball was extracted to a separate prefix and installed with its
own production dependencies, lifecycle scripts disabled and no SDK alias.
Resolution and registry-identity checks confirmed separate SDK instances.
The adapter now registers run-scoped cancellation readiness, responds to the
host AbortSignal, blocks pending stdin, and verifies its captured POSIX group
has disappeared after TERM/grace/KILL before acknowledging cancellation.
No acknowledgement is emitted on unverified termination. Parent close alone
is insufficient, including when a descendant ignores TERM and closes stdio.

| Independent-package check | Result |
| --- | --- |
| Real host cancellation API | 200, cancelled, executionCancellation acknowledged; parent/child absent |
| Real host timeout | timed_out/timeout; parent/child absent |
| Multilingual JSONL and stderr split one byte per write | exact Chinese, emoji, Arabic, Cyrillic and Korean; successful summary and no replacement characters |
| Updated real Qoder CLI execution | succeeded; 6/6 existing tests unchanged; 4.556609 credits |

UTF-8 decoding is enabled on the adapter's owned pipes before the first data
event, so this deployment does not require patching its SDK. The termination
checks verify normalized host statuses, not identical adapter error codes.
These synthetic tests consumed no model calls. The Unicode stub did not mark
its issue done and the host scheduled follow-up runs; both completed with exact
output. The issue was then marked done and its test agent paused through the
normal API. This fixture behavior was not a parser or adapter failure.

The browser automation surface remained natively hidden, which makes the host
pause persisted-log loading. The user explicitly authorized temporarily
simulating visibility on the disposable localhost page and dispatching its
normal visibility event. The actual log/Worker pipeline then loaded the
persisted run. That override was removed after each test; **it is not evidence
of a natively visible window**. Screenshot capture was unavailable. The Worker
sandbox was never bypassed and the original installed host remained unchanged.

Other boundaries:

- General host per-chunk UTF-8 corruption remains tracked in #7479 / PR #13225.
  This adapter configures its own streams before data delivery; that does not
  fix other adapters or the SDK's direct-call behavior.
- Bundling refreshes internal modules only; changed shared dependencies need
  restart. General reload caching: issue #11530 / PR #15146.
- Linux/Windows, remote execution, ACP and skills sync were not verified.
  Remote execution is explicitly unsupported; cwd is not an OS sandbox.
- Bare legacy ids depend on host ownership; separate agents/workspaces are
  needed for confidential boundaries.
- The isolated server exited cleanly after SIGTERM. HTTP and PostgreSQL test
  ports were confirmed closed; the existing instance remained healthy with
  its original process start time.

## Community status

Integration proposal: https://github.com/paperclipai/paperclip/issues/18130.
It explains local CLI execution's necessity, distinguishes Cloud PR #16146 and
requests the preferred external-package/documentation contribution path.
No maintainer reply was observed at the latest check. Candidate source:
https://github.com/kobe-yang/paperclip-adapter-qoder.
No core PR or npm publication has been performed.
