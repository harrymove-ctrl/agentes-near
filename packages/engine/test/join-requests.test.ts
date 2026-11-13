import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, countQueries, eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  approveJoinRequest,
  askToJoin,
  createInvitation,
  denyJoinRequest,
  type EmailTemplate,
  FILE_JOIN_REQUEST_JOB,
  fileJoinRequest,
  findInviteLink,
  inviteLink,
  isSignupAllowed,
  JOIN_REQUEST_TTL_DAYS,
  joinStatus,
  listInviteLinks,
  listWaitingJoinRequests,
  MAX_PENDING_JOIN_REQUESTS,
  memberRoleIds,
  pruneJoinRequests,
  randomToken,
  removeMember,
  renderEmail,
  renderPush,
  resendInvitation,
  revokeInvitation,
  settleJoinRequests,
  sha256,
  turnOffInviteLink,
} from "../src";
import { addMember, adminRoleId, type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PUBLIC = "https://agentes.test/";
const DAY = 86_400_000;
const NOW = new Date("2026-10-26T10:15:00.000Z");
const later = (days: number) => new Date(NOW.getTime() + days * DAY);
let limiter = createMemoryRateLimiter();
const deps = () => ({ db: f.db, pubsub: f.pubsub, rateLimiter: limiter });

async function start() {
  f = await setup();
  close = f.close;
  limiter = createMemoryRateLimiter();
  const { token, link } = await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
  return { token, link };
}

/** A person with this address (`verified`: they opened the confirmation link). */
async function person(email: string, options: { verified?: boolean; locale?: string } = {}) {
  const id = `user_${email.split("@")[0]}`;
  const name = `${email.split("@")[0]?.replace(/^./, (c) => c.toUpperCase())} Lima`;
  await f.db.insert(schema.users).values({
    id,
    name,
    email,
    emailVerified: options.verified ?? false,
    locale: options.locale ?? null,
  });
  return { id, name, email };
}

/** Files the asks queued so far, as the worker's job does. */
async function fileQueued(now = NOW) {
  const jobs = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, FILE_JOIN_REQUEST_JOB), eq(schema.outbox.status, "pending")))
    .orderBy(schema.outbox.id);
  for (const job of jobs) {
    await fileJoinRequest(deps(), job.payload, now);
    await f.db.update(schema.outbox).set({ status: "done" }).where(eq(schema.outbox.id, job.id));
  }
}
const ask = (input: Omit<Parameters<typeof askToJoin>[2], "token">, token: string, now = NOW) =>
  askToJoin(deps(), PUBLIC, { token, ...input }, now);
/** Asked signed out, then filed. */
async function typed(token: string, name: string, email: string, extra: { note?: string; locale?: string } = {}) {
  const asked = await ask({ user: null, name, email, ...extra }, token);
  await fileQueued();
  return asked;
}
/** Asked by a signed-in account; an unconfirmed one's request is filed by the job, as a typed one's. */
async function signedIn(token: string, user: { id: string }, note?: string, now = NOW) {
  const asked = await ask({ user, note }, token, now);
  await fileQueued(now);
  return asked;
}

const rows = () => f.db.select().from(schema.organizationJoinRequests);
const notices = () => f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "join_request"));
const emails = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"))).map(
    (r) => r.payload as { key: string; to: string[]; template: EmailTemplate },
  );
const joinEmails = async (kind: "join_request" | "join_answer") =>
  (await emails()).filter((e) => e.template.kind === kind);
const memberOf = async (userId: string) =>
  (
    await f.db
      .select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];

