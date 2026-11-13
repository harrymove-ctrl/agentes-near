import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  buildTeamWeek,
  calendarRange,
  commentIssue,
  createAgent,
  createChannel,
  createIssue,
  drainOutbox,
  getIssue,
  getIssueDetail,
  grantScopes,
  issueFromMessage,
  listApprovals,
  listIssues,
  listNotifications,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openPersonAgentDm,
  openTaskConversation,
  postPersonMessage,
  removeChannelMember,
  requireChannelAccess,
  searchVisible,
  setIssueAudience,
  updateIssue,
  userVisibleChannels,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const ISSUES = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));
const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** The fixture's owner and agent in a DM, a second person outside it, and the agent's tools there. */
async function inDm() {
  f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
  const other = await addMember(f.db, f.org.id, "member", "ada");
  const call = await toolsIn(dm.id);
  return { dm, other, call };
}

async function toolsIn(channelId: string) {
  const ctx = { ...(await runContext(f)), channelId };
  await f.db.update(schema.agentRuns).set({ channelId }).where(eq(schema.agentRuns.id, ctx.runId));
  return (name: string, input: Record<string, unknown>) =>
    f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
}

const made = async (call: Awaited<ReturnType<typeof toolsIn>>, title: string, more: Record<string, unknown> = {}) => {
  const answer = await call("create_issue", { title, ...more });
  if (answer?.type !== "result") throw new Error("no result");
  const issue = (answer.output.data as { issue?: { id: string; number: number } } | undefined)?.issue;
  if (!issue) throw new Error(`not created: ${answer.output.content}`);
  return issue;
};

describe("a task made in a private conversation stays there", () => {
  test("from a DM: the board, a direct link, the number and search show it only to who is in it", async () => {
    const { other, call, dm } = await inDm();
    const task = await made(call, "Reajuste do salário da Bia", { description: "Conversa reservada" });

    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: task.id })).channelId).toBe(dm.id);
    expect((await listIssues(f.db, person(f.owner.id), f.org.id)).map((i) => i.id)).toEqual([task.id]);

    expect(await listIssues(f.db, person(other.id), f.org.id)).toEqual([]);
    expect(await listIssues(f.db, person(other.id), f.org.id, { q: "salário" })).toEqual([]);
    await expect(getIssue(f.db, person(other.id), f.org.id, { id: task.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getIssueDetail(f.db, person(other.id), f.org.id, { number: task.number })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(updateIssue(deps(), person(other.id), f.org.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(commentIssue(deps(), person(other.id), f.org.id, task.id, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(openTaskConversation(f.db, person(other.id), f.org.id, task.id)).rejects.toBeInstanceOf(NotFoundError);

    await drainOutbox(f.db, f.handlers);
    const found = (visibleChannelIds: string[]) =>
      searchVisible(f.context, { orgId: f.org.id, text: "salário", visibleChannelIds, kinds: ["issue"] });
    expect(await found(await userVisibleChannels(f.db, f.org.id, other.id))).toEqual([]);
    const mine = await found(await userVisibleChannels(f.db, f.org.id, f.owner.id));
    expect(mine.map((h) => h.sourceId)).toEqual([task.id]);
  });

  test("from a private channel, the same; a public channel's stays the workspace's", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const outside = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const hidden = await made(await toolsIn(secret.id), "Fusão");
    const open = await made(await toolsIn(f.general.id), "Onboarding");
    expect((await listIssues(f.db, person(outside.id), f.org.id)).map((i) => i.id)).toEqual([open.id]);
    expect((await listIssues(f.db, person(f.owner.id), f.org.id)).map((i) => i.id).sort()).toEqual(
      [hidden.id, open.id].sort(),
    );
  });

  test("the agent lists it in that conversation; elsewhere it reaches it by id for who sees it, never in a list", async () => {
    const { call } = await inDm();
    const task = await made(call, "Fechar a folha");
    expect(await call("list_issues", {})).toMatchObject({ output: { content: expect.stringContaining("Fechar") } });
    expect(await call("comment_issue", { issue: task.id, text: "Comecei." })).toMatchObject({
      output: { content: `Commented on #${task.number}.` },
    });
    const elsewhere = await toolsIn(f.general.id);
    expect(await elsewhere("list_issues", {})).toMatchObject({ output: { content: "No issues." } });
    expect(await elsewhere("list_issues", { issue: task.id })).toMatchObject({
      output: { content: expect.stringContaining("Fechar") },
    });
  });

  test("realtime goes to the conversation, never to the whole workspace", async () => {
    const { call, dm } = await inDm();
    const toOrg: RealtimeEvent[] = [];
    const toDm: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => toOrg.push(e));
    f.pubsub.subscribe(channelTopic(dm.id), (e) => toDm.push(e));
    const task = await made(call, "Fechar a folha");
    await updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { status: "in_progress" });
    expect(toOrg.filter((e) => e.type.startsWith("issue."))).toEqual([]);
    expect(toDm.map((e) => e.type)).toEqual(expect.arrayContaining(["issue.created", "issue.updated"]));
  });

  test("someone outside can't be assigned, by an agent or a person, so nothing reaches them", async () => {
    const { other, call } = await inDm();
    const refused = await call("create_issue", { title: "Folha", assignee: "ada" });
    expect(refused).toMatchObject({ output: { isError: true, content: expect.stringContaining("can't see") } });

    const task = await made(call, "Fechar a folha");
    await expect(
      updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { assignee: { type: "person", id: other.id } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { status: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, other.id, f.org.id)).items).toEqual([]);
  });

  test("a due date shows on the calendar of who is in it only", async () => {
    const { other, call } = await inDm();
    await made(call, "Fechar a folha", { due_date: "2026-11-20" });
    const range = (userId: string) =>
      calendarRange({ db: f.db }, userId, f.org.id, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect((await range(f.owner.id)).deadlines.map((d) => d.title)).toEqual(["Fechar a folha"]);
    expect((await range(other.id)).deadlines).toEqual([]);
  });

  test("a step of a private task, and a task made in its own conversation, stay with it", async () => {
    const { other, call, dm } = await inDm();
    const parent = await made(call, "Fechar a folha");
    const step = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "Holerites",
      parentIssueId: parent.id,
    });
    expect(step.channelId).toBe(dm.id);
    await expect(
      createIssue(deps(), person(other.id), f.org.id, { title: "Olhar", parentIssueId: parent.id }),
    ).rejects.toBeInstanceOf(ValidationError);

    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, parent.id);
    const inside = await made(await toolsIn(at.channelId), "Passo no tópico");
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: inside.id })).channelId).toBe(dm.id);
    const said = await postPersonMessage(deps(), f.owner.id, f.org.id, at.channelId, {
      body: "Conferir os valores",
      threadId: at.rootId,
    });
    expect((await issueFromMessage(deps(), f.owner.id, f.org.id, said.id)).channelId).toBe(dm.id);
  });

  test("a workspace task's conversation and a room no person reads leave a task the workspace's", async () => {
    const { other } = await inDm();
    const open = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Aberta" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, open.id);
    const step = await made(await toolsIn(at.channelId), "Passo aberto");
    const seen = (await listIssues(f.db, person(other.id), f.org.id)).map((i) => i.id);
    expect(seen).toContain(step.id);

    const [room] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "routine-room", visibility: "private", kind: "dm", dmKey: "routine:x" })
      .returning();
    if (!room) throw new Error("no room");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: room.id, agentId: f.agent.id });
    const fromRoutine = await made(await toolsIn(room.id), "Da rotina");
    expect((await listIssues(f.db, person(other.id), f.org.id)).map((i) => i.id)).toContain(fromRoutine.id);
  });
});

