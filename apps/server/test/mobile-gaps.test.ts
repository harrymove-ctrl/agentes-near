import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type Browser,
  browser,
  createTestServer,
  deletionCode,
  deletionsDue,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

/**
 * Routes the phone app needed (ADR 0035): unread and last message in the
 * channel list, following threads, pins, "working now" for members,
 * reminders, and revoking Apple tokens when an account is deleted.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const MOBILE = { "x-agentes-client": "mobile" };
/** The account's password, which the app sends to prove it's them (`DELETE /account`). */
const fromApp = (b: Browser, path: string, init: { method?: string; json?: unknown } = {}) =>
  b(path, { ...init, origin: null, headers: MOBILE });

/** A second person in the owner's org (invited, signed up, accepted: in #general). */
async function addPerson(owner: Browser, orgId: string, email: string) {
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email, role: "member" } })
  ).json()) as { url: string };
  const person = browser(t);
  await signUp(person, email);
  expect((await person(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} })).status).toBe(200);
  return person;
}

type ChannelRow = {
  id: string;
  name: string;
  unreadCount: number;
  lastMessage: { id: string; authorType: string; authorName: string | null; preview: string } | null;
};

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const bia = await addPerson(owner, seeded.orgId, "bia@example.com");
  const org = `/api/app/organizations/${seeded.orgId}`;
  const post = async (b: Browser, channelId: string, body: string, threadId?: string) =>
    (await (await b(`${org}/channels/${channelId}/messages`, { json: { body, threadId } })).json()) as { id: string };
  return { ...seeded, owner, bia, org, post };
}

describe("channel list", () => {
  test("unread count and last message per channel; marking read clears it", async () => {
    const { owner, bia, org, channelId, post } = await start();
    await post(owner, channelId, "first");
    const last = await post(owner, channelId, "second");
    const list = async () =>
      ((await (await fromApp(bia, `${org}/channels`)).json()) as { channels: ChannelRow[] }).channels;
    const general = (await list()).find((c) => c.id === channelId);
    expect(general?.unreadCount).toBe(2);
    expect(general?.lastMessage).toMatchObject({
      id: last.id,
      authorType: "person",
      authorName: "owner",
      preview: "second",
    });
    expect((await fromApp(bia, `${org}/channels/${channelId}/read`, { json: {} })).status).toBe(204);
    expect((await list()).find((c) => c.id === channelId)?.unreadCount).toBe(0);
  });
});

describe("threads: follow", () => {
  test("PUT follows, DELETE mutes; the view carries it; outsiders can't", async () => {
    const { owner, bia, org, channelId, post } = await start();
    const root = await post(owner, channelId, "Release checklist");
    const followPath = `${org}/threads/${root.id}/follow`;
    const view = async () =>
      ((await (await fromApp(bia, `${org}/threads/${root.id}`)).json()) as { following: boolean }).following;
    expect(await view()).toBe(false);
    const put = await fromApp(bia, followPath, { method: "PUT", json: {} });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ threadId: root.id, channelId, following: true });
    expect(await view()).toBe(true);
    const muted = (await (await fromApp(bia, followPath, { method: "DELETE" })).json()) as { following: boolean };
    expect(muted.following).toBe(false);
    expect(await view()).toBe(false);

    const stranger = browser(t);
    await signUp(stranger, "zed@example.com");
    expect((await fromApp(stranger, followPath, { method: "PUT", json: {} })).status).toBe(403);
  });
});

describe("pins", () => {
  test("pin, list, the message's mark, unpin; a private channel stays private", async () => {
    const { owner, bia, org, channelId, post } = await start();
    const m = await post(owner, channelId, "Runbook: deploy");
    const pinPath = `${org}/channels/${channelId}/pins/${m.id}`;
    const pinned = await fromApp(bia, pinPath, { method: "POST", json: {} });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({
      messageId: m.id,
      threadId: null,
      message: { body: "Runbook: deploy" },
    });
    const pins = (await (await fromApp(bia, `${org}/channels/${channelId}/pins`)).json()) as {
      pins: { messageId: string }[];
    };
    expect(pins.pins.map((p) => p.messageId)).toEqual([m.id]);
    const messages = (await (await fromApp(bia, `${org}/channels/${channelId}/messages`)).json()) as {
      messages: { id: string; pinned?: boolean }[];
    };
    expect(messages.messages.find((x) => x.id === m.id)?.pinned).toBe(true);
    expect((await fromApp(bia, pinPath, { method: "DELETE" })).status).toBe(204);
    expect(await t.db.select().from(schema.messagePins)).toEqual([]);

    const secret = (await (
      await owner(`${org}/channels`, { json: { name: "secret", visibility: "private" } })
    ).json()) as { id: string };
    const hidden = await post(owner, secret.id, "private plan");
    expect(
      (await fromApp(bia, `${org}/channels/${secret.id}/pins/${hidden.id}`, { method: "POST", json: {} })).status,
    ).toBe(403);
    expect((await fromApp(bia, `${org}/channels/${secret.id}/pins`)).status).toBe(403);
  });
});

