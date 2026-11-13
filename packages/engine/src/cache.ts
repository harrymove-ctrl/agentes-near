import { listenResumedTopic, type PubSub } from "@agenteschat/adapters";

/**
 * Per-process caches for data read on every run but rarely changed (agent
 * config, org settings, channel rows and members, scopes, connections,
 * credential rows). A write invalidates at once in this process and, through
 * `shareCacheInvalidations`, in every other one on the database (the app and
 * its workers); the short TTL covers an invalidation lost on the way.
 * Decrypted secrets are never cached, only database rows.
 */
let enabled = false;

/**
 * Caching is off unless the server turns it on (`enableCaches()`): tests write
 * the database directly and expect every read to see it.
 */
export function enableCaches(on = true) {
  enabled = on;
  if (!on) clearCaches();
}

export const cachesEnabled = () => enabled;

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 5000,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V) {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  /** Told of each invalidation made in this process (`shareCacheInvalidations`). */
  onInvalidate?: (op: CacheOp, key: string) => void;

  delete(key: string) {
    this.apply("delete", key);
    this.onInvalidate?.("delete", key);
  }

  /** Drops every key starting with `prefix` (e.g. everything of one org). */
  deletePrefix(prefix: string) {
    this.apply("deletePrefix", prefix);
    this.onInvalidate?.("deletePrefix", prefix);
  }

  clear() {
    this.apply("clear", "");
    this.onInvalidate?.("clear", "");
  }

  /** An invalidation, here only: another process's, which it already told everyone. */
  apply(op: CacheOp, key: string) {
    if (op === "clear") this.entries.clear();
    else if (op === "delete") this.entries.delete(key);
    else for (const k of this.entries.keys()) if (k.startsWith(key)) this.entries.delete(k);
  }

  /** Returns the cached value or loads, caches and returns it (`undefined`/null results are cached too). */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    if (!enabled) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expires >= Date.now()) return hit.value;
    const value = await load();
    this.set(key, value);
    return value;
  }
}

const TTL_MS = 30_000;

/** The engine's caches, keyed `orgId:id`. Invalidated by the functions that write them. */
export const caches = {
  agents: new TtlCache<unknown>(TTL_MS),
  orgs: new TtlCache<unknown>(TTL_MS),
  channels: new TtlCache<unknown>(TTL_MS),
  channelMembers: new TtlCache<unknown>(TTL_MS),
  scopes: new TtlCache<unknown>(TTL_MS),
  connections: new TtlCache<unknown>(TTL_MS),
  credentials: new TtlCache<unknown>(TTL_MS),
  /** Whether an org has any active context item (skips memory retrieval for empty orgs). */
  contextPresence: new TtlCache<unknown>(TTL_MS),
  /** Whether a thread's context range from another channel is still visible to everyone in the thread. */
  rangeVisible: new TtlCache<unknown>(TTL_MS),
  /** A person's time zone in an org, else the org's (`orgId:userId`): the "Now" block of every run. */
  zones: new TtlCache<unknown>(TTL_MS),
  /** An org's standing (`standing.ts`), read before every model and computer call: a hold bites within 5 s everywhere. */
  standing: new TtlCache<unknown>(5_000),
  /** Whether an org spent its platform AI for the month (`limits.ts`), read before every Jev call and route. */
  platformSpend: new TtlCache<unknown>(60_000),
  /**
   * What a message's chain roots in (`messageRoot`). Its links never change, so it is kept a day: a wake after a wait
   * (a follow-up, CI, an approval) walks only its newest links, never the whole chain again (2 queries a link).
   */
  messageRoots: new TtlCache<unknown>(24 * 3600_000, 20_000),
  /** Runs that read outside content (`runReadOutside`): only `true` is kept, since it never turns false. */
  readOutsideRuns: new TtlCache<true>(3600_000, 20_000),
  /** The workspace's devices by name (`deviceRoster`): a run's prompt and its tool lists read it once. */
  deviceRoster: new TtlCache<unknown>(5_000),
};

/** `caches.contextPresence`'s key for whether an agent holds a rule people gave (`rulesForRun`). */
export const rulesPresenceKey = (orgId: string, agentId: string) => `${orgId}:rules:${agentId}`;

/** Forgets everything about an org (used after broad changes and in tests). */
export function invalidateOrg(orgId: string) {
  for (const c of Object.values(caches)) c.deletePrefix(`${orgId}:`);
}

export function clearCaches() {
  for (const c of Object.values(caches)) c.clear();
}

export type CacheOp = "delete" | "deletePrefix" | "clear";

/** Pub/sub topic that carries every process's cache invalidations to the others (Postgres LISTEN/NOTIFY). */
export const CACHE_TOPIC = "system:cache-invalidate";

/**
 * Every process forgets what any process changed (ADR 0163): an invalidation of `caches` made here is published,
 * and one received is applied here without being published again. Without it, a worker would go on reading a revoked
 * scope, a removed member or a changed credential until its entry's TTL ran out. A process whose LISTEN came back after
 * a gap (`listenResumedTopic`) missed the invalidations sent meanwhile: it forgets everything. Returns the way to stop.
 */
export function shareCacheInvalidations(pubsub: Pick<PubSub, "publish" | "subscribe">) {
  const named: Record<string, TtlCache<unknown>> = caches;
  for (const [cache, c] of Object.entries(named))
    c.onInvalidate = (op, key) =>
      void pubsub.publish(CACHE_TOPIC, { type: "cache.invalidate", cache, op, key }).catch(() => {});
  const off = pubsub.subscribe(CACHE_TOPIC, (event) => {
    const target = typeof event.cache === "string" ? named[event.cache] : undefined;
    const op = event.op;
    if (target && typeof event.key === "string" && (op === "delete" || op === "deletePrefix" || op === "clear"))
      target.apply(op, event.key);
  });
  const offResumed = pubsub.subscribe(listenResumedTopic, () => {
    for (const c of Object.values(named)) c.apply("clear", "");
  });
  return () => {
    off();
    offResumed();
    for (const c of Object.values(named)) c.onInvalidate = undefined;
  };
}
