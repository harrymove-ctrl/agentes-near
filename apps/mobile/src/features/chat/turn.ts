import type { LiveRun } from "@agenteschat/client";
import { holdsText } from "@agenteschat/client/lib/text";
import { type ToolItem, toolItemsLive } from "@agenteschat/client/lib/work";

/**
 * An agent's turn in the conversation: while it works nothing of it draws there (the line above the box says who
 * works, on what and for how long), and its saved reply shows whole, once, with the work it did. Pure, so it is
 * tested: the lines of its work, which runs are at work, and what the saved reply keeps.
 */

/**
 * The run's work in order, as the tool block's items (the shared model): its calls, repeats folded (five
 * browser steps are one line), what it said between them and the messages it read. `over`: nothing more comes, so a
 * call that was running shows as stopped.
 */
export function turnItems(r: Pick<LiveRun, "work" | "status">, over = r.status === "failed"): ToolItem[] {
  return toolItemsLive(r.work ?? [], over);
}

/** What a saved reply's kept work depends on: a line's state and count, and how much of a line said has arrived. */
export const turnSignature = (items: readonly ToolItem[]) =>
  items
    .map((x) =>
      x.kind === "call"
        ? `${x.key}:${x.line.state}${x.line.count}`
        : `${x.key}:${x.kind === "say" ? x.text.length : ""}`,
    )
    .join("|");

/** The first thing it said, out of the lines below (the line its block opens with, above its tools). */
export function turnOpener(items: readonly ToolItem[], posted = ""): { said: string | null; lines: ToolItem[] } {
  const first = items.find((x) => x.kind === "say");
  // Said before a call and then posted as the saved reply (`posted`, the lead before a card): the reply shows it.
  if (first)
    return {
      said: posted && holdsText(posted, first.text) ? null : first.text,
      lines: items.filter((x) => x !== first),
    };
  return { said: null, lines: [...items] };
}

/** Live statuses of an agent at work (a "pensando…" guessed on send too). */
const AT_WORK: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * The runs at work here (a "pensando…" guessed on send too), but one in its browser, which has its browser card. None
 * draws a block of its own: the line above the box speaks for them, and each reply shows whole once posted.
 */
export function turnRuns<R extends Pick<LiveRun, "runId" | "status">>(
  runs: readonly R[],
  browsing: ReadonlySet<string> = new Set(),
): R[] {
  return runs.filter((r) => AT_WORK.has(r.status) && !browsing.has(r.runId));
}

// ── Colors ───────────────────────────────────────────────────────────────────

/** A color at `opacity` (hex or rgba; anything else as it is): a fade's stops over the conversation. */
export function withOpacity(color: string, opacity: number): string {
  const a = Math.max(0, Math.min(1, opacity));
  if (/^#[0-9a-f]{6}$/i.test(color))
    return `${color}${Math.round(a * 255)
      .toString(16)
      .padStart(2, "0")}`;
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (rgba) {
    const base = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${Number((base * a).toFixed(3))})`;
  }
  return color;
}

// ── The block's work, handed to the saved reply ──────────────────────────────

/**
 * The work a run at work here did last, so its saved reply shows the same tool block at once ("Usou 4 ferramentas")
 * and the messages it read, instead of loading the run's steps first.
 */
export interface TurnSnapshot {
  items: ToolItem[];
  /** The text of each message it read (the "Leu seu recado" wells). */
  quotes: Record<string, string>;
  at: number;
}

const SNAPSHOTS = new Map<string, TurnSnapshot>();
const SNAPSHOT_MAX = 24;

/** The run `runId` did this work so far. */
export function rememberTurn(runId: string, snapshot: TurnSnapshot) {
  SNAPSHOTS.delete(runId);
  SNAPSHOTS.set(runId, snapshot);
  while (SNAPSHOTS.size > SNAPSHOT_MAX) {
    const oldest = SNAPSHOTS.keys().next().value;
    if (oldest === undefined) break;
    SNAPSHOTS.delete(oldest);
  }
}

/** The work the run `runId` did, heard a moment ago (its saved reply just came), or null. */
export function recentTurn(runId: string, now: number, maxAgeMs = 8000): TurnSnapshot | null {
  const s = SNAPSHOTS.get(runId);
  return s && now - s.at <= maxAgeMs && s.items.length > 0 ? s : null;
}

// ── A stopped reply ──────────────────────────────────────────────────────────

/**
 * `meta.canceled` of a stopped reply: who stopped it, and the run that continued it ("Continuar" goes
 * away then). Null when it wasn't stopped.
 */
export function stoppedOf(
  meta: Record<string, unknown> | undefined,
): { byUserId: string | null; continuedRunId: string | null } | null {
  const c = meta?.canceled;
  if (!c) return null;
  const o = typeof c === "object" ? (c as Record<string, unknown>) : {};
  return {
    byUserId: typeof o.byUserId === "string" ? o.byUserId : null,
    continuedRunId: typeof o.continuedRunId === "string" ? o.continuedRunId : null,
  };
}

/**
 * `meta.stepLimit` of the reply of a run that reached its step limit, or stopped because it got stuck (`stuck`):
 * the run that continued it ("Continuar" goes away then). Null for any other reply.
 */
export function stepLimitOf(
  meta: Record<string, unknown> | undefined,
): { continuedRunId: string | null; stuck: boolean } | null {
  const c = meta?.stepLimit;
  if (!c || typeof c !== "object") return null;
  const { continuedRunId: id, stuck } = c as Record<string, unknown>;
  return { continuedRunId: typeof id === "string" ? id : null, stuck: stuck === true };
}

/**
 * The reply's meta once it was continued (the `run.continued` event; also optimistic): `meta.canceled`,
 * `meta.stepLimit` on a reply at the step limit, or `meta.workEnd` on a long work's end.
 */
export function withContinued(meta: Record<string, unknown> | undefined, newRunId: string): Record<string, unknown> {
  const key = meta?.canceled ? "canceled" : meta?.stepLimit ? "stepLimit" : meta?.workEnd ? "workEnd" : "canceled";
  const c = meta?.[key];
  const base = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  return { ...(meta ?? {}), [key]: { ...base, continuedRunId: newRunId } };
}

// ── A tool line's open view ──────────────────────────────────────────────────

/** What a call printed, as one text: its end when long (the open line shows the newest output). */
export function outputTail(output: readonly { text: string }[], max = 2000): string {
  const text = output.map((o) => o.text).join("");
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
