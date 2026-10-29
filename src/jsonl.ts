/**
 * Incremental JSONL line splitter for the CLI's stdout chunks.
 *
 * Why this exists instead of parsing `RunProcessResult.stdout` at the end: the
 * host caps its batched capture at `MAX_CAPTURE_BYTES` (4 MiB) and truncates
 * from the FRONT (`appendWithCap` in `@paperclipai/adapter-utils`). A long run
 * therefore loses the `system/init` line — and with it the session id — from the
 * batched buffer. We aggregate state as chunks arrive and never depend on the
 * final buffer.
 *
 * The pending-line buffer is bounded. A single line longer than the cap is
 * unparseable JSON anyway, so it is dropped with a counter rather than grown
 * without limit.
 */

export const DEFAULT_MAX_PENDING_LINE_BYTES = 2 * 1024 * 1024;

export type LineSplitterOptions = {
  maxPendingLineBytes?: number;
  /** Invoked once per dropped oversized line. */
  onOverflow?: (droppedChars: number) => void;
};

export class LineSplitter {
  private pending = "";
  private readonly maxPendingLineBytes: number;
  private readonly onOverflow: ((droppedChars: number) => void) | undefined;
  private overflowCount = 0;
  /** Set after an overflow: the next newline still belongs to the dropped line. */
  private discardingTail = false;

  constructor(options: LineSplitterOptions = {}) {
    this.maxPendingLineBytes =
      options.maxPendingLineBytes ?? DEFAULT_MAX_PENDING_LINE_BYTES;
    this.onOverflow = options.onOverflow;
  }

  /** Feeds a chunk and returns every complete line it closed. */
  push(chunk: string): string[] {
    if (!chunk) return [];
    this.pending += chunk;

    // The remainder of a dropped oversized line is not a line of its own;
    // reporting it as one would show up as a spurious protocol error.
    if (this.discardingTail) {
      const tailEnd = this.pending.indexOf("\n");
      if (tailEnd === -1) {
        this.pending = "";
        return [];
      }
      this.pending = this.pending.slice(tailEnd + 1);
      this.discardingTail = false;
    }

    const lines: string[] = [];
    let newlineAt = this.pending.indexOf("\n");
    while (newlineAt !== -1) {
      const raw = this.pending.slice(0, newlineAt);
      this.pending = this.pending.slice(newlineAt + 1);
      const line = this.checkLine(raw);
      if (line) lines.push(line);
      newlineAt = this.pending.indexOf("\n");
    }
    if (this.checkLine(this.pending) === null) {
      this.pending = "";
      this.discardingTail = true;
    }
    return lines;
  }

  /** Returns any trailing unterminated line. The CLI may omit a final newline. */
  flush(): string[] {
    if (!this.pending) return [];
    const remainder = this.pending;
    this.pending = "";
    if (this.discardingTail) {
      this.discardingTail = false;
      return [];
    }
    const line = this.checkLine(remainder);
    return line ? [line] : [];
  }

  private checkLine(raw: string): string | null {
    // A trailing CR is stripped for CRLF and by flush. Defer charging it while
    // pending, too, so splitting CRLF across chunks cannot cause an overflow.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Measure the reassembled prefix, not each chunk separately: a surrogate
    // pair split across chunks must not be counted as two replacement chars.
    if (Buffer.byteLength(line, "utf8") > this.maxPendingLineBytes) {
      this.overflowCount += 1;
      // Preserve the callback's JS code-unit count at the point of overflow.
      this.onOverflow?.(raw.length);
      return null;
    }
    return line;
  }

  get droppedLineCount(): number {
    return this.overflowCount;
  }
}