describe("asking to join through a link", () => {
  test("a typed request waits; admins get one merged notice, one push and one email an hour per language", async () => {
    const { token, link } = await start();
    const bob = await addMember(f.db, f.org.id, "admin", "bob");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, bob.id));
    await f.db
      .insert(schema.pushDevices)
      .values({ userId: bob.id, token: "ExponentPushToken[bob]", platform: "ios", locale: "en" });

    const asked = await typed(token, "  Ana   Souza ", " Ana@Example.COM ", {
      note: " Paula's new designer ",
      locale: "en",
    });
    expect(asked).toEqual({ status: "pending", email: "ana@example.com", created: true });
    const [row] = await rows();
    expect(row).toMatchObject({
      orgId: f.org.id,
      linkId: link.id,
      userId: null,
      email: "ana@example.com",
      name: "Ana Souza",
      note: "Paula's new designer",
      locale: "en",
      status: "pending",
      expiresAt: later(JOIN_REQUEST_TTL_DAYS),
    });
    const first = await notices();
    expect(first.map((n) => n.userId).sort()).toEqual([f.owner.id, bob.id].sort());
    for (const n of first) {
      expect(n).toMatchObject({
        waiting: true,
        count: 1,
        actors: [],
        latest: { title: "Ana Souza", names: ["Ana Souza"] },
        source: { label: "Acme" },
      });
    }
    const hour = `join-request:${f.org.id}:2026-10-26T10`;
    const sent = await joinEmails("join_request");
    expect(sent.map((e) => [e.key, e.to, e.template.locale]).sort()).toEqual([
      [hour, [f.owner.email], "pt-BR"],
      [`${hour}:en`, [bob.email], "en"],
    ]);
    expect(sent.find((e) => e.template.locale === "en")?.template).toMatchObject({
      kind: "join_request",
      orgName: "Acme",
      name: "Ana Souza",
      email: "ana@example.com",
      url: `https://agentes.test/org/${f.org.id}/settings/members?request=${row?.id}&do=approve`,
      denyUrl: `https://agentes.test/org/${f.org.id}/settings/members?request=${row?.id}&do=deny`,
    });
    expect(JSON.stringify(sent)).not.toContain("Paula");
    const pushes = async () =>
      (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "push.send"))).length;
    expect(await pushes()).toBe(1);

    // The same address again: the same answer, and nothing changes or goes out.
    expect(await typed(token, "Someone Else", "ana@example.com")).toEqual({
      status: "pending",
      email: "ana@example.com",
      created: true,
    });
    expect(await rows()).toHaveLength(1);
    expect((await notices()).map((n) => n.count)).toEqual([1, 1]);
    // Another person in the same hour: the notice merges (no second push), the hour's email was already sent.
    // It names both, the first to ask first (its time is hers).
    await typed(token, "Bruno Lima", "bruno@example.com");
    expect((await notices()).map((n) => [n.count, n.latest])).toEqual([
      [2, { title: "Bruno Lima", names: ["Ana Souza", "Bruno Lima"] }],
      [2, { title: "Bruno Lima", names: ["Ana Souza", "Bruno Lima"] }],
    ]);
    expect(await joinEmails("join_request")).toHaveLength(2);
    expect(await pushes()).toBe(1);
    // A third: still the first two by name, and the count.
    await typed(token, "Carla Dias", "carla@example.com");
    expect((await notices()).map((n) => [n.count, n.latest.names])).toEqual([
      [3, ["Ana Souza", "Bruno Lima"]],
      [3, ["Ana Souza", "Bruno Lima"]],
    ]);
  });

  test("a typed request gets the same answer after the same work whatever the address, and files only a new one", async () => {
    const { token } = await start();
    await typed(token, "Ana", "ana@example.com");
    const [ana] = await rows();
    await denyJoinRequest(deps(), f.owner.id, f.org.id, ana?.id ?? "", null, NOW);
    await typed(token, "Bia", "bia@example.com");
    const sent = (await emails()).length;
    // A new address, a member's, a waiting and a denied one: the same reply after the same statements, so how
    // long it takes tells nothing either. Only the job that files it looks at the address.
    const work = new Set<number>();
    for (const email of ["new@example.com", f.owner.email, "BIA@example.com", "ana@example.com"]) {
      const { result, queries } = await countQueries(() => ask({ user: null, name: "Eve", email }, token));
      expect(result).toEqual({ status: "pending", email: email.toLowerCase(), created: true });
      work.add(queries);
    }
    expect(work.size).toBe(1);
    expect([...work][0]).toBeGreaterThan(0);
    expect((await rows()).length).toBe(2);
    await fileQueued();
    expect((await rows()).map((r) => [r.email, r.name, r.status]).sort()).toEqual([
      ["ana@example.com", "Ana", "denied"],
      ["bia@example.com", "Bia", "pending"],
      ["new@example.com", "Eve", "pending"],
    ]);
    // The hour's email to the admins already went out.
    expect((await emails()).length).toBe(sent);
  });

  test("at most 50 wait in a workspace; requests that ran out don't count", async () => {
    const { token, link } = await start();
    await f.db.insert(schema.organizationJoinRequests).values(
      Array.from({ length: MAX_PENDING_JOIN_REQUESTS }, (_, i) => ({
        orgId: f.org.id,
        linkId: link.id,
        email: `p${i}@example.com`,
        name: `P${i}`,
        expiresAt: later(1),
      })),
    );
    await expect(typed(token, "Late", "late@example.com")).rejects.toMatchObject({ code: "join.full" });
    // Full, every typed address gets the same answer: a member's and a waiting one too.
    for (const email of [f.owner.email, "p3@example.com"]) {
      await expect(typed(token, "Eve", email)).rejects.toMatchObject({ code: "join.full" });
    }
    await f.db
      .update(schema.organizationJoinRequests)
      .set({ expiresAt: later(-1) })
      .where(eq(schema.organizationJoinRequests.email, "p0@example.com"));
    expect(await typed(token, "Late", "late@example.com")).toMatchObject({ created: true });
    await expect(typed(token, "P0 again", "p0@example.com")).rejects.toMatchObject({ code: "join.full" });
    // With room again, the one that ran out asks again: its row starts over.
    await f.db
      .delete(schema.organizationJoinRequests)
      .where(eq(schema.organizationJoinRequests.email, "p1@example.com"));
    expect(await typed(token, "P0 again", "p0@example.com")).toMatchObject({ created: true });
    const again = (await rows()).filter((r) => r.email === "p0@example.com");
    expect(again).toEqual([
      expect.objectContaining({ name: "P0 again", status: "pending", expiresAt: later(JOIN_REQUEST_TTL_DAYS) }),
    ]);
  });

  test("a link files 20 new requests an hour: a confirmed account asking again spends none of them", async () => {
    const { token, link } = await start();
    const confirmed = (name: string) => person(`${name}@example.com`, { verified: true });
    const bia = await confirmed("bia");
    expect(await signedIn(token, bia)).toMatchObject({ created: true });
    expect(await signedIn(token, bia)).toMatchObject({ created: false });
    // Bia's request was the 1st: with 18 more, Cai's is the 20th and Dan's waits.
    const hour = { limit: 20, windowMs: 3_600_000 };
    for (let i = 0; i < 18; i++) await limiter.consume(`join-request:link:${link.id}`, hour);
    expect(await signedIn(token, await confirmed("cai"))).toMatchObject({ created: true });
    await expect(signedIn(token, await confirmed("dan"))).rejects.toMatchObject({ code: "join.link_busy" });
    expect((await rows()).map((r) => r.email).sort()).toEqual(["bia@example.com", "cai@example.com"]);
  });

  test("signed in and confirmed: a member; a denied address hears it; a typed waiting request becomes theirs", async () => {
    const { token } = await start();
    await expect(signedIn(token, f.owner)).rejects.toMatchObject({ code: "join.member" });

    await typed(token, "Carl", "carl@example.com");
    const [carlRow] = await rows();
    await denyJoinRequest(deps(), f.owner.id, f.org.id, carlRow?.id ?? "", "Not now", NOW);
    const carl = await person("carl@example.com", { verified: true });
    await expect(signedIn(token, carl)).rejects.toMatchObject({ code: "join.denied" });
    expect(await joinStatus(f.db, carl, token, NOW)).toEqual({
      member: false,
      email: "carl@example.com",
      request: { status: "denied", reason: "Not now" },
    });

    await typed(token, "Impostor", "dora@example.com", { note: "let me in" });
    const dora = await person("dora@example.com", { verified: true });
    // Not hers until she asks: approving it now would send an invitation, not let her in.
    expect(await joinStatus(f.db, dora, token, NOW)).toMatchObject({ request: null });
    expect(await signedIn(token, dora, "Dora from sales")).toMatchObject({ created: false });
    const [doraRow] = (await rows()).filter((r) => r.email === "dora@example.com");
    expect(doraRow).toMatchObject({ userId: dora.id, name: dora.name, note: "Dora from sales", status: "pending" });
    expect(await joinStatus(f.db, dora, token, NOW)).toMatchObject({ request: { status: "pending" } });
  });

  test("an unconfirmed account asks like a typed address: no one else's denial, no one else's request", async () => {
    const { token } = await start();
    await typed(token, "Otto", "otto@corp.com");
    const [otto] = await rows();
    await denyJoinRequest(deps(), f.owner.id, f.org.id, otto?.id ?? "", "Not this team", NOW);
    await typed(token, "Paula Real", "paula@corp.com", { note: "Marina's new designer" });

    // Accounts with those addresses, never confirmed: anyone can sign up with an address that isn't theirs.
    const notOtto = await person("otto@corp.com");
    expect(await joinStatus(f.db, notOtto, token, NOW)).toEqual({
      member: false,
      email: "otto@corp.com",
      request: null,
    });
    expect(await signedIn(token, notOtto)).toEqual({ status: "pending", email: "otto@corp.com", created: true });
    expect(await joinStatus(f.db, notOtto, token, NOW)).toMatchObject({ request: null });
    const notPaula = await person("paula@corp.com");
    expect(await signedIn(token, notPaula, "please approve me quickly")).toMatchObject({ created: true });
    expect((await rows()).find((r) => r.email === "paula@corp.com")).toMatchObject({
      userId: null,
      name: "Paula Real",
      note: "Marina's new designer",
    });
    expect(await joinStatus(f.db, notPaula, token, NOW)).toMatchObject({ request: null });

    // What it asks itself is filed as its own, and its page still says nothing: that it was filed would tell, by
    // the difference with the two above, that an address already waited or was turned down.
    const gil = await person("gil@corp.com");
    await signedIn(token, gil, "Gil from ops");
    expect((await rows()).find((r) => r.email === "gil@corp.com")).toMatchObject({
      userId: gil.id,
      note: "Gil from ops",
      status: "pending",
    });
    expect(await joinStatus(f.db, gil, token, NOW)).toEqual({ member: false, email: "gil@corp.com", request: null });
    const [gilRow] = (await listWaitingJoinRequests(f.db, f.owner.id, f.org.id, NOW)).filter(
      (r) => r.email === "gil@corp.com",
    );
    expect(gilRow?.confirmed).toBe(false);
  });

  test("a link turned off, run out, or of a workspace on hold no longer works, and never says why", async () => {
    const { token, link } = await start();
    await f.db
      .update(schema.organizations)
      .set({ standing: "hold", standingReason: "Unpaid invoices" })
      .where(eq(schema.organizations.id, f.org.id));
    const held = await typed(token, "Ana", "ana@example.com").catch((e) => e);
    expect(held).toMatchObject({ code: "join.link_closed" });
    expect(JSON.stringify({ message: held.message, params: held.params })).not.toContain("Unpaid");
    await f.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, f.org.id));

    await f.db
      .update(schema.organizationInviteLinks)
      .set({ expiresAt: later(-1) })
      .where(eq(schema.organizationInviteLinks.id, link.id));
    await expect(typed(token, "Ana", "ana@example.com")).rejects.toMatchObject({ code: "join.link_closed" });

    const fresh = await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
    expect(fresh.made).toBe(true);
    await turnOffInviteLink(deps(), f.owner.id, f.org.id, fresh.link.id, NOW);
    await expect(typed(fresh.token, "Ana", "ana@example.com")).rejects.toMatchObject({ code: "join.link_closed" });
    await expect(typed("not-a-link", "Ana", "ana@example.com")).rejects.toMatchObject({ code: "join.link_closed" });

    // Turned off while an ask waited to be filed: it is filed under the same lock, and nothing outlives the link.
    const third = await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
    await ask({ user: null, name: "Late", email: "late@example.com" }, third.token);
    await turnOffInviteLink(deps(), f.owner.id, f.org.id, third.link.id, NOW);
    await fileQueued();
    expect(await rows()).toEqual([]);
  });
});

