import { afterEach, describe, expect, test } from "bun:test";
import { createTestDatabase } from "@agenteschat/db/testing";
import type { PGlite } from "@electric-sql/pglite";
import {
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  createPostgresPubSub,
  isReservedSecretName,
  listenResumedTopic,
  PayloadTooLargeError,
  type PgNotifier,
  type PubSub,
  type RealtimeEvent,
} from "../src";

function pgliteNotifier(pg: PGlite): PgNotifier {
  return {
    async listen(channel, onPayload) {
      const unsub = await pg.listen(channel, onPayload);
      return async () => unsub();
    },
    async notify(channel, payload) {
      await pg.query("select pg_notify($1, $2)", [channel, payload]);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function contract(name: string, make: () => Promise<{ pubsub: PubSub; close: () => Promise<void> }>) {
  describe(`PubSub contract: ${name}`, () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
    });

    test("delivers to subscribers of the topic only", async () => {
      const ctx = await make();
      close = ctx.close;
      const a: RealtimeEvent[] = [];
      const b: RealtimeEvent[] = [];
      ctx.pubsub.subscribe("channel:a", (e) => a.push(e));
      ctx.pubsub.subscribe("channel:b", (e) => b.push(e));
      await ctx.pubsub.publish("channel:a", { type: "x", n: 1 });
      await tick();
      expect(a).toEqual([{ type: "x", n: 1 }]);
      expect(b).toEqual([]);
    });

    test("unsubscribe stops delivery; a throwing handler doesn't break others", async () => {
      const ctx = await make();
      close = ctx.close;
      const got: RealtimeEvent[] = [];
      ctx.pubsub.subscribe("t", () => {
        throw new Error("boom");
      });
      const off = ctx.pubsub.subscribe("t", (e) => got.push(e));
      await ctx.pubsub.publish("t", { type: "one" });
      await tick();
      off();
      await ctx.pubsub.publish("t", { type: "two" });
      await tick();
      expect(got.map((e) => e.type)).toEqual(["one"]);
    });
  });
}

contract("memory", async () => ({ pubsub: createMemoryPubSub(), close: async () => {} }));
contract("postgres LISTEN/NOTIFY (PGlite)", async () => {
  const ctx = await createTestDatabase();
  if (!ctx.pglite) throw new Error("needs PGlite");
  const pubsub = await createPostgresPubSub(pgliteNotifier(ctx.pglite));
  return {
    pubsub,
    close: async () => {
      await pubsub.close?.();
      await ctx.close();
    },
  };
});

test("postgres pub/sub rejects payloads over the NOTIFY limit", async () => {
  const pubsub = await createPostgresPubSub({ listen: async () => async () => {}, notify: async () => {} });
  await expect(pubsub.publish("t", { type: "big", text: "x".repeat(9000) })).rejects.toBeInstanceOf(
    PayloadTooLargeError,
  );
});

test("memory presence tracks connections per user", async () => {
  const p = createMemoryPresence();
  await p.connect("o", "u1", "c1");
  await p.connect("o", "u1", "c2");
  await p.connect("o", "u2", "c3");
  await p.disconnect("o", "u1", "c1");
  expect(await p.online("o")).toEqual(["u1", "u2"]);
  await p.disconnect("o", "u1", "c2");
  expect(await p.online("o")).toEqual(["u2"]);
  expect(await p.online("other")).toEqual([]);
});

test("memory rate limiter uses fixed windows", async () => {
  let t = 0;
  const rl = createMemoryRateLimiter(() => t);
  const rule = { limit: 2, windowMs: 1000 };
  expect((await rl.consume("k", rule)).allowed).toBe(true);
  expect((await rl.consume("k", rule)).allowed).toBe(true);
  expect((await rl.consume("k", rule)).allowed).toBe(false);
  expect((await rl.consume("other", rule)).allowed).toBe(true);
  t = 1000;
  expect((await rl.consume("k", rule)).remaining).toBe(1);
});

test("postgres pub/sub: publish doesn't wait for the database; a tick's events go out in one statement, in order", async () => {
  const { createPostgresPubSub } = await import("../src");
  let listener: ((p: string) => void) | null = null;
  const statements: string[][] = [];
  const pubsub = await createPostgresPubSub({
    listen: async (_c, on) => {
      listener = on;
      return async () => {};
    },
    notify: async (_c, p) => {
      statements.push([p]);
      listener?.(p);
    },
    notifyMany: async (_c, ps) => {
      statements.push(ps);
      for (const p of ps) listener?.(p);
    },
  });
  const got: unknown[] = [];
  pubsub.subscribe("t", (e) => got.push(e.n));
  for (const n of [1, 2, 3]) await pubsub.publish("t", { type: "x", n });
  expect(statements).toEqual([]); // nothing sent yet: publishing never waited
  await pubsub.close?.();
  expect(statements).toHaveLength(1);
  expect(got).toEqual([1, 2, 3]);
});

