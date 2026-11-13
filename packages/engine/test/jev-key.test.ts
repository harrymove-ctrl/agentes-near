import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  callJev,
  checkJevKey,
  createJevKey,
  createLocalKeyWrapper,
  createOrganization,
  type JevKey,
  type JevState,
  jevStateOf,
  sealSecret,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

type Answer = number | "down" | "late" | { status: number; body?: unknown; retryAfter?: string };

/** A fake TypeSafe: answers in turn (the last one repeats), and records the keys it was called with. */
function typesafe(...answers: Answer[]) {
  const keys: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "");
    const a = answers[Math.min(keys.length - 1, answers.length - 1)] ?? 200;
    if (a === "down") throw new TypeError("fetch failed");
    // What fetch throws once the deadline we set passes.
    if (a === "late") throw new DOMException("The operation timed out.", "TimeoutError");
    const { status, body, retryAfter } =
      typeof a === "number" ? { status: a, body: undefined, retryAfter: undefined } : a;
    const headers = retryAfter ? { "retry-after": retryAfter } : undefined;
    return Response.json(body ?? (status < 300 ? { answers: { ok: { noul: 1 } } } : { detail: {} }), {
      status,
      headers,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, keys, answers };
}

const clock = { now: 1_800_000_000_000 };
const tick = (ms: number) => {
  clock.now += ms;
};
const MIN = 60_000;
const DOWN_SKIP_MS = 60_000;

function jevKey(fetch: typeof globalThis.fetch, envKey?: string) {
  const keyWrapper = createLocalKeyWrapper(SECRET);
  return createJevKey({ db: f.db, keyWrapper, keyWrappers: [keyWrapper], envKey, fetch, now: () => clock.now });
}

/** One live call, as the router and the judge make them: answered, failed, or not made (no key now). */
const live = (key: JevKey, fetch: typeof globalThis.fetch) =>
  callJev(key, { body: {}, timeoutMs: 2000, fetch }).then(
    () => "answered",
    (e: Error) => (e.name === "JevOffError" ? "off" : "failed"),
  );

describe("what an answer says about the key", () => {
  test("first match wins, and the request's own errors say nothing", () => {
    const credit = { detail: { error_type: "billing_error", message: "Insufficient credits" } };
    const table: [number, unknown, JevState | null][] = [
      [200, undefined, "ok"],
      [401, undefined, "invalid"],
      [402, undefined, "no_credit"],
      [403, { detail: { error_type: "authentication_error", message: "Must supply an API key!" } }, "invalid"],
      [403, credit, "no_credit"],
      [400, { detail: { message: "Your balance is too low" } }, "no_credit"],
      [400, { detail: "out of funds" }, "no_credit"],
      [400, undefined, null],
      [413, undefined, null],
      [415, undefined, null],
      [422, { detail: { message: "The image must be 280 to 1568 px a side" } }, null],
      [429, undefined, "rate_limited"],
      [500, undefined, "down"],
      [529, { detail: { error_type: "overloaded_error" } }, "down"],
    ];
    for (const [status, body, state] of table)
      expect({ status, state: jevStateOf(status, body) }).toEqual({ status, state });
  });

  test("the check before saving: a network error is down, our own 5 s deadline is unchecked", async () => {
    expect(await checkJevKey("ts_key_1234", { fetch: typesafe(200).fetch })).toBe("ok");
    expect(await checkJevKey("ts_key_1234", { fetch: typesafe(401).fetch })).toBe("invalid");
    expect(await checkJevKey("ts_key_1234", { fetch: typesafe("down").fetch })).toBe("down");
    expect(await checkJevKey("ts_key_1234", { fetch: typesafe("late").fetch })).toBe("unchecked");
    expect(await checkJevKey("ts_key_1234", { fetch: typesafe(422).fetch })).toBe("unchecked");
  });
});

