import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  acceptInvitation,
  approveJoinRequest,
  askToJoin,
  cancelSuggestion,
  changeMemberRole,
  claimJoinRequest,
  createInvitation,
  createRole,
  denyJoinRequest,
  type EmailTemplate,
  holdsInvitation,
  invitationMailProof,
  invitationState,
  invitationToken,
  inviteLink,
  inviteMany,
  joinStatus,
  listInvitationsWithStatus,
  listMySuggestions,
  listWaitingJoinRequests,
  MAX_PENDING_JOIN_REQUESTS,
  MAX_PENDING_SUGGESTIONS,
  MAX_SUGGESTIONS_PER_MEMBER,
  NotFoundError,
  noticeInvitationAccepted,
  previewInvitation,
  pruneJoinRequests,
  queueInvitationEmail,
  removeMember,
  renewInviteLink,
  resendInvitation,
  sendJoinCode,
  setInvitationRoles,
  sha256,
  spentClaimHash,
  suggestPerson,
} from "../src";
import { addMember, adminRoleId, type Fixture, SECRET, setup } from "./fixtures";

// ADR 0090: a link asks with a password, the account is made at approval; invitations keep their link; members
// suggest; the inviter hears who joined.

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const PUBLIC = "https://agentes.test";
const NOW = new Date("2026-10-31T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
let limiter = createMemoryRateLimiter();
const fx = () => f as Fixture;
const deps = () => ({ db: fx().db, pubsub: fx().pubsub, rateLimiter: limiter });

async function start() {
  f = await setup();
  limiter = createMemoryRateLimiter();
  return inviteLink(f.db, SECRET, f.owner.id, f.org.id, NOW);
}

const outboxEmails = async () =>
  (await fx().db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send")).orderBy(schema.outbox.id))
    .map((r) => r.payload as { key: string; to: string[]; template: EmailTemplate })
    .filter((p) => p.template.kind !== "join_code");

/** Proves `email` with the code its email carries, then asks signed out with a password (as the route hashed it). */
async function askWithPassword(token: string, email: string, passwordHash: string, secret: string) {
  await sendJoinCode(deps(), PUBLIC, { token, user: null, email, locale: "pt-BR" }, NOW);
  const [codeEmail] = (
    await fx().db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send")).orderBy(schema.outbox.id)
  )
    .map((r) => r.payload as { template: EmailTemplate })
    .filter((p) => p.template.kind === "join_code")
    .slice(-1);
  const code = codeEmail?.template.kind === "join_code" ? codeEmail.template.code : "";
  return askToJoin(
    deps(),
    PUBLIC,
    {
      token,
      user: null,
      name: "Rafael Costa",
      email,
      note: "Do financeiro",
      proofNeeded: true,
      code,
      passwordHash,
      claimHash: sha256(secret),
    },
    NOW,
  );
}

const requestOf = async (id: string) =>
  (await fx().db.select().from(schema.organizationJoinRequests).where(eq(schema.organizationJoinRequests.id, id)))[0];
const memberOf = async (userId: string) =>
  (
    await fx()
      .db.select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx().org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];

/** `n` requests waiting, as they are filed: through the link, or suggested by a member. */
async function insertWaiting(n: number, prefix: string, by: { linkId?: string; suggestedByUserId?: string }) {
  await fx()
    .db.insert(schema.organizationJoinRequests)
    .values(
      Array.from({ length: n }, (_, i) => ({
        orgId: fx().org.id,
        email: `${prefix}${i}@example.com`,
        name: `${prefix}${i}`,
        expiresAt: at(14),
        ...by,
      })),
    );
}

describe("asking through a link with a password (ADR 0090)", () => {
  test("approval makes the confirmed account with it and lets the page that asked in, once", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "rafael@example.com", "hash:rafael", "page-secret");
    expect(asked).toMatchObject({ status: "pending", created: true });
    const id = "requestId" in asked ? asked.requestId : null;
    expect(id).toBeTruthy();
    const key = `${id}.page-secret`;
    expect(await requestOf(id ?? "")).toMatchObject({ passwordHash: "hash:rafael", claimHash: sha256("page-secret") });
    // Nobody signs up through a link: no account until an admin answers.
    expect(await fx().db.select().from(schema.users).where(eq(schema.users.email, "rafael@example.com"))).toEqual([]);
    expect(await claimJoinRequest(fx().db, token, key, NOW)).toEqual({ status: "pending" });
    await expect(claimJoinRequest(fx().db, token, `${id}.wrong`, NOW)).rejects.toBeInstanceOf(NotFoundError);

    expect(await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id ?? "", [], NOW)).toEqual({
      outcome: "joined",
    });
    const [made] = await fx().db.select().from(schema.users).where(eq(schema.users.email, "rafael@example.com"));
    expect(made).toMatchObject({ name: "Rafael Costa", emailVerified: true });
    const [account] = await fx()
      .db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, made?.id ?? ""));
    expect(account).toMatchObject({ providerId: "credential", password: "hash:rafael", accountId: made?.id });
    expect(await memberOf(made?.id ?? "")).toBeTruthy();
    // The password lives in the account now, nowhere else.
    expect(await requestOf(id ?? "")).toMatchObject({ status: "approved", passwordHash: null, userId: made?.id });
    const answer = (await outboxEmails()).find((e) => e.template.kind === "join_answer");
    expect(answer?.template).toMatchObject({ outcome: "joined", url: `${PUBLIC}/org/${fx().org.id}` });

    expect(await claimJoinRequest(fx().db, token, key, NOW)).toEqual({
      status: "in",
      userId: made?.id ?? "",
      orgId: fx().org.id,
    });
    // Spent: the page (or a second one with the same key) reads it closed from then on, and signs in no one.
    expect((await requestOf(id ?? ""))?.claimHash).toBe(spentClaimHash(sha256("page-secret")));
    expect(await claimJoinRequest(fx().db, token, key, NOW)).toEqual({ status: "closed" });
    // Not even with the live hash itself, as someone who saw the row before could hand it in.
    const seen = `${id}.${sha256("page-secret")}`;
    await expect(claimJoinRequest(fx().db, token, seen, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an address with an account signs in as always; a denial keeps nothing of what they chose", async () => {
    const { token } = await start();
    await fx()
      .db.insert(schema.users)
      .values({ id: "u_bia", name: "Bia", email: "bia@example.com", emailVerified: true });
    const asked = await askWithPassword(token, "bia@example.com", "hash:bia", "bia-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id, [], NOW);
    expect(await memberOf("u_bia")).toBeTruthy();
    expect(await fx().db.select().from(schema.accounts).where(eq(schema.accounts.userId, "u_bia"))).toEqual([]);
    // The page's key is spent, not dropped: the page hears it closed instead of waiting on.
    expect(await requestOf(id)).toMatchObject({ passwordHash: null, claimHash: spentClaimHash(sha256("bia-secret")) });
    expect(await claimJoinRequest(fx().db, token, `${id}.bia-secret`, NOW)).toEqual({ status: "closed" });

    const other = await askWithPassword(token, "caio@example.com", "hash:caio", "caio-secret");
    const otherId = "requestId" in other ? (other.requestId ?? "") : "";
    await denyJoinRequest(deps(), fx().owner.id, fx().org.id, otherId, "Só o time interno", NOW);
    expect(await requestOf(otherId)).toMatchObject({ status: "denied", passwordHash: null });
    expect(await claimJoinRequest(fx().db, token, `${otherId}.caio-secret`, NOW)).toEqual({
      status: "denied",
      reason: "Só o time interno",
    });
  });

  test("joining another way closes the request, its page told so; a key is good for a day", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "gabi@example.com", "hash:gabi", "gabi-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    // An email invitation to the same address, accepted: the request closes, its password gone, its key spent.
    const [invited] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: ["gabi@example.com"] }, NOW);
    if (invited?.status !== "invited") throw new Error("expected an invitation");
    await fx().db.insert(schema.users).values({ id: "u_gabi", name: "Gabi", email: "gabi@example.com" });
    await acceptInvitation(fx().db, { id: "u_gabi", email: "gabi@example.com" }, invited.token, NOW);
    expect(await requestOf(id)).toMatchObject({
      status: "closed",
      passwordHash: null,
      claimHash: spentClaimHash(sha256("gabi-secret")),
    });
    expect(await claimJoinRequest(fx().db, token, `${id}.gabi-secret`, NOW)).toEqual({ status: "closed" });

    // Approved and made, but the page never came back: a day later its key signs in no one.
    const other = await askWithPassword(token, "hugo@example.com", "hash:hugo", "hugo-secret");
    const otherId = "requestId" in other ? (other.requestId ?? "") : "";
    await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, otherId, [], NOW);
    expect((await requestOf(otherId))?.claimHash).toBe(sha256("hugo-secret"));
    expect(await claimJoinRequest(fx().db, token, `${otherId}.hugo-secret`, at(2))).toEqual({ status: "closed" });
    await pruneJoinRequests(deps(), at(2));
    expect(await requestOf(otherId)).toMatchObject({ passwordHash: null, claimHash: null });
  });

  test("a request that runs out drops the password and the key", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "duda@example.com", "hash:duda", "duda-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    await pruneJoinRequests(deps(), at(15));
    expect(await requestOf(id)).toMatchObject({ passwordHash: null, claimHash: null });
  });

  test("a link gets 30 more days and stays the same", async () => {
    const { link, token } = await start();
    const { expiresAt } = await renewInviteLink(fx().db, fx().owner.id, fx().org.id, link.id, at(20));
    expect(expiresAt).toEqual(at(50));
    const [row] = await fx()
      .db.select()
      .from(schema.organizationInviteLinks)
      .where(eq(schema.organizationInviteLinks.id, link.id));
    expect(row?.tokenHash).toBe(sha256(token));
  });

  test("a page that took over an account's request never signs that account in", async () => {
    const { token } = await start();
    await fx()
      .db.insert(schema.users)
      .values({ id: "u_tom", name: "Tom", email: "tom@example.com", emailVerified: true });
    // The account asks; then a page signed out asks for its address, proven, with a password of its own.
    await askToJoin(deps(), PUBLIC, { token, user: { id: "u_tom" } }, NOW);
    const asked = await askWithPassword(token, "tom@example.com", "hash:tom", "tom-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    expect(await requestOf(id)).toMatchObject({ userId: "u_tom", claimHash: sha256("tom-secret") });
    const approval = await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id, [], NOW);
    expect(approval).toEqual({ outcome: "joined" });
    // Tom signs in as he always did: the page only hears it closed.
    expect(await claimJoinRequest(fx().db, token, `${id}.tom-secret`, NOW)).toEqual({ status: "closed" });
    expect(await fx().db.select().from(schema.accounts).where(eq(schema.accounts.userId, "u_tom"))).toEqual([]);
  });

  test("an account signed up for the address while the approval runs is never written over", async () => {
    const { token } = await start();
    const asked = await askWithPassword(token, "iris@example.com", "hash:iris", "iris-secret");
    const id = "requestId" in asked ? (asked.requestId ?? "") : "";
    // Someone signs up with the address just as the approval makes the account: theirs lands first.
    await fx().db.execute(
      sql.raw(
        "create function race() returns trigger language plpgsql as $$ begin if new.id <> 'u_iris' then " +
          "insert into users (id, name, email) values ('u_iris', 'Iris', new.email); end if; return new; end $$",
      ),
    );
    await fx().db.execute(sql.raw("create trigger race before insert on users for each row execute function race()"));
    const approval = await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id, [], NOW);
    // Not confirmed: it gets an invitation, as any account already there, and nothing of it changes.
    expect(approval.outcome).toBe("invited");
    const iris = await fx().db.select().from(schema.users).where(eq(schema.users.email, "iris@example.com"));
    expect(iris).toEqual([expect.objectContaining({ id: "u_iris", name: "Iris", emailVerified: false })]);
    expect(await fx().db.select().from(schema.accounts).where(eq(schema.accounts.userId, "u_iris"))).toEqual([]);
    expect(await requestOf(id)).toMatchObject({ status: "approved", passwordHash: null });
    expect(await claimJoinRequest(fx().db, token, `${id}.iris-secret`, NOW)).toEqual({ status: "closed" });
  });
});

