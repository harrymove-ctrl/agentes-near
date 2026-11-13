import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, like, schema } from "@agenteschat/db";
import { publishOrgEvent, purgeWorkspace } from "@agenteschat/engine";
import { desktopChallenge } from "../src/desktop-sign-in";
import { currentSubscriptions } from "../src/realtime/ws";
import {
  type Browser,
  browser,
  createTestServer,
  deletionCode,
  joinByInvitation,
  lastCode,
  listen,
  ORIGIN,
  pairComputer,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Deletion = { dueAt: string | null; requestedAt: string | null; requestedBy: { id: string; name: string } | null };
const meOf = async (b: ReturnType<typeof browser>) =>
  (await (await b("/api/app/me")).json()) as {
    user: { id: string };
    organizations: { id: string; deletion?: Deletion }[];
  };

const deleteOrg = (b: Browser, orgId: string, json: Record<string, unknown> = {}) =>
  b(`/api/app/organizations/${orgId}/deletion`, { json });
const restoreOrg = (b: Browser, orgId: string) => b(`/api/app/organizations/${orgId}/deletion`, { method: "DELETE" });
/** A response's status and error code. */
const answer = async (res: Response) => [
  res.status,
  ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code,
];
/** Every session of theirs signed in an hour ago, as the database says. */
const signedInAnHourAgo = (userId: string) =>
  t.db
    .update(schema.sessions)
    .set({ createdAt: new Date(Date.now() - 3600_000) })
    .where(eq(schema.sessions.userId, userId));
/** The database wrote the date: a test moves it back to make the deletion due. */
const pastDue = (userId: string) =>
  t.db
    .update(schema.users)
    .set({ deletionDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.users.id, userId));
/** A code that isn't `code`. */
const otherThan = (code: string) => (code === "000000" ? "111111" : "000000");

test("a workspace being deleted reads as ever, its sockets open; any other change answers why, to its members only", async () => {
  // Open sign-up: someone from outside signs up too.
  await t.close();
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const ownerId = (await meOf(owner)).user.id;
  const anaId = (await meOf(ana)).user.id;
  const dueAt = new Date(Date.now() + 7 * 86_400_000);
  await t.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));
  const server = listen(t);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`, {
    headers: { origin: ORIGIN, cookie: owner.cookie() },
  } as unknown as string[]);
  try {
    const frames: { type?: string; event?: { type?: string } }[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as (typeof frames)[number];
        frames.push(frame);
        if (frame.type === "ready") resolve();
      });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    expect(await currentSubscriptions(t.db, ownerId, orgId, [channelId])).toEqual(new Set([channelId]));
    await publishOrgEvent(t.adapters.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.deleting", orgId, dueAt: dueAt.toISOString() },
    });
    // The app hears it, and the socket stays.
    expect(await Promise.race([closed, Bun.sleep(500).then(() => -1)])).toBe(-1);
    expect(frames.some((f) => f.event?.type === "org.deleting")).toBe(true);
  } finally {
    socket.close();
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }

  const app = `/api/app/organizations/${orgId}`;
  expect((await owner(`${app}/issues`)).status).toBe(200);
  expect((await owner(`${app}/channels/${channelId}/messages`)).status).toBe(200);
  const refused = await owner(`${app}/channels/${channelId}/messages`, { json: { body: "still here?" } });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({
    error: { code: "org.deleting", params: { dueAt: dueAt.toISOString() } },
  });
  expect(await answer(await owner(app, { method: "PATCH", json: { name: "Acme 2" } }))).toEqual([403, "org.deleting"]);
  expect(await answer(await owner(`${app}/members/${anaId}`, { method: "DELETE" }))).toEqual([403, "org.deleting"]);
  // What stays open: what they read, their own settings there.
  expect((await owner(`${app}/channels/${channelId}/read`, { json: {} })).status).toBe(204);
  expect((await owner(`${app}/me/status`, { method: "PUT", json: { availability: "away" } })).status).toBe(200);
  // Someone outside never hears it's being deleted.
  const zoe = browser(t);
  await signUp(zoe, "zoe@example.com");
  expect(await answer(await zoe(`${app}/channels/${channelId}/messages`, { json: { body: "hi" } }))).toEqual([
    403,
    "forbidden",
  ]);
  // Leaving, and who you are, still answer.
  expect((await meOf(ana)).organizations.map((o) => o.id)).toEqual([orgId]);
  expect((await ana(`${app}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
  expect((await meOf(ana)).organizations).toEqual([]);
});

