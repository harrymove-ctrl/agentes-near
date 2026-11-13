import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  buildTeamWeek,
  createAgent,
  enqueueIdleReflections,
  HOLDOUT_EVERY,
  insertContextItem,
  insertMessage,
  memoryArmOf,
  memoryScorecard,
  openAgentDm,
  recordContextUse,
  summaryModelReady,
  type ToolContext,
  widenDmHowTos,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("no reflection where there's no summary model (ADR 0167)", () => {
  test("an idle thread is reflected on only while the workspace has a model to do it", async () => {
    f = await setup();
    const root = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Como vai o lançamento?",
    });
    for (const body of ["Quase pronto.", "Falta o texto da página."])
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "person", userId: f.owner.id },
        body,
      });
    const later = new Date(Date.now() + 3 * 3600_000);
    const revoke = (at: Date | null) =>
      f.db
        .update(schema.providerCredentials)
        .set({ revokedAt: at })
        .where(eq(schema.providerCredentials.id, f.credential.id));

    await revoke(new Date());
    expect(await summaryModelReady(f.context, f.org.id)).toBe(false);
    expect(await enqueueIdleReflections(f.context, later)).toBe(0);

    await revoke(null);
    expect(await summaryModelReady(f.context, f.org.id)).toBe(true);
    expect(await enqueueIdleReflections(f.context, later)).toBe(1);
  });
});

describe("how-tos from agents' DMs reach the agent's other work (ADR 0167)", () => {
  test("a method that names nobody leaves the DM; one naming a member or an address stays there", async () => {
    f = await setup({ contextTools: true });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, ops.id);
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: ops.id, runId: null, hop: 1, stretchId: null },
      body: "how do you list the Northwind models?",
    });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: "",
      channelId: dm.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    };
    const save = async (key: string, how: string) => {
      if (!f.tools) throw new Error("no tools");
      await f.tools.invoke(ctx, {
        toolUseId: `tu_${crypto.randomUUID()}`,
        name: "save_how_to",
        input: { title: `Como ${key}`, key, how },
      });
      const [row] = await f.db
        .select()
        .from(schema.contextItems)
        .where(eq(schema.contextItems.title, `Como ${key}`));
      return row?.channelIds;
    };
    expect(await save("list models", "GET https://api.example.com/v1/models with the NORTHWIND_KEY header.")).toEqual(
      [],
    );
    expect(await save("ask ana", "Ask ana before publishing the list.")).toEqual([dm.id]);
    expect(await save("mail list", "Send the list to sales@example.com every Monday.")).toEqual([dm.id]);
  });

  test("the boot backfill widens the clean ones once", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, ops.id);
    const howTo = (subject: string, content: string) =>
      insertContextItem(f.db, {
        orgId: f.org.id,
        kind: "note",
        scopeType: "agent",
        scopeId: f.agent.id,
        agentId: f.agent.id,
        subject,
        content,
        channelIds: [dm.id],
        createdByKind: "agent",
        createdById: f.agent.id,
      });
    const clean = await howTo("howto list models", "GET https://api.example.com/v1/models.");
    const named = await howTo("howto ask ana", "Ask ana first.");
    expect(await widenDmHowTos(f.db)).toBe(1);
    expect(await widenDmHowTos(f.db)).toBe(0);
    const rows = new Map((await f.db.select().from(schema.contextItems)).map((i) => [i.id, i.channelIds]));
    expect([rows.get(clean.id), rows.get(named.id)]).toEqual([[], [dm.id]]);
  });
});

describe("measuring memory (ADR 0167)", () => {
  test("one run in ten is the holdout that still carries its own items whatever the request", () => {
    const ids = Array.from({ length: 2000 }, () => crypto.randomUUID());
    const share = ids.filter((id) => memoryArmOf(id) === "with").length / ids.length;
    expect(share).toBeGreaterThan(1 / HOLDOUT_EVERY - 0.03);
    expect(share).toBeLessThan(1 / HOLDOUT_EVERY + 0.03);
    expect(memoryArmOf(ids[0] as string)).toBe(memoryArmOf(ids[0] as string));
  });

  test("the scorecard counts runs, what they were sent and opened, refusals, and each arm", async () => {
    f = await setup();
    const item = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "note",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      subject: "howto deploy northwind",
      content: "Deploy with scripts/blue.sh.",
      channelIds: [f.general.id],
      createdByKind: "agent",
      createdById: f.agent.id,
    });
    const run = async (arm: "with" | "without") => {
      const [row] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: crypto.randomUUID(),
          triggerMessageId: crypto.randomUUID(),
          trigger: "mention",
          hop: 1,
          status: "done",
        })
        .returning();
      if (!row) throw new Error("no run");
      await addRunStep(f.db, row, "context", { memoryItems: [item.id], memoryArm: arm });
      return row;
    };
    const a = await run("without");
    const b = await run("with");
    for (const r of [a, b]) await recordContextUse(f.db, f.org.id, r.id, [item.id], [item.id]);
    await addRunStep(f.db, a, "tool_call", { toolUseId: "tu_1", name: "expand", input: { item_id: item.id } });
    await f.db.insert(schema.outcomes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: b.id,
      kind: "approval_refused",
      polarity: "negative",
      subject: "send_email",
      summary: "Refused",
      source: "approval",
    });
    const card = await memoryScorecard(f.db, f.org.id, f.agent.id, 7);
    expect([card.runs, card.sent, card.opened, card.howTos.runs]).toEqual([2, 2, 1, 2]);
    expect(card.correctionsPer100).toBe(50);
    expect(card.arms).toEqual({ with: { runs: 1, refusedPer100: 100 }, without: { runs: 1, refusedPer100: 0 } });
  });
});

describe("proven how-tos become skills with one click (ADR 0167)", () => {
  test("the weekly card offers its owner the how-tos reused past the bar that nobody vouched for", async () => {
    f = await setup();
    const howTo = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "note",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      subject: "howto fill play console",
      title: "Preencher o Play Console",
      content: "Open the store listing, fill every field, save as draft.",
      channelIds: [f.general.id],
      trust: "low",
      createdByKind: "agent",
      createdById: f.agent.id,
    });
    await f.db.update(schema.contextItems).set({ recurrence: 3 }).where(eq(schema.contextItems.id, howTo.id));
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
    expect((await week(f.owner.id))?.rows.find((r) => r.kind === "howto")).toEqual({
      id: `howto:${howTo.id}`,
      kind: "howto",
      agentId: f.agent.id,
      itemId: howTo.id,
      title: "Preencher o Play Console",
      uses: 3,
    });
    // Someone else's card doesn't offer another person's agent's how-tos.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    expect((await week(bia.id))?.rows.some((r) => r.kind === "howto") ?? false).toBe(false);
  });
});
