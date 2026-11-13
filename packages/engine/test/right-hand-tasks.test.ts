import { afterEach, describe, expect, test } from "bun:test";
import { and, asc, eq, schema } from "@agenteschat/db";
import {
  absorbToolData,
  answersHandOffs,
  createIssueToolSource,
  createToolGateway,
  insertMessage,
  onConsultedRunFinished,
  openPersonAgentDm,
  RIGHT_HAND,
  setAgentAudience,
  type ToolContext,
  type ToolSideEffects,
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

/** A run of Lodi on what `userId` wrote in their DM with it. */
async function lodiRun(userId: string, body: string): Promise<ToolContext & { dmId: string }> {
  const lodi = await lodiOf();
  const dm = await openPersonAgentDm(f.db, f.org.id, userId, lodi.id);
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: dm.id,
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
    channelId: dm.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
    dmId: dm.id,
  };
}

async function createIssue(ctx: ToolContext, input: Record<string, unknown>) {
  const gateway = createToolGateway({ sources: [createIssueToolSource(f.artifactDeps)] });
  const res = await gateway.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "create_issue", input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output as { content: string; isError?: boolean; data?: Record<string, unknown> };
}

describe("a task Lodi hands on (ADR 0137 §13)", () => {
  test("its agent starts on it in the task's conversation, written as Lodi, and the reply carries its chip", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const ctx = await lodiRun(f.owner.id, "pede pro dev preparar a campanha de natal");
    const out = await createIssue(ctx, { title: "Campanha de Natal", assignee: "@dev" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("started on it in the task's own conversation");

    const [issue] = await f.db.select().from(schema.issues).where(eq(schema.issues.orgId, f.org.id));
    if (!issue?.conversationChannelId || !issue.conversationRootId) throw new Error("no conversation");
    expect(issue.createdByType).toBe("agent");
    expect(issue.createdById).toBe(lodi.id);
    expect(issue.assigneeId).toBe(f.agent.id);
    // Never opened to everyone from a private DM: tied to it, or to the person who asked.
    expect(issue.restricted || issue.channelId === ctx.dmId).toBe(true);

    const [start] = await f.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, issue.conversationChannelId),
          eq(schema.messages.threadId, issue.conversationRootId),
        ),
      );
    expect(start?.authorType).toBe("agent");
    expect(start?.authorAgentId).toBe(lodi.id);
    expect(start?.authorUserId).toBeNull();
    expect(start?.meta).toMatchObject({ issueWorkStart: true, bodyCode: "issue_work_start" });

    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(
        and(eq(schema.agentRuns.agentId, f.agent.id), eq(schema.agentRuns.channelId, issue.conversationChannelId)),
      );
    expect(run?.triggerMessageId).toBe(start?.id);

    const [handOff] = await f.db.select().from(schema.agentConsultations);
    expect(handOff).toMatchObject({
      kind: "note",
      askerRunId: ctx.runId,
      askerAgentId: lodi.id,
      targetAgentId: f.agent.id,
      targetRunId: run?.id,
      status: "open",
    });

    expect(out.data?.handedTask).toEqual({
      issueId: issue.id,
      number: issue.number,
      title: "Campanha de Natal",
      agentId: f.agent.id,
      channelId: issue.conversationChannelId,
      rootId: issue.conversationRootId,
    });
    // What the reply posts with: its chips (`meta.tasks`).
    const effects: ToolSideEffects = {};
    absorbToolData(effects, out.data);
    expect(effects.tasks?.map((t) => t.number)).toEqual([issue.number]);
    expect(answersHandOffs({ kind: "task", dmKey: null })).toBe(true);
    expect(answersHandOffs({ kind: "channel", dmKey: null })).toBe(false);
  });

  test("what came of it goes back to the person's DM with Lodi, by itself", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id, "pede pro dev preparar a campanha");
    await createIssue(ctx, { title: "Campanha", assignee: "@dev" });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
    if (!run) throw new Error("no run");
    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: run.channelId,
      threadId: run.threadRootId,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 2 },
      body: "Campanha pronta: três peças no Drive.",
    });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", replyMessageId: reply.id })
      .where(eq(schema.agentRuns.id, run.id));
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
    await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, run, "done");

    const [closed] = await f.db.select().from(schema.agentConsultations);
    expect(closed?.status).toBe("answered");
    expect(closed?.answer).toContain("Campanha pronta");
    const back = (
      await f.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.channelId, ctx.dmId))
        .orderBy(asc(schema.messages.createdAt))
    ).filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "consult_reply");
    expect(back.length).toBe(1);
    expect(back[0]?.body).toContain("Campanha pronta");
  });

  test("an agent the person can't talk to is refused before any task is made, saying who can let them in", async () => {
    f = await setup({ rightHand: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const out = await createIssue(await lodiRun(bob.id, "pede pro dev"), { title: "Algo", assignee: "@dev" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("its owner or an admin can let them in");
    expect(await f.db.select().from(schema.issues)).toEqual([]);
  });

  test("a task with no agent, or assigned to a person, starts nothing", async () => {
    f = await setup({ rightHand: true });
    const out = await createIssue(await lodiRun(f.owner.id, "anota isso"), { title: "Lembrar", assignee: "@ana" });
    expect(out.isError).toBeFalsy();
    expect(out.data?.handedTask).toBeUndefined();
    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id))).toEqual([]);
  });
});
