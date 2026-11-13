import { expect, test } from "bun:test";
import {
  type Adapters,
  createLogEmailSender,
  createMemoryBlobStore,
  createMemoryPresence,
  createMemoryPubSub,
  createMemoryRateLimiter,
  noPlatformCredentials,
} from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { createFakeProvider } from "@agenteschat/providers/testing";
import { type AgentesModule, resolveAdapters } from "../src";

const defaults: Adapters = {
  search: {
    forOrg: async () => ({
      backend: "postgres",
      upsert: async () => {},
      delete: async () => {},
      query: async () => [],
    }),
  },
  pubsub: createMemoryPubSub(),
  presence: createMemoryPresence(),
  rateLimiter: createMemoryRateLimiter(),
  keyWrapper: { id: "local:v1", wrap: async () => "", unwrap: async () => new Uint8Array() },
  legacyKeyWrappers: [],
  platformCredentials: noPlatformCredentials,
  email: createLogEmailSender(() => {}),
  platformBlobs: createMemoryBlobStore(),
};
const ctx = { config: testConfig(), db: {} as Database, edition: "cloud" as const, version: "test" };

test("modules override adapters in order; later modules win", async () => {
  const redis = createMemoryPubSub();
  const platform = { resolve: async () => ({ apiKey: "platform" }) };
  const fake = createFakeProvider();
  const aPubSub = createMemoryPubSub();
  let seenByB: unknown;
  const modules: AgentesModule[] = [
    { name: "a", adapters: () => ({ pubsub: aPubSub }) },
    {
      name: "b",
      adapters: ({ defaults: d }) => {
        seenByB = d.pubsub;
        return {
          pubsub: redis,
          platformCredentials: platform,
          modelProviders: { anthropic: fake },
        };
      },
    },
    { name: "no-adapters" },
  ];
  const result = await resolveAdapters(modules, ctx, defaults, {});
  expect(seenByB).toBe(aPubSub); // each module sees the adapters resolved so far
  expect(result.adapters.pubsub).toBe(redis);
  expect(result.adapters.platformCredentials).toBe(platform);
  expect(result.adapters.presence).toBe(defaults.presence);
  expect(result.modelProviders.anthropic).toBe(fake);
  expect(result.overridden).toEqual(["a:pubsub", "b:pubsub", "b:platformCredentials", "b:modelProviders.anthropic"]);
});

test("no modules: defaults unchanged", async () => {
  const result = await resolveAdapters([], ctx, defaults, {});
  expect(result.adapters).toEqual(defaults);
  expect(result.overridden).toEqual([]);
});

test("vault sources merge by kind; null turns them off (ADR 0144)", async () => {
  const s = (kind: string) => ({ kind }) as unknown as import("@agenteschat/adapters").VaultSource;
  const base = { ...defaults, vaultSources: { a: s("a"), b: s("b") } };
  const r = await resolveAdapters(
    [{ name: "m", adapters: () => ({ vaultSources: { b: s("b2"), c: s("c") } }) }],
    ctx,
    base,
    {},
  );
  expect(Object.keys(r.adapters.vaultSources ?? {}).sort()).toEqual(["a", "b", "c"]);
  expect(r.overridden).toEqual(["m:vaultSources.b", "m:vaultSources.c"]);
  const off = await resolveAdapters([{ name: "n", adapters: () => ({ vaultSources: null }) }], ctx, base, {});
  expect(off.adapters.vaultSources).toBeNull();
});