describe("answering", () => {
  test("approve: a confirmed account joins with the roles; anyone else gets an invitation, refreshed not doubled", async () => {
    const { token, link } = await start();
    const admin = await adminRoleId(f.db, f.org.id);
    const erin = await person("erin@example.com", { verified: true, locale: "en" });
    await signedIn(token, erin);
    const [erinRow] = await rows();
    expect(await listWaitingJoinRequests(f.db, f.owner.id, f.org.id, NOW)).toEqual([
      expect.objectContaining({ id: erinRow?.id, email: "erin@example.com", confirmed: true }),
    ]);
    expect(await approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, erinRow?.id ?? "", [admin], NOW)).toEqual({
      outcome: "joined",
    });
    expect((await memberOf(erin.id))?.role).toBe("member");
    expect(await memberRoleIds(f.db, f.org.id, erin.id)).toEqual([admin]);
    const general = await f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, erin.id)));
    expect(general).toHaveLength(1);
    const [used] = await f.db
      .select()
      .from(schema.organizationInviteLinks)
      .where(eq(schema.organizationInviteLinks.id, link.id));
    expect(used?.uses).toBe(1);
    const [answer] = await joinEmails("join_answer");
    expect(answer).toMatchObject({
      key: `join-answer:${erinRow?.id}`,
      to: ["erin@example.com"],
      template: {
        kind: "join_answer",
        locale: "en",
        outcome: "joined",
        orgName: "Acme",
        approverName: "ana",
        role: "member",
        crew: [{}],
        url: `https://agentes.test/org/${f.org.id}`,
      },
    });
    // Nothing left waiting: the admins' notice closed.
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
    await expect(
      approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, erinRow?.id ?? "", [], NOW),
    ).rejects.toMatchObject({ code: "join.answered" });

    // Typed (or an unconfirmed account): an invitation to the address, the one already waiting refreshed.
    const waiting = await createInvitation(
      f.db,
      f.owner.id,
      f.org.id,
      { email: "fay@example.com", roleIds: [admin] },
      NOW,
    );
    await typed(token, "Fay", "fay@example.com");
    const [fayRow] = (await rows()).filter((r) => r.email === "fay@example.com");
    const approved = await approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, fayRow?.id ?? "", [], NOW);
    const url = approved.outcome === "invited" ? approved.url : "";
    expect(approved.outcome).toBe("invited");
    expect(url).toStartWith("https://agentes.test/invite/");
    const invitations = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.email, "fay@example.com"));
    // Still out with the Admin role, it keeps it: approving never takes a role away.
    expect(invitations.map((i) => [i.id, i.roleIds, i.expiresAt, i.tokenHash])).toEqual([
      [waiting.invitation.id, [admin], later(7), sha256(url.split("/invite/")[1] ?? "")],
    ]);
    const [, invitedEmail] = await joinEmails("join_answer");
    expect(invitedEmail?.template).toMatchObject({ outcome: "invited", url, role: "member", locale: "en" });
    const [fayAfter] = (await rows()).filter((r) => r.email === "fay@example.com");
    expect(fayAfter).toMatchObject({ status: "approved", role: "member", invitationId: waiting.invitation.id });
    // The invitation opens sign-up for that address only.
    expect(await isSignupAllowed(f.db, "fay@example.com", { allowSignup: false, ownerByLink: false }, NOW)).toBe(true);

    await typed(token, "Gus", "gus@example.com");
    const [gusRow] = (await rows()).filter((r) => r.email === "gus@example.com");
    const member = await addMember(f.db, f.org.id, "member", "hal");
    await expect(
      approveJoinRequest(deps(), PUBLIC, member.id, f.org.id, gusRow?.id ?? "", [], NOW),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Only roles of this workspace.
    await expect(
      approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, gusRow?.id ?? "", [crypto.randomUUID()], NOW),
    ).rejects.toMatchObject({ code: "role.unknown" });
    await expect(
      approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, gusRow?.id ?? "", [], later(15)),
    ).rejects.toMatchObject({ code: "join.expired" });
  });

  test("an owner's invitation still out goes out again only from an owner, through approval or the invite form", async () => {
    const { token } = await start();
    const admin = await addMember(f.db, f.org.id, "admin", "adm");
    const first = await createInvitation(f.db, f.owner.id, f.org.id, { email: "co@example.com", role: "owner" }, NOW);
    await typed(token, "Co", "co@example.com");
    const [row] = await rows();
    await expect(approveJoinRequest(deps(), PUBLIC, admin.id, f.org.id, row?.id ?? "", [], NOW)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createInvitation(f.db, admin.id, f.org.id, { email: "co@example.com", role: "member" }, NOW),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(resendInvitation(f.db, admin.id, f.org.id, first.invitation.id, NOW)).rejects.toMatchObject({
      code: "forbidden",
    });
    const invitation = async () => (await f.db.select().from(schema.organizationInvitations))[0];
    expect(await invitation()).toMatchObject({ role: "owner", tokenHash: first.invitation.tokenHash });
    expect((await rows())[0]?.status).toBe("pending");

    expect(await approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, row?.id ?? "", [], NOW)).toMatchObject({
      outcome: "invited",
    });
    expect(await invitation()).toMatchObject({ id: first.invitation.id, role: "owner" });
    // Run out, an invitation is sent again with the role asked.
    await createInvitation(f.db, admin.id, f.org.id, { email: "co@example.com", role: "member" }, later(8));
    expect(await invitation()).toMatchObject({ id: first.invitation.id, role: "member" });
  });

  test("an approval shows on the link's page while it means something: they're in, or its invitation is out", async () => {
    const { token } = await start();
    const ana = await person("ana@example.com", { verified: true });
    await signedIn(token, ana);
    const [anaRow] = await rows();
    await approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, anaRow?.id ?? "", [], NOW);
    expect(await joinStatus(f.db, ana, token, NOW)).toMatchObject({ member: true, request: { status: "approved" } });
    // Removed later: the page asks again, and asking files a new request.
    await removeMember(f.db, f.owner.id, f.org.id, ana.id);
    expect(await joinStatus(f.db, ana, token, NOW)).toEqual({ member: false, email: "ana@example.com", request: null });
    expect(await signedIn(token, ana)).toMatchObject({ created: true });

    // Asked signed out, approved, then signed in with the address confirmed: the invitation finishes it.
    await typed(token, "Bo", "bo@example.com");
    const boRow = (await rows()).find((r) => r.email === "bo@example.com");
    const invited = await approveJoinRequest(deps(), PUBLIC, f.owner.id, f.org.id, boRow?.id ?? "", [], NOW);
    expect(invited.outcome).toBe("invited");
    const bo = await person("bo@example.com", { verified: true });
    expect(await joinStatus(f.db, bo, token, NOW)).toMatchObject({ request: { status: "approved" } });
    expect(await joinStatus(f.db, bo, token, later(8))).toMatchObject({ request: null });
    const [sent] = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.email, "bo@example.com"));
    await revokeInvitation(f.db, f.owner.id, f.org.id, sent?.id ?? "");
    expect(await joinStatus(f.db, bo, token, NOW)).toMatchObject({ request: null });
  });

  test("a request closes when its address joins another way, so nobody answers it and its notice goes", async () => {
    const { token } = await start();
    await typed(token, "Rui", "rui@example.com");
    const [row] = await rows();
    const invitation = await createInvitation(
      f.db,
      f.owner.id,
      f.org.id,
      { email: "rui@example.com", role: "member" },
      NOW,
    );
    const rui = await person("rui@example.com");
    await acceptInvitation(f.db, rui, invitation.token, NOW);
    expect(await rows()).toEqual([expect.objectContaining({ id: row?.id, status: "closed" })]);
    expect(await listWaitingJoinRequests(f.db, f.owner.id, f.org.id, NOW)).toEqual([]);
    await expect(denyJoinRequest(deps(), f.owner.id, f.org.id, row?.id ?? "", null, NOW)).rejects.toMatchObject({
      code: "join.answered",
    });
    expect(await joinEmails("join_answer")).toEqual([]);
    await settleJoinRequests(deps(), f.org.id, NOW);
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
  });

  test("deny: the reason goes to the person, escaped; the notice closes", async () => {
    const { token } = await start();
    await typed(token, "Ana", "ana@example.com", { locale: "en" });
    const [row] = await rows();
    await denyJoinRequest(deps(), f.owner.id, f.org.id, row?.id ?? "", "  Only <b>studio</b> people  ", NOW);
    const [denied] = await rows();
    expect(denied).toMatchObject({
      status: "denied",
      reason: "Only <b>studio</b> people",
      decidedByUserId: f.owner.id,
    });
    const [answer] = await joinEmails("join_answer");
    expect(answer?.template).toMatchObject({ outcome: "denied", reason: "Only <b>studio</b> people", locale: "en" });
    // No picture of the workspace's agents for someone it turned away.
    expect(answer?.template).not.toHaveProperty("crew");
    const rendered = renderEmail(answer?.template as EmailTemplate);
    expect(rendered.subject).toBe("Your request to join wasn't approved");
    expect(rendered.html).toContain(
      '“Only <span style="display:inline-block">&lt;b&gt;studio&lt;/b&gt; people”</span>',
    );
    expect(rendered.html).not.toContain("<b>studio</b>");
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "join_request.denied"));
    expect(audit.map((a) => a.details)).toEqual([{ withReason: true }]);
  });

  test("turning a link off closes its waiting requests without emailing anyone", async () => {
    const { token, link } = await start();
    await typed(token, "Ana", "ana@example.com");
    await typed(token, "Bia", "bia@example.com");
    const sent = (await emails()).length;
    expect(await turnOffInviteLink(deps(), f.owner.id, f.org.id, link.id, NOW)).toEqual({ closed: 2 });
    expect((await rows()).map((r) => r.status)).toEqual(["closed", "closed"]);
    expect((await emails()).length).toBe(sent);
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
    await expect(typed(token, "Cris", "cris@example.com")).rejects.toMatchObject({ code: "join.link_closed" });
    expect(await turnOffInviteLink(deps(), f.owner.id, f.org.id, link.id, NOW)).toEqual({ closed: 0 });
  });
});

