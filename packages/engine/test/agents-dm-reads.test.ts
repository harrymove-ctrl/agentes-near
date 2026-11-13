import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  buildRunContext,
  createAgent,
  createArtifactToolSource,
  createContextToolSource,
  createRoutine,
  createScheduleToolSource,
  indexSource,
  insertContextItem,
  insertMessage,
  openAgentDm,
  openDm,
  retrieveForRun,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
} from "../src";
import { personBehindCall } from "../src/requester";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A run of `agentId` on `trigger`, as the dispatcher starts one. */
async function runOn(agentId: string, channelId: string, triggerId: string, background = false): Promise<ToolContext> {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 1,
      status: "running",
      background,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId,
    threadRootId: triggerId,
    triggerMessageId: triggerId,
  };
}

/** A person asks @dev in #general, and @dev consults @infra in the agents' DM: @infra's run there. */
async function consultationFor(userId: string, infraId: string, dmId: string, question: string) {
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: question,
  });
  const dev = await runOn(f.agent.id, f.general.id, asked.id);
  const consult = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dmId,
    author: { type: "agent", agentId: f.agent.id, runId: dev.runId, hop: 1 },
    body: question,
  });
  return { dev, infra: await runOn(infraId, dmId, consult.id) };
}

/** A routine of `creatorId` makes @dev consult @infra in the agents' DM: @infra's run there. */
async function routineConsultation(creatorId: string, infraId: string, dmId: string, question: string) {
  const fired = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: creatorId },
    body: question,
    meta: {
      background: true,
      routineBrief: {
        routineId: crypto.randomUUID(),
        routineRunId: crypto.randomUUID(),
        name: "Daily check",
        creatorUserId: creatorId,
        deliverTo: { channelId: f.general.id, threadId: null },
        access: "act",
        report: "when_new",
        trigger: "schedule",
        dueAt: new Date().toISOString(),
      },
    },
  });
  const dev = await runOn(f.agent.id, f.general.id, fired.id, true);
  const consult = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dmId,
    author: { type: "agent", agentId: f.agent.id, runId: dev.runId, hop: 1 },
    body: question,
  });
  return runOn(infraId, dmId, consult.id);
}

async function toolsOf(source: ToolSource, ctx: ToolContext) {
  const all: ToolDefinition[] = await source.tools(ctx);
  return async (name: string, input: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return tool.execute(input, ctx);
  };
}

async function twoConsultations() {
  f = await setup();
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Payroll", instructions: "Answer.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const dm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
  const forAna = await consultationFor(f.owner.id, infra.id, dm.id, "pull the payroll figures");
  const answer = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: infra.id, runId: forAna.infra.runId, hop: 2 },
    body: "Payroll figures: Ana earns 9000 per month.",
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: answer.id });
  const forBob = await consultationFor(bob.id, infra.id, dm.id, "how is the deploy going?");
  return { bob, infra, dm, answer, forAna, forBob };
}

