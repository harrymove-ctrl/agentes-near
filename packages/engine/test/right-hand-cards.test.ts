import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  APP_PAGES,
  changeMemberRole,
  createRole,
  createSetupToolSource,
  createToolGateway,
  decideApproval,
  decideApprovals,
  listAudit,
  MAX_CARDS_PER_RUN_RIGHT_HAND,
  memberRoleIds,
  OFFER_APPROVALS_TOOL,
  OFFER_OPEN_PAGE_TOOL,
  openPersonAgentDm,
  PROPOSE_MEMBER_CHANGES_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  removeMember,
  rightHandPrompt,
  setMemberRoles,
  type ToolContext,
  undoAgentAction,
  WORKSPACE_ACTION_TOOL,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in their DM with it: its tools act for that person (`outside`: it relays outside content). */
async function lodiRun(fx: Fixture, userId: string, body: string, outside = false): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
  if (outside)
    await fx.db
      .update(schema.messages)
      .set({ meta: { readOutside: true } })
      .where(eq(schema.messages.id, trigger.id));
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

/** The newest card of `kind` in the workspace: its message id and `meta.actionCard`. */
async function lastCard(fx: Fixture, kind: string) {
  const rows = await fx.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.orgId, fx.org.id))
    .orderBy(schema.messages.createdAt);
  const m = rows.filter((r) => (r.meta.actionCard as { kind?: string } | undefined)?.kind === kind).at(-1);
  if (!m) throw new Error(`no ${kind} card`);
  return { id: m.id, card: m.meta.actionCard as { forUserId: string; params: Record<string, unknown> } };
}

/** What people applied from the right hand's cards (its own tool calls aside). */
const appliedVia = async (fx: Fixture, agentId: string) =>
  (await listAudit(fx.db, fx.owner.id, fx.org.id, { via: agentId })).rows
    .map((r) => r.action)
    .filter((a) => a !== "tool.call")
    .sort();

const later = () => new Date(Date.now() + 3_600_000);
async function pendingApproval(fx: Fixture, title: string) {
  const [row] = await fx.db
    .insert(schema.approvals)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `tool-${title}`,
      tool: "github_merge",
      scope: "github:pr.merge",
      params: { pr: 42 },
      actionHash: `hash-${title}`,
      title,
      expiresAt: later(),
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

test("only the right hand has them, and its prompt offers them instead of refusing", async () => {
  f = await setup({ rightHand: true });
  const lodi = await lodiOf(f);
  const names = (await gatewayOf(f).granted(await lodiRun(f, f.owner.id, "oi"))).map((t) => t.name);
  for (const tool of [OFFER_APPROVALS_TOOL, PROPOSE_MEMBER_CHANGES_TOOL, OFFER_OPEN_PAGE_TOOL, WORKSPACE_ACTION_TOOL])
    expect(names).toContain(tool);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const dev = await gatewayOf(f).granted({
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  });
  expect(dev.map((t) => t.name)).not.toContain(OFFER_APPROVALS_TOOL);
  expect(dev.map((t) => t.name)).not.toContain(WORKSPACE_ACTION_TOOL);
  const prompt = await rightHandPrompt(
    { db: f.db },
    { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
  );
  expect(prompt).not.toContain("# Never");
  for (const tool of [OFFER_APPROVALS_TOOL, PROPOSE_MEMBER_CHANGES_TOOL, OFFER_OPEN_PAGE_TOOL, WORKSPACE_ACTION_TOOL])
    expect(prompt).toContain(tool);
  // It does what the app lets the person do: roles are no longer only a screen it opens.
  expect(prompt).not.toMatch(/roles[^.]*: offer_open_page/);
  expect(prompt).toContain("Never ask for a key, password or token in the chat");
});

describe("offer_approvals", () => {
  test("lists what waits for this person; their click decides it, and the audit says via the right hand", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const merge = await pendingApproval(f, "Merge PR #42");
    const deploy = await pendingApproval(f, "Run deploy");
    const out = await call(f, await lodiRun(f, f.owner.id, "o que está esperando eu aprovar?"), OFFER_APPROVALS_TOOL, {
      why: "Duas ações do Dev esperam você.",
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("nothing is decided yet");
    const { id, card } = await lastCard(f, "approvals");
    expect(card.forUserId).toBe(f.owner.id);
    expect((card.params.approvalIds as string[]).sort()).toEqual([merge.id, deploy.id].sort());
    // Its body names no approval: a channel's readers (and its notifications) see the text, not each viewer's card.
    const [posted] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, id));
    expect(posted?.body).not.toContain("Merge PR #42");
    // Nothing was decided by posting it.
    const still = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, merge.id));
    expect(still[0]?.status).toBe("pending");

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, merge.id, {
      decision: "approve",
      via: id,
    });
    await decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      ids: [deploy.id],
      decision: "refuse",
      via: id,
    });
    expect(await appliedVia(f, lodi.id)).toEqual(["approval.approved", "approval.refused"]);
  });

  test("a card that doesn't list the approval adds no via; nothing waiting posts no card", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const nina = await addMember(f.db, f.org.id, "member", "Nina");
    const merge = await pendingApproval(f, "Merge PR #42");
    // Nina can't decide the Dev's merge: nothing waits for her.
    const none = await call(f, await lodiRun(f, nina.id, "tem algo pra eu aprovar?"), OFFER_APPROVALS_TOOL, {
      why: "x",
    });
    expect(none.content).toContain("Nothing waits for their decision");
    const other = await pendingApproval(f, "Other");
    await call(f, await lodiRun(f, f.owner.id, "aprova o outro"), OFFER_APPROVALS_TOOL, { why: "x" });
    const { id, card } = await lastCard(f, "approvals");
    await f.db
      .update(schema.messages)
      .set({
        meta: { actionCard: { ...card, kind: "approvals", params: { ...card.params, approvalIds: [other.id] } } },
      })
      .where(eq(schema.messages.id, id));
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, merge.id, {
      decision: "approve",
      via: id,
    });
    expect(await appliedVia(f, lodi.id)).toEqual([]);
  });
});

