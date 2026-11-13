import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type Browser,
  browser,
  createTestServer,
  deletionCode,
  deletionsDue,
  signUp,
  type TestServer,
} from "./harness";

/**
 * The installation's GIPHY key (ADR 0091, amended 2026-10-31): only its owner has it, never on agentes.chat, and GIFs
 * follow it in every workspace at once, without a restart.
 */

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GIPHY_KEY = "giphy_do_not_leak_7a1e";

/** A fake GIPHY: one GIF for `GIPHY_KEY`, 403 for any other key, and the key of every call recorded. */
function fakeGiphy() {
  const keys: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const key = url.searchParams.get("api_key") ?? "";
    keys.push(key);
    if (key !== GIPHY_KEY) return Response.json({ meta: { status: 403, msg: "Forbidden" } }, { status: 403 });
    const wave = {
      id: "wave1",
      title: "Hello wave",
      rating: "g",
      images: {
        downsized: { url: "https://media0.giphy.com/media/wave1/giphy-downsized.gif", width: "480", height: "270" },
      },
    };
    return Response.json({ data: [wave], pagination: { total_count: 1, count: 1, offset: 0 }, meta: { status: 200 } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, keys };
}

/** A server whose GIFs come from the fake GIPHY with the installation's key, its first account and another. */
async function start(env: Record<string, string> = {}) {
  const giphy = fakeGiphy();
  const server = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env }, giphyFetch: giphy.fetch });
  t = server;
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const other = browser(server);
  await signUp(other, "other@example.com");
  return { server, owner, other, giphy };
}

/** A workspace of `b`'s: its id and its #general. */
async function workspace(b: Browser, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
    generalChannelId: string;
  };
  return { orgId: created.organization.id, channelId: created.generalChannelId };
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("only the installation's first account reaches it: signed out 401, anyone else 404", async () => {
  const { server, owner, other } = await start();
  expect((await browser(server)("/api/app/gif-key")).status).toBe(401);
  expect((await other("/api/app/gif-key")).status).toBe(404);
  expect((await other("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY } })).status).toBe(404);
  expect((await other("/api/app/gif-key", { method: "DELETE" })).status).toBe(404);
  const res = await owner("/api/app/gif-key");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ source: null, hint: null, state: "off" });
});

test("on agentes.chat itself nobody has it", async () => {
  const origin = "https://app.agentes.chat";
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin } });
  const first = browser(t);
  const signedUp = await first("/api/auth/sign-up/email", {
    json: { email: "first@example.com", password: "correct horse battery", name: "First" },
    origin,
  });
  expect(signedUp.status).toBe(200);
  expect((await first("/api/app/gif-key")).status).toBe(404);
  expect((await first("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY }, origin })).status).toBe(404);
  expect((await first("/api/app/gif-key", { method: "DELETE", origin })).status).toBe(404);
});

test("a key GIPHY refuses, or one that can't be a key: 422 and nothing stored", async () => {
  const { server, owner, giphy } = await start();
  const res = await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: "giphy_made_up_0000" } });
  expect(res.status).toBe(422);
  expect(await errorCode(res)).toBe("gif_key_invalid");
  // Pasted with curly quotes, a zero-width space or a space: refused before GIPHY is asked.
  for (const apiKey of [`“${GIPHY_KEY}”`, "giphy​_key_7a1e", "giphy with spaces"]) {
    expect((await owner("/api/app/gif-key", { method: "PUT", json: { apiKey } })).status).toBe(422);
  }
  expect(giphy.keys).toEqual(["giphy_made_up_0000"]);
  expect(await server.db.select().from(schema.instanceSecrets)).toEqual([]);
  expect((await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: "short" } })).status).toBe(400);
});