describe("the key, saved and read", () => {
  test("saved encrypted, shown by its last 4, recorded in every workspace; removed the same way", async () => {
    f = await setup();
    const other = await createOrganization(f.db, f.owner.id, { name: "Beta" });
    const ts = typesafe(200);
    const key = jevKey(ts.fetch);
    await key.ready();
    expect(await key.view()).toEqual({ source: null, hint: null, state: "off" });
    expect(key.usable()).toBe(false);

    const view = await key.save("  ts_live_secret_9f2c  ", f.owner.id);
    expect(view).toEqual({ source: "settings", hint: "9f2c", state: "ok" });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(ts.keys).toEqual(["ts_live_secret_9f2c"]);
    const [row] = await f.db.select().from(schema.instanceSecrets);
    expect(row).toMatchObject({ name: "typesafe", keyHint: "9f2c", updatedBy: f.owner.id });
    expect(JSON.stringify(row)).not.toContain("ts_live_secret");
    expect(await key.key()).toBe("ts_live_secret_9f2c");

    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "jev.key_saved"));
    expect(audit.map((a) => a.orgId).sort()).toEqual([f.org.id, other.organization.id].sort());
    expect(audit[0]).toMatchObject({ actorType: "person", actorId: f.owner.id, details: { hint: "9f2c" } });
    expect(JSON.stringify(audit)).not.toContain("ts_live_secret");

    expect(await key.remove(f.owner.id)).toEqual({ source: null, hint: null, state: "off" });
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    expect(await key.key()).toBeNull();
    const removed = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "jev.key_removed"));
    expect(removed).toHaveLength(2);
  });

  test("a key TypeSafe refuses is never stored", async () => {
    f = await setup();
    const key = jevKey(typesafe(401).fetch);
    await expect(key.save("ts_made_up_key", f.owner.id)).rejects.toMatchObject({ code: "jev_key_invalid" });
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action.startsWith("jev."))).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain("ts_made_up_key");
  });

  test("a key that isn't printable ASCII is refused before TypeSafe sees it, and one in the env is never called", async () => {
    f = await setup();
    const ts = typesafe(200);
    const key = jevKey(ts.fetch);
    for (const pasted of ["“ts_quoted_key_9f2c”", "ts_zero\u200bwidth_9f2c", "ts with spaces"]) {
      await expect(key.save(pasted, f.owner.id)).rejects.toMatchObject({ code: "jev_key_invalid" });
    }
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    const env = jevKey(ts.fetch, "“ts_from_env_abcd”");
    expect(await env.view()).toMatchObject({ source: "env", state: "invalid" });
    expect(env.usable()).toBe(false);
    expect(await live(env, ts.fetch)).toBe("off");
    expect(ts.keys).toEqual([]);
  });

  test("out of credit is stored and shown; a limit or no answer is stored and shown On", async () => {
    f = await setup();
    const broke = jevKey(typesafe({ status: 402 }).fetch);
    expect((await broke.save("ts_no_credit_1", f.owner.id)).state).toBe("no_credit");
    expect(broke.usable()).toBe(false);
    for (const answer of [429, 529, "late"] as const) {
      const key = jevKey(typesafe(answer).fetch);
      expect((await key.save("ts_unanswered_1", f.owner.id)).state).toBe("ok");
      expect(key.usable()).toBe(true);
    }
  });

  test("TYPESAFE_API_KEY wins: shown read-only, never saved or removed here", async () => {
    f = await setup();
    const key = jevKey(typesafe(200).fetch, "ts_from_env_abcd");
    await key.ready();
    expect(await key.view()).toEqual({ source: "env", hint: "abcd", state: "ok" });
    expect(key.usable()).toBe(true);
    await expect(key.save("ts_other_key_1", f.owner.id)).rejects.toMatchObject({ code: "jev_key_env" });
    await expect(key.remove(f.owner.id)).rejects.toMatchObject({ code: "jev_key_env" });
    expect(await key.key()).toBe("ts_from_env_abcd");
  });

  test("a sealed key copied from elsewhere doesn't open here: it reads as not accepted, and nothing calls with it", async () => {
    f = await setup();
    const keyWrapper = createLocalKeyWrapper(SECRET);
    const sealed = await sealSecret(keyWrapper, "ts_copied_key_1", `provider-credential|${f.org.id}|x`);
    await f.db.insert(schema.instanceSecrets).values({ name: "typesafe", ...sealed, keyHint: "ey_1" });
    const ts = typesafe(200);
    const key = jevKey(ts.fetch);
    await key.ready();
    expect(await key.view()).toEqual({ source: "settings", hint: "ey_1", state: "invalid" });
    expect(key.usable()).toBe(false);
    expect(await live(key, ts.fetch)).toBe("off");
    expect(ts.keys).toEqual([]);
  });

  test("a key saved at runtime is used by the next call, and after a restart before any call", async () => {
    f = await setup();
    const ts = typesafe(200);
    const key = jevKey(ts.fetch);
    await key.ready();
    expect(await live(key, ts.fetch)).toBe("off");
    await key.save("ts_runtime_key_1", f.owner.id);
    expect(await live(key, ts.fetch)).toBe("answered");
    expect(ts.keys).toEqual(["ts_runtime_key_1", "ts_runtime_key_1"]);

    const restarted = typesafe(200);
    const after = jevKey(restarted.fetch);
    await after.ready();
    expect(after.usable()).toBe(true);
    expect(await after.view()).toEqual({ source: "settings", hint: "ey_1", state: "ok" });
    expect(restarted.keys).toEqual([]);
  });

  test("another server on the same database sees a new key within a minute", async () => {
    f = await setup();
    const a = jevKey(typesafe(200).fetch);
    const b = jevKey(typesafe(200).fetch);
    await Promise.all([a.ready(), b.ready()]);
    await a.save("ts_shared_key_1", f.owner.id);
    expect(await b.key()).toBeNull();
    tick(MIN);
    expect(await b.key()).toBe("ts_shared_key_1");
    await a.remove(f.owner.id);
    tick(MIN);
    expect(await b.key()).toBeNull();
  });
});