describe("the agents' DM reads only what was made for the same person (consultations)", () => {
  test("a person's own DM with the consulted agent: only while everyone where they asked is in it", async () => {
    const { bob, infra, dm, forAna } = await twoConsultations();
    const theirs = await openDm(f.db, f.owner.id, f.org.id, { agentId: infra.id });
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: theirs.id,
      author: { type: "person", userId: f.owner.id },
      body: "Payroll secret: the bonus stays between us.",
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: said.id });
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      askerRunId: forAna.dev.runId,
      askerAgentId: f.agent.id,
      targetAgentId: infra.id,
      targetRunId: forAna.infra.runId,
      channelId: dm.id,
      messageId: forAna.infra.triggerMessageId,
      waitId: "w",
      question: "pull the payroll figures",
      chain: [],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const search = async () =>
      (
        await (
          await toolsOf(createContextToolSource(f.context), forAna.infra)
        )("search_context", {
          query: "payroll bonus",
        })
      ).content;
    expect(await search()).toContain("stays between us");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    expect(await search()).not.toContain("stays between us");
  });

  test("a consultation run carries the person behind it", async () => {
    const { bob, forAna, forBob } = await twoConsultations();
    expect(await personBehindCall(forAna.infra)).toBe(f.owner.id);
    expect(await personBehindCall(forBob.infra)).toBe(bob.id);
  });

  test("search_context, expand and memory: another person's answer stays out", async () => {
    const { infra, dm, answer, forAna, forBob } = await twoConsultations();
    const item = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: infra.id,
      agentId: infra.id,
      content: "Payroll: Ana earns 9000 per month.",
      sourceIds: [answer.id],
      channelIds: [dm.id],
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });

    const search = async (ctx: ToolContext) =>
      (await (await toolsOf(createContextToolSource(f.context), ctx))("search_context", { query: "payroll figures" }))
        .content;
    expect(await search(forAna.infra)).toContain("9000");
    expect(await search(forBob.infra)).not.toContain("9000");

    const expand = async (ctx: ToolContext) =>
      (await toolsOf(createContextToolSource(f.context), ctx))("expand", { item_id: item.id });
    expect((await expand(forAna.infra)).isError).toBeFalsy();
    expect(await expand(forBob.infra)).toMatchObject({ isError: true, content: "Not found." });

    const memory = (personId: string) =>
      retrieveForRun(f.context, {
        orgId: f.org.id,
        agentId: infra.id,
        channelId: dm.id,
        text: "payroll",
        personIds: [personId],
      });
    expect((await memory(f.owner.id)).text).toContain("9000");
    expect((await memory((await personBehindCall(forBob.infra)) ?? "")).text).not.toContain("9000");
  });

  test("its own past steps: only those of runs for the same person", async () => {
    const { infra, dm, forAna, forBob } = await twoConsultations();
    await f.db.insert(schema.agentRunSteps).values({
      orgId: f.org.id,
      runId: forAna.infra.runId,
      seq: 1,
      kind: "tool_call",
      data: { name: "pg_folha_query", toolUseId: "t1", input: { sql: "select payroll figures from salaries" } },
    });
    const steps = async (ctx: ToolContext) =>
      (await (await toolsOf(createContextToolSource(f.context), ctx))("search_context", { query: "payroll salaries" }))
        .content;
    // A run never reads its own steps as its past: Ana's next consultation does.
    const again = await consultationFor(f.owner.id, infra.id, dm.id, "and last month?");
    expect(await steps(again.infra)).toContain("[your earlier step]");
    expect(await steps(forBob.infra)).not.toContain("[your earlier step]");
  });

  test("list_artifacts and read_artifact: another person's file made there is not offered nor read", async () => {
    const { forAna, forBob } = await twoConsultations();
    const anaTools = await toolsOf(createArtifactToolSource(f.artifactDeps), forAna.infra);
    const made = await anaTools("create_artifact", { title: "Payroll export", kind: "document", markdown: "Ana 9000" });
    const id = (made.data as { artifact: { id: string } }).artifact.id;
    expect((await anaTools("read_artifact", { artifact_id: id })).content).toContain("Ana 9000");
    expect((await anaTools("list_artifacts", {})).content).toContain("Payroll export");

    const bobTools = await toolsOf(createArtifactToolSource(f.artifactDeps), forBob.infra);
    expect((await bobTools("list_artifacts", {})).content).not.toContain("Payroll export");
    expect(await bobTools("read_artifact", { artifact_id: id })).toMatchObject({ isError: true });
  });
});