describe("what still reads a private task", () => {
  test("the agent in a task's conversation reaches a step it made there", async () => {
    const { call } = await inDm();
    const parent = await made(call, "Fechar a folha");
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, parent.id);
    const inside = await toolsIn(at.channelId);
    const step = await made(inside, "Passo no tópico");
    expect(await inside("list_issues", {})).toMatchObject({
      output: { content: expect.stringContaining("Passo no tópico") },
    });
    expect(await inside("update_issue", { issue: step.id, status: "in_progress" })).toMatchObject({
      output: { content: expect.not.stringContaining("Failed") },
    });
  });

  test("an agent assigned from outside reaches its task from its conversation, not the rest of that DM", async () => {
    const { call } = await inDm();
    const outsider = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Fora", handle: "fora" },
      NEW_AGENT_DEFAULTS,
    );
    const task = await made(call, "Folha");
    await made(call, "Férias");
    await updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { assignee: { type: "agent", id: outsider.id } });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, task.id);
    const seen = await listIssues(f.db, { type: "agent", agentId: outsider.id, channelId: at.channelId }, f.org.id);
    expect(seen.map((i) => i.id)).toEqual([task.id]);
  });

  test("someone taken out of a private channel loses its task everywhere, its notifications too", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    const task = await made(await toolsIn(secret.id), "Fusão", { assignee: "bia" });
    const at = await openTaskConversation(f.db, person(bia.id), f.org.id, task.id);
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, bia.id, f.org.id)).items).toHaveLength(1);

    await removeChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id }, { pubsub: f.pubsub });

    expect(await listIssues(f.db, person(bia.id), f.org.id)).toEqual([]);
    await expect(getIssue(f.db, person(bia.id), f.org.id, { id: task.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toThrow();
    expect((await listNotifications({ db: f.db }, bia.id, f.org.id)).items).toEqual([]);
    expect(await userVisibleChannels(f.db, f.org.id, bia.id)).not.toContain(secret.id);
  });

  test("an approval card names a private task to nobody: an approver may be outside the conversation", async () => {
    const { call, dm } = await inDm();
    const hidden = await made(call, "Reajuste da Bia");
    const open = await made(await toolsIn(f.general.id), "Onboarding");
    const cardOf = async (issueId: string, channelId: string) => {
      const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, channelId, { body: "vai" });
      const [run] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId,
          threadRootId: msg.id,
          triggerMessageId: msg.id,
          trigger: "mention",
          hop: 1,
          issueId,
        })
        .returning();
      const [card] = await f.db
        .insert(schema.approvals)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId,
          runId: run?.id,
          threadRootId: msg.id,
          toolUseId: crypto.randomUUID(),
          tool: "github_merge",
          scope: "",
          params: {},
          actionHash: crypto.randomUUID(),
          title: "Merge",
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning();
      return card?.id;
    };
    const inDmCard = await cardOf(hidden.id, dm.id);
    const openCard = await cardOf(open.id, f.general.id);
    const approver = await addMember(f.db, f.org.id, "admin", "approver");
    const seen = await listApprovals(f.db, approver.id, f.org.id);
    expect(seen.find((a) => a.id === inDmCard)?.issue).toBeNull();
    expect(seen.find((a) => a.id === openCard)?.issue).toMatchObject({ title: "Onboarding" });
  });

  test("the weekly card counts and names nothing it can't show: closed tasks, and steps under a task everyone sees", async () => {
    const { other, call, dm } = await inDm();
    const end = new Date(Date.now() + 60_000);
    const week = (userId: string) =>
      buildTeamWeek(f.db, {
        orgId: f.org.id,
        userId,
        rightHandId: f.agent.id,
        start: new Date(end.getTime() - 7 * 86_400_000),
        end,
        timezone: "UTC",
      });
    for (const title of ["Folha", "Férias"]) {
      const task = await made(call, title);
      await f.db
        .update(schema.issues)
        .set({ status: "done", assigneeType: "agent", assigneeId: f.agent.id })
        .where(eq(schema.issues.id, task.id));
    }
    const parent = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Aberta" });
    const steps = [];
    for (const title of ["a", "b", "c"]) {
      steps.push(await made(call, title));
    }
    await f.db
      .update(schema.issues)
      .set({
        parentIssueId: parent.id,
        status: "todo",
        channelId: dm.id,
        updatedAt: new Date(end.getTime() - 3 * 86_400_000),
      })
      .where(
        inArray(
          schema.issues.id,
          steps.map((s) => s.id),
        ),
      );
    await f.db
      .update(schema.issues)
      .set({ status: "in_progress" })
      .where(eq(schema.issues.id, steps[0]?.id ?? ""));

    const inside = await week(f.owner.id);
    const outside = await week(other.id);
    expect(inside?.worked.filter((h) => h.kind === "tasks")).toHaveLength(1);
    expect(inside?.rows.filter((r) => r.kind === "stalled")).toHaveLength(1);
    expect(outside?.worked.filter((h) => h.kind === "tasks") ?? []).toEqual([]);
    expect(outside?.rows.filter((r) => r.kind === "stalled") ?? []).toEqual([]);
  });
});

