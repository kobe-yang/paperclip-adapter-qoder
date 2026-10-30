/**
 * Model discovery.
 *
 * `qoder --list-models` prints a single-column table — a `MODEL` header line
 * followed by one model id per line — and exits 0 when logged in. Verified
 * against `qoder@1.1.80`:
 *
 *   MODEL
 *   Auto
 *   Ultimate
 *   …
 *
 * This is the only verified source of model names, which is why no list is
 * hardcoded: an invented name would be silently accepted by the CLI's `-m`
 * flag (`allowUnknownOption(true)`) and fail at request time instead.
 *
 * The probe spends no model calls — it is the same command the environment
 * test uses as its authentication check.
 *
 * Known limitation: the host's `listModels()` hook takes no arguments, so it
 * cannot see an agent's configured `command`. The probe therefore uses the
 * default executable name resolved from the server's PATH. An operator who
 * points an agent at an absolute CLI path still gets a free-text model field,
 * which remains valid.
 */

import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterModel } from "@paperclipai/adapter-utils/types";

import { DEFAULT_COMMAND } from "./config.js";
import { buildQoderChildEnv } from "./env.js";

const LIST_TIMEOUT_SEC = 25;
const LIST_GRACE_SEC = 5;

/** Cache TTL. Long enough to survive a form re-render, short enough that a
 *  newly released model shows up without restarting Paperclip. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Header the CLI prints above the column; not a model. */
const HEADER_VALUES = new Set(["model", "models", "id", "name"]);

/**
 * A model id, matched against the whole line.
 *
 * The verified format is strictly one id per line, so a line containing any
 * whitespace is prose — a warning, a hint, `Not logged in. Run …` — and is
 * dropped. Taking the first column instead would turn that message into a
 * model called "Not".
 *
 * If a future CLI adds columns, this yields an empty list, the UI falls back
 * to the free-text model field, and the environment test's
 * `qoder_cli_version_unverified` check already flags the version difference.
 * Degrading to "no list" beats offering a parsed-wrong one.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Parses the listing into model ids.
 *
 * Conservative on purpose: only a line that is exactly one id-shaped token
 * becomes a selectable model. The header is dropped, and anything else is
 * ignored rather than offered to the user as a model that would fail at
 * request time.
 */
export function parseModelList(stdout: string): AdapterModel[] {
  const seen = new Set<string>();
  const models: AdapterModel[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const id = rawLine.replace(ANSI_RE, "").trim();
    if (!id) continue;
    if (HEADER_VALUES.has(id.toLowerCase())) continue;
    if (!MODEL_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;

    seen.add(id);
    models.push({ id, label: id });
  }

  return models;
}

type Cache = { models: AdapterModel[]; fetchedAt: number };
let cache: Cache | null = null;
let inflightPromise: Promise<AdapterModel[]> | null = null;
let generation = 0;

/** Exported for tests; also used by `refreshModels` to force a fresh probe. */
export function clearModelCache(): void {
  cache = null;
  generation += 1;
  inflightPromise = null;
}

export type ModelProbe = () => Promise<AdapterModel[]>;

async function probeModels(): Promise<AdapterModel[]> {
  const env = buildQoderChildEnv({});
  const runId = `qoder-listmodels-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const proc = await runAdapterExecutionTargetProcess(
    runId,
    null,
    DEFAULT_COMMAND,
    ["--list-models"],
    {
      // The CLI does not read the working directory for this command; the
      // server's own cwd is always a valid place to run it.
      cwd: process.cwd(),
      env,
      timeoutSec: LIST_TIMEOUT_SEC,
      graceSec: LIST_GRACE_SEC,
      onLog: async () => {},
    },
  );

  // Not logged in, CLI missing, or a transport problem. An empty list makes the
  // host fall back to the free-text model field, which is the honest outcome —
  // better than offering names this adapter could not confirm.
  if (proc.timedOut || (proc.exitCode ?? 1) !== 0) return [];

  return parseModelList(proc.stdout);
}

/**
 * Cached model list. Returns `[]` when the CLI cannot be asked, so the UI
 * degrades to free text instead of showing a stale or invented list.
 *
 * `probe` is injectable so the caching rules can be tested without an account;
 * the host always calls this with no arguments.
 */
export async function listModels(probe: ModelProbe = probeModels): Promise<AdapterModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.models;
  if (inflightPromise) return inflightPromise;

  const probeGeneration = generation;
  inflightPromise = (async () => {
    try {
      const models = await probe();
      // Do not cache a failure: the usual cause is "not logged in yet", and the
      // operator will log in and expect the list to appear.
      if (probeGeneration === generation && models.length > 0) {
        cache = { models, fetchedAt: Date.now() };
      }
      return models;
    } catch {
      return [];
    }
  })().finally(() => {
    if (probeGeneration === generation) inflightPromise = null;
  });
  return inflightPromise;
}

/** Explicit bypass for the UI's refresh control. */
export async function refreshModels(probe: ModelProbe = probeModels): Promise<AdapterModel[]> {
  clearModelCache();
  return listModels(probe);
}
