import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMAND,
  DEFAULT_GRACE_SEC,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_SEC,
  QODER_PERMISSION_MODES,
  getConfigSchema,
  isQoderPermissionMode,
  parseArgList,
  parsePositiveInt,
  parseStringList,
  resolvePermissionMode,
} from "../src/config.js";

describe("permission mode", () => {
  it("defaults to the CLI's unattended mode", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
    expect(resolvePermissionMode(undefined)).toEqual({ mode: "auto", warning: null });
    expect(resolvePermissionMode("")).toEqual({ mode: "auto", warning: null });
    expect(resolvePermissionMode("   ")).toEqual({ mode: "auto", warning: null });
  });

  it("accepts every mode the installed CLI registers", () => {
    for (const mode of QODER_PERMISSION_MODES) {
      expect(resolvePermissionMode(mode)).toEqual({ mode, warning: null });
      expect(isQoderPermissionMode(mode)).toBe(true);
    }
  });

  it("rejects `plan`, which the CLI's parser accepts but does not implement", () => {
    // `--permission-mode` has no .choices() validation, so an unlisted value is
    // passed through to a mode that does not exist. Catching it here is the
    // only place it can be caught.
    const resolved = resolvePermissionMode("plan");
    expect(resolved.mode).toBe("auto");
    expect(resolved.warning).toContain("plan");
    expect(isQoderPermissionMode("plan")).toBe(false);
  });

  it("falls back with a warning for arbitrary junk", () => {
    const resolved = resolvePermissionMode("YOLO; rm -rf /");
    expect(resolved.mode).toBe("auto");
    expect(resolved.warning).toContain("falling back");
  });

  it("does not silently accept a non-string", () => {
    expect(resolvePermissionMode(42).mode).toBe("auto");
    expect(resolvePermissionMode(null).warning).toBeNull();
    expect(resolvePermissionMode({ mode: "auto" }).mode).toBe("auto");
  });
});

describe("parseStringList", () => {
  it("splits on commas and newlines and trims", () => {
    expect(parseStringList("Bash, Read\nWrite ,")).toEqual(["Bash", "Read", "Write"]);
  });

  it("accepts a JSON array from the config store", () => {
    expect(parseStringList(["Bash", " Read "])).toEqual(["Bash", "Read"]);
  });

  it("de-duplicates", () => {
    expect(parseStringList("Bash,Bash,bash")).toEqual(["Bash", "bash"]);
  });

  it("ignores non-strings and empty input", () => {
    expect(parseStringList([1, null, "Read", {}])).toEqual(["Read"]);
    expect(parseStringList(undefined)).toEqual([]);
    expect(parseStringList(42)).toEqual([]);
  });
});

describe("parseArgList", () => {
  it("splits only on newlines, because a comma can belong inside one argument", () => {
    expect(parseArgList("--foo\n--bar=a,b,c")).toEqual(["--foo", "--bar=a,b,c"]);
  });

  it("keeps spaces inside a single argument", () => {
    expect(parseArgList("--append-system-prompt\n写代码时请使用中文注释")).toEqual([
      "--append-system-prompt",
      "写代码时请使用中文注释",
    ]);
  });

  it("preserves repeated option values and order", () => {
    const args = ["--thinking-budget", "8192", "--context-window", "8192"];
    expect(parseArgList(args)).toEqual(args);
    expect(parseArgList(args.join("\n"))).toEqual(args);
  });
});

describe("parsePositiveInt", () => {
  it("accepts positive numbers and numeric strings", () => {
    expect(parsePositiveInt(5)).toBe(5);
    expect(parsePositiveInt("12")).toBe(12);
    expect(parsePositiveInt(" 7 ")).toBe(7);
    expect(parsePositiveInt(3.9)).toBe(3);
  });

  it("treats zero, negatives and junk as unset", () => {
    for (const value of [0, "0", -1, "-4", "", "  ", "abc", null, undefined, {}, NaN, Infinity]) {
      expect(parsePositiveInt(value), String(value)).toBeNull();
    }
  });
});

describe("getConfigSchema", () => {
  const schema = getConfigSchema();

  it("only uses field types the host can render", () => {
    const allowed = new Set(["text", "select", "toggle", "number", "textarea", "combobox"]);
    for (const field of schema.fields) {
      expect(allowed.has(field.type), `${field.key}: ${field.type}`).toBe(true);
    }
  });

  it("gives every field a unique key and a label", () => {
    const keys = schema.fields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of schema.fields) {
      expect(field.label, field.key).toBeTruthy();
    }
  });

  it("exposes the minimum configuration the task requires", () => {
    const keys = schema.fields.map((field) => field.key);
    for (const required of ["command", "cwd", "timeoutSec", "permissionMode"]) {
      expect(keys, required).toContain(required);
    }
  });

  it("leaves the model control to the host", () => {
    // The host renders its own "Model ID" picker, fed by this adapter's
    // listModels(). A `model` field here would bind a second input to the same
    // config key.
    expect(schema.fields.map((field) => field.key)).not.toContain("model");
  });

  it("offers exactly the permission modes the CLI implements", () => {
    const field = schema.fields.find((entry) => entry.key === "permissionMode");
    const offered = (field?.options ?? []).map((option) => option.value).sort();
    expect(offered).toEqual([...QODER_PERMISSION_MODES].sort());
  });

  it("ships defaults that match the documented constants", () => {
    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    expect(byKey.get("command")?.default).toBe(DEFAULT_COMMAND);
    expect(byKey.get("timeoutSec")?.default).toBe(DEFAULT_TIMEOUT_SEC);
    expect(byKey.get("graceSec")?.default).toBe(DEFAULT_GRACE_SEC);
    expect(byKey.get("permissionMode")?.default).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("warns in the UI that bypass_permissions removes the checks", () => {
    const field = schema.fields.find((entry) => entry.key === "permissionMode");
    expect(field?.hint ?? "").toMatch(/bypass/i);
  });
});
