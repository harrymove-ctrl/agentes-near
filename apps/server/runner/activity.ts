import { readFileSync } from "node:fs";
import path from "node:path";
import { redactCommon } from "@agenteschat/adapters/redact";
import type { ActivityEntry, ActivitySaid } from "@agenteschat/adapters/runner-control";
import { ROTATE_BYTES, ROTATE_KEEP, RotatingFile } from "./logfile";

/**
 * What agents did on this computer, for the person (ADR 0036 §7):
 * `<home>/activity.jsonl`, one `ActivityEntry` per line, rotated at 5 MB into
 * `activity.1.jsonl` and `activity.2.jsonl` (three files at most). Local
 * only; secrets are masked before anything is written.
 */

export const ACTIVITY_FILE = "activity.jsonl";
export const ACTIVITY_PAGE = 50;
export const ACTIVITY_PAGE_MAX = 200;
const SUMMARY_MAX = 300;
const COMMAND_MAX = 2000;

export class ActivityLog {
  private readonly file: RotatingFile;

  constructor(home: string, opts: { maxBytes?: number; keep?: number } = {}) {
    this.file = new RotatingFile(
      path.join(home, ACTIVITY_FILE),
      opts.maxBytes ?? ROTATE_BYTES,
      opts.keep ?? ROTATE_KEEP,
    );
  }

  /** Appends one entry (masked with `redact`, then the common credential shapes). Returns what was written. */
  append(entry: Omit<ActivityEntry, "at"> & { at?: string }, redact?: (text: string) => string): ActivityEntry {
    const clean = (s: string) => redactCommon(redact ? redact(s) : s);
    const out: ActivityEntry = {
      at: entry.at ?? new Date().toISOString(),
      ...(entry.agent ? { agent: { id: entry.agent.id, name: entry.agent.name.slice(0, 100) } } : {}),
      kind: entry.kind,
      summary: clean(entry.summary.replace(/\s+/g, " ").trim()).slice(0, SUMMARY_MAX),
      ...(entry.command ? { command: clean(entry.command).slice(0, COMMAND_MAX) } : {}),
      ...(entry.where ? { where: entry.where.slice(0, 200) } : {}),
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.said
        ? {
            said: Object.fromEntries(
              Object.entries(entry.said).map(([k, v]) => [k, clean(v).slice(0, SUMMARY_MAX)]),
            ) as ActivitySaid,
          }
        : {}),
    };
    try {
      this.file.append(`${JSON.stringify(out)}\n`);
    } catch {
      // a full disk never stops the work; the entry still goes to the app
    }
    return out;
  }

  /**
   * Newest first. `before`: an `at` from the previous page (entries strictly
   * older come back); `agentId`: only that agent's. `more`: older ones exist.
   */
  page(opts: { before?: string; limit?: number; agentId?: string } = {}): { entries: ActivityEntry[]; more: boolean } {
    const limit = Math.max(1, Math.min(ACTIVITY_PAGE_MAX, Math.floor(opts.limit ?? ACTIVITY_PAGE) || ACTIVITY_PAGE));
    const before = opts.before ? Date.parse(opts.before) : Number.NaN;
    const entries: ActivityEntry[] = [];
    for (const f of this.file.files()) {
      let text = "";
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let e: ActivityEntry;
        try {
          e = JSON.parse(line) as ActivityEntry;
        } catch {
          continue;
        }
        if (typeof e?.at !== "string") continue;
        if (!Number.isNaN(before) && !(Date.parse(e.at) < before)) continue;
        if (opts.agentId && e.agent?.id !== opts.agentId) continue;
        entries.push(e);
        if (entries.length > limit) return { entries: entries.slice(0, limit), more: true };
      }
    }
    return { entries, more: false };
  }
}
