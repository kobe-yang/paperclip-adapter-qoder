#!/usr/bin/env node
/**
 * Stand-in for the Qoder CLI's offline probes (`--version`, `--list-models`),
 * used by the environment-test suite.
 *
 * Mirrors the real exit codes and wording observed on `qoder@1.1.80`:
 *   --version      → "1.1.80", exit 0
 *   --list-models  → "Not logged in. Run `qodercli login` to authenticate.", exit 1
 *
 * It also records every invocation so a test can prove no probe ever passes a
 * prompt, i.e. that the environment test cannot spend a model call.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);

const recordPath = process.env.FAKE_PROBE_RECORD ?? "";
if (recordPath) {
  const previous = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, "utf8"))
    : [];
  previous.push(argv);
  fs.writeFileSync(recordPath, JSON.stringify(previous, null, 2));
}

const envRecordPath = process.env.FAKE_PROBE_ENV_RECORD ?? "";
if (envRecordPath) {
  fs.writeFileSync(
    envRecordPath,
    JSON.stringify(
      {
        QODER_SDK_AUTH_PAYLOAD_FILE: process.env.QODER_SDK_AUTH_PAYLOAD_FILE ?? null,
        QODER_AGENT_SDK_ENTRYPOINT: process.env.QODER_AGENT_SDK_ENTRYPOINT ?? null,
        CI: process.env.CI ?? null,
        TERM: process.env.TERM ?? null,
      },
      null,
      2,
    ),
  );
}

if (argv.includes("--version")) {
  if (process.env.FAKE_PROBE_VERSION_FAIL === "1") {
    process.stderr.write("qoder: could not determine version\n");
    process.exit(2);
  }
  process.stdout.write(`${process.env.FAKE_PROBE_VERSION ?? "1.1.80"}\n`);
  process.exit(0);
}

if (argv.includes("--list-models")) {
  switch (process.env.FAKE_PROBE_AUTH ?? "not-logged-in") {
    case "ok":
      process.stdout.write("model-a\nmodel-b\n");
      process.exit(0);
      break;
    case "quota":
      process.stderr.write("429 Too Many Requests: usage limit reached\n");
      process.exit(1);
      break;
    case "weird":
      process.stderr.write("unexpected internal state 0x5f\n");
      process.exit(1);
      break;
    default:
      process.stderr.write("Not logged in. Run `qodercli login` to authenticate.\n");
      process.exit(1);
  }
}

process.stderr.write(`fake-qoder-probe: unexpected argv ${argv.join(" ")}\n`);
process.exit(64);
