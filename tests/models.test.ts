import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterModel } from "@paperclipai/adapter-utils/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearModelCache,
  listModels,
  parseModelList,
  refreshModels,
} from "../src/models.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const REAL_OUTPUT = fs.readFileSync(path.join(fixturesDir, "list-models.txt"), "utf8");

function ids(stdout: string): string[] {
  return parseModelList(stdout).map((model) => model.id);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("parseModelList — recorded output", () => {
  it("reads every model from the real `qoder --list-models` output", () => {
    // Recorded from qoder@1.1.80 on a logged-in account.
    expect(ids(REAL_OUTPUT)).toEqual([
      "Auto",
      "Ultimate",
      "Fast",
      "Efficient",
      "Sonus",
      "Cantus",
      "Qwen3.8-Max",
      "Qwen3.8-Flash",
      "Kimi-K3.1-Pro",
      "Kimi-K2.8-Preview",
      "GLM-5.3",
      "GLM-5.3-Flash",
      "DeepSeek-V4-Pro",
      "DeepSeek-Flash",
      "MiniMax-M3.1-Flash",
    ]);
  });

  it("drops the MODEL header rather than offering it as a model", () => {
    expect(ids(REAL_OUTPUT)).not.toContain("MODEL");
  });

  it("uses the id as the label, since the CLI supplies no display name", () => {
    for (const model of parseModelList(REAL_OUTPUT)) {
      expect(model.label).toBe(model.id);
    }
  });

  it("keeps the CLI's own ordering, so `Auto` stays first", () => {
    expect(parseModelList(REAL_OUTPUT)[0]?.id).toBe("Auto");
  });
});

describe("parseModelList — robustness", () => {
  it("returns nothing for empty or whitespace output", () => {
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("   \n\n \t \n")).toEqual([]);
  });

  it("returns nothing for the not-logged-in message", () => {
    // This is what the CLI prints on stderr, but a future version could put it
    // on stdout. It must never become a selectable model.
    expect(ids("Not logged in. Run `qodercli login` to authenticate.")).toEqual([]);
  });

  it("ignores prose lines while keeping real ids", () => {
    const stdout = [
      "MODEL",
      "GLM-5.3",
      "Warning: your plan is close to its limit",
      "Fast",
      "",
    ].join("\n");
    expect(ids(stdout)).toEqual(["GLM-5.3", "Fast"]);
  });

  it("strips ANSI colour codes", () => {
    expect(ids("MODEL\n\u001B[32mGLM-5.3\u001B[0m\n")).toEqual(["GLM-5.3"]);
  });

  it("tolerates CRLF line endings", () => {
    expect(ids("MODEL\r\nGLM-5.3\r\nFast\r\n")).toEqual(["GLM-5.3", "Fast"]);
  });

  it("takes no model from a multi-column line", () => {
    // The verified format is one id per line. If a future CLI prints a table,
    // the list comes back empty and the UI falls back to free text — which is
    // safer than parsing a column wrong and offering ids that do not exist.
    const stdout = ["MODEL  CONTEXT  TIER", "GLM-5.3  200k  standard", "Fast  64k  fast"].join(
      "\n",
    );
    expect(ids(stdout)).toEqual([]);
  });

  it("skips table borders a future renderer might draw", () => {
    const stdout = ["+-----------+", "| MODEL     |", "+-----------+", "GLM-5.3", "==="].join(
      "\n",
    );
    expect(ids(stdout)).toEqual(["GLM-5.3"]);
  });

  it("de-duplicates", () => {
    expect(ids("MODEL\nGLM-5.3\nGLM-5.3\n")).toEqual(["GLM-5.3"]);
  });

  it("accepts the punctuation real Qoder model ids use", () => {
    expect(ids("MODEL\nQwen3.8-Max\nKimi-K2.8-Preview\nglm_4.6\nmodel:v1\na+b\n")).toEqual([
      "Qwen3.8-Max",
      "Kimi-K2.8-Preview",
      "glm_4.6",
      "model:v1",
      "a+b",
    ]);
  });

  it("rejects ids that could not be passed safely to -m", () => {
    // A value starting with a dash would be read as another flag; the rest are
    // shell/prose artefacts that are not model names.
    expect(ids("MODEL\n--help\n$(whoami)\n`id`\n;rm\n")).toEqual([]);
  });

  it("does not treat other header spellings as models", () => {
    for (const header of ["MODEL", "Models", "id", "NAME"]) {
      expect(ids(`${header}\nGLM-5.3\n`), header).toEqual(["GLM-5.3"]);
    }
  });
});