describe("members suggest someone (ADR 0090)", () => {
  test("it waits with who suggested it, the admins are told, and its author can take it back", async () => {
    await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const { id } = await suggestPerson(
      deps(),
      carla.id,
      fx().org.id,
      { email: " Otto@Example.com ", note: "Design do site" },
      NOW,
    );
    const [waiting] = await listWaitingJoinRequests(fx().db, fx().owner.id, fx().org.id, NOW);
    expect(waiting).toMatchObject({ id, email: "otto@example.com", suggestedBy: "carla", verified: false });
    const notices = await fx()
      .db.select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "join_request"));
    expect(notices.map((n) => n.userId)).toEqual([fx().owner.id]);
    await expect(
      suggestPerson(deps(), carla.id, fx().org.id, { email: "otto@example.com" }, NOW),
    ).rejects.toMatchObject({ code: "join.waiting" });
    await expect(suggestPerson(deps(), carla.id, fx().org.id, { email: carla.email }, NOW)).rejects.toMatchObject({
      code: "join.member",
    });
    expect((await listMySuggestions(fx().db, carla.id, fx().org.id, NOW)).map((s) => s.id)).toEqual([id]);
    await cancelSuggestion(deps(), carla.id, fx().org.id, id, NOW);
    expect(await listMySuggestions(fx().db, carla.id, fx().org.id, NOW)).toEqual([]);
  });

  test("approving a suggestion sends an invitation: nobody proved the address", async () => {
    await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const { id } = await suggestPerson(deps(), carla.id, fx().org.id, { email: "lu@example.com" }, NOW);
    const approval = await approveJoinRequest(
      { ...deps(), secret: SECRET },
      PUBLIC,
      fx().owner.id,
      fx().org.id,
      id,
      [],
      NOW,
    );
    expect(approval.outcome).toBe("invited");
    // Its link is the one the list can copy.
    const [invitation] = await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET);
    expect(approval.outcome === "invited" && approval.url).toBe(`${PUBLIC}/invite/${invitation?.token}`);
  });

  test("a suggested address never asked: approving sends just the invitation, denying sends nothing", async () => {
    const { token } = await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const lu = await suggestPerson(deps(), carla.id, fx().org.id, { email: "lu@example.com" }, NOW);
    const mo = await suggestPerson(deps(), carla.id, fx().org.id, { email: "mo@example.com" }, NOW);
    const approval = await approveJoinRequest(
      { ...deps(), secret: SECRET },
      PUBLIC,
      fx().owner.id,
      fx().org.id,
      lu.id,
      [],
      NOW,
    );
    await denyJoinRequest(deps(), fx().owner.id, fx().org.id, mo.id, "Já temos design", NOW);
    const sent = await outboxEmails();
    expect(sent.filter((e) => e.template.kind === "join_answer")).toEqual([]);
    expect(sent.filter((e) => e.to.includes("mo@example.com"))).toEqual([]);
    const [toLu, ...more] = sent.filter((e) => e.to.includes("lu@example.com"));
    const url = approval.outcome === "invited" ? approval.url : "";
    // The link the approval shows, with the proof only the email carries (ADR 0090).
    expect(toLu?.template).toMatchObject({ kind: "invitation", inviterName: "ana" });
    expect((toLu?.template as { url?: string } | undefined)?.url).toMatch(new RegExp(`^${url}\\?mail=[\\w-]{43}$`));
    expect(more).toEqual([]);

    // Turned down, the suggestion isn't Mo's: Mo hears nothing of it and may still ask through the link.
    await fx().db.insert(schema.users).values({ id: "u_mo", name: "Mo", email: "mo@example.com", emailVerified: true });
    expect(await joinStatus(fx().db, { id: "u_mo" }, token, NOW)).toMatchObject({ request: null });
    expect(await askToJoin(deps(), PUBLIC, { token, user: { id: "u_mo" } }, NOW)).toMatchObject({ created: true });
  });

  test("someone suggested who asks through the link makes it their own ask, answered to them", async () => {
    const { token, link } = await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const { id } = await suggestPerson(deps(), carla.id, fx().org.id, { email: "rafael@example.com" }, NOW);
    const asked = await askWithPassword(token, "rafael@example.com", "hash:rafael", "rafa-secret");
    expect(asked).toMatchObject({ created: false, requestId: id });
    expect(await requestOf(id)).toMatchObject({ linkId: link.id, suggestedByUserId: null, name: "Rafael Costa" });
    expect(await listMySuggestions(fx().db, carla.id, fx().org.id, NOW)).toEqual([]);
    const approval = await approveJoinRequest(deps(), PUBLIC, fx().owner.id, fx().org.id, id, [], NOW);
    expect(approval).toEqual({ outcome: "joined" });
    const answers = (await outboxEmails()).filter((e) => e.template.kind === "join_answer");
    expect(answers).toEqual([expect.objectContaining({ to: ["rafael@example.com"] })]);
    // Through the link it asked with, its page signs in.
    expect(await claimJoinRequest(fx().db, token, `${id}.rafa-secret`, NOW)).toMatchObject({ status: "in" });
  });

  test("suggestions wait apart from the asks: 20 in a workspace, 5 from one member", async () => {
    const { token, link } = await start();
    const carla = await addMember(fx().db, fx().org.id, "member", "carla");
    const dani = await addMember(fx().db, fx().org.id, "member", "dani");
    const eli = await addMember(fx().db, fx().org.id, "member", "eli");
    const suggest = (by: { id: string }, email: string) => suggestPerson(deps(), by.id, fx().org.id, { email }, NOW);
    // The asks through the link are full: a member still suggests.
    await insertWaiting(MAX_PENDING_JOIN_REQUESTS, "ask", { linkId: link.id });
    for (let i = 0; i < MAX_SUGGESTIONS_PER_MEMBER; i++) await suggest(carla, `carla${i}@example.com`);
    // Five of one member's wait: the sixth waits for one of them, while the workspace has room.
    await expect(suggest(carla, "sixth@example.com")).rejects.toMatchObject({ code: "join.full" });
    await suggest(dani, "dani0@example.com");
    // Twenty wait: nobody suggests more.
    const rest = MAX_PENDING_SUGGESTIONS - MAX_SUGGESTIONS_PER_MEMBER - 1;
    await insertWaiting(rest, "eli", { suggestedByUserId: eli.id });
    await expect(suggest(dani, "dani1@example.com")).rejects.toMatchObject({ code: "join.full" });
    // Nor do suggestions fill the asks' room: one ask answered, the next is filed.
    await expect(askWithPassword(token, "l@example.com", "hash:l", "l")).rejects.toMatchObject({ code: "join.full" });
    await fx()
      .db.delete(schema.organizationJoinRequests)
      .where(eq(schema.organizationJoinRequests.email, "ask0@example.com"));
    expect(await askWithPassword(token, "n@example.com", "hash:n", "n")).toMatchObject({ created: true });
  });
});

