import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

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
