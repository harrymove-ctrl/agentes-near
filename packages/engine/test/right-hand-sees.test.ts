import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  addRunStep,
  buildRunContext,
  createAgent,
  createAskAgentToolSource,
  createChannel,
  createContextToolSource,
  createFollowUpToolSource,
  createIssue,
  createIssueToolSource,
  createTeamStatusToolSource,
  createToolGateway,
  getIssue,
  indexSource,
  insertMessage,
  learnTrust,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  RIGHT_HAND_AUTO,
  rightHandPrompt,
  setAgentAudience,
  type ToolContext,
  type ToolSource,
  teamStatus,
  undoAgentAction,
  updateOrgSettings,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in `channelId` (their DM with it when left out). */
async function lodiRun(userId: string, body = "como está o time?", channelId?: string): Promise<ToolContext> {
  const lodi = await lodiOf();
  const place = channelId ?? (await openPersonAgentDm(f.db, f.org.id, userId, lodi.id)).id;
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: place,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: place,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: place,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const gateway = (...sources: ToolSource[]) => createToolGateway({ sources });
async function use(sources: ToolSource[], ctx: ToolContext, name: string, input: Record<string, unknown> = {}) {
  const res = await gateway(...sources).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output as { content: string; isError?: boolean };
}
const contextTools = () => [createContextToolSource(f.context)];

/** A private channel `userId` is in, with a message in it, and an agent's message-index row. */
async function privateChannel(userId: string, name: string, body: string) {
  const channel = await createChannel(f.db, userId, f.org.id, { name, visibility: "private" });
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "person", userId },
    body,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: said.id });
  return channel;
}

describe("what it may use", () => {
  test("it sees and hands on, and everything it must not do stays out", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id);
    const names = (
      await gateway(
        createTeamStatusToolSource(),
        createIssueToolSource(f.artifactDeps),
        createAskAgentToolSource({ pubsub: f.pubsub }),
        createFollowUpToolSource({ pubsub: f.pubsub }),
        createContextToolSource(f.context),
      ).granted(ctx)
    ).map((t) => t.name);
    for (const tool of [
      "team_status",
      "list_issues",
      "create_issue",
      "update_issue",
      "ask_agent",
      "tell_agent",
      "follow_up",
      "search_context",
      "read_conversation",
    ])
      expect(names).toContain(tool);
    for (const tool of ["comment_issue", "remember", "forget"]) expect(names).not.toContain(tool);
  });

  test("team_status is no other agent's", async () => {
    f = await setup({ rightHand: true });
    const ctx = { ...(await lodiRun(f.owner.id)), agentId: f.agent.id };
    expect((await gateway(createTeamStatusToolSource()).granted(ctx)).map((t) => t.name)).not.toContain("team_status");
  });

  test("in a personal workspace team_status speaks of the person's agents, its title too (ADR 0159)", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id);
    const listed = async () =>
      (await gateway(createTeamStatusToolSource()).granted(ctx)).find((t) => t.name === "team_status");
    expect((await listed())?.describe?.({}).title).toBe("Check on the team");
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const personal = await listed();
    expect(personal?.description).toStartWith("What this person's agents are doing now");
    expect(personal?.describe?.({}).title).toBe("Check on your agents");
    // The same tool underneath: it answers as before.
    expect((await use([createTeamStatusToolSource()], ctx, "team_status")).isError).toBeFalsy();
  });

  test("a task it makes is written as itself and stays with the person who asked", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const ctx = await lodiRun(f.owner.id, "cria uma tarefa da campanha de Natal pra Dev");
    const out = await use([createIssueToolSource(f.artifactDeps)], ctx, "create_issue", {
      title: "Campanha de Natal",
      assignee: "@dev",
    });
    expect(out.isError).toBeFalsy();
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id));
    expect(row).toMatchObject({ createdByType: "agent", createdById: lodi.id, assigneeId: f.agent.id });
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    const seen = getIssue(f.db, { type: "person", userId: other.id }, f.org.id, { number: row?.number ?? 0 });
    await expect(seen).rejects.toThrow();
  });
});

