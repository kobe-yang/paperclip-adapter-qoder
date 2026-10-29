import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_PENDING_LINE_BYTES, LineSplitter } from "../src/jsonl.js";

const CJK_LINE = '{"type":"assistant","text":"修复了除零错误，并补充了测试。"}';

describe("LineSplitter", () => {
  it("emits one line per newline and keeps the remainder pending", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b":2}\n{"c":3')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.flush()).toEqual(['{"c":3']);
  });

  it("reassembles a line split across arbitrary chunk boundaries", () => {
    for (let cut = 1; cut < CJK_LINE.length; cut += 1) {
      const splitter = new LineSplitter();
      const emitted = [
        ...splitter.push(CJK_LINE.slice(0, cut)),
        ...splitter.push(`${CJK_LINE.slice(cut)}\n`),
        ...splitter.flush(),
      ];
      expect(emitted, `split at ${cut}`).toEqual([CJK_LINE]);
    }
  });

  it("reassembles a line delivered one character at a time", () => {
    const splitter = new LineSplitter();
    const emitted: string[] = [];
    for (const char of `${CJK_LINE}\n`) emitted.push(...splitter.push(char));
    expect(emitted).toEqual([CJK_LINE]);
    expect(splitter.flush()).toEqual([]);
  });

  it("tolerates CRLF without leaving a stray carriage return", () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("drops blank lines rather than emitting empty strings", () => {
    const splitter = new LineSplitter();
    expect(splitter.push("\n\n\n")).toEqual([]);
    expect(splitter.droppedLineCount).toBe(0);
  });

  it("flushes nothing when the stream ended on a newline", () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}\n');
    expect(splitter.flush()).toEqual([]);
  });

  it("drops an oversized pending line instead of growing without bound", () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter({
      maxPendingLineBytes: 64,
      onOverflow: (n) => overflows.push(n),
    });

    // No newline, so this can only accumulate in the pending buffer.
    expect(splitter.push("x".repeat(500))).toEqual([]);
    expect(splitter.droppedLineCount).toBe(1);
    expect(overflows.length).toBe(1);

    // The tail of the dropped line is discarded rather than reported as its own
    // (unparseable) line; the next complete line is parsed normally.
    expect(splitter.push('tail-of-dropped-line\n{"ok":true}\n')).toEqual(['{"ok":true}']);
    expect(splitter.droppedLineCount).toBe(1);
  });

  it.each([
    { line: "x".repeat(65), cap: 64 },
    { line: "字字字", cap: 8 },
    { line: "\uD83D\uDE00\uD83D\uDE00", cap: 7 },
  ])("drops a complete oversized line in one chunk: $line", ({ line, cap }) => {
    const overflows: number[] = [];
    const splitter = new LineSplitter({
      maxPendingLineBytes: cap,
      onOverflow: (n) => overflows.push(n),
    });

    expect(splitter.push(`${line}\nok\n`)).toEqual(["ok"]);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.droppedLineCount).toBe(1);
    // The callback still reports JS code units, not the UTF-8 byte count.
    expect(overflows).toEqual([line.length]);
    expect(splitter.push("next\n")).toEqual(["next"]);
  });

  it("counts every oversized line in a single chunk exactly once", () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter({
      maxPendingLineBytes: 4,
      onOverflow: (n) => overflows.push(n),
    });

    expect(splitter.push("xxxxx\n字字\r\nok\nzzzzz\nhi")).toEqual(["ok"]);
    expect(splitter.flush()).toEqual(["hi"]);
    expect(splitter.droppedLineCount).toBe(3);
    expect(overflows).toEqual([5, 3, 5]);
  });

  it("drops a UTF-8 overflow across chunks and ignores its tail until newline", () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter({
      maxPendingLineBytes: 8,
      onOverflow: (n) => overflows.push(n),
    });

    expect(splitter.push("字字")).toEqual([]);
    expect(splitter.droppedLineCount).toBe(0);
    expect(splitter.push("字")).toEqual([]);
    expect(splitter.droppedLineCount).toBe(1);
    expect(overflows).toEqual([3]);
    expect(splitter.push("tail".repeat(100))).toEqual([]);
    expect(splitter.push("\r")).toEqual([]);
    expect(splitter.push("\n好\n")).toEqual(["好"]);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.droppedLineCount).toBe(1);
    expect(overflows).toEqual([3]);
  });

  it.each([
    { line: "12345678", accepted: true },
    { line: "123456789", accepted: false },
    { line: "字字ab", accepted: true },
    { line: "字字abc", accepted: false },
    { line: "\uD83D\uDE00\uD83D\uDE00", accepted: true },
    { line: "\uD83D\uDE00\uD83D\uDE00x", accepted: false },
  ])("enforces the same byte limit for every partition of $line", ({ line, accepted }) => {
    for (const ending of ["\n", "\r\n", "", "\r"]) {
      const source = `${line}${ending}`;
      const partitions = [[source], source.split("")];
      for (let cut = 1; cut < source.length; cut += 1) {
        partitions.push([source.slice(0, cut), source.slice(cut)]);
      }
      for (const chunks of partitions) {
        const overflows: number[] = [];
        const splitter = new LineSplitter({
          maxPendingLineBytes: 8,
          onOverflow: (n) => overflows.push(n),
        });
        const emitted = chunks.flatMap((chunk) => splitter.push(chunk));
        emitted.push(...splitter.flush());
        const context = JSON.stringify(chunks);
        expect(emitted, context).toEqual(accepted ? [line] : []);
        expect(splitter.droppedLineCount, context).toBe(accepted ? 0 : 1);
        expect(overflows.length, context).toBe(accepted ? 0 : 1);
        expect(splitter.flush(), context).toEqual([]);
      }
    }
  });

  it("does not count a split CRLF blank line against a zero-byte cap", () => {
    const splitter = new LineSplitter({ maxPendingLineBytes: 0 });
    expect(splitter.push("\r")).toEqual([]);
    expect(splitter.push("\n")).toEqual([]);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.droppedLineCount).toBe(0);
  });

  it("keeps a large but bounded line intact", () => {
    const splitter = new LineSplitter({ maxPendingLineBytes: 1024 * 1024 });
    const big = `{"type":"user","text":"${"字".repeat(50_000)}"}`;
    const emitted = [...splitter.push(`${big}\n`)];
    expect(emitted).toEqual([big]);
    expect(splitter.droppedLineCount).toBe(0);
  });

  it("defaults to a documented buffer ceiling", () => {
    expect(DEFAULT_MAX_PENDING_LINE_BYTES).toBe(2 * 1024 * 1024);
  });
});