test("saved: GIFs in every workspace at once, the key shown by its last 4 and recorded in each; removed: gone", async () => {
  const { server, owner, other, giphy } = await start();
  const acme = await workspace(owner, "Acme");
  const beta = await workspace(other, "Beta");
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${acme.orgId}${path}`, init);
  const gif = { body: "", media: { kind: "gif", id: "wave1" } };

  // No key yet: no GIFs, and GIPHY never asked.
  expect(await (await api("/settings")).json()).toMatchObject({ gifs: true, gifsAvailable: false });
  const off = await api("/gifs");
  expect(off.status).toBe(404);
  expect(await errorCode(off)).toBe("gifs.off");
  const refused = await api(`/channels/${acme.channelId}/messages`, { json: gif });
  expect(refused.status).toBe(422);
  expect(await errorCode(refused)).toBe("message.media_off");
  expect(giphy.keys).toEqual([]);

  const saved = await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: ` ${GIPHY_KEY} ` } });
  expect(saved.status).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain("do_not_leak");
  expect(JSON.parse(text)).toEqual({ source: "settings", hint: "7a1e", state: "ok" });
  // Asked of GIPHY once, before it was kept.
  expect(giphy.keys).toEqual([GIPHY_KEY]);

  // Without a restart: the settings say so, a search finds GIFs and one is sent.
  expect(await (await api("/settings")).json()).toMatchObject({ gifsAvailable: true });
  const found = await api("/gifs");
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({
    gifs: [{ id: "wave1", title: "Hello wave", width: 480, height: 270 }],
    next: null,
  });
  const posted = await api(`/channels/${acme.channelId}/messages`, { json: gif });
  expect(posted.status).toBe(201);
  expect(((await posted.json()) as { meta: { media?: unknown } }).meta.media).toMatchObject({
    kind: "gif",
    id: "wave1",
  });
  expect(giphy.keys.every((key) => key === GIPHY_KEY)).toBe(true);

  const read = await (await owner("/api/app/gif-key")).text();
  expect(read).not.toContain("do_not_leak");
  expect(JSON.parse(read)).toEqual({ source: "settings", hint: "7a1e", state: "ok" });
  const [row] = await server.db.select().from(schema.instanceSecrets);
  expect(row).toMatchObject({ name: "giphy", keyHint: "7a1e" });
  expect(JSON.stringify(row)).not.toContain("do_not_leak");
  const audit = await server.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "gif.key_saved"));
  expect(audit.map((a) => a.orgId).sort()).toEqual([acme.orgId, beta.orgId].sort());
  expect(JSON.stringify(audit)).not.toContain("do_not_leak");

  const removed = await owner("/api/app/gif-key", { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ source: null, hint: null, state: "off" });
  expect(await server.db.select().from(schema.instanceSecrets)).toEqual([]);
  const gone = await server.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "gif.key_removed"));
  expect(gone).toHaveLength(2);
  expect(await (await api("/settings")).json()).toMatchObject({ gifsAvailable: false });
  expect((await api("/gifs")).status).toBe(404);
});

test("with GIPHY_API_KEY set: GIFs from the start, the key shown read-only, 409 on save and remove", async () => {
  const { owner, giphy } = await start({ GIPHY_API_KEY: GIPHY_KEY });
  expect(await (await owner("/api/app/gif-key")).json()).toEqual({ source: "env", hint: "7a1e", state: "ok" });
  const acme = await workspace(owner, "Acme");
  expect(await (await owner(`/api/app/organizations/${acme.orgId}/settings`)).json()).toMatchObject({
    gifsAvailable: true,
  });
  expect((await owner(`/api/app/organizations/${acme.orgId}/gifs`)).status).toBe(200);
  const put = await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: "giphy_other_key_1111" } });
  expect(put.status).toBe(409);
  expect(await errorCode(put)).toBe("gif_key_env");
  expect((await owner("/api/app/gif-key", { method: "DELETE" })).status).toBe(409);
  expect(giphy.keys).toEqual([GIPHY_KEY]);
});

test("ten saves a minute, then 429", async () => {
  const { owner } = await start();
  for (let i = 0; i < 10; i++) {
    expect((await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY } })).status).toBe(200);
  }
  expect((await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY } })).status).toBe(429);
});

test("once the first account deletes itself, its key goes with it and nobody inherits the card", async () => {
  const { server, owner, other } = await start();
  const beta = await workspace(other, "Beta");
  expect((await owner("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY } })).status).toBe(200);
  const proof = await deletionCode(server, owner, null);
  expect((await owner("/api/app/account", { method: "DELETE", json: { code: proof } })).status).toBe(204);
  await deletionsDue(server);
  expect(await server.db.select().from(schema.instanceSecrets)).toEqual([]);
  const gone = await server.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "gif.key_removed"));
  expect(gone).toMatchObject([{ orgId: beta.orgId, actorType: "system", details: { hint: "7a1e" } }]);
  expect((await other("/api/app/gif-key")).status).toBe(404);
  expect((await other("/api/app/gif-key", { method: "PUT", json: { apiKey: GIPHY_KEY } })).status).toBe(404);
});