describe("Mostrar para todos", () => {
  const everyone = { mode: "everyone" } as const;

  test("someone in the conversation shows a task to everyone; it reaches the board and search; nobody outside can", async () => {
    const { other, call } = await inDm();
    const task = await made(call, "Fechar a folha");
    await expect(setIssueAudience(deps(), person(other.id), f.org.id, task.id, everyone)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await setIssueAudience(deps(), person(f.owner.id), f.org.id, task.id, everyone);
    expect((await listIssues(f.db, person(other.id), f.org.id)).map((i) => i.id)).toEqual([task.id]);
    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "folha",
      visibleChannelIds: [],
      kinds: ["issue"],
    });
    expect(hits.map((h) => h.sourceId)).toEqual([task.id]);
  });

  test("a task a person made from a private message too: anyone who can edit it changes who sees it", async () => {
    f = await setup();
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const said = await postPersonMessage(deps(), f.owner.id, f.org.id, secret.id, { body: "Bug" });
    const task = await issueFromMessage(deps(), f.owner.id, f.org.id, said.id);
    expect(task.audience).toMatchObject({ mode: "people", channelId: secret.id });
    const open = await setIssueAudience(deps(), person(f.owner.id), f.org.id, task.id, everyone);
    expect(open).toMatchObject({ channelId: null, audience: { mode: "everyone" } });
  });
});