describe("links", () => {
  test("one link shown again; a new one after turning it off; earlier random links verify and list without a URL", async () => {
    const { token, link } = await start();
    const again = await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
    expect(again).toMatchObject({ token, made: false, link: { id: link.id } });
    expect(link.expiresAt).toEqual(later(30));
    const [stored] = await f.db.select().from(schema.organizationInviteLinks);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.tokenHash).toBe(sha256(token));

    await turnOffInviteLink(deps(), f.owner.id, f.org.id, link.id, NOW);
    const next = await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
    expect(next.made).toBe(true);
    expect(next.token).not.toBe(token);

    const earlier = randomToken(32);
    await f.db.insert(schema.organizationInviteLinks).values({
      orgId: f.org.id,
      tokenHash: sha256(earlier),
      createdByUserId: f.owner.id,
      expiresAt: later(3),
      createdAt: later(-4),
    });
    expect((await findInviteLink(f.db, earlier))?.orgName).toBe("Acme");
    await typed(earlier, "Ana", "ana@example.com");
    const links = await listInviteLinks(f.db, SECRET, f.owner.id, f.org.id, NOW);
    expect(links.map((l) => [l.token, l.createdBy, l.waiting])).toEqual([
      [next.token, "ana", 0],
      [null, "ana", 1],
    ]);
    // The same link stays the one shown: earlier random ones are never it.
    expect((await inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW)).token).toBe(next.token);
  });

  test("a link token can't be accepted, and opens no sign-up", async () => {
    const { token } = await start();
    const ana = await person("ana@example.com");
    await expect(acceptInvitation(f.db, ana, token, NOW)).rejects.toMatchObject({ code: "invitation.ask_to_join" });
    await typed(token, "Ana", "ana@example.com");
    const closed = { allowSignup: false, ownerByLink: false };
    expect(await isSignupAllowed(f.db, "ana@example.com", closed, NOW)).toBe(false);
    expect(await isSignupAllowed(f.db, "new@example.com", closed, NOW)).toBe(false);
  });

  test("prune: requests answered or run out 90 days ago go; notices with nothing waiting close", async () => {
    const { token, link } = await start();
    await typed(token, "Waiting", "waiting@example.com");
    const old = (days: number) => later(-days);
    await f.db.insert(schema.organizationJoinRequests).values([
      {
        orgId: f.org.id,
        linkId: link.id,
        email: "denied@x.com",
        name: "D",
        status: "denied",
        decidedAt: old(91),
        expiresAt: old(80),
      },
      {
        orgId: f.org.id,
        linkId: link.id,
        email: "approved@x.com",
        name: "A",
        status: "approved",
        decidedAt: old(10),
        expiresAt: old(1),
      },
      { orgId: f.org.id, linkId: link.id, email: "ran-out@x.com", name: "R", status: "pending", expiresAt: old(91) },
      { orgId: f.org.id, linkId: link.id, email: "recent@x.com", name: "N", status: "pending", expiresAt: old(5) },
    ]);
    expect(await pruneJoinRequests(deps(), NOW)).toBe(2);
    expect((await rows()).map((r) => r.email).sort()).toEqual([
      "approved@x.com",
      "recent@x.com",
      "waiting@example.com",
    ]);
    expect((await notices()).some((n) => n.doneAt === null)).toBe(true);

    // The waiting one runs out too: the next prune closes the notice.
    await f.db
      .update(schema.organizationJoinRequests)
      .set({ expiresAt: old(1) })
      .where(eq(schema.organizationJoinRequests.email, "waiting@example.com"));
    expect(await pruneJoinRequests(deps(), NOW)).toBe(0);
    expect((await notices()).every((n) => n.doneAt !== null)).toBe(true);
  });
});

