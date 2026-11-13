import { afterEach, expect, test } from "bun:test";
import { and, eq, like, schema } from "@agenteschat/db";
import {
  audienceMailLoss,
  ConflictError,
  createRole,
  createRoutine,
  decideApproval,
  deleteAccount,
  ForbiddenError,
  ingestMail,
  insertMessage,
  listApprovals,
  notifyApproval,
  type RoutineBrief,
  removeMember,
  setAgentAudience,
  setAgentBrain,
  setMemberRoles,
  type ToolContext,
  updateAgent,
} from "../src";
import { addMember, makeAdmin } from "./fixtures";
import { giveMail, imapAccount, type MailFixture, mailSetup } from "./mail-fixtures";

/**
 * A person's own mailbox (ADR 0038): only the people its owner let in reach it through the agent, at use time and
 * after the agent's audience or owner changes; and only its owner approves an email someone else asked to send.
 */

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

const WHY = "The customer asked for this and it answers their question; sending closes the request.";

/**
 * A run of the agent in #general started by `userId`'s message (a consultation's run roots in its person the same way).
 * `routine`: the message is the brief of a routine `userId` created, so nobody is behind the run but the routine.
 */
async function runFor(userId: string, routine = false): Promise<ToolContext> {
  const { f } = m;
  const brief: RoutineBrief = {
    routineId: crypto.randomUUID(),
    routineRunId: crypto.randomUUID(),
    name: "Salários",
    creatorUserId: userId,
    deliverTo: { channelId: f.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "check the mail",
    ...(routine ? { meta: { routineBrief: brief } } : {}),
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const mailTools = async (ctx: ToolContext) =>
  (await m.tools.list(ctx)).map((t) => t.name).filter((n) => n.startsWith("mail_"));

const mailScopes = async () =>
  m.f.db
    .select({ scope: schema.agentScopes.scope })
    .from(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, m.f.agent.id), like(schema.agentScopes.scope, "mail:%")));

test("someone the agent doesn't answer directly never reaches its owner's mailbox, through a consultation either", async () => {
  m = await mailSetup();
  const { f } = m;
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");

  expect(await mailTools(await runFor(f.owner.id))).toContain("mail_support_search");
  // Lia's run (hers, or one consulting the agent for her) has no tool of that mailbox.
  expect(await mailTools(await runFor(lia.id))).toEqual([]);
  const refused = await m.tools.invoke(await runFor(lia.id), {
    toolUseId: "tu_search",
    name: "mail_support_search",
    input: { text: "salário" },
  });
  expect(refused.type === "result" && refused.output.isError).toBe(true);

  // The mailbox's owner lets her in: then she reaches it, and the grant stays.
  await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [lia.id] });
  expect(await mailTools(await runFor(lia.id))).toContain("mail_support_search");
  expect((await mailScopes()).length).toBeGreaterThan(0);
});

test("an agent whose audience someone else widens, or that gets a new owner, loses the mailboxes others gave it", async () => {
  m = await mailSetup();
  const { f } = m;
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await makeAdmin(f.db, f.org.id, carla.id);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");

  // An admin opens it to everyone: the owner's mailbox no longer goes with it.
  await setAgentAudience(f.db, carla.id, f.org.id, f.agent.id, { mode: "everyone", userIds: [] });
  expect(await mailScopes()).toEqual([]);
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "agent.mail_access_changed"), eq(schema.auditLog.actorId, carla.id)));
  expect(audit?.details).toEqual({ accountId: account.id, level: "none", reason: "audience_widened" });

  // Given again for an owner-only agent, then handed to Carla: it goes again.
  await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
  await giveMail(m, account.id, "read");
  expect((await mailScopes()).length).toBeGreaterThan(0);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: carla.id });
  expect(await mailScopes()).toEqual([]);
});

test("before widening, the apps can ask which mailboxes would go: whose they are, and nothing is taken", async () => {
  m = await mailSetup();
  const { f } = m;
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await makeAdmin(f.db, f.org.id, carla.id);
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");

  const everyone = { mode: "everyone" as const, userIds: [] };
  expect(await audienceMailLoss(f.db, carla.id, f.org.id, f.agent.id, everyone)).toEqual([
    { accountId: account.id, address: account.address, ownerUserId: f.owner.id, ownerName: f.owner.name },
  ]);
  expect(
    await audienceMailLoss(f.db, carla.id, f.org.id, f.agent.id, { mode: "people", userIds: [carla.id] }),
  ).toHaveLength(1);
  expect((await mailScopes()).length).toBeGreaterThan(0);
  // Letting nobody new in, or the mailbox being the actor's own: nothing to ask.
  expect(await audienceMailLoss(f.db, carla.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] })).toEqual([]);
  expect(await audienceMailLoss(f.db, f.owner.id, f.org.id, f.agent.id, everyone)).toEqual([]);
  // Only who may change the audience asks.
  await expect(audienceMailLoss(f.db, lia.id, f.org.id, f.agent.id, everyone)).rejects.toBeInstanceOf(ForbiddenError);
});