describe("listModels caching", () => {
  beforeEach(() => {
    clearModelCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one pending probe between concurrent callers", async () => {
    const pending = deferred<AdapterModel[]>();
    const models = [{ id: "Auto", label: "Auto" }];
    const probe = vi.fn(() => pending.promise);

    const first = listModels(probe);
    const second = listModels(probe);
    pending.resolve(models);

    const results = await Promise.all([first, second]);
    expect(results).toEqual([models, models]);
    expect(results[0]).toBe(results[1]);
    expect(await listModels(probe)).toBe(models);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps the refreshed cache when an older probe finishes last", async () => {
    const oldPending = deferred<AdapterModel[]>();
    const freshPending = deferred<AdapterModel[]>();
    const oldModels = [{ id: "old", label: "old" }];
    const freshModels = [{ id: "fresh", label: "fresh" }];
    const probe = vi.fn()
      .mockImplementationOnce(() => oldPending.promise)
      .mockImplementationOnce(() => freshPending.promise);

    const oldRequest = listModels(probe);
    const refreshedRequest = refreshModels(probe);
    expect(probe).toHaveBeenCalledTimes(2);

    freshPending.resolve(freshModels);
    await expect(refreshedRequest).resolves.toEqual(freshModels);
    oldPending.resolve(oldModels);
    await expect(oldRequest).resolves.toEqual(oldModels);

    expect(await listModels(probe)).toEqual(freshModels);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate the cache after clearing a pending probe", async () => {
    const pending = deferred<AdapterModel[]>();
    const oldModels = [{ id: "old", label: "old" }];
    const freshModels = [{ id: "fresh", label: "fresh" }];
    const probe = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(freshModels);

    const oldRequest = listModels(probe);
    clearModelCache();
    pending.resolve(oldModels);
    await expect(oldRequest).resolves.toEqual(oldModels);

    expect(await listModels(probe)).toEqual(freshModels);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not let an old completion clear a newer pending probe", async () => {
    const oldPending = deferred<AdapterModel[]>();
    const freshPending = deferred<AdapterModel[]>();
    const oldModels = [{ id: "old", label: "old" }];
    const freshModels = [{ id: "fresh", label: "fresh" }];
    const probe = vi.fn()
      .mockImplementationOnce(() => oldPending.promise)
      .mockImplementation(() => freshPending.promise);

    const oldRequest = listModels(probe);
    const refreshedRequest = refreshModels(probe);
    oldPending.resolve(oldModels);
    await expect(oldRequest).resolves.toEqual(oldModels);

    const joinedRequest = listModels(probe);
    freshPending.resolve(freshModels);
    await expect(Promise.all([refreshedRequest, joinedRequest]))
      .resolves.toEqual([freshModels, freshModels]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "rejected"] as const)(
    "retries after a shared pending probe returns %s",
    async (outcome) => {
      const pending = deferred<AdapterModel[]>();
      const models = [{ id: "Auto", label: "Auto" }];
      const probe = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(() => pending.promise);

      const first = listModels(probe);
      const second = listModels(probe);
      if (outcome === "empty") pending.resolve([]);
      else pending.reject(new Error("spawn qoder ENOENT"));
      await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

      probe.mockResolvedValue(models);
      expect(await listModels(probe)).toEqual(models);
      expect(await listModels(probe)).toEqual(models);
      expect(probe).toHaveBeenCalledTimes(2);
    },
  );

  it("retries after a synchronous probe exception", async () => {
    const models = [{ id: "Auto", label: "Auto" }];
    const probe = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("spawn qoder ENOENT");
      })
      .mockResolvedValue(models);

    await expect(listModels(probe)).resolves.toEqual([]);
    expect(await listModels(probe)).toEqual(models);
    expect(await listModels(probe)).toEqual(models);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("expires the cache exactly five minutes after the probe completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = new Date("2026-10-01T00:00:00Z").getTime();
    vi.setSystemTime(startedAt);
    const pending = deferred<AdapterModel[]>();
    const models = [{ id: "Auto", label: "Auto" }];
    const refreshedModels = [{ id: "Fast", label: "Fast" }];
    const probe = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(refreshedModels);

    const request = listModels(probe);
    const fetchedAt = startedAt + 60_000;
    vi.setSystemTime(fetchedAt);
    pending.resolve(models);
    await expect(request).resolves.toEqual(models);

    vi.setSystemTime(fetchedAt + 5 * 60 * 1000 - 1);
    expect(await listModels(probe)).toEqual(models);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(fetchedAt + 5 * 60 * 1000);
    expect(await listModels(probe)).toEqual(refreshedModels);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes once and serves the cache afterwards", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return [{ id: "GLM-5.3", label: "GLM-5.3" }];
    };

    expect(await listModels(probe)).toEqual([{ id: "GLM-5.3", label: "GLM-5.3" }]);
    expect(await listModels(probe)).toEqual([{ id: "GLM-5.3", label: "GLM-5.3" }]);
    // The UI asks for models on every form render; spawning the CLI each time
    // would make the form crawl.
    expect(calls).toBe(1);
  });

  it("does not cache an empty result, so logging in later still works", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      // First two calls: not logged in. Third: logged in.
      return calls < 3 ? [] : [{ id: "Auto", label: "Auto" }];
    };

    expect(await listModels(probe)).toEqual([]);
    expect(await listModels(probe)).toEqual([]);
    expect(await listModels(probe)).toEqual([{ id: "Auto", label: "Auto" }]);
    expect(calls).toBe(3);
  });

  it("refreshModels bypasses a warm cache", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return [{ id: `model-${calls}`, label: `model-${calls}` }];
    };

    await listModels(probe);
    expect(calls).toBe(1);
    expect(await refreshModels(probe)).toEqual([{ id: "model-2", label: "model-2" }]);
    expect(calls).toBe(2);
  });

  it("returns an empty list instead of throwing when the probe fails", async () => {
    const probe = async () => {
      throw new Error("spawn qoder ENOENT");
    };
    await expect(listModels(probe)).resolves.toEqual([]);
  });

  it("takes no arguments as far as the host contract is concerned", async () => {
    const { createServerAdapter } = await import("../src/index.js");
    const adapter = createServerAdapter();
    expect(typeof adapter.listModels).toBe("function");
    expect(adapter.listModels?.length).toBe(0);
    expect(typeof adapter.refreshModels).toBe("function");
  });
});