describe("words", () => {
  test("the admins' email: our words up top; the typed name inert and cut in the body; the address copies whole; both actions", () => {
    const name = `<script> ${"Souza ".repeat(20)}`.trim();
    for (const [locale, subject, deny] of [
      ["en", "Someone asks to join your workspace", "Deny"],
      ["pt-BR", "Alguém pede para entrar no seu workspace", "Recusar"],
    ] as const) {
      const e = renderEmail({
        kind: "join_request",
        locale,
        orgName: "Acme",
        name,
        email: "ana@example.com",
        url: "https://a.test/approve",
        denyUrl: "https://a.test/deny",
      });
      expect(e.subject).toBe(subject);
      expect(e.html).not.toContain("<script>");
      expect(e.html).toContain("&lt;script&gt; Souza");
      expect(e.html).toContain('href="https://a.test/deny"');
      expect(e.text).toContain(`${deny}: https://a.test/deny`);
      const [shown = "", address] =
        e.text
          .split("\n")
          .find((l) => l.startsWith("<script>"))
          ?.split(" · ") ?? [];
      expect(shown).toEndWith("…");
      expect(shown.length).toBeLessThanOrEqual(60);
      // A real link, so no client links it on its own, and no hair spaces to break a copied address.
      expect(address).toBe("ana@example.com");
      expect(e.html).toContain('<a class="ln-m" href="mailto:ana@example.com" style="color:#5c5c58;');
      expect(e.html).toContain(">ana@example.com</a>");
    }
  });

  test("the three answers in both languages, to an address that asked", () => {
    const answer = (locale: "en" | "pt-BR", outcome: "joined" | "invited" | "denied") =>
      renderEmail({
        kind: "join_answer",
        locale,
        outcome,
        orgName: "Acme",
        approverName: "Marina",
        role: "member",
        url: outcome === "denied" ? undefined : "https://a.test/x",
        reason: outcome === "denied" ? "Full <b>team</b>" : undefined,
      });
    const outcomes = ["joined", "invited", "denied"] as const;
    expect(outcomes.map((o) => answer("en", o).subject)).toEqual([
      "Your request to join was approved",
      "Your request to join was approved",
      "Your request to join wasn't approved",
    ]);
    expect(outcomes.map((o) => answer("pt-BR", o).subject)).toEqual([
      "Seu pedido para entrar foi aprovado",
      "Seu pedido para entrar foi aprovado",
      "Seu pedido para entrar não foi aprovado",
    ]);
    expect(answer("en", "joined").text).toContain("Marina approved your request. You joined Acme as a member.");
    expect(answer("pt-BR", "invited").text).toContain("Aceitar convite: https://a.test/x");
    // The address proved itself before asking: nothing for someone who never asked.
    for (const outcome of outcomes) {
      expect(answer("en", outcome).text).not.toContain("If you didn't ask");
      expect(answer("pt-BR", outcome).text).not.toContain("Se você não pediu");
    }
    expect(answer("en", "denied").text).toContain(
      "If you think it's a mistake, ask someone there to invite you by email.",
    );
    expect(answer("en", "denied").text).toContain("Their note: “Full <b>team</b>”");
    expect(answer("en", "denied").html).toContain("“Full &lt;b&gt;team&lt;/b&gt;”");
    expect(answer("en", "denied").html).not.toContain("https://a.test/x");
    expect(answer("en", "denied").html).toContain(
      'this address asked to join Acme <span style="display:inline-block">on agentes.chat.</span>',
    );
    expect(answer("pt-BR", "joined").html).toContain("este endereço pediu para entrar na Acme");
  });

  test("the push: who asks and where, in the phone's language", () => {
    const input = { kind: "join_request", waiting: true, title: "Ana Souza", label: "Acme" };
    expect(renderPush("en", input)).toEqual({ title: "Ana Souza asks to join Acme", body: "Tap to approve or deny." });
    expect(renderPush("pt-BR", input)).toEqual({
      title: "Ana Souza pede para entrar na Acme",
      body: "Toque para aprovar ou recusar.",
    });
  });
});