describe("a broken key is skipped for a while", () => {
  async function saved(...answers: Answer[]) {
    f = await setup();
    const check = typesafe(200);
    const key = jevKey(check.fetch);
    await key.save("ts_skip_key_1", f.owner.id);
    return { key, ts: typesafe(...answers) };
  }

  test("not accepted: no call for 30 minutes, then one tries again", async () => {
    const { key, ts } = await saved(401);
    expect(await live(key, ts.fetch)).toBe("failed");
    expect((await key.view()).state).toBe("invalid");
    expect(await live(key, ts.fetch)).toBe("off");
    tick(29 * MIN);
    expect(await live(key, ts.fetch)).toBe("off");
    expect(ts.keys).toHaveLength(1);
    tick(MIN);
    expect(await live(key, ts.fetch)).toBe("failed");
    expect(ts.keys).toHaveLength(2);
  });

  test("a limit waits for retry-after, or 10 s, and screens still read On", async () => {
    const { key, ts } = await saved({ status: 429, retryAfter: "3" }, 429, 200);
    expect(await live(key, ts.fetch)).toBe("failed");
    expect(key.usable()).toBe(false);
    expect((await key.view()).state).toBe("ok");
    tick(3000);
    expect(key.usable()).toBe(true);
    expect(await live(key, ts.fetch)).toBe("failed");
    tick(9000);
    expect(key.usable()).toBe(false);
    tick(1000);
    expect(await live(key, ts.fetch)).toBe("answered");
  });

  test("our own deadline, the request's own error and one outage leave Jev on; three outages in a row skip 60 s", async () => {
    const { key, ts } = await saved("late", 422, 529, 529, 200, 529, 529, "down");
    for (let i = 0; i < 4; i++) {
      expect(await live(key, ts.fetch)).toBe("failed");
      expect(key.usable()).toBe(true);
    }
    // An answer between them starts the count again.
    expect(await live(key, ts.fetch)).toBe("answered");
    expect(await live(key, ts.fetch)).toBe("failed");
    expect(await live(key, ts.fetch)).toBe("failed");
    expect(key.usable()).toBe(true);
    // A network error is an outage too.
    expect(await live(key, ts.fetch)).toBe("failed");
    expect(key.usable()).toBe(false);
    expect(await live(key, ts.fetch)).toBe("off");
    expect((await key.view()).state).toBe("ok");
    tick(DOWN_SKIP_MS);
    expect(key.usable()).toBe(true);
  });

  test("an answer for a key replaced meanwhile says nothing about the new one", async () => {
    f = await setup();
    const key = jevKey(typesafe(200).fetch);
    await key.save("ts_old_key_0000", f.owner.id);
    let started = () => {};
    let release = () => {};
    const calling = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    // A live call with the old key, refused once the owner has replaced it.
    const revoked = (async () => {
      started();
      await held;
      return Response.json({ detail: {} }, { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const call = live(key, revoked);
    await calling;
    await key.save("ts_new_key_1111", f.owner.id);
    release();
    expect(await call).toBe("failed");
    expect(await key.view()).toEqual({ source: "settings", hint: "1111", state: "ok" });
    expect(await key.key()).toBe("ts_new_key_1111");
  });

  test("Check again: an answer about the key moves the state, a limit leaves Out of credit", async () => {
    f = await setup();
    const ts = typesafe({ status: 402 });
    const key = jevKey(ts.fetch);
    expect((await key.save("ts_check_key_1", f.owner.id)).state).toBe("no_credit");
    ts.answers[0] = 429;
    expect((await key.check()).state).toBe("no_credit");
    expect(key.usable()).toBe(false);
    ts.answers[0] = 200;
    expect((await key.check()).state).toBe("ok");
    expect(key.usable()).toBe(true);
  });
});
