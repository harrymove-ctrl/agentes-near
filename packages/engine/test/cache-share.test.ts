import { afterEach, expect, test } from "bun:test";
import { createMemoryPubSub, listenResumedTopic } from "@agenteschat/adapters";
import { CACHE_TOPIC, caches, enableCaches, shareCacheInvalidations } from "../src";

afterEach(() => enableCaches(false));

test("an invalidation reaches every process: published where the write was, applied elsewhere without an echo", async () => {
  enableCaches();
  const pubsub = createMemoryPubSub();
  const seen: unknown[] = [];
  pubsub.subscribe(CACHE_TOPIC, (event) => void seen.push(event));
  const stop = shareCacheInvalidations(pubsub);
  try {
    caches.scopes.set("org1:agent1:visible", ["deploy"]);
    caches.scopes.deletePrefix("org1:agent1:");
    expect(caches.scopes.get("org1:agent1:visible")).toBeUndefined();
    expect(seen).toEqual([{ type: "cache.invalidate", cache: "scopes", op: "deletePrefix", key: "org1:agent1:" }]);

    // Another process removed a member: its invalidation clears the entry here, and this process tells nobody again.
    caches.channelMembers.set("org1:channel1", ["person1"]);
    await pubsub.publish(CACHE_TOPIC, {
      type: "cache.invalidate",
      cache: "channelMembers",
      op: "delete",
      key: "org1:channel1",
    });
    expect(caches.channelMembers.get("org1:channel1")).toBeUndefined();
    expect(seen).toHaveLength(2);

    // Nothing to apply for a cache it doesn't have, or an operation it doesn't know.
    caches.credentials.set("org1:key1", { id: "key1" });
    await pubsub.publish(CACHE_TOPIC, { type: "cache.invalidate", cache: "nope", op: "clear", key: "" });
    await pubsub.publish(CACHE_TOPIC, { type: "cache.invalidate", cache: "credentials", op: "drop", key: "org1:" });
    expect(caches.credentials.get("org1:key1")).toEqual({ id: "key1" });
  } finally {
    stop();
  }
  // Stopped: invalidations stay here.
  caches.agents.delete("org1:agent1");
  expect(seen).toHaveLength(4);
});

test("a process whose LISTEN came back after a gap forgets what it cached: invalidations sent meanwhile never reached it", async () => {
  enableCaches();
  const pubsub = createMemoryPubSub();
  const stop = shareCacheInvalidations(pubsub);
  try {
    caches.scopes.set("org1:agent1:visible", ["deploy"]);
    await pubsub.publish(listenResumedTopic, { type: "pubsub.resumed" });
    expect(caches.scopes.get("org1:agent1:visible")).toBeUndefined();
  } finally {
    stop();
  }
});