test("being deleted, a DM it has opens as it is and none starts; its payer still opens billing", async () => {
  await t.close();
  t = await createTestServer({
    env: { BILLING_URL: "https://billing.example.com", BILLING_LINK_SECRET: "b".repeat(32) },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const anaId = (await meOf(ana)).user.id;
  const app = `/api/app/organizations/${orgId}`;
  const opened = await owner(`${app}/dms`, { json: { agentId } });
  expect(opened.status).toBe(200);
  const { channelId } = (await opened.json()) as { channelId: string };
  await t.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
    .where(eq(schema.organizations.id, orgId));

  const again = await owner(`${app}/dms`, { json: { agentId } });
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ channelId, dm: { channelId } });
  expect(await answer(await owner(`${app}/dms`, { json: { userId: anaId } }))).toEqual([403, "org.deleting"]);
  expect((await owner(`${app}/billing-link`, { json: { from: "settings" } })).status).toBe(200);
});

describe("proof that it's you: a code emailed to you", () => {
  test("it goes to your address for that deletion only, and works once; no code, a wrong one or a password won't do", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const path = `/api/app/organizations/${orgId}/deletion/code`;
    const sent = await owner(path, { json: {} });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ email: "owner@example.com", resendIn: 60 });
    await t.drain();
    expect(t.email.sent.at(-1)?.to).toEqual(["owner@example.com"]);
    const code = lastCode(t);
    // Another goes only after a minute.
    const again = await owner(path, { json: {} });
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: { code: "reauth.code_wait", params: { retryIn: 60 } } });

    expect(await answer(await deleteOrg(owner, orgId))).toEqual([403, "reauth.code"]);
    // Where email goes, the password proves nothing.
    expect(await answer(await deleteOrg(owner, orgId, { password: "correct horse battery" }))).toEqual([
      403,
      "reauth.code",
    ]);
    expect(await answer(await deleteOrg(owner, orgId, { code: otherThan(code) }))).toEqual([400, "reauth.code_wrong"]);
    // The account's own code deletes no workspace.
    const account = await deletionCode(t, owner, null);
    expect(await answer(await deleteOrg(owner, orgId, { code: account }))).toEqual([400, "reauth.code_wrong"]);
    expect((await deleteOrg(owner, orgId, { code })).status).toBe(202);
    // Spent: restored and deleted again, it takes a new one.
    expect((await restoreOrg(owner, orgId)).status).toBe(204);
    expect(await answer(await deleteOrg(owner, orgId, { code }))).toEqual([400, "reauth.code_wrong"]);
    expect((await deleteOrg(owner, orgId, { code: await deletionCode(t, owner, orgId) })).status).toBe(202);
  });

  test("five wrong tries use a code up, and one past its 10 minutes is refused", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const code = await deletionCode(t, owner, orgId);
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await answer(await deleteOrg(owner, orgId, { code: otherThan(code) })));
    expect(tries).toEqual([...Array(4).fill([400, "reauth.code_wrong"]), [409, "reauth.code_tries"]]);
    expect(await answer(await deleteOrg(owner, orgId, { code }))).toEqual([409, "reauth.code_tries"]);

    const next = await deletionCode(t, owner, orgId);
    await t.db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(schema.verifications.identifier, "deletion-code:%"));
    expect(await answer(await deleteOrg(owner, orgId, { code: next }))).toEqual([409, "reauth.code_expired"]);
  });

  test("a server that sends no email takes the password instead, 5 tries in 15 minutes, and sends no code", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    const theirs = await workspace(bia, "Theirs");
    Object.assign(t.email, { delivers: false });
    expect(await answer(await owner(`/api/app/organizations/${orgId}/deletion/code`, { json: {} }))).toEqual([
      409,
      "reauth.no_email",
    ]);
    expect(await answer(await bia("/api/app/account/deletion/code", { json: {} }))).toEqual([409, "reauth.no_email"]);
    expect(await answer(await deleteOrg(owner, orgId))).toEqual([403, "reauth.password"]);
    const answers = [];
    for (let i = 0; i < 6; i++)
      answers.push(await answer(await deleteOrg(owner, orgId, { password: "not my password" })));
    expect(answers).toEqual([...Array(5).fill([403, "reauth.password"]), [429, "rate_limited"]]);
    // An old session with the right password: the password is the proof, not the sign-in.
    await signedInAnHourAgo((await meOf(bia)).user.id);
    expect((await deleteOrg(bia, theirs, { password: "correct horse battery" })).status).toBe(202);
  });

  test("past the limit, a session can't try passwords on the sign-in service's own routes either", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const right = { password: "correct horse battery" };
    expect((await owner("/api/auth/verify-password", { json: right })).status).toBe(404);
    const change = { currentPassword: right.password, newPassword: "another fake password" };
    expect((await owner("/api/auth/change-password", { json: change })).status).toBe(404);
  });

  test("setting a password takes a sign-in in the last 10 minutes; one minted from an old session, for the phone or the desktop app, is just as old", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const ownerId = (await meOf(owner)).user.id;
    const password = { password: "another fake password" };
    // Signed in just now: a new password in place of its own (the same one here, so the sign-in below keeps working).
    expect((await owner("/api/app/me/password", { json: { password: "correct horse battery" } })).status).toBe(204);
    await signedInAnHourAgo(ownerId);
    expect(await answer(await owner("/api/app/me/password", { json: password }))).toEqual([403, "reauth.sign_in"]);

    const { token } = (await (await owner("/api/app/phone-sign-in", { json: {} })).json()) as { token: string };
    const phone = browser(t);
    expect((await phone("/api/auth/sign-in/one-time-token", { json: { token } })).status).toBe(200);
    expect(await answer(await phone("/api/app/me/password", { json: password }))).toEqual([403, "reauth.sign_in"]);

    // The desktop app's window, handed a browser's sign-in that turns old before the window picks it up.
    const site = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await site("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    const verifier = randomBytes(32).toString("base64url");
    const window = browser(t);
    const opened = await window("/api/auth/desktop/open", { json: { challenge: desktopChallenge(verifier) } });
    const { requestId } = (await opened.json()) as { requestId: string };
    expect(await (await site("/api/auth/desktop/handoff", { json: { requestId } })).json()).toEqual({ ok: true });
    await signedInAnHourAgo(ownerId);
    expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({
      signedIn: true,
    });
    expect(await answer(await window("/api/app/me/password", { json: password }))).toEqual([403, "reauth.sign_in"]);
  });
});

