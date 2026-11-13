import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  ForbiddenError,
  insertContextItem,
  insertMessage,
  makeTeamMemory,
  retrieveForRun,
  type ToolContext,
  teamMemoryForPrompt,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** @dev's run in #general answering a message by `author` (a person, or an agent). */
async function runOn(author: { userId: string } | { agentId: string }, body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      "userId" in author
        ? { type: "person", userId: author.userId }
        : { type: "agent", agentId: author.agentId, runId: null, hop: 1, stretchId: null },
    body,
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

async function remember(ctx: ToolContext, input: Record<string, unknown>) {
  if (!f.tools) throw new Error("no tools");
  const res = await f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "remember", input });
  if (res.type !== "result") throw new Error(res.type);
  return res.output as { content: string; isError?: boolean };
}

const ops = () =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

describe("team memory every agent reads (ADR 0167)", () => {
  test("'everyone, remember' from someone who reviews memory is one team item, in every run's cached prompt", async () => {
    f = await setup({ contextTools: true });
    const out = await remember(await runOn({ userId: f.owner.id }, "pessoal, lembrem: relatórios em português"), {
      for: "team",
      kind: "preference",
      content: "Reports go out in Portuguese.",
    });
    expect(out.content).toContain("Saved for the team");
    const [item] = await f.db.select().from(schema.contextItems);
    expect([item?.agentId, item?.createdByKind, item?.createdById, item?.channelIds]).toEqual([
      null,
      "person",
      f.owner.id,
      [],
    ]);
    const prompt = await teamMemoryForPrompt(f.db, f.org.id);
    expect(prompt).toContain("# Team memory");
    expect(prompt).toContain(
      `[preference · ana, ${new Date().toISOString().slice(0, 10)}] Reports go out in Portuguese.`,
    );
    // Not twice: the per-run memory leaves it to the cached prompt.
    const other = await ops();
    const memory = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: other.id,
      channelId: f.general.id,
      text: "reports portuguese",
    });
    expect(memory.text).not.toContain("Reports go out in Portuguese.");
  });

  test("one kept for a single conversation comes in every run there, whatever it is about", async () => {
    f = await setup({ contextTools: true });
    await remember(await runOn({ userId: f.owner.id }, "pessoal, aqui no #general respondam curto"), {
      for: "team",
      kind: "preference",
      content: "In #general, answers stay short.",
      everywhere: false,
    });
    expect(await teamMemoryForPrompt(f.db, f.org.id)).toBe("");
    const other = await ops();
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: other.id });
    const memory = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: other.id,
      channelId: f.general.id,
      text: "",
    });
    expect(memory.text).toContain("In #general, answers stay short.");
  });

  test("a member's team save waits as a card for who reviews memory", async () => {
    f = await setup({ contextTools: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const out = await remember(await runOn({ userId: bia.id }, "pessoal, lembrem: a reunião é às 9"), {
      for: "team",
      kind: "fact",
      content: "The weekly meeting is at 9.",
    });
    expect(out.content).toContain("Proposed for the team");
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
    const [card] = await f.db.select().from(schema.contextProposals);
    expect([card?.target, card?.requestedByUserId, card?.status]).toEqual(["org_context", bia.id, "pending"]);
  });

  test("asked by another agent, a save points to the team save instead of a copy only that DM reads", async () => {
    f = await setup({ contextTools: true });
    const other = await ops();
    const out = await remember(
      await runOn({ agentId: other.id }, "a Ana pediu: todos salvem que relatórios são em pt"),
      {
        kind: "preference",
        content: "Ana wants reports in Portuguese.",
      },
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('for: "team"');
    expect(await f.db.select().from(schema.contextItems)).toEqual([]);
  });

  test("every save says where it holds", async () => {
    f = await setup({ contextTools: true });
    const out = await remember(await runOn({ userId: f.owner.id }, "lembra que o deploy é às sextas"), {
      kind: "fact",
      content: "Deploys happen on Fridays.",
    });
    expect(out.content).toContain("it holds in all your conversations");
  });

  test("Tornar do time: one team item, and the copies agents kept of it are archived behind it", async () => {
    f = await setup();
    const other = await ops();
    const copy = (agentId: string) =>
      insertContextItem(f.db, {
        orgId: f.org.id,
        kind: "preference",
        scopeType: "agent",
        scopeId: agentId,
        agentId,
        subject: "reports language",
        content: "Reports go out in Portuguese.",
        channelIds: [f.general.id],
        createdByKind: "agent",
        createdById: agentId,
      });
    const mine = await copy(f.agent.id);
    const theirs = await copy(other.id);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(makeTeamMemory(f.db, bia.id, f.org.id, mine.id)).rejects.toBeInstanceOf(ForbiddenError);

    const team = await makeTeamMemory(f.db, f.owner.id, f.org.id, mine.id);
    expect([team.agentId, team.createdByKind, team.channelIds]).toEqual([null, "person", []]);
    const rows = await f.db
      .select()
      .from(schema.contextItems)
      .where(and(eq(schema.contextItems.orgId, f.org.id), eq(schema.contextItems.supersededBy, team.id)));
    expect(rows.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});
