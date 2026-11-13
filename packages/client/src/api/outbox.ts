import { hashKey, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { upsertMessage } from "../lib/timeline";
import type { ConnectionStatus } from "../realtime/connection";
import { keys } from "./keys";
import type { Message } from "./types";

interface Waiting {
  orgId: string;
  message: Message;
}

/** Where the outbox is kept between loads: the tab's session storage on the web, a file on the phone. Never throws. */
export interface OutboxStorage {
  read(): string | null;
  write(value: string): void;
}

let waiting: readonly Waiting[] = [];
let storage: OutboxStorage | null = null;
const listeners = new Set<() => void>();

function set(next: readonly Waiting[]) {
  waiting = next;
  storage?.write(JSON.stringify(next));
  for (const l of listeners) l();
}

const ME_HASH = hashKey(keys.me);

/**
 * My messages that wait for the connection (`sendWaits`): "sai quando a conexão voltar" instead of "Não enviada".
 * One outbox for the whole app, each message its local copy as it was sent, so they go out again from whatever
 * screen is open (`flushOutbox`), with the same `clientId`, which the server writes once.
 */
export const outbox = {
  /** My message (its local copy) waits, in `orgId`. */
  add(orgId: string, message: Message) {
    if (!message.clientId || outbox.has(message.clientId)) return;
    set([...waiting, { orgId, message: { ...message, local: "failed" } }]);
  },
  remove(clientId: string) {
    if (outbox.has(clientId)) set(waiting.filter((w) => w.message.clientId !== clientId));
  },
  has: (clientId: string | null | undefined) =>
    Boolean(clientId) && waiting.some((w) => w.message.clientId === clientId),
  /** What waits in an organization, in the order it was sent. */
  of: (orgId: string) => waiting.flatMap((w) => (w.orgId === orgId ? [w.message] : [])),
  get size() {
    return waiting.length;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /**
   * Keeps the outbox in `store` from now on, with what waited there before (a reload, the app's restart). Mine
   * alone: it empties when the signed-in person leaves `qc` (sign-out, another sign-in, a 401). Returns the stop.
   */
  keep(qc: QueryClient, store: OutboxStorage) {
    let saved: unknown;
    try {
      saved = JSON.parse(store.read() ?? "[]");
    } catch {
      saved = [];
    }
    // Only what `flushOutbox` can send: one it can't read would stop every message behind it, and a file saved by
    // another version of the app may hold anything.
    const kept = (Array.isArray(saved) ? (saved as Partial<Waiting>[]) : []).filter(
      (w): w is Waiting =>
        typeof w?.orgId === "string" &&
        typeof w.message?.clientId === "string" &&
        typeof w.message.channelId === "string" &&
        typeof w.message.body === "string" &&
        typeof w.message.author?.id === "string" &&
        !outbox.has(w.message.clientId),
    );
    storage = store;
    set([...waiting, ...kept]);
    const off = qc.getQueryCache().subscribe((event) => {
      if (event.type === "removed" && event.query.queryHash === ME_HASH) set([]);
    });
    return () => {
      off();
      if (storage === store) storage = null;
    };
  },
  /** Puts what waits back in its conversation's list when that list is there (restored from the device's snapshot). */
  show(qc: QueryClient) {
    for (const { orgId, message } of waiting) {
      qc.setQueryData<Message[]>(
        keys.messages(orgId, message.channelId),
        (list) => list && upsertMessage(list, message),
      );
    }
  },
};

/** This message (its `clientId`) waits for the connection. */
export function useWaiting(clientId: string | null | undefined) {
  return useSyncExternalStore(
    outbox.subscribe,
    () => outbox.has(clientId),
    () => false,
  );
}

/** Between tries while the connection stays open and only the proxy in front of the server answers. */
export const OUTBOX_RETRY_MS = 10_000;

/**
 * Runs `send` (true while something still waits) each time the connection opens, and again every `every` ms while
 * it stays open and something waits: the server may answer only through its proxy for a while without the socket
 * dropping (stuck, or restarting behind a proxy that holds the socket). Returns the stop.
 */
export function keepSending(
  connection: { readonly status: ConnectionStatus; onStatus(listener: (status: ConnectionStatus) => void): () => void },
  send: () => Promise<boolean>,
  every = OUTBOX_RETRY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const later = () => {
    if (timer === null && !stopped && connection.status === "open" && outbox.size > 0) timer = setTimeout(run, every);
  };
  function run() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped || connection.status !== "open") return;
    void send().then((waits) => {
      if (waits) later();
    });
  }
  const offStatus = connection.onStatus((status) => {
    if (status === "open") run();
  });
  // A send that failed again with the socket still open: another try in a while.
  const offOutbox = outbox.subscribe(later);
  run();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    offStatus();
    offOutbox();
  };
}