describe("deleting and restoring a workspace", () => {
  test("owners only; again keeps its date; GET /me says when it goes, null past its date; restored only before it", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ana = await joinByInvitation(t, owner, orgId, "ana@example.com", { role: "admin" });
    const ownerId = (await meOf(owner)).user.id;
    const deletionOf = async (b: Browser) => (await meOf(b)).organizations.find((o) => o.id === orgId)?.deletion;

    expect(await deletionOf(ana)).toBeUndefined();
    expect(await answer(await deleteOrg(ana, orgId))).toEqual([403, "forbidden"]);
    expect(await answer(await ana(`/api/app/organizations/${orgId}/deletion/code`, { json: {} }))).toEqual([
      403,
      "forbidden",
    ]);
    const deleted = await deleteOrg(owner, orgId, { code: await deletionCode(t, owner, orgId) });
    expect(deleted.status).toBe(202);
    const { deletion } = (await deleted.json()) as { deletion: { dueAt: string } };
    // Again: its date, before any proof.
    expect(await (await deleteOrg(owner, orgId)).json()).toEqual({ deletion });
    expect(await deletionOf(ana)).toEqual({
      dueAt: deletion.dueAt,
      requestedAt: expect.any(String),
      requestedBy: { id: ownerId, name: "owner" },
    });
    expect(await answer(await restoreOrg(ana, orgId))).toEqual([403, "forbidden"]);

    await t.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.organizations.id, orgId));
    expect((await deletionOf(ana))?.dueAt).toBeNull();
    expect(await answer(await restoreOrg(owner, orgId))).toEqual([409, "org.not_restorable"]);
    expect(await purgeWorkspace({ db: t.db }, orgId)).toBe(true);
    expect(await answer(await restoreOrg(owner, orgId))).toEqual([404, "not_found"]);
    expect((await meOf(ana)).organizations).toEqual([]);
  });

  test("restored, it opens again; a workspace takes 3 deletions a day", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const statuses: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await deleteOrg(owner, orgId, { code: await deletionCode(t, owner, orgId) })).status);
      statuses.push((await restoreOrg(owner, orgId)).status);
      statuses.push((await owner(`/api/app/organizations/${orgId}`)).status);
    }
    expect(statuses).toEqual([202, 204, 200, 202, 204, 200, 202, 204, 200, 429, 409, 200]);
  });
});

