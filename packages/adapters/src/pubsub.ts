/**
 * Real-time fan-out between server instances (docs/adr/0010-realtime.md).
 * Core: in-memory (one process) or Postgres LISTEN/NOTIFY (several replicas).
 * Cloud may register Redis pub/sub. Postgres stays the source of truth: only
 * already-committed facts and ephemeral stream deltas travel here.
 */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type Unsubscribe = () => void;

export interface PubSub {
  publish(topic: string, event: RealtimeEvent): Promise<void>;
  /** Handlers run for events published by any instance, including this one. */
  subscribe(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe;
  close?(): Promise<void>;
}

/**
 * For a transaction: `pubsub` keeps what its steps publish, and `flush` sends it after the commit, each event once.
 * An app told earlier would read the rows before they exist, and one told of a rollback would read rows that never do.
 */
export function holdEvents<T extends PubSub | undefined>(target: T) {
  const held = new Map<string, [string, RealtimeEvent]>();
  const holding: PubSub | undefined = target && {
    publish: async (topic, event) => void held.set(`${topic} ${JSON.stringify(event)}`, [topic, event]),
    subscribe: (topic, handler) => target.subscribe(topic, handler),
  };
  const pubsub = holding as T;
  const flush = async () => {
    for (const [topic, event] of held.values()) await target?.publish(topic, event).catch(() => {});
    held.clear();
  };
  return { pubsub, flush };
}

/** Topic of everything happening in one channel. */
export const channelTopic = (channelId: string) => `channel:${channelId}`;

/** Server-side: every `user.typing`, also published on its channel's topic (an agent's quiet window, ADR 0112). */
export const typingTopic = "typing";

/** Server-side organization events (membership changes). Never forwarded to clients as is. */
export const orgTopic = (orgId: string) => `org:${orgId}`;

/** Events for one person in one organization (approvals waiting for them, DMs). */
export const userTopic = (orgId: string, userId: string) => `user:${orgId}:${userId}`;

/** Server-side: each new message's channel, for the unread marks of its members' sockets. Never forwarded as is. */
export const chatActivityTopic = "chat-activity";

/** Server-side signal that one upload to the Drive finished (`upload_file`, ADR 0025). Never forwarded to clients. */
export const uploadTopic = (uploadId: string) => `upload:${uploadId}`;

/** Server-side: a request (`machine_rpc` row) for a machine whose socket this replica holds (ADR 0025). */
export const machineRpcTopic = (replicaId: string) => `machine-rpc:${replicaId}`;

/** Server-side: the reply to one `machine_rpc` row is written. */
export const machineRpcReplyTopic = (rpcId: string) => `machine-rpc-reply:${rpcId}`;

/** Server-side: the `brain.event` frames of one run's brain turn on a connected computer (ADR 0032). */
export const brainTopic = (runId: string) => `brain:${runId}`;

function deliver(handlers: Set<(event: RealtimeEvent) => void> | undefined, event: RealtimeEvent) {
  for (const handler of handlers ?? []) {
    try {
      handler(event);
    } catch {
      // One broken subscriber must not stop the others.
    }
  }
}

class Registry {
  readonly topics = new Map<string, Set<(event: RealtimeEvent) => void>>();
  add(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.topics.delete(topic);
    };
  }
}

/** Single-process pub/sub. Default for tests and single-instance self-host. */
export function createMemoryPubSub(): PubSub {
  const registry = new Registry();
  return {
    async publish(topic, event) {
      deliver(registry.topics.get(topic), structuredClone(event));
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
  };
}

/** Minimal LISTEN/NOTIFY surface, implemented by postgres.js (prod) and PGlite (tests). */
export interface PgNotifier {
  /** `onListen`: each time the LISTEN is in place (postgres.js: at first, and whenever its connection came back). */
  listen(channel: string, onPayload: (payload: string) => void, onListen?: () => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
  /** Several notifications in one statement (one round trip), in order. Optional. */
  notifyMany?(channel: string, payloads: string[]): Promise<void>;
}

/**
 * Local to each replica, never sent to Postgres: its LISTEN is back after a gap. What was published meanwhile never
 * reached it, so the apps on its sockets must read again.
 */
export const listenResumedTopic = "pubsub.resumed";

/** How often a replica checks that its LISTEN still hears: its own heartbeat must come back on it. */
export const LISTEN_HEARTBEAT_MS = 30_000;

/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7900;

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`pub/sub payload is ${bytes} bytes; the limit is ${MAX_NOTIFY_BYTES}. Publish ids, not documents.`);
    this.name = "PayloadTooLargeError";
  }
}