/**
 * A Postgres whose LISTEN can go deaf: NOTIFY still works, its payloads stop arriving (the LISTEN's connection died and
 * postgres.js gave up on it). Each listen counts; `back()` is postgres.js listening again once its connection came
 * back, with the same handlers.
 */
function deafeningNotifier() {
  const listeners: { on: (p: string) => void; onListen?: () => void }[] = [];
  const state = { deaf: false, listens: 0 };
  const notifier: PgNotifier = {
    listen: async (_c, on, onListen) => {
      state.listens++;
      state.deaf = false;
      const entry = { on, onListen };
      listeners.push(entry);
      onListen?.();
      return async () => {
        listeners.splice(listeners.indexOf(entry), 1);
      };
    },
    notify: async (_c, p) => {
      if (!state.deaf) for (const l of [...listeners]) l.on(p);
    },
  };
  const back = () => {
    state.deaf = false;
    for (const l of listeners) l.onListen?.();
  };
  return { notifier, state, back, listeners };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("postgres pub/sub: a LISTEN gone deaf is made again, and once it hears its subscribers learn events were missed", async () => {
  const { notifier, state } = deafeningNotifier();
  const pubsub = await createPostgresPubSub(notifier, { heartbeatMs: 10 });
  const resumed: RealtimeEvent[] = [];
  const got: unknown[] = [];
  pubsub.subscribe(listenResumedTopic, (e) => resumed.push(e));
  pubsub.subscribe("t", (e) => got.push(e.n));
  await new Promise((r) => setTimeout(r, 40));
  // Heard all along: nothing is made again, nothing said.
  expect(state.listens).toBe(1);
  expect(resumed).toEqual([]);
  state.deaf = true;
  await until(() => state.listens === 2);
  expect(state.listens).toBe(2);
  await until(() => resumed.length > 0);
  expect(resumed).toEqual([{ type: "pubsub.resumed" }]);
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => got.length > 0);
  expect(got).toEqual([1]);
  await pubsub.close?.();
});

test("postgres pub/sub: postgres.js listening again after its connection came back says so once, with no event twice", async () => {
  const { notifier, back } = deafeningNotifier();
  const pubsub = await createPostgresPubSub(notifier, { heartbeatMs: 1000 });
  const resumed: RealtimeEvent[] = [];
  const got: unknown[] = [];
  pubsub.subscribe(listenResumedTopic, (e) => resumed.push(e));
  pubsub.subscribe("t", (e) => got.push(e.n));
  back();
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => got.length > 0);
  expect(got).toEqual([1]);
  expect(resumed).toEqual([{ type: "pubsub.resumed" }]);
  await pubsub.close?.();
});

test("postgres pub/sub: a LISTEN made again leaves the one it replaced silent, should its driver bring it back", async () => {
  const { notifier, state, listeners } = deafeningNotifier();
  const pubsub = await createPostgresPubSub(notifier, { heartbeatMs: 10 });
  const got: unknown[] = [];
  pubsub.subscribe("t", (e) => got.push(e.n));
  // The first one stays registered, as a driver that made it again would keep it.
  const first = listeners[0];
  state.deaf = true;
  await until(() => state.listens === 2);
  if (first && !listeners.includes(first)) listeners.unshift(first);
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => got.length > 0);
  await new Promise((r) => setTimeout(r, 20));
  expect(got).toEqual([1]);
  await pubsub.close?.();
});

test("secret names that would steer an AI CLI's sign-in or requests are reserved", () => {
  for (const name of ["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "CODEX_HOME", "OPENCODE_API_KEY"])
    expect(isReservedSecretName(name)).toBe(true);
  for (const name of [
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
  ])
    expect(isReservedSecretName(name)).toBe(true);
  // The Antigravity CLI's (ADR 0143): its keys, endpoint and switches. Google Cloud's sign-ins stay usable by agents
  // on other CLIs (the Antigravity CLI never gets them).
  for (const name of ["GEMINI_API_KEY", "AGY_ADC_AUTH", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"])
    expect(isReservedSecretName(name)).toBe(true);
  expect(isReservedSecretName("GOOGLE_GENAI_USE_VERTEXAI")).toBe(true);
  for (const name of ["GITHUB_TOKEN", "NPM_TOKEN", "STRIPE_PASSWORD", "PROXY_HOST", "MY_CLAUDE", "GOOGLE_MAPS_KEY"])
    expect(isReservedSecretName(name)).toBe(false);
  for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"])
    expect(isReservedSecretName(name)).toBe(false);
});