describe("propose_member_changes", () => {
  test("a row per change, applied by whoever may with the members' own rules, via the right hand", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const nina = await addMember(f.db, f.org.id, "member", "Nina");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    // Outside content read this turn: even what the owner may give waits on the card.
    const out = await call(
      f,
      await lodiRun(f, f.owner.id, "Nina vira dona e entra em Vendas, tira o Caio", true),
      PROPOSE_MEMBER_CHANGES_TOOL,
      {
        changes: [
          { person: "Nina", owner: true, add_roles: ["vendas"] },
          { person: "Caio", remove: true },
        ],
        why: "Nina assume a conta; Caio saiu da empresa.",
      },
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Nothing has changed yet");
    const { id, card } = await lastCard(f, "member_changes");
    expect(card.params.rows).toEqual([
      { userId: nina.id, name: "Nina", role: "owner" },
      { userId: nina.id, name: "Nina", addRoleIds: [sales.id], removeRoleIds: [] },
      { userId: caio.id, name: "Caio", remove: true },
    ]);
    // Nothing changed by posting it.
    const [still] = await f.db
      .select()
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, nina.id)));
    expect(still?.role).toBe("member");

    // A member's click is refused at the click, as on the members screen.
    await expect(changeMemberRole(f.db, caio.id, f.org.id, nina.id, "owner", { via: id })).rejects.toThrow();
    await changeMemberRole(f.db, f.owner.id, f.org.id, nina.id, "owner", { via: id });
    await setMemberRoles(f.db, f.owner.id, f.org.id, nina.id, [sales.id], { via: id });
    await removeMember(f.db, f.owner.id, f.org.id, caio.id, { via: id });
    expect(await appliedVia(f, lodi.id)).toEqual(["member.removed", "member.role_changed", "member.roles_changed"]);
  });

  test("roles the person may give, in their own words, apply at once with Undo; ownership stays on the card", async () => {
    f = await setup({ rightHand: true });
    const nina = await addMember(f.db, f.org.id, "member", "Nina");
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    const ctx = await lodiRun(f, f.owner.id, "Nina entra em Vendas e vira dona");
    const out = await call(f, ctx, PROPOSE_MEMBER_CHANGES_TOOL, {
      changes: [{ person: "Nina", owner: true, add_roles: ["vendas"] }],
      why: "Nina assume a conta.",
    });
    expect(out.content).toContain("Applied at once, with Undo under your reply: Nina (+ Vendas).");
    expect(await memberRoleIds(f.db, f.org.id, nina.id)).toEqual([sales.id]);
    const { card } = await lastCard(f, "member_changes");
    expect(card.params.rows).toEqual([{ userId: nina.id, name: "Nina", role: "owner" }]);
    const [receipt] = await f.db
      .select()
      .from(schema.agentActions)
      .where(and(eq(schema.agentActions.runId, ctx.runId), eq(schema.agentActions.kind, "workspace.changed")));
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await memberRoleIds(f.db, f.org.id, nina.id)).toEqual([]);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
    // Only roles: nothing left for a card.
    const only = await call(f, await lodiRun(f, f.owner.id, "Nina entra em Vendas"), PROPOSE_MEMBER_CHANGES_TOOL, {
      changes: [{ person: "Nina", add_roles: ["vendas"] }],
      why: "x",
    });
    expect(only.content).toContain("Say it is done.");
    expect(only.data).toBeUndefined();
  });

  test("an unknown person or role posts nothing and says why", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "tira o Zé");
    const nobody = await call(f, ctx, PROPOSE_MEMBER_CHANGES_TOOL, {
      changes: [{ person: "Zé", remove: true }],
      why: "x",
    });
    expect(nobody).toMatchObject({ isError: true, content: 'No one called "Zé" in this workspace.' });
    await addMember(f.db, f.org.id, "member", "Nina");
    const role = await call(f, ctx, PROPOSE_MEMBER_CHANGES_TOOL, {
      changes: [{ person: "Nina", add_roles: ["Marte"] }],
      why: "x",
    });
    expect(role.isError).toBe(true);
    expect(role.content).toContain("No role Marte");
  });
});

