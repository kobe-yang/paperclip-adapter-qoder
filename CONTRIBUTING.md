# Contributing / upstream notes

Integration proposal: https://github.com/paperclipai/paperclip/issues/18130
(submitted 2026-10-29). Candidate source:
https://github.com/kobe-yang/paperclip-adapter-qoder. No npm package has been
published; maintainer guidance is still pending.

## Relationship to existing work

A search of the installed Paperclip `2026.1023.0` found **no Qoder adapter**,
built-in or external: the 16 registered types are `acpx_local`, `claude_local`,
`codex_local`, `cursor`, `cursor_cloud`, `gemini_local`, `grok_local`,
`hermes_gateway`, `hermes_local`, `http`, `kimi_local`, `openclaw_gateway`,
`opencode_local`, `paperclip_runner`, `pi_local`, `process`. None matches
`/qoder/i`, so `qoder_local` is free and this is not a duplicate.

Paperclip PR #16146 was checked on 2026-10-29: it proposes a built-in Qoder
Cloud Agents adapter using managed REST/SSE and remote sessions, not a local
CLI external adapter. Our proposal is complementary. Upstream contribution
instructions prefer an external adapter package where possible; no core
registry change is required.

This adapter reuses the official helper surface
(`@paperclipai/adapter-utils`: `server-utils`, `execution-target`,
`provider-stopped-boundary`, `types`) and follows the structure of the built-in
`adapter-kimi-local` and `adapter-claude-local` packages, without copying
framework code that is not needed here.

## If this were to be proposed upstream

Intended scope of a submission, in order:

1. The adapter package itself (`src/`, `ui-parser.cjs`, tests, `README.md`,
   `DESIGN.md`) as a standalone external adapter. It needs no change to
   Paperclip.
2. Two host-side findings worth reporting independently of this package, since
   they affect every adapter, not just this one:
   - `runChildProcess` decodes each stdout chunk with `String(chunk)`, so a
     multi-byte UTF-8 character on a chunk boundary is corrupted before any
     adapter sees it. A `StringDecoder` held across chunks would fix it. See
     `DESIGN.md` §5.
   - `ServerAdapterModule` has no display-name or icon field. The UI derives a
     label from the type (strip `_local`, title-case), which happens to read
     well here — `qoder_local` renders as "Qoder" — but an adapter cannot
     present a name like "Qoder CLI (Local)" or supply its own icon, and a
     multi-word type would render awkwardly. An optional `displayName` and
     `icon` would close this.
3. Optionally, the `--max-turns`-is-hidden and `--permission-mode`-is-unvalidated
   observations as a note to the Qoder CLI maintainers.

## Before submitting anything

- Complete real-task acceptance for the current release artifact. Login has
  been verified without model calls; do not present historical task runs as
  acceptance of a later build.
- Re-run `npm run verify` and report only executed checks. Keep the host
  external-parser Worker blocker (#16143 / PR #8806) explicit; do not claim
  typed transcripts pass or bypass the sandbox.
- Keep `tests/fixtures/` free of credentials, private repository content and
  the installed-plugin inventory. `tests/fixtures/README.md` records which
  fixture is a recording and which is constructed; keep that distinction
  accurate.
- The version pins in `README.md` and `DESIGN.md` are measurements. Re-measure
  rather than bumping them by hand.
