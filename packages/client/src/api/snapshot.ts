import { type DehydratedState, dehydrate, hashKey, hydrate, type Query, type QueryClient } from "@tanstack/react-query";
import { MISSIONS_WAITING_COUNT } from "./missions";
import type { Me, Message } from "./types";

/**
 * A snapshot of the conversations on this device: opening the app shows the
 * last lists and recent chats at once, then every query revalidates as usual
 * (the server stays the source of truth). Each app brings its own storage
 * (IndexedDB on the web, a file on the phone).
 *
 * Only an allow-list is kept: the signed-in person, the conversation lists,
 * agents and people, the sidebar's tools and counts, and the latest messages
 * of the most recent chats. It belongs to one person: dropped when `me` leaves
 * the cache (`qc.clear()` on sign-out, sign-in or a 401) or comes back as
 * someone else.
 */
export interface SnapshotStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

/** Bump when a cached shape changes: older snapshots are ignored. */
export const SNAPSHOT_VERSION = 1;
/** Conversations kept, most recently updated first. */
export const SNAPSHOT_CHATS = 10;
/** Messages kept per conversation (the newest). */
export const SNAPSHOT_MESSAGES = 50;
/** Older snapshots are ignored (the app loads from the server). */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 2_000;

interface Snapshot {
  v: number;
  savedAt: number;
  owner: string;
  state: DehydratedState;
}

/**
 * `["org", orgId, <list>]`: the lists the shell and the chat need right away. Where I put the sidebar's tools too, and
 * the overview with its count of the approvals waiting for me, so no tool moves in once the server answers; and how I
 * look at Tarefas, so the board doesn't open as the default and then turn into my list.
 */
const ORG_LISTS = new Set([
  "channels",
  "channel-categories",
  "dms",
  "agents",
  "members",
  "team",
  "detail",
  "sidebar-items",
  "overview",
  "issues-view",
]);
/** `["org", orgId, "channel", channelId, <part>]`: kept for the chats in the snapshot. */
const CHAT_PARTS = new Set(["messages", "roster", "members"]);
const ME_HASH = hashKey(["me"]);

const isMe = (key: readonly unknown[]) => key.length === 1 && key[0] === "me";
const chatPart = (key: readonly unknown[]) =>
  key.length === 5 && key[0] === "org" && key[2] === "channel" && CHAT_PARTS.has(key[4] as string)
    ? { chat: `${key[1]}/${key[3]}`, part: key[4] as string }
    : null;
const isOrgList = (key: readonly unknown[]) => key.length === 3 && key[0] === "org" && ORG_LISTS.has(key[2] as string);
/** `["org", orgId, "missions", "list", <query>]`: only the sidebar's count of the missions waiting for me. */
const WAITING_COUNT = JSON.stringify(MISSIONS_WAITING_COUNT);
const isWaitingCount = (key: readonly unknown[]) =>
  key.length === 5 && key[0] === "org" && key[2] === "missions" && key[3] === "list" && key[4] === WAITING_COUNT;
/** Always kept (a chat's parts only for the most recent chats). */
const isKept = (key: readonly unknown[]) => isMe(key) || isOrgList(key) || isWaitingCount(key);

/** The queries worth keeping: the allow-list, loaded, and only the chats most recently updated. */
export function pickSnapshotQueries(queries: Query[], chats = SNAPSHOT_CHATS): Query[] {
  const loaded = queries.filter((q) => q.state.status === "success" && q.state.data != null);
  const recent = loaded
    .filter((q) => chatPart(q.queryKey)?.part === "messages")
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, chats)
    .map((q) => chatPart(q.queryKey)?.chat);
  const kept = new Set(recent);
  return loaded.filter((q) => {
    if (isKept(q.queryKey)) return true;
    const c = chatPart(q.queryKey);
    return c !== null && kept.has(c.chat);
  });
}

/** A conversation's newest messages, without the ones still sending or that failed (they live in memory only). */
export const trimMessages = (list: Message[], max = SNAPSHOT_MESSAGES): Message[] =>
  list.filter((m) => !m.local).slice(-max);

export function createSnapshot(qc: QueryClient, storage: SnapshotStorage) {
  let owner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const currentOwner = () => qc.getQueryData<Me | null>(["me"])?.user.id ?? null;

  const save = async () => {
    timer = null;
    const who = currentOwner();
    if (!who) return;
    owner = who;
    const picked = new Set(pickSnapshotQueries(qc.getQueryCache().getAll()).map((q) => q.queryHash));
    const state = dehydrate(qc, { shouldDehydrateQuery: (q) => picked.has(q.queryHash) });
    for (const q of state.queries) {
      if (chatPart(q.queryKey)?.part === "messages" && Array.isArray(q.state.data)) {
        q.state = { ...q.state, data: trimMessages(q.state.data as Message[]) };
      }
    }
    const snapshot: Snapshot = { v: SNAPSHOT_VERSION, savedAt: Date.now(), owner: who, state };
    await storage.write(JSON.stringify(snapshot)).catch(() => {});
  };

  const wipe = async () => {
    owner = null;
    if (timer) clearTimeout(timer);
    timer = null;
    await storage.remove().catch(() => {});
  };

  return {
    /** Puts the saved snapshot in the cache; false when there was none (or it was too old, or another version). */
    async restore(): Promise<boolean> {
      const raw = await storage.read().catch(() => null);
      if (!raw) return false;
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(raw) as Snapshot;
      } catch {
        await wipe();
        return false;
      }
      if (snapshot.v !== SNAPSHOT_VERSION || Date.now() - snapshot.savedAt > SNAPSHOT_MAX_AGE_MS) {
        await wipe();
        return false;
      }
      owner = snapshot.owner;
      hydrate(qc, snapshot.state);
      return true;
    },

    /** Saves after changes (a couple of seconds after the last one) and drops the snapshot with its owner. Returns the stop. */
    start(): () => void {
      return qc.getQueryCache().subscribe((event) => {
        const q = event.query;
        if (q.queryHash === ME_HASH) {
          if (event.type === "removed") return void wipe();
          const who = currentOwner();
          if (event.type === "updated" && q.state.status === "success" && owner !== null && who !== owner) {
            // Signed out, or someone else on this device: nothing of the previous person stays.
            void wipe();
            if (who) void qc.resetQueries({ queryKey: ["org"] });
          }
        }
        if (event.type !== "updated" && event.type !== "added") return;
        if (!isKept(q.queryKey) && !chatPart(q.queryKey)) return;
        if (!timer) timer = setTimeout(() => void save(), SAVE_DELAY_MS);
      });
    },

    /** Saves now (the page is being hidden or the app goes to the background). */
    flush: () => {
      if (timer) clearTimeout(timer);
      return save();
    },

    wipe,
  };
}

export type SnapshotController = ReturnType<typeof createSnapshot>;