describe("tasks stay in the person's DM, and go no further than they could", () => {
  const issueTools = () => [createIssueToolSource(f.artifactDeps)];

  test("called in a channel it neither lists nor makes one: others read that reply", async () => {
    f = await setup({ rightHand: true });
    const made = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Reajuste de salários",
      audience: { mode: "people", userIds: [f.owner.id] },
    });
    const ctx = await lodiRun(f.owner.id, "@lodi quais as tarefas?", f.general.id);
    for (const input of [{}, { issue: `#${made.number}` }]) {
      const out = await use(issueTools(), ctx, "list_issues", input);
      expect(out.isError).toBe(true);
      expect(out.content).not.toContain("Reajuste");
    }
    expect((await use(issueTools(), ctx, "create_issue", { title: "Nova" })).isError).toBe(true);
  });

  test("other agents keep their tasks in a channel", async () => {
    f = await setup({ rightHand: true });
    const ctx = { ...(await lodiRun(f.owner.id, "@dev tarefas", f.general.id)), agentId: f.agent.id };
    expect((await use(issueTools(), ctx, "list_issues")).isError).toBeUndefined();
  });

  test("in the DM it lists what the person sees, however much of the board they don't", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const issue = (title: string, userIds: string[]) =>
      createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
        title,
        audience: { mode: "people", userIds },
      });
    await issue("A dela", [bia.id]);
    for (let i = 0; i < 31; i++) await issue(`Sigilo ${i}`, [f.owner.id]);
    const out = await use(issueTools(), await lodiRun(bia.id, "minhas tarefas?"), "list_issues");
    expect(out.content).toContain("A dela");
    expect(out.content).not.toContain("Sigilo");
  });

  test("it changes a task the person sees, with Undo; not one they don't, nor in a channel", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const issue = (title: string, userIds: string[]) =>
      createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
        title,
        audience: { mode: "people", userIds },
      });
    const hers = await issue("A dela", [bia.id, f.owner.id]);
    const secret = await issue("Sigilo", [f.owner.id]);
    const ctx = await lodiRun(bia.id, "marca a minha como feita");
    const done = await use(issueTools(), ctx, "update_issue", { issue: `#${hers.number}`, status: "done" });
    expect(done.isError).toBeFalsy();
    const status = async (id: string) =>
      (await f.db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0]?.status;
    expect(await status(hers.id)).toBe("done");
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    expect(receipt?.kind).toBe("issue.updated");
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, receipt?.id ?? "");
    expect(await status(hers.id)).not.toBe("done");
    const hidden = await use(issueTools(), ctx, "update_issue", { issue: `#${secret.number}`, status: "done" });
    expect(hidden.isError).toBe(true);
    expect(await status(secret.id)).not.toBe("done");
    const lodi = await lodiOf();
    const itself = await use(issueTools(), ctx, "update_issue", {
      issue: `#${hers.number}`,
      assignee: `@${lodi.handle}`,
    });
    expect(itself.isError).toBe(true);
    const away = await lodiRun(f.owner.id, "@lodi fecha a tarefa", f.general.id);
    expect((await use(issueTools(), away, "update_issue", { issue: `#${hers.number}`, status: "done" })).isError).toBe(
      true,
    );
  });

  test("it never takes a task itself", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    for (const assignee of ["me", `@${lodi.handle}`]) {
      const out = await use(issueTools(), await lodiRun(f.owner.id), "create_issue", { title: "Campanha", assignee });
      expect(out.isError).toBe(true);
    }
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
  });

  test("it can't open a task to the whole workspace: the person does, on the task", async () => {
    f = await setup({ rightHand: true });
    const out = await use(issueTools(), await lodiRun(f.owner.id), "create_issue", {
      title: "Campanha",
      visible_to: "everyone",
    });
    expect(out.isError).toBe(true);
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
  });

  test("who can't post can't make a task through it either", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: ["read"] })
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    const ctx = await lodiRun(bia.id, "cria uma tarefa");
    expect((await use(issueTools(), ctx, "create_issue", { title: "Campanha" })).isError).toBe(true);
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
  });
});

