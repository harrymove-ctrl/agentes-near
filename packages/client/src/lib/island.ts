import type { AppNotification, MediaKind, NotificationEvent } from "../api/types";
import { mediaKindOf } from "./media";
import { channelOf, isSnoozed } from "./notifications";

/**
 * The island (ADR 0071 §9): what reaches me while the app is open shows in a dark pill at the top of the screen
 * (on the phone it grows out of the camera's island), in place of the system's banner. It opens with the whole text
 * and the answer right there; what isn't waiting on me leaves on its own, what is (an approval, a question, a
 * browser) shrinks and stays until I decide. Nothing shows for the conversation on screen, and whatever leaves the
 * island stays in the inbox. The same rules on the web and on the phone; each draws it its own way.
 */

/** How long a notice stays before it leaves (or, waiting on me, shrinks). */
export const ISLAND_LIFE_MS = 6000;
/** At most this many at once: past it, the oldest one that isn't waiting leaves first (the inbox keeps it). */
export const ISLAND_MAX = 6;

/** A conversation on screen: a channel or a DM, or one of its threads. */
export interface OnScreen {
  channelId: string;
  threadId: string | null;
}

/** Whether a notification is about a conversation on screen, where its message already shows. */
export function isOnScreen(n: Pick<AppNotification, "source">, screens: readonly OnScreen[]): boolean {
  const channel = channelOf(n);
  if (!channel) return false;
  const thread = n.source.threadId ?? null;
  return screens.some((s) => s.channelId === channel && s.threadId === thread);
}

type Upserted = Extract<NotificationEvent, { type: "notification.upserted" }>;

/**
 * Whether a notification raises the island: still news (not read, done or snoozed), a kind the person keeps on
 * (`alert`, their choices in Notificações, ADR 0071 §8; absent from older servers) and not about what is on screen.
 */
export function raisesIsland(event: Upserted, screens: readonly OnScreen[], now = Date.now()): boolean {
  const n = event.notification;
  if (event.alert === false) return false;
  if (n.readAt || n.doneAt || isSnoozed(n, now)) return false;
  return !isOnScreen(n, screens);
}

/** The notification an event takes off the island: read, done or snoozed somewhere else, or gone. */
export function settledBy(event: NotificationEvent, now = Date.now()): string | null {
  if (event.type === "notification.removed") return event.id;
  if (event.type !== "notification.upserted") return null;
  const n = event.notification;
  return n.readAt || n.doneAt || isSnoozed(n, now) ? n.id : null;
}

/** Kinds whose `latest.title` says it better than its text (an approval's action, a routine's name). */
const TITLED = new Set(["approval", "mission_stopped", "routine_failed", "routine_paused"]);

/**
 * The line under a notice's headline: the message's snippet, an approval's action, the word for a GIF, a sticker
 * or a voice message (ADR 0091, 0100). The desktop app's banners say the same.
 */
export function noticeLine(
  n: Pick<AppNotification, "kind" | "latest">,
  mediaWord: (kind: MediaKind) => string,
): string {
  const media = mediaKindOf(n.latest.media);
  if (media === "voice") return mediaWord(media);
  const [first, second] = TITLED.has(n.kind) ? [n.latest.title, n.latest.text] : [n.latest.text, n.latest.title];
  return (first ?? second ?? "") || (media ? mediaWord(media) : "");
}

export interface IslandItem {
  n: AppNotification;
  /** Time left on screen; at zero it leaves, or, waiting on me, shrinks. */
  left: number;
  /** Shrunk to the small island: waiting on me, past its time or put away once. */
  small: boolean;
  /** Its arrival, counted: a new one (or the same one again, merged) makes the island pulse. */
  seq: number;
}

export interface IslandSnapshot {
  /** Newest first. */
  items: IslandItem[];
  /** The last arrival's `seq`. */
  seq: number;
}

/**
 * The island's list, shared by the web and the phone: arrivals, time running out, shrinking and leaving. The app
 * ticks it (`tick`) and pauses it while the person looks at it or types an answer (`pause`).
 */
export function createIsland({ life = ISLAND_LIFE_MS, max = ISLAND_MAX }: { life?: number; max?: number } = {}) {
  let items: IslandItem[] = [];
  let seq = 0;
  let snapshot: IslandSnapshot = { items, seq };
  const paused = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => {
    snapshot = { items, seq };
    for (const l of listeners) l();
  };
  const without = (id: string) => items.filter((i) => i.n.id !== id);
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A notification arrives, or the same one again (merged, updated): on top, with its time back. */
    arrive(n: AppNotification) {
      seq += 1;
      items = [{ n, left: life, small: false, seq }, ...without(n.id)];
      while (items.length > max) {
        let drop = -1;
        for (let i = items.length - 1; i >= 0; i--)
          if (!items[i]?.n.waiting) {
            drop = i;
            break;
          }
        items.splice(drop >= 0 ? drop : items.length - 1, 1);
      }
      emit();
    },
    /** Read, done or answered somewhere else (or here): it leaves. */
    settle(id: string) {
      if (!items.some((i) => i.n.id === id)) return;
      items = without(id);
      emit();
    },
    /** ×: what is waiting on me shrinks first (it still waits); anything else, or a second ×, leaves. */
    dismiss(id: string) {
      const item = items.find((i) => i.n.id === id);
      if (!item) return;
      items = item.n.waiting && !item.small ? items.map((i) => (i === item ? { ...i, small: true } : i)) : without(id);
      emit();
    },
    /** Swiped up (or Esc on the closed island): what isn't waiting leaves, what is shrinks. */
    putAway() {
      if (!items.length) return;
      items = items.filter((i) => i.n.waiting).map((i) => (i.small ? i : { ...i, small: true }));
      emit();
    },
    clear() {
      if (!items.length) return;
      items = [];
      emit();
    },
    /** Time stops while any reason holds: the pointer on it, open, an answer being typed, the app hidden. */
    pause(reason: string, on: boolean) {
      if (on) paused.add(reason);
      else paused.delete(reason);
    },
    /** `ms` went by: notices past their time leave or shrink (counting down alone draws nothing). */
    tick(ms: number) {
      if (paused.size > 0 || items.length === 0) return;
      let changed = false;
      const next: IslandItem[] = [];
      for (const i of items) {
        if (i.small) {
          next.push(i);
          continue;
        }
        i.left -= ms;
        if (i.left > 0) next.push(i);
        else {
          changed = true;
          if (i.n.waiting) next.push({ ...i, left: 0, small: true });
        }
      }
      if (!changed) return;
      items = next;
      emit();
    },
  };
}
export type Island = ReturnType<typeof createIsland>;

/**
 * What the closed island shows: the newest one still in its time (else the newest, small), whether it is the small
 * island (everything left is waiting and shrunk) and how many others there are.
 */
export function islandLead(items: readonly IslandItem[]): { lead: IslandItem | null; small: boolean; others: number } {
  const lead = items.find((i) => !i.small) ?? items[0] ?? null;
  return { lead, small: lead !== null && items.every((i) => i.small), others: Math.max(0, items.length - 1) };
}
