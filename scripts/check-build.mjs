#!/usr/bin/env node
/**
 * Post-build gate.
 *
 * Proves four things that a unit test cannot, because they are properties of
 * the published artifact rather than of the source:
 *
 * 1. The packed tarball is self-sufficient — the adapter loads with `src/`
 *    absent, which is how it will exist inside Paperclip's node_modules.
 * 2. `createServerAdapter()` satisfies the host's loader contract (a
 *    zero-argument synchronous factory returning `type`, `execute` and
 *    `testEnvironment`).
 * 3. `ui-parser.cjs` runs under the host's browser sandbox rules: evaluated
 *    with `new Function`, no `require`, no Node global.
 * 4. Nothing private rode along in the tarball.
 *
 * Exits non-zero on the first failure with the reason on stderr.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    notes.push(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));

check("package exports declare the adapter entry and the UI parser", () => {
  assert(pkg.exports?.["."]?.import === "./dist/index.js", "exports['.'].import must be ./dist/index.js");
  assert(pkg.exports?.["./ui-parser"] === "./ui-parser.cjs", "exports['./ui-parser'] must be ./ui-parser.cjs");
  assert(
    typeof pkg.paperclip?.adapterUiParser === "string" &&
      pkg.paperclip.adapterUiParser.split(".")[0] === "1",
    "paperclip.adapterUiParser must be a version 1.x string",
  );
  return `adapterUiParser ${pkg.paperclip.adapterUiParser}`;
});

// ---------------------------------------------------------------------------
// Pack, extract, and load the artifact with no `src/` in sight.
// ---------------------------------------------------------------------------

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-adapter-checkbuild-"));
let extractedDir = null;

try {
  check("npm pack produces a loadable tarball", () => {
    const packJson = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", stageDir],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const [entry] = JSON.parse(packJson);
    assert(entry?.filename, "npm pack returned no filename");
    const tarball = path.join(stageDir, entry.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", stageDir]);
    extractedDir = path.join(stageDir, "package");
    assert(fs.existsSync(extractedDir), "tarball did not contain a package/ directory");
    return `${entry.filename}, ${entry.files.length} files, ${entry.unpackedSize} bytes unpacked`;
  });

  check("tarball omits sources, tests and local scratch", () => {
    assert(extractedDir, "nothing was extracted");
    const offenders = [];
    const walk = (dir, prefix) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(path.join(dir, item.name), rel);
          continue;
        }
        const allowed =
          rel.startsWith("dist/") ||
          rel === "ui-parser.cjs" ||
          rel === "package.json" ||
          rel === "README.md" ||
          rel === "LICENSE";
        if (!allowed) offenders.push(rel);
      }
    };
    walk(extractedDir, "");
    assert(offenders.length === 0, `unexpected files in tarball: ${offenders.join(", ")}`);
    assert(!fs.existsSync(path.join(extractedDir, "src")), "src/ must not ship");
    return "dist, ui-parser.cjs and metadata only";
  });

  check("tarball contains no credential or private-path material", () => {
    assert(extractedDir, "nothing was extracted");
    // Credential-shaped strings and this machine's home directory. The home
    // path is checked because a leaked absolute path identifies the author's
    // account even when it carries no secret.
    const patterns = [
      [/sk-[A-Za-z0-9]{16,}/, "an API-key-shaped string"],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
      [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "a JWT"],
      [new RegExp(escapeRegExp(os.homedir())), `this machine's home directory (${os.homedir()})`],
    ];
    const offenders = [];
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(js|cjs|mjs|json|md|ts|map)$/.test(item.name)) continue;
        const contents = fs.readFileSync(full, "utf8");
        for (const [pattern, label] of patterns) {
          if (pattern.test(contents)) {
            offenders.push(`${path.relative(extractedDir, full)} contains ${label}`);
          }
        }
      }
    };
    walk(extractedDir);
    assert(offenders.length === 0, offenders.join("; "));
    return `${patterns.length} patterns checked`;
  });

  await checkAsync("built artifact loads without the source tree", async () => {
    assert(extractedDir, "nothing was extracted");
    // Dependencies are resolved through the project's own node_modules; the
    // point of this check is the absence of `src/`, not a fresh install.
    const link = path.join(extractedDir, "node_modules");
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.join(projectDir, "node_modules"), link, "dir");
    }
    const entry = pathToFileURL(path.join(extractedDir, "dist", "index.js")).href;
    const mod = await import(entry);

    assert(typeof mod.createServerAdapter === "function", "createServerAdapter is not exported");
    assert(mod.createServerAdapter.length === 0, "createServerAdapter must take no arguments");

    const adapter = mod.createServerAdapter();
    assert(adapter && typeof adapter === "object", "createServerAdapter did not return an object");
    assert(typeof adapter.type === "string" && adapter.type, "adapter.type must be a non-empty string");
    assert(typeof adapter.execute === "function", "adapter.execute must be a function");
    assert(typeof adapter.testEnvironment === "function", "adapter.testEnvironment must be a function");

    const schema = await adapter.getConfigSchema();
    assert(Array.isArray(schema?.fields) && schema.fields.length > 0, "getConfigSchema returned no fields");
    const allowedTypes = new Set(["text", "select", "toggle", "number", "textarea", "combobox"]);
    for (const field of schema.fields) {
      assert(typeof field.key === "string" && field.key, "a config field has no key");
      assert(allowedTypes.has(field.type), `config field ${field.key} has unsupported type ${field.type}`);
    }
    return `type=${adapter.type}, ${schema.fields.length} config fields`;
  });

  await checkAsync("entry-point reload refreshes internal adapter modules", async () => {
    assert(extractedDir, "nothing was extracted");
    const entry = pathToFileURL(path.join(extractedDir, "dist", "index.js")).href;
    const first = (await import(entry)).createServerAdapter();
    const reloaded = (await import(`${entry}?reload=1`)).createServerAdapter();
    for (const hook of ["execute", "testEnvironment", "getConfigSchema", "listModels"]) {
      assert(first[hook] !== reloaded[hook], `${hook} remained in the transitive ESM cache`);
    }
    const schema = await reloaded.getConfigSchema();
    assert(schema.fields.length > 0, "reloaded config schema is empty");
    return "execution, environment, configuration and model hooks are fresh";
  });

  check("ui-parser.cjs is evaluable under the host's browser sandbox", () => {
    assert(extractedDir, "nothing was extracted");
    const source = fs.readFileSync(path.join(extractedDir, "ui-parser.cjs"), "utf8");
    // The file's own header documents the sandbox it runs in, so it mentions
    // `new Function` and "no import" in prose. Scan the code, not the comments.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

    for (const forbidden of [
      "require(",
      "import ",
      "import(",
      "process.",
      "__dirname",
      "__filename",
      "Buffer",
      "eval(",
      "new Function",
    ]) {
      assert(!code.includes(forbidden), `must not reference ${forbidden}`);
    }

    // Same evaluation shape the host uses. `require` throws so that a stray
    // call fails loudly here instead of in the browser.
    const factory = new Function(
      "module",
      "exports",
      "require",
      `${source}\nreturn module.exports;`,
    );
    const moduleObj = { exports: {} };
    const exported = factory(moduleObj, moduleObj.exports, () => {
      throw new Error("ui-parser must not call require()");
    });
    assert(typeof exported.parseStdoutLine === "function", "parseStdoutLine is not exported");

    const ts = "2026-10-29T00:00:00.000Z";
    const init = exported.parseStdoutLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s-1",
        model: "auto",
        qodercli_version: "1.1.80",
      }),
      ts,
    );
    assert(init.some((entry) => entry.kind === "init"), "init line did not yield an init entry");
    assert(exported.parseStdoutLine("", ts).length === 0, "blank line must yield no entries");
    assert(
      exported.parseStdoutLine("{not json", ts)[0]?.kind === "stdout",
      "malformed JSON must fall back to a stdout entry",
    );
    for (const entry of exported.parseStdoutLine(JSON.stringify({ type: "stream_event" }), ts)) {
      throw new Error(`stream_event should be dropped, got ${entry.kind}`);
    }
    return "evaluated with new Function, require() never called";
  });
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    notes.push(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const note of notes) console.log(note);
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`\n${failures.length} build check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} build checks passed.`);