describe("working now", () => {
  test("any member lists runs in conversations they are in; never another person's DM", async () => {
    const { owner, bia, org, agentId, channelId, post } = await start();
    const ask = await post(owner, channelId, "Dev, check the deploy?");
    const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, ask.id));
    await t.db.insert(schema.agentRuns).values({
      orgId: message?.orgId ?? "",
      agentId,
      channelId,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "router",
      hop: 1,
      status: "running",
    });
    // The owner's DM with the agent starts a run of its own.
    const { channelId: dmId } = (await (await owner(`${org}/dms`, { json: { agentId } })).json()) as {
      channelId: string;
    };
    await post(owner, dmId, "summarize my week");

    const runs = async (b: Browser) =>
      (
        (await (await fromApp(b, `${org}/active-runs`)).json()) as {
          runs: { channelId: string; label: string | null }[];
        }
      ).runs;
    const biaRuns = await runs(bia);
    expect(biaRuns.map((r) => r.channelId)).toEqual([channelId]);
    // Never the ask's own words: with no thread title the apps say where it is.
    expect(biaRuns[0]?.label).toBeNull();
    expect((await runs(owner)).map((r) => r.channelId).sort()).toEqual([channelId, dmId].sort());
  });
});

describe("reminders", () => {
  test("create about a message, list mine, cancel; the past is refused", async () => {
    const { owner, bia, org, channelId, post } = await start();
    const m = await post(owner, channelId, "Ship the release notes");
    const at = new Date(Date.now() + 3600_000).toISOString();
    const created = await fromApp(bia, `${org}/reminders`, { json: { channelId, messageId: m.id, at } });
    expect(created.status).toBe(201);
    const reminder = (await created.json()) as { id: string; threadId: string; message: string };
    expect(reminder).toMatchObject({ threadId: m.id, message: "Ship the release notes" });
    const mine = (await (await fromApp(bia, `${org}/reminders`)).json()) as { reminders: { id: string }[] };
    expect(mine.reminders.map((r) => r.id)).toEqual([reminder.id]);
    expect(((await (await fromApp(owner, `${org}/reminders`)).json()) as { reminders: unknown[] }).reminders).toEqual(
      [],
    );
    expect((await fromApp(owner, `${org}/reminders/${reminder.id}`, { method: "DELETE" })).status).toBe(404);
    const cancelled = await fromApp(bia, `${org}/reminders/${reminder.id}`, { method: "DELETE" });
    expect(((await cancelled.json()) as { done: boolean }).done).toBe(true);

    const past = await fromApp(bia, `${org}/reminders`, {
      json: { channelId, text: "x", at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(past.status).toBe(400);
    expect(((await past.json()) as { error: { code: string } }).error.code).toBe("when.past");
  });
});

describe("account deletion revokes Apple tokens", () => {
  test("revoked after the account is gone; nothing when the deletion is refused", async () => {
    const revoked: { value: string; hint: string }[] = [];
    t = await createTestServer({
      env: { ALLOW_SIGNUP: "true" },
      appleRevoke: async (token) => {
        revoked.push(token);
      },
    });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await addPerson(owner, orgId, "bia@example.com");
    const users = await t.db.select().from(schema.users);
    const userId = (email: string) => users.find((u) => u.email === email)?.id ?? "";
    for (const email of ["owner@example.com", "bia@example.com"]) {
      await t.db.insert(schema.accounts).values({
        id: `apple-${email}`,
        accountId: `apple-sub-${email}`,
        providerId: "apple",
        userId: userId(email),
        refreshToken: `refresh-${email}`,
      });
    }

    expect((await fromApp(owner, "/api/app/account", { method: "DELETE", json: {} })).status).toBe(409);
    expect(revoked).toEqual([]);
    const code = await deletionCode(t, bia, null);
    expect((await fromApp(bia, "/api/app/account", { method: "DELETE", json: { code } })).status).toBe(204);
    expect(revoked).toEqual([]);
    await deletionsDue(t);
    expect(revoked).toEqual([{ value: "refresh-bia@example.com", hint: "refresh_token" }]);
  });

  test("a failing revocation never fails the deletion", async () => {
    t = await createTestServer({
      env: { ALLOW_SIGNUP: "true" },
      appleRevoke: async () => {
        throw new Error("apple down");
      },
    });
    const person = browser(t);
    await signUp(person, "solo@example.com");
    const [user] = await t.db.select().from(schema.users);
    await t.db.insert(schema.accounts).values({
      id: "apple-solo",
      accountId: "apple-sub-solo",
      providerId: "apple",
      userId: user?.id ?? "",
      accessToken: "access-solo",
    });
    const code = await deletionCode(t, person, null);
    expect((await fromApp(person, "/api/app/account", { method: "DELETE", json: { code } })).status).toBe(204);
    await deletionsDue(t);
    expect(await t.db.select().from(schema.users)).toEqual([]);
  });
});
