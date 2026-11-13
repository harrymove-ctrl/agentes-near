import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  addChannelMember,
  buildRunContext,
  createAgent,
  createAgentRuns,
  createAgentStyleToolSource,
  insertMessage,
  openDm,
  PLAIN_WORDS_LINE,
  postPersonMessage,
  type RoutineBrief,
  routineRoomKey,
  saveAgentStyle,
  setAgentStyle,
  TECHNICAL_STYLE_LINE,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * ADR 0147: how agents talk to a person. Simple is the rule every agent reads; a person who chose technical replies
 * gets a line in the turn, read for the person behind the run: the author of a DM or channel message, the person
 * behind an agent's message, a routine's creator. `set_reply_style` saves it when they ask in the chat.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const runOf = async (triggerMessageId: string, agentId = f.agent.id) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.triggerMessageId, triggerMessageId), eq(schema.agentRuns.agentId, agentId)));
  if (!run) throw new Error("no run");
  // Done, so the next message starts a run of its own instead of joining this one.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  return run;
};
const promptOf = async (run: AgentRun, options: { routine?: boolean } = {}) => {
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, run.agentId));
  if (!agent) throw new Error("no agent");
  const ctx = await buildRunContext(f.db, run, agent, { maxMessages: 30, toolsAvailable: true, ...options });
  const turn = ctx.system.filter((b) => b.turn).map((b) => b.text);
  return { system: systemText(ctx.system), turn };
};
const say = (userId: string, channelId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, channelId, { body });

describe("the style that reaches the prompt", () => {
  test("a DM: simple (never picked) is the rule alone; technical adds its line for that person", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const first = await promptOf(await runOf((await say(f.owner.id, dm.id, "oi")).id));
    expect(first.system).toContain(PLAIN_WORDS_LINE);
    expect(PLAIN_WORDS_LINE).toContain("<details><summary>");
    expect(first.turn).not.toContain(TECHNICAL_STYLE_LINE);

    await setAgentStyle(f.db, f.owner.id, f.org.id, "technical");
    const next = await promptOf(await runOf((await say(f.owner.id, dm.id, "e o deploy?")).id));
    expect(next.turn).toContain(TECHNICAL_STYLE_LINE);
    // Still the same cached rules: only the turn changes.
    expect(next.system).toContain(PLAIN_WORDS_LINE);
  });

  test("a channel: the style of whoever wrote the message, then of the person behind an agent's mention", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await saveAgentStyle(f.db, f.org.id, bia.id, "technical");

    const owners = await say(f.owner.id, f.general.id, "@dev como está o deploy?");
    expect((await promptOf(await runOf(owners.id))).turn).not.toContain(TECHNICAL_STYLE_LINE);
    const bias = await say(bia.id, f.general.id, "@dev e o build?");
    const biasRun = await runOf(bias.id);
    expect((await promptOf(biasRun)).turn).toContain(TECHNICAL_STYLE_LINE);

    // Another agent brought in by @dev's reply to Bia: still Bia's request, so her style.
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "DevOps", instructions: "Keep it up.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    const handed = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: biasRun.id, hop: 1 },
      body: "@ops pode olhar o build?",
    });
    const [opsRun] = await f.db.transaction((tx) => createAgentRuns(tx, handed, [ops.id], "mention"));
    if (!opsRun) throw new Error("no run");
    expect((await promptOf(opsRun)).turn).toContain(TECHNICAL_STYLE_LINE);
  });

  test("a routine: its creator's style", async () => {
    f = await setup();
    const { run } = await routineRun();
    expect((await promptOf(run, { routine: true })).turn).not.toContain(TECHNICAL_STYLE_LINE);
    await saveAgentStyle(f.db, f.org.id, f.owner.id, "technical");
    expect((await promptOf(run, { routine: true })).turn).toContain(TECHNICAL_STYLE_LINE);
  });
});

describe("set_reply_style", () => {
  const call = async (run: AgentRun, style: string) => {
    const [tool] = await createAgentStyleToolSource().tools({} as ToolContext);
    if (!tool) throw new Error("no tool");
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
    } as ToolContext;
    return tool.execute({ style }, ctx);
  };
  const styleOf = async (userId: string) =>
    (
      await f.db
        .select({ style: schema.organizationMembers.agentStyle })
        .from(schema.organizationMembers)
        .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)))
    )[0]?.style;

  test("'fala mais simples' saves it for the person behind the run, for every agent here", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const run = await runOf((await say(bia.id, f.general.id, "@dev pode ser técnico comigo")).id);
    expect((await call(run, "technical")).isError).toBeUndefined();
    expect(await styleOf(bia.id)).toBe("technical");
    expect(await styleOf(f.owner.id)).toBeNull();
    expect((await call(run, "loud")).isError).toBe(true);
    expect(await styleOf(bia.id)).toBe("technical");
  });

  test("nobody behind the run (a routine's): nothing saved", async () => {
    f = await setup();
    const { run } = await routineRun();
    expect((await call(run, "technical")).isError).toBe(true);
    expect(await styleOf(f.owner.id)).toBeNull();
  });
});

/** A routine of the owner's firing in its own room, as `startRoutineRun` posts it: the brief written as its creator. */
async function routineRun() {
  const [routine] = await f.db
    .insert(schema.routines)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      name: "Vigiar o deploy",
      prompt: "Veja se o deploy de hoje passou.",
      target: { type: "channel", channelId: f.general.id },
      triggerType: "schedule",
      timezone: "UTC",
      createdByUserId: f.owner.id,
    })
    .returning();
  if (!routine) throw new Error("no routine");
  const [room] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: `routine-${routine.id.slice(0, 8)}`,
      kind: "dm",
      visibility: "private",
      dmKey: routineRoomKey(f.agent.id, routine.id),
    })
    .returning();
  const [current] = await f.db
    .insert(schema.routineRuns)
    .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "started" })
    .returning();
  if (!room || !current) throw new Error("no room");
  const brief: RoutineBrief = {
    routineId: routine.id,
    routineRunId: current.id,
    name: routine.name,
    creatorUserId: f.owner.id,
    deliverTo: { channelId: f.general.id, threadId: null },
    access: "read",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: room.id,
    author: { type: "person", userId: f.owner.id },
    body: routine.prompt,
    meta: { routineBrief: brief, routine: { id: routine.id, name: routine.name, runId: current.id }, background: true },
  });
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, trigger, [f.agent.id], "mention", { background: true }),
  );
  if (!run) throw new Error("no run");
  return { run };
}