test("a mailbox given after the person was asked refuses the save, so nothing is taken unasked", async () => {
  m = await mailSetup();
  const { f } = m;
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await makeAdmin(f.db, f.org.id, carla.id);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  const everyone = { mode: "everyone" as const, userIds: [] };

  // Asked when it held nothing, then the owner gave it a mailbox.
  await expect(setAgentAudience(f.db, carla.id, f.org.id, f.agent.id, everyone, [])).rejects.toBeInstanceOf(
    ConflictError,
  );
  const [kept] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  expect(kept?.audienceMode).toBe("owner");
  expect((await mailScopes()).length).toBeGreaterThan(0);

  await setAgentAudience(f.db, carla.id, f.org.id, f.agent.id, everyone, [account.id]);
  expect(await mailScopes()).toEqual([]);
});

test("an email in someone's own mailbox: they approve their own; asked by anyone else, only they decide", async () => {
  m = await mailSetup();
  const { f } = m;
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read_write");
  // Bia's own mailbox; the agent belongs to the workspace's owner, who may approve every action.
  await f.db.update(schema.mailAccounts).set({ createdByUserId: bia.id }).where(eq(schema.mailAccounts.id, account.id));
  const send = async (userId: string) => {
    const r = await m.tools.invoke(await runFor(userId), {
      toolUseId: `tu_${userId}`,
      name: "mail_support_send",
      input: { to: ["client@acme.com"], subject: "Proposta", body: "Segue a proposta.", why: WHY },
    });
    if (r.type !== "approval") throw new Error("expected an approval");
    return r.approval;
  };

  // (a) Bia asks: she decides it, and so may the owner.
  const own = await send(bia.id);
  expect(own.approvers).toEqual({ userIds: [bia.id], label: "bia", requestedBy: null, requesterDecides: false });
  const [hers] = await listApprovals(f.db, bia.id, f.org.id, { status: "pending" });
  expect(hers?.id).toBe(own.id);
  expect(hers?.canDecide).toBe(true);
  const ownersView = (await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" })).find(
    (a) => a.id === own.id,
  );
  expect(ownersView?.canDecide).toBe(true);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, own.id, { decision: "approve" });

  // (b) Caio asks to send from Bia's mailbox: the owner can't approve it, Caio neither; Bia does.
  const theirs = await send(caio.id);
  expect(theirs.approvers).toEqual({
    userIds: [bia.id],
    label: "bia",
    requestedBy: caio.id,
    requesterDecides: false,
    required: true,
  });
  const ownersNow = (await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" })).find(
    (a) => a.id === theirs.id,
  );
  expect(ownersNow?.canDecide).toBe(false);
  for (const who of [f.owner.id, caio.id]) {
    await expect(
      decideApproval({ db: f.db, pubsub: f.pubsub }, who, f.org.id, theirs.id, { decision: "approve" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
  const decided = await decideApproval({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, theirs.id, {
    decision: "approve",
  });
  expect(decided.status).toBe("approved");
});

/** The agent answers its owner alone and holds the owner's mailbox; `carla` is an admin. */
async function ownerOnlyWithMailbox(level: "read" | "read_write" = "read") {
  const { f } = m;
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await makeAdmin(f.db, f.org.id, carla.id);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, level);
  expect((await mailScopes()).length).toBeGreaterThan(0);
  return { carla, account };
}

test("an admin who lets an owner-only agent out through its brain settings takes the owner's mailbox from it", async () => {
  m = await mailSetup();
  const { carla } = await ownerOnlyWithMailbox();
  await setAgentBrain({ db: m.f.db }, carla.id, m.f.org.id, m.f.agent.id, { onlyOwner: false });
  expect(await mailScopes()).toEqual([]);
});

test("a consultation that roots in someone's routine is theirs: outside the audience, no mailbox", async () => {
  m = await mailSetup();
  const { f } = m;
  await ownerOnlyWithMailbox();
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  expect(await mailTools(await runFor(lia.id, true))).toEqual([]);
  expect(await mailTools(await runFor(f.owner.id, true))).toContain("mail_support_search");
});

test("someone who joins a role the agent answers gets no mailbox its owner gave it before", async () => {
  m = await mailSetup();
  const { f } = m;
  const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finance", permissions: ["talk_to_agents"] });
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "people", audienceRoleIds: [finance.id] })
    .where(eq(schema.agents.id, f.agent.id));
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read");
  expect((await mailScopes()).length).toBeGreaterThan(0);
  await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [finance.id]);
  expect(await mailScopes()).toEqual([]);
});