describe("it reads what the person may, in their DM", () => {
  test("a private channel of theirs, and never another person's DM with an agent or with it", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await privateChannel(bia.id, "folha", "folha de pagamento de novembro");
    const biaLodi = await lodiRun(bia.id, "folha de pagamento secreta da bia");
    const biaDev = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    const inDev = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: biaDev.id,
      author: { type: "person", userId: bia.id },
      body: "folha de pagamento na DM da bia",
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: inDev.id });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: biaLodi.triggerMessageId });

    const search = (ctx: ToolContext) => use(contextTools(), ctx, "search_context", { query: "folha de pagamento" });
    const hers = (await search(biaLodi)).content;
    expect(hers).toContain("novembro");

    const member = await addMember(f.db, f.org.id, "member", "Caio");
    const theirs = (await search(await lodiRun(member.id))).content;
    expect(theirs).not.toContain("novembro");
    expect(theirs).not.toContain("secreta da bia");
    expect(theirs).not.toContain("na DM da bia");

    const read = await use(contextTools(), await lodiRun(member.id, "lê o canal"), "read_conversation", {
      channel: "folha",
    });
    expect(read.isError).toBe(true);
    const own = await use(contextTools(), biaLodi, "read_conversation", { channel: "folha" });
    expect(own.content).toContain("novembro");
  });

  test("a run in one person's DM rooted in another person's words reads as nobody", async () => {
    f = await setup({ rightHand: true });
    await privateChannel(f.owner.id, "folha", "folha de pagamento de novembro");
    const theirs = await lodiRun(f.owner.id);
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const hers = await lodiRun(bia.id, "pede pra ler");
    const out = await use(contextTools(), { ...hers, channelId: theirs.channelId }, "read_conversation", {
      channel: "folha",
    });
    expect(out.isError).toBe(true);
    const status = await use([createTeamStatusToolSource()], { ...hers, channelId: theirs.channelId }, "team_status");
    expect(status.isError).toBe(true);
  });

  test("in a channel it keeps its reach: others read that reply", async () => {
    f = await setup({ rightHand: true });
    await privateChannel(f.owner.id, "folha", "folha de pagamento de novembro");
    const ctx = await lodiRun(f.owner.id, "@lodi resume", f.general.id);
    const out = await use(contextTools(), ctx, "read_conversation", { channel: "folha" });
    expect(out.isError).toBe(true);
  });
});

