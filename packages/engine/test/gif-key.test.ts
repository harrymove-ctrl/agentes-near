import { afterEach, describe, expect, test } from "bun:test";
import type { GiphyKeyCheck } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createGifKey, createLocalKeyWrapper, createOrganization, sealSecret } from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

/** The installation's GIPHY key (ADR 0091, amended 2026-10-31), kept like the Jev key (ADR 0073). */

let f: Fixture;
afterEach(() => f?.close());

/** A fake GIPHY: what it says of each key it is asked about (it takes any other), and the keys asked. */
function giphy(verdicts: Record<string, GiphyKeyCheck> = {}) {
  const asked: string[] = [];
  const check = async (apiKey: string): Promise<GiphyKeyCheck> => {
    asked.push(apiKey);
    return verdicts[apiKey] ?? "ok";
  };
  return { check, asked };
}

const clock = { now: 1_800_000_000_000 };
const tick = (ms: number) => {
  clock.now += ms;
};
const MIN = 60_000;

function gifKey(check = giphy().check, envKey?: string) {
  const keyWrapper = createLocalKeyWrapper(SECRET);
  return createGifKey({ db: f.db, keyWrapper, keyWrappers: [keyWrapper], envKey, check, now: () => clock.now });
}

describe("the GIPHY key, saved and read", () => {
  test("saved sealed, checked first, shown by its last 4, recorded in every workspace; removed the same way", async () => {
    f = await setup();
    const other = await createOrganization(f.db, f.owner.id, { name: "Beta" });
    const fake = giphy();
    const key = gifKey(fake.check);
    await key.ready();
    expect(await key.view()).toEqual({ source: null, hint: null, state: "off" });
    expect(key.key()).toBeNull();

    const view = await key.save("  giphy_secret_key_7a1e  ", f.owner.id);
    expect(view).toEqual({ source: "settings", hint: "7a1e", state: "ok" });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(fake.asked).toEqual(["giphy_secret_key_7a1e"]);
    expect(key.key()).toBe("giphy_secret_key_7a1e");
    const [row] = await f.db.select().from(schema.instanceSecrets);
    expect(row).toMatchObject({ name: "giphy", keyHint: "7a1e", updatedBy: f.owner.id });
    expect(JSON.stringify(row)).not.toContain("giphy_secret");

    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "gif.key_saved"));
    expect(audit.map((a) => a.orgId).sort()).toEqual([f.org.id, other.organization.id].sort());
    expect(audit[0]).toMatchObject({ actorType: "person", actorId: f.owner.id, details: { hint: "7a1e" } });
    expect(JSON.stringify(audit)).not.toContain("giphy_secret");

    expect(await key.remove(f.owner.id)).toEqual({ source: null, hint: null, state: "off" });
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    expect(key.key()).toBeNull();
    const removed = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "gif.key_removed"));
    expect(removed).toHaveLength(2);
    expect(removed[0]).toMatchObject({ actorType: "person", actorId: f.owner.id, details: { hint: "7a1e" } });
  });

  test("a key GIPHY refuses is never stored, and one that can't be a key isn't even asked about", async () => {
    f = await setup();
    const fake = giphy({ giphy_made_up_0000: "invalid" });
    const key = gifKey(fake.check);
    await expect(key.save("giphy_made_up_0000", f.owner.id)).rejects.toMatchObject({ code: "gif_key_invalid" });
    for (const pasted of ["“giphy_quoted_7a1e”", "giphy_zero​width_7a1e", "giphy with spaces"]) {
      await expect(key.save(pasted, f.owner.id)).rejects.toMatchObject({ code: "gif_key_invalid" });
    }
    expect(fake.asked).toEqual(["giphy_made_up_0000"]);
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action.startsWith("gif."))).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain("giphy_made_up");
    expect(key.key()).toBeNull();
  });

  test("GIPHY not answering, or limiting, is no refusal: the key is kept and used", async () => {
    f = await setup();
    const key = gifKey(giphy({ giphy_unanswered_1: "unknown" }).check);
    expect(await key.save("giphy_unanswered_1", f.owner.id)).toEqual({ source: "settings", hint: "ed_1", state: "ok" });
    expect(key.key()).toBe("giphy_unanswered_1");
  });

  test("GIPHY_API_KEY wins: shown read-only, never saved, removed or asked about here", async () => {
    f = await setup();
    const fake = giphy();
    const key = gifKey(fake.check, " giphy_from_env_abcd ");
    await key.ready();
    expect(await key.view()).toEqual({ source: "env", hint: "abcd", state: "ok" });
    expect(key.key()).toBe("giphy_from_env_abcd");
    await expect(key.save("giphy_other_key_1", f.owner.id)).rejects.toMatchObject({ code: "gif_key_env" });
    await expect(key.remove(f.owner.id)).rejects.toMatchObject({ code: "gif_key_env" });
    expect(fake.asked).toEqual([]);
    // One that can't be sent reads as invalid, and nothing calls with it.
    const pasted = gifKey(fake.check, "“giphy_from_env_abcd”");
    expect(await pasted.view()).toMatchObject({ source: "env", state: "invalid" });
    expect(pasted.key()).toBeNull();
  });

  test("a sealed key copied from elsewhere doesn't open here: it reads as invalid, and nothing calls with it", async () => {
    f = await setup();
    const keyWrapper = createLocalKeyWrapper(SECRET);
    const sealed = await sealSecret(keyWrapper, "giphy_copied_key_1", "instance-secret|typesafe");
    await f.db.insert(schema.instanceSecrets).values({ name: "giphy", ...sealed, keyHint: "ey_1" });
    const key = gifKey();
    await key.ready();
    expect(await key.view()).toEqual({ source: "settings", hint: "ey_1", state: "invalid" });
    expect(key.key()).toBeNull();
  });

  test("a key saved at runtime is used by the next call, and after a restart from the first", async () => {
    f = await setup();
    const key = gifKey();
    await key.ready();
    expect(key.key()).toBeNull();
    await key.save("giphy_runtime_key_1", f.owner.id);
    expect(key.key()).toBe("giphy_runtime_key_1");

    const restarted = gifKey();
    await restarted.ready();
    expect(restarted.key()).toBe("giphy_runtime_key_1");
    expect(await restarted.view()).toEqual({ source: "settings", hint: "ey_1", state: "ok" });
  });

  test("another server on the same database sees a change within a minute, read again behind a call", async () => {
    f = await setup();
    const a = gifKey();
    const b = gifKey();
    await Promise.all([a.ready(), b.ready()]);
    await a.save("giphy_shared_key_1", f.owner.id);
    expect(b.key()).toBeNull();
    tick(MIN);
    // The first call past the minute starts the read and answers at once; the ones after it have the key.
    expect(b.key()).toBeNull();
    await b.view();
    expect(b.key()).toBe("giphy_shared_key_1");

    await a.remove(f.owner.id);
    tick(MIN);
    expect(await b.view()).toEqual({ source: null, hint: null, state: "off" });
    expect(b.key()).toBeNull();
  });
});