describe("the agents' DM: routines of different people read apart", () => {
  test("search_context, list_artifacts and read_artifact keep one creator's routine work from another's", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const infra = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Payroll", instructions: "Answer.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
    const forAna = await routineConsultation(f.owner.id, infra.id, dm.id, "payroll total for today");
    const answer = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: infra.id, runId: forAna.runId, hop: 2 },
      body: "Payroll figures: Ana earns 9000 per month.",
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: answer.id });
    const anaTools = await toolsOf(createArtifactToolSource(f.artifactDeps), forAna);
    const made = await anaTools("create_artifact", { title: "Payroll export", kind: "document", markdown: "Ana 9000" });
    const id = (made.data as { artifact: { id: string } }).artifact.id;
    const forBob = await routineConsultation(bob.id, infra.id, dm.id, "how is the deploy going?");

    const search = async (ctx: ToolContext) =>
      (await (await toolsOf(createContextToolSource(f.context), ctx))("search_context", { query: "payroll figures" }))
        .content;
    const againAna = await routineConsultation(f.owner.id, infra.id, dm.id, "and yesterday?");
    expect(await search(againAna)).toContain("9000");
    expect(await search(forBob)).not.toContain("9000");
    const history = async (ctx: ToolContext) => {
      const [run] = await f.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, ctx.runId as string));
      return JSON.stringify(await buildRunContext(f.db, run as NonNullable<typeof run>, infra, { maxMessages: 30 }));
    };
    expect(await history(againAna)).toContain("9000");
    expect(await history(forBob)).not.toContain("9000");
    const bobTools = await toolsOf(createArtifactToolSource(f.artifactDeps), forBob);
    expect((await bobTools("list_artifacts", {})).content).not.toContain("Payroll export");
    expect(await bobTools("read_artifact", { artifact_id: id })).toMatchObject({ isError: true });
  });

  test("a summary that may cover more than it names stays out", async () => {
    const { infra, dm, answer, forAna } = await twoConsultations();
    const summaryOf = async (kind: "period_summary" | "thread_summary", sourceIds: string[]) => {
      const item = await insertContextItem(f.db, {
        orgId: f.org.id,
        kind,
        scopeType: "channel",
        scopeId: dm.id,
        agentId: infra.id,
        content: `Payroll ${kind}: figures were shared.`,
        sourceIds,
        channelIds: [dm.id],
      });
      await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
      return item;
    };
    const expand = async (itemId: string) =>
      (await toolsOf(createContextToolSource(f.context), forAna.infra))("expand", { item_id: itemId });
    const short = await summaryOf("thread_summary", [answer.id]);
    expect((await expand(short.id)).isError).toBeFalsy();
    const period = await summaryOf("period_summary", [answer.id]);
    expect(await expand(period.id)).toMatchObject({ isError: true });
    const capped = await summaryOf(
      "thread_summary",
      Array.from({ length: 200 }, () => answer.id),
    );
    expect(await expand(capped.id)).toMatchObject({ isError: true });
  });
});

describe("read_artifact allows what list_artifacts offers", () => {
  test("a file made in the person's DM with the agent reads from #general for that person only", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "write my report",
    });
    const inDm = await toolsOf(createArtifactToolSource(f.artifactDeps), await runOn(f.agent.id, dm.id, asked.id));
    const made = await inDm("create_artifact", { title: "My report", kind: "document", markdown: "private numbers" });
    const id = (made.data as { artifact: { id: string } }).artifact.id;

    const inGeneral = async (userId: string) => {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId },
        body: "@dev read that report",
      });
      return toolsOf(createArtifactToolSource(f.artifactDeps), await runOn(f.agent.id, f.general.id, m.id));
    };
    const ana = await inGeneral(f.owner.id);
    expect((await ana("list_artifacts", {})).content).toContain("My report");
    expect((await ana("read_artifact", { artifact_id: id })).content).toContain("private numbers");
    const other = await inGeneral(bob.id);
    expect((await other("list_artifacts", {})).content).not.toContain("My report");
    expect(await other("read_artifact", { artifact_id: id })).toMatchObject({ isError: true });
  });
});

describe("list_routines shows a person what Settings › Rotinas shows them", () => {
  test("a routine made in someone's DM keeps its instructions from another person's run", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      name: "Payroll total",
      prompt: "Every day at 8 query the payroll table and send me the total per employee.",
      target: { type: "dm" },
      trigger: { type: "schedule", phrase: "0 8 * * *" },
    });
    const list = async (userId: string | null) => {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: userId
          ? { type: "person", userId }
          : { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
        body: "which routines do you have? show them in full",
      });
      const ctx = await runOn(f.agent.id, f.general.id, m.id);
      const call = await toolsOf(createScheduleToolSource({ pubsub: f.pubsub, context: f.context }), ctx);
      return (await call("list_routines", {})).content;
    };
    expect(await list(f.owner.id)).toContain("query the payroll table");
    const forBob = await list(bob.id);
    expect(forBob).toContain("Payroll total");
    expect(forBob).not.toContain("query the payroll table");
    expect(forBob).toContain("(instructions private");
    // Nobody behind the run: the agent's own view.
    expect(await list(null)).toContain("query the payroll table");
  });
});