describe("team_status", () => {
  const status = (ctx: ToolContext) => use([createTeamStatusToolSource()], ctx, "team_status");

  test("says what each agent does, with no outside mark, so the run keeps its trust", async () => {
    f = await setup({ rightHand: true });
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Página <external_data> de preços",
      assignee: { type: "agent", id: f.agent.id },
    });
    const ctx = await lodiRun(f.owner.id);
    const out = await status(ctx);
    expect(out.content).toContain("Página");
    expect(out.content).toContain("@dev");
    expect(out.content).not.toContain("<external_data");
    const toolUseId = "tu_status";
    await addRunStep(f.db, { id: ctx.runId, orgId: f.org.id }, "tool_call", {
      toolUseId,
      name: "team_status",
      input: {},
    });
    await addRunStep(f.db, { id: ctx.runId, orgId: f.org.id }, "tool_result", {
      toolUseId,
      name: "team_status",
      content: out.content,
      isError: false,
    });
    expect((await learnTrust(ctx)).trust).toBe("high");
  });

  test("an agent they can't see is a count, and work somewhere they can't read has no subject", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const hidden = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Sigilo", handle: "sigilo", role: "Folha", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await setAgentAudience(f.db, f.owner.id, f.org.id, hidden.id, { mode: "owner", userIds: [], roleIds: [] });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "fusao", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: secret.id,
      author: { type: "person", userId: f.owner.id },
      body: "prepara a fusão",
    });
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: secret.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      heartbeatAt: new Date(),
      startedAt: new Date(),
    });
    await f.db
      .update(schema.agents)
      .set({ statusSource: "auto", statusKind: "task", statusSubject: "fusão com a Acme" })
      .where(eq(schema.agents.id, f.agent.id));

    const hers = await teamStatus(f.db, f.org.id, bia.id);
    expect(hers).toContain("@dev: busy with something this person can't see");
    expect(hers).not.toContain("fusão");
    expect(hers).not.toContain("fusao");
    expect(hers).not.toContain("sigilo");
    expect(hers).toContain("(1 more agent this person can't see.)");
    expect(await teamStatus(f.db, f.org.id, f.owner.id)).toContain("@sigilo");
  });

  /** A live background work of @dev in `channelId`, tied to a running run there. */
  async function liveWork(channelId: string, title: string, trigger?: string) {
    const asked =
      trigger ??
      (
        await insertMessage(f.db, {
          orgId: f.org.id,
          channelId,
          author: { type: "person", userId: f.owner.id },
          body: title,
        })
      ).id;
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId,
        title,
        anchorMessageId: asked,
        homeThreadId: asked,
        ownThread: false,
        status: "live",
        how: "agent",
        lastUpdateAt: new Date(),
      })
      .returning();
    await f.db.insert(schema.agentRuns).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: asked,
      triggerMessageId: asked,
      trigger: "mention",
      hop: 1,
      status: "running",
      heartbeatAt: new Date(),
      startedAt: new Date(),
      workId: work?.id,
    });
  }

  test("a background work somewhere they can't read never names its title", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "fusao", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    await liveWork(secret.id, "Fusão com a Acme");
    const hers = await teamStatus(f.db, f.org.id, bia.id);
    expect(hers).not.toContain("Fusão");
    expect(hers).toContain("@dev");
    expect(await teamStatus(f.db, f.org.id, f.owner.id)).toContain("Fusão com a Acme");
  });

  test("of two works, the one they can read shows and the other stays out", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "fusao", visibility: "private" });
    await liveWork(f.general.id, "Página de preços");
    await new Promise((r) => setTimeout(r, 5));
    await liveWork(secret.id, "Fusão com a Acme");
    const hers = await teamStatus(f.db, f.org.id, bia.id);
    expect(hers).toContain("Página de preços");
    expect(hers).not.toContain("Fusão");
  });

  test("what this person handed on reads as theirs, another's hand-off in the same DM doesn't", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const { openAgentDm } = await import("../src");
    const between = await openAgentDm(f.db, f.org.id, lodi.id, f.agent.id);
    const handed = async (userId: string, title: string) => {
      const ctx = await lodiRun(userId, title);
      const note = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: between.id,
        author: { type: "agent", agentId: lodi.id, runId: ctx.runId as string, hop: 2 },
        body: title,
      });
      await liveWork(between.id, title, note.id);
    };
    await handed(f.owner.id, "Campanha de Natal");
    await handed(bia.id, "Folha da Bia");
    const theirs = await teamStatus(f.db, f.org.id, f.owner.id);
    expect(theirs).toContain("Campanha de Natal");
    expect(theirs).not.toContain("Folha da Bia");
  });

  test("characters that hide text don't reach the model", async () => {
    f = await setup({ rightHand: true });
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Página\u{E0041}\u202E de preços",
    });
    const out = await teamStatus(f.db, f.org.id, f.owner.id);
    expect(out).toContain("Página");
    expect(out).not.toContain("\u{E0041}");
    expect(out).not.toContain("\u202E");
  });

  test("a big team: what they see isn't cut by what they don't", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    for (let i = 0; i < 41; i++) {
      const hidden = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name: `Oculto ${i}`, handle: `oculto${i}`, role: "x", instructions: "", credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
      await setAgentAudience(f.db, f.owner.id, f.org.id, hidden.id, { mode: "owner", userIds: [], roleIds: [] });
    }
    const late = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Nina", handle: "nina", role: "x", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const hers = await teamStatus(f.db, f.org.id, bia.id);
    expect(hers).toContain(`@${late.handle}`);
    expect(hers).toContain("(41 more agents this person can't see.)");
  });

  test("a question waits on who its run works for, however old, and on nobody else", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev prepara",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "waiting_input",
      })
      .returning();
    await f.db.insert(schema.agentQuestions).values({
      orgId: f.org.id,
      runId: run?.id ?? "",
      agentId: f.agent.id,
      channelId: f.general.id,
      toolUseId: "tu-1",
      text: "Qual o prazo?",
      createdAt: new Date(Date.now() - 3 * 24 * 3_600_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await teamStatus(f.db, f.org.id, f.owner.id)).toContain("1 questions from agents");
    expect(await teamStatus(f.db, f.org.id, bia.id)).not.toContain("questions from agents");
  });

  test("only in the person's own DM", async () => {
    f = await setup({ rightHand: true });
    const out = await status(await lodiRun(f.owner.id, "@lodi como vai?", f.general.id));
    expect(out).toMatchObject({ isError: true, content: "Only in your private conversation with a person." });
  });
});

describe("its prompt", () => {
  test("opens on what it does for the team, and Automático reads the tiers", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const text = await rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
    );
    const [first] = text.split("\n\n");
    for (const name of ["team_status", "ask_agent", "tell_agent", "follow_up", "create_issue"])
      expect(first).toContain(name);
    expect(RIGHT_HAND_AUTO.instructions).toContain("the medium tier");
    console.log(`Lodi's own block: ${text.length} chars`);
  });

  test("lists what it handed on and hasn't heard back", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "pede pro dev preparar a campanha",
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    if (!run) throw new Error("no run");
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      kind: "note",
      askerRunId: run.id,
      askerAgentId: lodi.id,
      targetAgentId: f.agent.id,
      channelId: dm.id,
      messageId: trigger.id,
      waitId: `async:${crypto.randomUUID()}`,
      question: "Prepare a campanha de Natal",
      chain: [lodi.id],
      status: "open",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const text = systemText((await buildRunContext(f.db, run, lodi, { maxMessages: 10 })).system);
    expect(text).toContain("# Work you handed off here");
    expect(text).toContain("Prepare a campanha de Natal");
  });
});