const PG_CHANNEL = "agenteschat_events";

/**
 * Pub/sub over Postgres LISTEN/NOTIFY: one NOTIFY channel, topic inside the
 * payload. Works across replicas with no extra infrastructure. Payloads must
 * stay small (ids and short deltas), see `MAX_NOTIFY_BYTES`.
 */
export async function createPostgresPubSub(
  notifier: PgNotifier,
  { heartbeatMs = LISTEN_HEARTBEAT_MS }: { heartbeatMs?: number } = {},
): Promise<PubSub> {
  const registry = new Registry();
  let heardAt = 0;
  let started = false;
  /** Events were missed: the next payload heard proves the LISTEN back, and the subscribers hear so then. */
  let gap = false;
  // Only the newest LISTEN made here delivers: postgres.js makes an older one again with its connection, and two
  // would deliver every event twice.
  let generation = 0;
  const listen = () => {
    const mine = ++generation;
    return notifier.listen(
      PG_CHANNEL,
      (payload) => {
        if (mine !== generation) return;
        heardAt = Date.now();
        try {
          const { t, e } = JSON.parse(payload) as { t: string; e: RealtimeEvent };
          deliver(registry.topics.get(t), e);
        } catch {
          // Ignore malformed payloads from other software on the same channel.
        }
        if (!gap) return;
        gap = false;
        deliver(registry.topics.get(listenResumedTopic), { type: "pubsub.resumed" });
      },
      () => {
        if (started && mine === generation) gap = true;
      },
    );
  };
  let unlisten = await listen();
  started = true;
  // postgres.js listens again by itself when its connection comes back, but gives up when that fails at once
  // (Postgres restarting): the replica would then hear nothing until it restarted, its sockets open and silent. Its
  // heartbeat must come back on the LISTEN, or it listens again. One that couldn't go out proves nothing.
  const heartbeat = JSON.stringify({ t: "pubsub.heartbeat", e: { type: "heartbeat" } });
  let sentAt: number | null = null;
  let relistening = false;
  const beat = setInterval(() => {
    if (relistening) return;
    if (sentAt !== null && heardAt < sentAt) {
      // A heartbeat sent now would go before the new LISTEN is in place, never to be heard: the next tick sends it.
      sentAt = null;
      gap = true;
      relistening = true;
      void unlisten()
        .catch(() => {})
        .then(listen)
        .then((off) => {
          unlisten = off;
        })
        .catch(() => {})
        .finally(() => {
          relistening = false;
        });
      return;
    }
    sentAt = null;
    const at = Date.now();
    notifier.notify(PG_CHANNEL, heartbeat).then(
      () => {
        sentAt = at;
      },
      () => {},
    );
  }, heartbeatMs);
  (beat as { unref?: () => void }).unref?.();
  // Publishing doesn't wait for the database: events queue in order and go out
  // together in one statement per tick (a remote database costs one round trip
  // per batch, not per event). Delivery stays best effort, as before.
  let queue: string[] = [];
  let flushing: Promise<void> = Promise.resolve();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    flushing = flushing
      .then(async () => {
        if (notifier.notifyMany && batch.length > 1) await notifier.notifyMany(PG_CHANNEL, batch);
        else for (const payload of batch) await notifier.notify(PG_CHANNEL, payload);
      })
      .catch(() => {});
  };
  return {
    async publish(topic, event) {
      const payload = JSON.stringify({ t: topic, e: event });
      const bytes = Buffer.byteLength(payload);
      if (bytes > MAX_NOTIFY_BYTES) throw new PayloadTooLargeError(bytes);
      queue.push(payload);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0); // after awaited publishes of this tick have queued too
      }
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
    close: async () => {
      clearInterval(beat);
      flush();
      await flushing;
      await unlisten();
    },
  };
}

/** Adapts a postgres.js client (`createDatabase().client`). */
export function postgresJsNotifier(client: {
  listen(channel: string, fn: (payload: string) => void, onlisten?: () => void): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
  unsafe?(query: string, params: string[]): Promise<unknown>;
}): PgNotifier {
  return {
    async listen(channel, onPayload, onListen) {
      const sub = await client.listen(channel, onPayload, onListen);
      return () => sub.unlisten();
    },
    async notify(channel, payload) {
      await client.notify(channel, payload);
    },
    async notifyMany(channel, payloads) {
      if (!client.unsafe) {
        for (const p of payloads) await client.notify(channel, p);
        return;
      }
      const calls = payloads.map((_, i) => `pg_notify($1, $${i + 2})`).join(", ");
      await client.unsafe(`select ${calls}`, [channel, ...payloads]);
    },
  };
}
