# Release-candidate acceptance

Date: 2026-10-29. This report describes the hardened candidate, not historical
runs on pre-fix code. Local execution is verified; full production readiness
is blocked by the host's external-parser worker. No upstream acceptance or npm
publication is claimed.

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

- `npm run verify`: **356 tests across 13 files**, typecheck, build and
  **7 artifact gates**, all passed. Initial baseline: 288 tests.
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

## Real executions: 3 of 6 authorized

All runs used a disposable dependency-free calculator repository. Metrics were
independently reconstructed from persisted stdout protocol output.

| Scenario | Status | Seconds | Turns | Credits | Resume | Unparsed/unknown/decode-damaged |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Fix divide-by-zero for 0/-0 and add tests | succeeded | 62.851 | 7 | 3.931968 | no | 0/0/0 |
| Same-task negative/fractional regressions | succeeded | 41.562 | 5 | 7.527081 | same session | 0/0/0 |
| Independent usage note with Chinese text | succeeded | 92.790 | 8 | 4.645032 | fresh session | 0/0/0 |

Total: **16.104081 credits**. No USD amount was inferred.

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

The same assignment remains in the verified host bootstrap. Existing upstream
issue #16143 and PR #8806 track it. The Nice/Raw controls were clicked, but
structured transcripts remained unavailable. No sandbox bypass or modification
to the installed host UI was made. Host avatar resources also returned 503;
screenshot capture remained unavailable because the browser reported hidden
visibility despite an attached surface.

Other boundaries:

- Per-chunk host UTF-8 decoding can corrupt output before the adapter sees it;
  existing issue #7479 / PR #13225. Zero detected damage in three runs does not
  prove the host bug is fixed.
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
