import type { Message } from "@agenteschat/client";

/**
 * The requests waiting in a conversation, without React Native, so they are unit-tested: which wait on the person,
 * which of those are out of view (the line above the composer says the first), and the times that end them. Whose a
 * request on an agent's screen is: `handoffIsMine` in `@agenteschat/client`, shared with the web.
 */

/** What a request asks (`proposal`: a change to the context or to an agent's instructions; `agent`: a new agent). */
export type AskKind =
  | "approval"
  | "secret"
  | "question"
  | "browser"
  | "desktop"
  | "proposal"
  | "agent"
  | "team"
  | "firstTask";

/** A request the person can answer now, in this conversation. `order`: where its message sits in the list. */
export interface PendingAsk {
  id: string;
  kind: AskKind;
  agentId: string;
  /** The thing it is about, short (the action, the secret's name, the question). */
  what: string;
  messageId: string;
  order: number;
}

/** The first request out of view and how many more are. */
export interface AwayAsk {
  ask: PendingAsk;
  more: number;
}

/** What the screen measures of a request's card: where it sits in the window (a React Native view has it). */
export interface Measurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

/**
 * The requests waiting here, their cards on screen and which of them are out of view. Kept outside React so a
 * look at the list (on every scroll) only redraws what reads it, and only when the answer changes.
 */
export class AskStore {
  private asks = new Map<string, PendingAsk>();
  private settled = new Set<string>();
  private cards = new Map<string, Measurable>();
  /** The waiting requests the screen last found out of view. */
  private hidden = new Set<string>();
  /** The screen looked at least once: before that every request would look out of view. */
  private measured = false;
  private away: AwayAsk | null = null;
  private listeners = new Set<() => void>();
  private watchers = new Set<() => void>();

  /** Hears when the first request out of view, or how many more, changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getAway = () => this.away;

  /** Hears when what waits or which cards are drawn changes: the screen looks again. */
  watch(watcher: () => void) {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  hasWaiting() {
    return this.asks.size > 0;
  }

  waiting(): PendingAsk[] {
    return [...this.asks.values()];
  }

  cardOf(id: string): Measurable | undefined {
    return this.cards.get(id);
  }

  put(ask: PendingAsk) {
    if (this.settled.has(ask.id)) return;
    const old = this.asks.get(ask.id);
    if (
      old &&
      old.kind === ask.kind &&
      old.what === ask.what &&
      old.messageId === ask.messageId &&
      old.order === ask.order &&
      old.agentId === ask.agentId
    )
      return;
    this.asks.set(ask.id, ask);
    this.update();
    this.changed();
  }

  drop(id: string) {
    if (!this.asks.delete(id)) return;
    this.hidden.delete(id);
    this.update();
  }

  /** Answered here: gone at once, before the server's own update arrives. */
  settle(id: string) {
    this.settled.add(id);
    this.drop(id);
  }

  /** A request's card is drawn (`AskCard`); returns the call that takes it back when it goes. */
  register(id: string, card: Measurable) {
    this.cards.set(id, card);
    this.changed();
    return () => {
      if (this.cards.get(id) !== card) return;
      this.cards.delete(id);
      this.changed();
    };
  }

  /** The screen's look: which waiting requests are out of view (their cards outside the band, or not drawn). */
  setHidden(ids: Iterable<string>) {
    const next = new Set(ids);
    const same = this.measured && next.size === this.hidden.size && [...next].every((id) => this.hidden.has(id));
    this.measured = true;
    if (same) return;
    this.hidden = next;
    this.update();
  }

  private changed() {
    for (const watcher of this.watchers) watcher();
  }

  private update() {
    const out = this.measured
      ? [...this.asks.values()].filter((a) => this.hidden.has(a.id)).sort((a, b) => a.order - b.order)
      : [];
    const first = out[0];
    const next = first ? { ask: first, more: out.length - 1 } : null;
    const prev = this.away;
    const same =
      prev === next ||
      (prev &&
        next &&
        prev.ask.id === next.ask.id &&
        prev.ask.what === next.ask.what &&
        prev.ask.kind === next.ask.kind &&
        prev.ask.agentId === next.ask.agentId &&
        prev.ask.messageId === next.ask.messageId &&
        prev.more === next.more);
    if (same) return;
    this.away = next;
    for (const listener of this.listeners) listener();
  }
}

// ── What a message asks ──────────────────────────────────────────────────────

/** The keys of `meta` a request comes in (what they hold is the probes' to read). */
const ASK_KEYS = [
  "approvalId",
  "question",
  "secretRequest",
  "browserHandoff",
  "actionCard",
  "proposalId",
  "memoryUpdates",
] as const;

/**
 * Whether a message may carry a request, by its keys alone: cheap enough to run over every loaded message whenever
 * the list changes.
 */
export function mayAsk(m: Pick<Message, "author" | "meta">): boolean {
  const meta = m.meta;
  return m.author.type === "agent" && meta !== undefined && ASK_KEYS.some((key) => Boolean(meta[key]));
}

export { secretRequestOf } from "@agenteschat/client/lib/secret-requests";

/**
 * How long an approval waits before it expires: the engine's `APPROVAL_TTL_MS`
 * (`packages/engine/src/tools/gateway.ts`), which the phone can't import.
 */
export const APPROVAL_TTL_MS = 24 * 3600_000;

/** Whether an approval asked by a message sent at `createdAt` may still wait (an older one has expired). */
export function approvalMayWait(createdAt: string, now: number): boolean {
  const age = now - Date.parse(createdAt);
  // A time it can't read never hides a request.
  return Number.isNaN(age) || age < APPROVAL_TTL_MS;
}

// ── Times and the screen ─────────────────────────────────────────────────────

/** The longest delay a timer takes: a time farther away is waited for in steps. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A timer's delay to `at` (ms since the epoch): never negative, never past the longest a timer takes. */
export const timerDelay = (at: number, now: number) => Math.min(Math.max(0, at - now), MAX_TIMER_MS);

/** When a request ended: when someone decided it, or the deadline of one that ran out; null when it has neither. */
export const askEndedAt = (r: { status: string; decidedAt: string | null; expiresAt: string }) =>
  r.decidedAt ?? (r.status === "expired" ? r.expiresAt : null);

/** When a card of change proposals closed: its last decision; null when its rows only went stale. */
export const lastDecidedAt = (rows: { decidedAt: string | null }[]) =>
  rows.reduce<string | null>((last, p) => (p.decidedAt && (!last || p.decidedAt > last) ? p.decidedAt : last), null);

/** How much of a request's card has to show for it to count as on screen (the web's rule). */
export const SHOWN_MIN_PX = 40;

/** The list's visible band in window points: below the floating header, above the composer. */
export interface Band {
  top: number;
  bottom: number;
}

/**
 * Whether a card (its window `y` and `height`) shows enough inside the band: 40 points of it, or all of a smaller
 * one. A card not laid out yet (no height) counts as shown, so the line above the composer doesn't flash.
 */
export function cardShows(y: number, height: number, band: Band): boolean {
  if (!(height > 0)) return true;
  const shown = Math.min(y + height, band.bottom) - Math.max(y, band.top);
  return shown >= Math.min(SHOWN_MIN_PX, height);
}