/** A workspace `b` makes and finishes setting up, so their next one is a new one. */
async function workspace(b: Browser, name: string) {
  const made = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  await b(`/api/app/organizations/${made.organization.id}/onboarding`, { method: "PATCH", json: { finished: true } });
  return made.organization.id;
}
const deleteAccount = (b: Browser, json?: Record<string, unknown>) =>
  b("/api/app/account", { method: "DELETE", ...(json ? { json } : {}) });

describe("deleting an account", () => {
  test("the preflight lists what stops it, what closes, what they leave, the computers that go and what stays behind", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com", { role: "admin" });
    const inAcme = (path: string, init?: Parameters<Browser>[1]) => bia(`/api/app/organizations/${orgId}${path}`, init);
    const key = { provider: "anthropic", label: "Bia's key", apiKey: "sk-ant-api-fake-1234" };
    expect((await inAcme("/credentials", { json: key })).status).toBe(201);
    const runner = { os: "linux", arch: "x64", hostname: "box", version: "0.1.0" };
    const laptop = await pairComputer(t, inAcme, runner, { name: "Bia's laptop" });
    const solo = await workspace(bia, "Solo");
    const team = await workspace(bia, "Team");
    await joinByInvitation(t, bia, team, "owner@example.com", { as: owner });
    // One being deleted already keeps its own date.
    const old = await workspace(bia, "Old");
    const { deletion } = (await (await deleteOrg(bia, old, { code: await deletionCode(t, bia, old) })).json()) as {
      deletion: { dueAt: string };
    };

    const plan = await (await bia("/api/app/account/deletion")).json();
    expect(plan).toEqual({
      closes: [
        // What it holds, so the page can say which is which.
        { id: solo, name: "Solo", agents: expect.any(Number), messages: expect.any(Number) },
        { id: old, name: "Old", deletion },
      ],
      leaves: [
        { id: orgId, name: "Acme", role: "member" },
        { id: team, name: "Team", role: "owner" },
      ],
      soleOwner: [{ id: team, name: "Team" }],
      computers: [{ orgId, id: laptop.machineId, name: "Bia's laptop" }],
      staysBehind: [{ orgId, kind: "key", name: "Bia's key" }],
      serverOwner: false,
    });
    expect(((await (await owner("/api/app/account/deletion")).json()) as { serverOwner: boolean }).serverOwner).toBe(
      true,
    );
  });

  test("the emailed code proves it's you; a workspace's only owner hears that first, before any code goes", async () => {
    const revoked: unknown[] = [];
    await t.close();
    t = await createTestServer({
      appleRevoke: async (token) => {
        revoked.push(token);
      },
    });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
    const biaId = (await meOf(bia)).user.id;
    await t.db.insert(schema.accounts).values({
      id: "apple-bia",
      accountId: "apple-sub-bia",
      providerId: "apple",
      userId: biaId,
      refreshToken: "refresh-bia",
    });
    const refused = await deleteAccount(owner);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "sole_owner", params: { organizations: ["Acme"], orgIds: [orgId] } },
    });
    await t.drain();
    const mails = t.email.sent.length;
    expect(await answer(await owner("/api/app/account/deletion/code", { json: {} }))).toEqual([409, "sole_owner"]);
    await t.drain();
    expect(t.email.sent.length).toBe(mails);

    // No body: how the phone's builds from before the code ask, which now delete nothing.
    expect(await answer(await deleteAccount(bia))).toEqual([403, "reauth.code"]);
    expect(await answer(await deleteAccount(bia, { password: "correct horse battery" }))).toEqual([403, "reauth.code"]);
    // A workspace's code deletes no account.
    const theirs = await workspace(bia, "Theirs");
    expect(await answer(await deleteAccount(bia, { code: await deletionCode(t, bia, theirs) }))).toEqual([
      400,
      "reauth.code_wrong",
    ]);
    expect(revoked).toEqual([]);
    const deleted = await deleteAccount(bia, { code: await deletionCode(t, bia, null) });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=;"))).toBe(true);
    // It waits for its date, with its sign-ins: Apple's only go then.
    await t.drain();
    expect(revoked).toEqual([]);
    await pastDue(biaId);
    await t.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.outbox.kind, "account.delete"));
    await t.drain();
    expect(revoked).toEqual([{ value: "refresh-bia", hint: "refresh_token" }]);
    expect(await t.db.select().from(schema.users).where(eq(schema.users.id, biaId))).toEqual([]);
  });

  test("its other sessions: GET /me answers 401 and expires the cookies, and no workspace is made with them", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const other = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await other("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    expect((await other("/api/app/me")).status).toBe(200);
    const cached = other.cookie();

    expect((await deleteAccount(owner, { code: await deletionCode(t, owner, null) })).status).toBe(204);
    await pastDue((await meOf(other)).user.id);
    await t.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.outbox.kind, "account.delete"));
    await t.drain();
    const me = await other("/api/app/me");
    expect(me.status).toBe(401);
    expect(me.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_data=;"))).toBe(true);
    const made = await t.app.request("/api/app/organizations", {
      method: "POST",
      headers: { cookie: cached, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Late" }),
    });
    expect(await answer(made)).toEqual([401, "unauthorized"]);
  });

  test("7 days to come back: every session ends, signing in shows only that, and Restaurar brings it all back", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const id = (await meOf(owner)).user.id;
    const phone = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await phone("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);

    expect((await deleteAccount(owner, { code: await deletionCode(t, owner, null) })).status).toBe(204);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, id))).toEqual([]);
    await t.drain();
    const told = t.email.sent.at(-1);
    expect(told?.to).toEqual(["owner@example.com"]);
    expect(told?.subject).toContain("vai ser apagada");

    // A cached cookie still reads as a session for minutes: no workspace answers it.
    expect((await phone(`/api/app/organizations/${orgId}/channels`)).status).toBe(403);

    // The same address can't start over meanwhile: it is this account's until the date.
    const newcomer = browser(t);
    const again = { email: "owner@example.com", password: "another good password", name: "Twin" };
    expect((await newcomer("/api/auth/sign-up/email", { json: again })).status).not.toBe(200);
    expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"))).toHaveLength(1);

    const back = browser(t);
    expect((await back("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    const waiting = (await (await back("/api/app/me")).json()) as {
      user: { deletion?: { dueAt: string | null }; canCreateWorkspace: boolean };
      organizations: unknown[];
    };
    expect(waiting.organizations).toEqual([]);
    expect(waiting.user.canCreateWorkspace).toBe(false);
    const dueAt = Date.parse(waiting.user.deletion?.dueAt ?? "");
    expect(Math.abs(dueAt - Date.now() - 7 * 86_400_000)).toBeLessThan(60_000);
    expect((await back(`/api/app/organizations/${orgId}/channels`)).status).toBe(403);
    expect(await answer(await back("/api/app/organizations", { json: { name: "Fresh start" } }))).toEqual([
      403,
      "org.create_refused",
    ]);

    expect((await back("/api/app/account/deletion", { method: "DELETE" })).status).toBe(204);
    const restored = (await (await back("/api/app/me")).json()) as {
      user: { deletion?: unknown };
      organizations: { id: string; deletion?: unknown }[];
    };
    expect(restored.user.deletion).toBeUndefined();
    expect(restored.organizations.map((o) => [o.id, o.deletion])).toEqual([[orgId, undefined]]);
    expect((await back(`/api/app/organizations/${orgId}/channels`)).status).toBe(200);
    expect(await answer(await back("/api/app/account/deletion", { method: "DELETE" }))).toEqual([
      409,
      "account.not_restorable",
    ]);
    // Its job comes and finds nothing to do.
    await t.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.outbox.kind, "account.delete"));
    await t.drain();
    expect((await back("/api/app/me")).status).toBe(200);
  });

  test("past its date Restaurar is refused, and the job deletes it", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const id = (await meOf(owner)).user.id;
    expect((await deleteAccount(owner, { code: await deletionCode(t, owner, null) })).status).toBe(204);
    const back = browser(t);
    const signIn = { email: "owner@example.com", password: "correct horse battery" };
    expect((await back("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    await pastDue(id);
    const me = (await (await back("/api/app/me")).json()) as { user: { deletion?: { dueAt: string | null } } };
    expect(me.user.deletion?.dueAt).toBeNull();
    expect(await answer(await back("/api/app/account/deletion", { method: "DELETE" }))).toEqual([
      409,
      "account.not_restorable",
    ]);
  });

  test("a person makes at most 10 workspaces a day", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await owner("/api/app/organizations", { json: { name: `W${i}` } })).status);
    expect(statuses).toEqual([201, ...Array(9).fill(200), 429]);
  });
});
