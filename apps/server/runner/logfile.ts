import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Append-only files that rotate by size (ADR 0036 §3 and §7): the runner's
 * log in app mode (`<home>/logs/runner.log`) and the activity log
 * (`<home>/activity.jsonl`). When a file would pass `maxBytes` it becomes
 * `<name>.1<ext>`, the older ones move up, and at most `keep` files remain
 * (the oldest is deleted).
 */

export const ROTATE_BYTES = 5 * 1024 * 1024;
export const ROTATE_KEEP = 3;

/** `runner.log`, 2 → `runner.2.log`; 0 is the file itself. */
export function rotatedName(file: string, index: number): string {
  if (index === 0) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${index}${ext}`;
}

export class RotatingFile {
  private size: number | null = null;

  constructor(
    readonly file: string,
    private readonly maxBytes = ROTATE_BYTES,
    private readonly keep = ROTATE_KEEP,
  ) {}

  /** Every file, newest first (only the ones that exist). */
  files(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.keep; i++) {
      const f = rotatedName(this.file, i);
      try {
        statSync(f);
        out.push(f);
      } catch {
        // not there
      }
    }
    return out;
  }

  append(text: string) {
    const bytes = Buffer.byteLength(text);
    if (this.size === null) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        this.size = statSync(this.file).size;
      } catch {
        this.size = 0;
      }
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.file, text, { mode: 0o600 });
    this.size += bytes;
  }

  private rotate() {
    rmSync(rotatedName(this.file, this.keep - 1), { force: true });
    for (let i = this.keep - 2; i >= 0; i--) {
      try {
        renameSync(rotatedName(this.file, i), rotatedName(this.file, i + 1));
      } catch {
        // that one didn't exist
      }
    }
    this.size = 0;
  }
}

/** A duration as the log says it, to the hundredth of a second ("0.42 s"). */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** The last `lines` lines of a file (reads at most `maxBytes` from its end). */
export function tailLines(file: string, lines: number, maxBytes = 256 * 1024): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