describe("the data migrations", () => {
  const run = async (name: string) =>
    f.db.execute(sql.raw(await Bun.file(new URL(`../../db/migrations/${name}.sql`, import.meta.url)).text()));
  const write = (agentId: string) =>
    f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(and(eq(schema.agentScopes.agentId, agentId), eq(schema.agentScopes.scope, "issues:write")));
  const agent = (handle: string) =>
    createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, NEW_AGENT_DEFAULTS);
  const drop = (ids: string[]) =>
    f.db
      .delete(schema.agentScopes)
      .where(and(inArray(schema.agentScopes.agentId, ids), eq(schema.agentScopes.scope, "issues:write")));

  test("every agent gets task writing: archived too; not one a person took it from or refused it to, nor the right hand", async () => {
    f = await setup();
    const plain = await agent("plain");
    const archived = await agent("arquivado");
    const turnedOff = await agent("desligado");
    const cardRefused = await agent("recusado");
    const cardRemoved = await agent("devolvido");
    const saved = await agent("salvo");
    const gone = await agent("apagado");
    const all = [plain, archived, turnedOff, cardRefused, cardRemoved, saved, gone].map((a) => a.id);
    await drop(all);
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));
    await f.db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, gone.id));
    const audited = (agentId: string, scopes: string[]) =>
      f.db.insert(schema.auditLog).values({
        orgId: f.org.id,
        actorType: "person",
        actorId: f.owner.id,
        action: "agent.access_changed",
        targetType: "agent",
        targetId: agentId,
        details: { scopes },
      });
    // Held it, then a later save left it out.
    await audited(turnedOff.id, ["issues:read", "issues:write"]);
    await audited(turnedOff.id, ["issues:read"]);
    // Saved with it off all along: never held it, so that says nothing.
    await audited(saved.id, ["issues:read"]);
    const card = (agentId: string, status: "approved" | "refused") =>
      f.db.insert(schema.approvals).values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        toolUseId: crypto.randomUUID(),
        tool: "request_permission",
        scope: "",
        params: { permission: "issues:write" },
        actionHash: crypto.randomUUID(),
        title: "Turn on: Issues",
        status,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await card(cardRefused.id, "refused");
    await card(cardRemoved.id, "approved");
    const [rightHand] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));

    await run("0228_agents_write_tasks");
    await run("0228_agents_write_tasks");

    for (const yes of [plain, archived, saved]) expect(await write(yes.id)).toHaveLength(1);
    for (const no of [turnedOff, cardRefused, cardRemoved, gone]) expect(await write(no.id)).toEqual([]);
    if (rightHand) expect(await write(rightHand.id)).toEqual([]);
  });

  test("an agent's task from a private conversation goes back to it, search included; one someone outside works on stays", async () => {
    const { other, call, dm } = await inDm();
    const tied = await made(call, "Fechar a folha");
    const assigned = await made(call, "Com alguém de fora");
    const commented = await made(call, "Comentada de fora");
    const noReceipt = await made(call, "Sem recibo");
    const fromPublic = await made(await toolsIn(f.general.id), "Do canal aberto");
    const ids = [tied, assigned, commented, noReceipt].map((t) => t.id);
    await drainOutbox(f.db, f.handlers);
    // As they were before: made for the whole workspace.
    await f.db.update(schema.issues).set({ channelId: null }).where(inArray(schema.issues.id, ids));
    await f.db
      .update(schema.searchDocuments)
      .set({ channelIds: [] })
      .where(inArray(schema.searchDocuments.sourceId, ids));
    await f.db
      .update(schema.issues)
      .set({ assigneeType: "person", assigneeId: other.id })
      .where(eq(schema.issues.id, assigned.id));
    await commentIssue(deps(), person(other.id), f.org.id, commented.id, "Vi aqui");
    await drainOutbox(f.db, f.handlers);
    await f.db.delete(schema.agentActions).where(eq(schema.agentActions.targetId, noReceipt.id));

    await run("0229_private_tasks");

    const channelOf = async (id: string) =>
      (await f.db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0]?.channelId;
    expect(await channelOf(tied.id)).toBe(dm.id);
    expect(await channelOf(assigned.id)).toBeNull();
    expect(await channelOf(commented.id)).toBeNull();
    expect(await channelOf(noReceipt.id)).toBeNull();
    expect(await channelOf(fromPublic.id)).toBeNull();
    const [doc] = await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.sourceId, tied.id));
    expect(doc?.channelIds).toEqual([dm.id]);
  });
});