describe("email invitations (ADR 0090)", () => {
  test("a link that stays the same, roles per person, channels, and the inviter told", async () => {
    await start();
    const admin = await adminRoleId(fx().db, fx().org.id);
    const [produto] = await fx()
      .db.insert(schema.channels)
      .values({ orgId: fx().org.id, name: "produto", createdByUserId: fx().owner.id })
      .returning();
    const results = await inviteMany(
      fx().db,
      fx().owner.id,
      fx().org.id,
      {
        invites: [{ email: "rita@example.com", roleIds: [admin] }, { email: "theo@example.com" }],
        channelIds: [produto?.id ?? ""],
        note: "Vem para a Acme",
        secret: SECRET,
      },
      NOW,
    );
    expect(results.map((r) => r.status)).toEqual(["invited", "invited"]);
    const rita = results[0];
    if (rita?.status !== "invited") throw new Error("expected an invitation");
    expect(rita.token).toBe(invitationToken(SECRET, rita.invitationId));

    const listed = await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET);
    expect(listed.find((i) => i.email === "rita@example.com")).toMatchObject({
      roleIds: [admin],
      channelIds: [produto?.id],
      token: rita.token,
      invitedBy: "ana",
    });
    expect(listed.find((i) => i.email === "theo@example.com")?.roleIds).toEqual([]);

    // Sending it again keeps its link.
    const again = await resendInvitation(fx().db, fx().owner.id, fx().org.id, rita.invitationId, at(1), SECRET);
    expect(again.token).toBe(rita.token);
    await setInvitationRoles(fx().db, fx().owner.id, fx().org.id, rita.invitationId, [], at(1));
    expect(
      (await listInvitationsWithStatus(fx().db, fx().owner.id, fx().org.id, NOW, SECRET)).find(
        (i) => i.email === "rita@example.com",
      )?.roleIds,
    ).toEqual([]);

    // The page knows the address has no account yet.
    expect(await previewInvitation(fx().db, rita.token, at(1))).toMatchObject({
      kind: "email",
      account: { exists: false, password: false, providers: [] },
    });
    await fx().db.insert(schema.users).values({ id: "u_rita", name: "Rita", email: "rita@example.com" });
    const fromEmail = { secret: SECRET, proof: invitationMailProof(SECRET, rita.invitationId) };
    const ritaUser = { id: "u_rita", email: "rita@example.com" };
    const joined = await acceptInvitation(fx().db, ritaUser, rita.token, at(1), fromEmail);
    expect(joined).toEqual({ orgId: fx().org.id, invitedBy: fx().owner.id });
    // In #produto too, and the address counts as confirmed: accepted from its email, the message reached that mailbox.
    const channels = await fx()
      .db.select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.userId, "u_rita"));
    expect(channels.map((c) => c.channelId)).toContain(produto?.id ?? "");
    const [user] = await fx().db.select().from(schema.users).where(eq(schema.users.id, "u_rita"));
    expect(user?.emailVerified).toBe(true);

    await noticeInvitationAccepted(
      deps(),
      { orgId: fx().org.id, inviterId: joined.invitedBy, userId: "u_rita" },
      at(1),
    );
    const [notice] = await fx()
      .db.select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "invitation_accepted"));
    expect(notice).toMatchObject({ userId: fx().owner.id });

    // A dead link says what happened; one that never was says nothing.
    expect(await invitationState(fx().db, rita.token, at(2))).toMatchObject({ state: "accepted", orgId: fx().org.id });
    const theo = results[1];
    if (theo?.status !== "invited") throw new Error("expected an invitation");
    expect(await invitationState(fx().db, theo.token, at(9))).toMatchObject({ state: "expired", invitedBy: "ana" });
    expect(await invitationState(fx().db, "nope", NOW)).toBeNull();
  });

  test("the note goes in the email, and every sending is its own email", async () => {
    await start();
    const [result] = await inviteMany(
      fx().db,
      fx().owner.id,
      fx().org.id,
      { emails: ["lia@example.com"], note: "Oi Lia", secret: SECRET },
      NOW,
    );
    if (result?.status !== "invited") throw new Error("expected an invitation");
    const send = () =>
      queueInvitationEmail(fx().db, {
        orgId: fx().org.id,
        invitationId: result.invitationId,
        email: "lia@example.com",
        role: "member",
        url: `${PUBLIC}/invite/${result.token}`,
        inviterId: fx().owner.id,
        secret: SECRET,
      });
    await send();
    await resendInvitation(fx().db, fx().owner.id, fx().org.id, result.invitationId, at(1), SECRET);
    await send();
    const sent = (await outboxEmails()).filter((e) => e.template.kind === "invitation");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.template).toMatchObject({ note: "Oi Lia" });
    // The email's link is the one an admin copies plus the proof only the message carries.
    const proof = invitationMailProof(SECRET, result.invitationId);
    expect(sent[0]?.template).toMatchObject({ url: `${PUBLIC}/invite/${result.token}?mail=${proof}` });
  });

  test("a channel the sender can't give refuses the invitation; a full workspace says so first", async () => {
    await start();
    const [secret] = await fx()
      .db.insert(schema.channels)
      .values({ orgId: fx().org.id, name: "diretoria", visibility: "private", createdByUserId: fx().owner.id })
      .returning();
    const admin = await addMember(fx().db, fx().org.id, "admin", "bruno");
    await expect(
      inviteMany(fx().db, admin.id, fx().org.id, { emails: ["x@example.com"], channelIds: [secret?.id ?? ""] }, NOW),
    ).rejects.toMatchObject({ code: "invitation.channel" });

    const [result] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: ["y@example.com"] }, NOW);
    if (result?.status !== "invited") throw new Error("expected an invitation");
    await fx().db.update(schema.organizations).set({ limitMembers: 2 }).where(eq(schema.organizations.id, fx().org.id));
    expect(await previewInvitation(fx().db, result.token, NOW)).toMatchObject({ full: true });
  });

  test("a batch takes `emails` or `invites`, never both", async () => {
    await start();
    const both = { emails: ["a@example.com"], invites: [{ email: "b@example.com" }] };
    await expect(inviteMany(fx().db, fx().owner.id, fx().org.id, both, NOW)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await fx().db.select().from(schema.organizationInvitations)).toEqual([]);
  });

  test("an invitation's roles change only while it works, from a workspace that may invite", async () => {
    await start();
    const admin = await adminRoleId(fx().db, fx().org.id);
    const [sent] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: ["nina@example.com"] }, NOW);
    if (sent?.status !== "invited") throw new Error("expected an invitation");
    const { invitationId } = sent;
    const setRoles = (roleIds: string[], now: Date) =>
      setInvitationRoles(fx().db, fx().owner.id, fx().org.id, invitationId, roleIds, now);
    expect(await setRoles([admin], at(1))).toEqual({ roleIds: [admin] });
    // Run out: sending it again is what brings it back.
    await expect(setRoles([], at(8))).rejects.toMatchObject({ code: "conflict" });
    // A workspace on hold changes no invitation.
    const acme = eq(schema.organizations.id, fx().org.id);
    await fx().db.update(schema.organizations).set({ standing: "hold" }).where(acme);
    await expect(setRoles([], at(1))).rejects.toMatchObject({ code: "org.paused" });
  });

  test("a private channel goes with an invitation only while whoever sent it is still in it", async () => {
    await start();
    const channel = async (name: string, visibility: "public" | "private") => {
      const [row] = await fx()
        .db.insert(schema.channels)
        .values({ orgId: fx().org.id, name, visibility, createdByUserId: fx().owner.id })
        .returning();
      return row?.id ?? "";
    };
    const produto = await channel("produto", "public");
    const diretoria = await channel("diretoria", "private");
    const ownerIn = { orgId: fx().org.id, channelId: diretoria, userId: fx().owner.id };
    await fx().db.insert(schema.channelMembers).values(ownerIn);
    const invite = async (email: string) => {
      const channelIds = [produto, diretoria];
      const [sent] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails: [email], channelIds }, NOW);
      if (sent?.status !== "invited") throw new Error("expected an invitation");
      return sent.token;
    };
    const accept = async (id: string, email: string, token: string) => {
      await fx().db.insert(schema.users).values({ id, name: id, email });
      await acceptInvitation(fx().db, { id, email }, token, NOW);
      const rows = await fx()
        .db.select({ channelId: schema.channelMembers.channelId })
        .from(schema.channelMembers)
        .where(eq(schema.channelMembers.userId, id));
      return rows.map((r) => r.channelId);
    };

    // Ana left #diretoria before Olga accepted: it is no longer hers to give, #produto still is.
    const olga = await invite("olga@example.com");
    const ownerRow = eq(schema.channelMembers.userId, fx().owner.id);
    await fx()
      .db.delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, diretoria), ownerRow));
    const olgaIn = await accept("u_olga", "olga@example.com", olga);
    expect(olgaIn).toContain(produto);
    expect(olgaIn).not.toContain(diretoria);

    // An invitation whose sender is gone gives no private channel either.
    await fx().db.insert(schema.channelMembers).values(ownerIn);
    const pia = await invite("pia@example.com");
    await fx()
      .db.update(schema.organizationInvitations)
      .set({ invitedByUserId: null })
      .where(eq(schema.organizationInvitations.email, "pia@example.com"));
    const piaIn = await accept("u_pia", "pia@example.com", pia);
    expect(piaIn).toContain(produto);
    expect(piaIn).not.toContain(diretoria);
  });

  test("an invitation gives only the roles its sender could still give, and none to someone already in", async () => {
    await start();
    const { db, org, owner } = fx();
    const devs = await createRole(db, owner.id, org.id, { name: "Devs" });
    const rolesOf = async (userId: string) => {
      const rows = await db
        .select({ role: schema.organizationMembers.role })
        .from(schema.organizationMembers)
        .where(and(eq(schema.organizationMembers.orgId, org.id), eq(schema.organizationMembers.userId, userId)));
      const roleIds = await db
        .select({ id: schema.organizationMemberRoles.roleId })
        .from(schema.organizationMemberRoles)
        .where(eq(schema.organizationMemberRoles.userId, userId));
      return { role: rows[0]?.role, roleIds: roleIds.map((r) => r.id) };
    };
    const accept = async (id: string, email: string, token: string) => {
      await db.insert(schema.users).values({ id, name: id, email }).onConflictDoNothing();
      await acceptInvitation(db, { id, email }, token, NOW);
      return rolesOf(id);
    };

    // Its sender was removed before it was accepted: the person comes in with no role from it.
    const adm = await addMember(db, org.id, "admin", "adm");
    const rita = await createInvitation(db, adm.id, org.id, { email: "rita@example.com", roleIds: [devs.id] }, NOW);
    await removeMember(db, owner.id, org.id, adm.id);
    expect((await previewInvitation(db, rita.token, NOW))?.invitedBy).toBeNull();
    expect(await accept("u_rita", "rita@example.com", rita.token)).toEqual({ role: "member", roleIds: [] });

    // An owner who invited an owner and was then made a member: the person comes in as a member.
    const bob = await addMember(db, org.id, "owner", "bob");
    const ze = await createInvitation(db, bob.id, org.id, { email: "ze@example.com", role: "owner" }, NOW);
    expect((await previewInvitation(db, ze.token, NOW))?.role).toBe("owner");
    await changeMemberRole(db, owner.id, org.id, bob.id, "member");
    expect(await previewInvitation(db, ze.token, NOW)).toEqual(
      expect.objectContaining({ role: "member", invitedBy: "bob" }),
    );
    expect(await accept("u_ze", "ze@example.com", ze.token)).toEqual({ role: "member", roleIds: [] });

    // Someone who joined another way meanwhile gets no roles from an old invitation.
    const lia = await createInvitation(db, owner.id, org.id, { email: "lia@example.com", roleIds: [devs.id] }, NOW);
    await db.insert(schema.users).values({ id: "u_lia", name: "u_lia", email: "lia@example.com" });
    await db.insert(schema.organizationMembers).values({ orgId: org.id, userId: "u_lia", role: "member" });
    expect(await accept("u_lia", "lia@example.com", lia.token)).toEqual({ role: "member", roleIds: [] });

    // A sender who still may give them: the roles go with it.
    const theo = await createInvitation(db, owner.id, org.id, { email: "theo@example.com", roleIds: [devs.id] }, NOW);
    expect(await accept("u_theo", "theo@example.com", theo.token)).toEqual({ role: "member", roleIds: [devs.id] });
  });

  test("only an invitation's own email proves the address: the sign-up skips confirming, accepting confirms", async () => {
    await start();
    const emails = ["nina@example.com", "olga@example.com"];
    const [nina, olga] = await inviteMany(fx().db, fx().owner.id, fx().org.id, { emails }, NOW);
    if (nina?.status !== "invited" || olga?.status !== "invited") throw new Error("expected invitations");
    const fromEmail = (invitationId: string) => ({ secret: SECRET, proof: invitationMailProof(SECRET, invitationId) });
    const holds = (email: string, token: string, mail: { secret: string; proof?: string }, now = NOW) =>
      holdsInvitation(fx().db, email, token, mail, now);
    expect(await holds(" Nina@Example.com", nina.token, fromEmail(nina.invitationId))).toBe(true);
    // The link alone, as an admin copies it: nothing shows the mailbox got the message.
    expect(await holds("nina@example.com", nina.token, { secret: SECRET })).toBe(false);
    // Another invitation's proof, another address's link, none, or one run out: the sign-up holds nothing.
    expect(await holds("nina@example.com", nina.token, fromEmail(olga.invitationId))).toBe(false);
    expect(await holds("nina@example.com", olga.token, fromEmail(olga.invitationId))).toBe(false);
    expect(await holds("nina@example.com", "", fromEmail(nina.invitationId))).toBe(false);
    expect(await holds("nina@example.com", nina.token, fromEmail(nina.invitationId), at(8))).toBe(false);

    // Accepted with the copied link, the address isn't confirmed (its own sign-up's message does that); from the
    // email, it is.
    await fx()
      .db.insert(schema.users)
      .values([
        { id: "u_nina", name: "Nina", email: "nina@example.com" },
        { id: "u_olga", name: "Olga", email: "olga@example.com" },
      ]);
    const verified = async (id: string) =>
      (await fx().db.select().from(schema.users).where(eq(schema.users.id, id)))[0]?.emailVerified;
    await acceptInvitation(fx().db, { id: "u_olga", email: "olga@example.com" }, olga.token, NOW, { secret: SECRET });
    expect(await verified("u_olga")).toBe(false);
    const ninaUser = { id: "u_nina", email: "nina@example.com" };
    await acceptInvitation(fx().db, ninaUser, nina.token, NOW, fromEmail(nina.invitationId));
    expect(await verified("u_nina")).toBe(true);
  });
});