test("a mail watch stops feeding the routine once the agent lost the mailbox", async () => {
  m = await mailSetup();
  const { f } = m;
  const { carla, account } = await ownerOnlyWithMailbox();
  const routine = await createRoutine({ db: f.db, pubsub: f.pubsub, mail: m.mail }, f.owner.id, f.org.id, {
    agentId: f.agent.id,
    prompt: "Triage new mail",
    target: { type: "dm" },
    trigger: { type: "email", accountId: account.id, folder: "INBOX", filter: {} },
  });
  const [watch] = await f.db.select().from(schema.mailWatches).where(eq(schema.mailWatches.routineId, routine.id));
  if (!watch) throw new Error("no watch");
  await setAgentAudience(f.db, carla.id, f.org.id, f.agent.id, { mode: "everyone", userIds: [] });
  expect(await mailScopes()).toEqual([]);
  const mail = {
    id: "m1",
    from: { address: "boss@example.com" },
    to: [],
    cc: [],
    subject: "Salários",
    date: new Date().toISOString(),
    snippet: "the numbers",
    unread: true,
    hasAttachments: false,
  };
  expect(await ingestMail(m.deps, watch.id, [mail])).toEqual({ added: 0, fired: false });
});

test("a new owner takes over a card-less mailbox approval without taking it from the mailbox's owner", async () => {
  m = await mailSetup();
  const { f } = m;
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read_write");
  await f.db.update(schema.mailAccounts).set({ createdByUserId: bia.id }).where(eq(schema.mailAccounts.id, account.id));
  const r = await m.tools.invoke(await runFor(caio.id), {
    toolUseId: "tu_caio",
    name: "mail_support_send",
    input: { to: ["client@acme.com"], subject: "Proposta", body: "Segue a proposta.", why: WHY },
  });
  if (r.type !== "approval") throw new Error("expected an approval");
  expect(r.approval.messageId).toBeNull();
  await notifyApproval({ db: f.db, pubsub: f.pubsub }, r.approval, [bia.id]);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id }, { pubsub: f.pubsub });
  const items = await f.db
    .select()
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.userId, bia.id), eq(schema.notifications.groupKey, `approval:${r.approval.id}`)),
    );
  expect(items.map((n) => n.doneAt)).toEqual([null]);
});

/** Bia's own mailbox and the owner's, both given to the agent (read and send); one email waits in Bia's for her. */
async function biaAndOwnerMailboxes() {
  const { f } = m;
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const hers = await imapAccount(m, "bia@example.com");
  await giveMail(m, hers.id, "read_write");
  await f.db.update(schema.mailAccounts).set({ createdByUserId: bia.id }).where(eq(schema.mailAccounts.id, hers.id));
  const ours = await imapAccount(m, "support@example.com");
  await giveMail(m, ours.id, "read_write");
  const r = await m.tools.invoke(await runFor(caio.id), {
    toolUseId: "tu_waiting",
    name: "mail_bia_send",
    input: { to: ["client@acme.com"], subject: "Proposta", body: "Segue a proposta.", why: WHY },
  });
  if (r.type !== "approval") throw new Error("expected an approval");
  const grantsOn = async (accountId: string) =>
    (
      await f.db
        .select()
        .from(schema.agentScopes)
        .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.connectionId, accountId)))
    ).length;
  expect(await grantsOn(hers.id)).toBeGreaterThan(0);
  return { bia, caio, hers, ours, waiting: r.approval, grantsOn };
}

test("a member who leaves the workspace takes their mailbox from every agent; the others' stay", async () => {
  m = await mailSetup();
  const { f } = m;
  const { bia, caio, hers, ours, waiting, grantsOn } = await biaAndOwnerMailboxes();

  await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });

  expect(await grantsOn(hers.id)).toBe(0);
  expect(await grantsOn(ours.id)).toBeGreaterThan(0);
  const tools = await mailTools(await runFor(caio.id));
  expect(tools.filter((t) => t.startsWith("mail_bia_"))).toEqual([]);
  expect(tools).toContain("mail_support_send");
  const refused = await m.tools.invoke(await runFor(caio.id), {
    toolUseId: "tu_after",
    name: "mail_bia_send",
    input: { to: ["client@acme.com"], subject: "Proposta 2", body: "Segue a proposta.", why: WHY },
  });
  expect(refused.type === "result" && refused.output.isError).toBe(true);
  // The email waiting in her mailbox never goes, whoever would have decided it.
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, waiting.id));
  expect(row?.status).toBe("canceled");
  await expect(
    decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, waiting.id, { decision: "approve" }),
  ).rejects.toThrow();
  const audits = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "agent.mail_access_changed"), eq(schema.auditLog.actorId, f.owner.id)));
  expect(audits.map((a) => a.details)).toContainEqual({ accountId: hers.id, level: "none", reason: "owner_left" });
});

test("a member who deletes their account takes their mailbox from every agent before it is nobody's", async () => {
  m = await mailSetup();
  const { f } = m;
  const { bia, hers, ours, grantsOn } = await biaAndOwnerMailboxes();
  await deleteAccount(f.db, bia.id, { pubsub: f.pubsub });
  expect(await grantsOn(hers.id)).toBe(0);
  expect(await grantsOn(ours.id)).toBeGreaterThan(0);
});