describe("offer_open_page", () => {
  test("billing, deleting the workspace, an agent's page: a card that opens the screen, which asks what it always asks", async () => {
    f = await setup({ rightHand: true });
    const nina = await addMember(f.db, f.org.id, "member", "Nina");
    const ctx = await lodiRun(f, f.owner.id, "quero apagar o workspace");
    const del = await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "delete_workspace", why: "Apagar o workspace." });
    expect(del.isError).toBeFalsy();
    expect((await lastCard(f, "open_page")).card.params).toEqual({
      page: "delete_workspace",
      why: "Apagar o workspace.",
    });
    await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "agent", agent: "@dev", why: "As instruções do Dev." });
    expect((await lastCard(f, "open_page")).card.params).toMatchObject({ page: "agent", agentId: f.agent.id });
    await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "channel", channel: "#general", why: "Configurar o canal." });
    expect((await lastCard(f, "open_page")).card.params).toMatchObject({ page: "channel", channelId: f.general.id });
    // A member's card still opens; the tool tells the agent they can't use it.
    const member = await call(f, await lodiRun(f, nina.id, "minha fatura"), OFFER_OPEN_PAGE_TOOL, {
      page: "billing",
      why: "A cobrança.",
    });
    expect(member.content).toContain("can't use that screen");
    const bad = await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "nowhere", why: "x" });
    expect(bad.isError).toBe(true);
    expect(Object.keys(APP_PAGES)).toContain("ai_accounts");
    const tasks = await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "task_manager", why: "O que está rodando." });
    expect(tasks.content).toContain("Task manager");
  });

  test("the right hand's card cap holds across every kind", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "abre tudo");
    for (let i = 0; i < MAX_CARDS_PER_RUN_RIGHT_HAND; i++)
      expect((await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "usage", why: "x" })).isError).toBeFalsy();
    const over = await call(f, ctx, OFFER_OPEN_PAGE_TOOL, { page: "usage", why: "x" });
    expect(over).toMatchObject({ isError: true });
  });
});
