import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  createDashboard,
  type DashboardDeps,
  listPinnableBlocks,
  pinMessageAsWidget,
  pinnedWidgetPrompt,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
let deps: DashboardDeps;
beforeEach(async () => {
  f = await setup();
  deps = { db: f.db, pubsub: f.pubsub, context: f.context };
});
afterEach(() => f.close());

const KPI = JSON.stringify({
  type: "number",
  title: "Revenue today",
  value: 18420,
  unit: "R$",
  delta: "+12% vs yesterday",
});
const BARS = JSON.stringify({
  type: "bar",
  title: "Sales by region",
  subtitle: "This week",
  labels: ["North", "South"],
  series: [{ name: "2026", values: [12, 8] }],
});

const fence = (json: string) => `\`\`\`chart\n${json}\n\`\`\``;

async function message(channelId: string, body: string, by: { agentId: string } | { userId: string }) {
  const [row] = await f.db
    .insert(schema.messages)
    .values({
      orgId: f.org.id,
      channelId,
      body,
      ...("agentId" in by
        ? { authorType: "agent" as const, authorAgentId: by.agentId }
        : { authorType: "person" as const, authorUserId: by.userId }),
    })
    .returning();
  if (!row) throw new Error("message insert failed");
  return row;
}

const board = (actorId: string) =>
  createDashboard(deps, actorId, f.org.id, { title: "Sales", audience: "workspace", editPolicy: "viewers" });

describe("Pin (ADR 0135 §3)", () => {
  test("a chart an agent sent becomes a widget with its data, looked after by that agent", async () => {
    const m = await message(f.general.id, `Here is today so far:\n${fence(KPI)}\nUp from yesterday.\n${fence(BARS)}`, {
      agentId: f.agent.id,
    });
    const made = await board(f.owner.id);
    const w = await pinMessageAsWidget(deps, f.owner.id, f.org.id, made.id, {
      messageId: m.id,
      block: `  ${KPI}\n`,
      schedule: "manual",
    });
    expect(w).toMatchObject({
      dashboardId: made.id,
      agentId: f.agent.id,
      title: "Revenue today",
      format: "kpi",
      kind: "kpi",
      status: "ok",
      schedule: "manual",
      routineId: null,
      sourceMessageId: m.id,
      layout: { position: 0, w: 1, h: 1 },
      spec: { kind: "kpi", value: 18420, prefix: "R$", delta: { text: "+12%", up: true }, note: "vs yesterday" },
      createdBy: { kind: "person", id: f.owner.id },
    });
    expect(w.refreshedAt).not.toBeNull();
    expect(w.prompt).toContain("Revenue today");
    expect(w.prompt).toContain("Up from yesterday.");
    expect(w.prompt).not.toContain("```");

    const bars = await pinMessageAsWidget(deps, f.owner.id, f.org.id, made.id, {
      messageId: m.id,
      block: BARS,
      schedule: "manual",
      size: "l",
      title: "Regions",
    });
    expect(bars).toMatchObject({
      title: "Regions",
      kind: "bars",
      layout: { position: 1, w: 2, h: 2 },
      spec: { kind: "bars", labels: ["North", "South"], values: [12, 8] },
    });
    expect(bars.prompt).toContain("This week");
  });

  test("only a chart that is in the message, from an agent, where the person reads", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const made = await board(f.owner.id);
    const m = await message(f.general.id, fence(KPI), { agentId: f.agent.id });
    const pin = (actorId: string, input: Partial<Parameters<typeof pinMessageAsWidget>[4]> = {}) =>
      pinMessageAsWidget(deps, actorId, f.org.id, made.id, {
        messageId: m.id,
        block: KPI,
        schedule: "manual",
        ...input,
      });
    await expect(pin(f.owner.id, { block: BARS })).rejects.toMatchObject({ code: "widget.block_not_found" });
    await expect(pin(f.owner.id, { messageId: crypto.randomUUID() })).rejects.toMatchObject({
      code: "widget.block_not_found",
    });
    await expect(pin(f.owner.id, { messageId: "not-an-id" })).rejects.toMatchObject({
      code: "widget.block_not_found",
    });
    const mine = await message(f.general.id, fence(KPI), { userId: f.owner.id });
    await expect(pin(f.owner.id, { messageId: mine.id })).rejects.toMatchObject({
      code: "widget.not_agent_message",
    });
    // Nina edits the board but isn't in the channel: she can't read the message, so it isn't there for her.
    await expect(pin(nina.id)).rejects.toMatchObject({ code: "widget.block_not_found" });
    const broken = await message(f.general.id, fence('{"type":"number","title":"Broken"}'), { agentId: f.agent.id });
    await expect(
      pin(f.owner.id, { messageId: broken.id, block: '{"type":"number","title":"Broken"}' }),
    ).rejects.toMatchObject({ code: "widget.block_not_found" });
  });

  test("updating it means asking the agent: only someone who may talk to it; just pinning needs no more", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: nina.id });
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    const made = await board(f.owner.id);
    const m = await message(f.general.id, fence(KPI), { agentId: f.agent.id });
    await expect(
      pinMessageAsWidget(deps, nina.id, f.org.id, made.id, { messageId: m.id, block: KPI, schedule: "hour" }),
    ).rejects.toMatchObject({ code: "widget.agent_unreachable" });
    const pinned = await pinMessageAsWidget(deps, nina.id, f.org.id, made.id, {
      messageId: m.id,
      block: KPI,
      schedule: "manual",
    });
    expect(pinned.status).toBe("ok");
  });

  test("pinning needs edit on the board", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: nina.id });
    const closed = await createDashboard(deps, f.owner.id, f.org.id, {
      title: "Closed",
      audience: "workspace",
      editPolicy: "owner",
    });
    const m = await message(f.general.id, fence(KPI), { agentId: f.agent.id });
    await expect(
      pinMessageAsWidget(deps, nina.id, f.org.id, closed.id, { messageId: m.id, block: KPI, schedule: "manual" }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  });
});

describe("Pin from chat", () => {
  test("the latest charts agents sent where the person reads, newest first", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const first = await message(f.general.id, fence(KPI), { agentId: f.agent.id });
    await message(f.general.id, fence(KPI), { userId: f.owner.id });
    await message(f.general.id, "No chart here", { agentId: f.agent.id });
    await message(f.general.id, fence('{"type":"number","title":"Broken"}'), { agentId: f.agent.id });
    const second = await message(f.general.id, `Two:\n${fence(BARS)}\n${fence(KPI)}`, { agentId: f.agent.id });

    const blocks = await listPinnableBlocks(deps, f.owner.id, f.org.id);
    expect(blocks.map((b) => [b.messageId, b.title])).toEqual([
      [second.id, "Sales by region"],
      [second.id, "Revenue today"],
      [first.id, "Revenue today"],
    ]);
    expect(blocks[0]).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      agentId: f.agent.id,
      block: BARS,
      spec: { kind: "bars" },
      place: { kind: "channel", name: "general" },
    });
    expect((await listPinnableBlocks(deps, f.owner.id, f.org.id, 2)).length).toBe(2);
    // Nina isn't in the channel.
    expect(await listPinnableBlocks(deps, nina.id, f.org.id)).toEqual([]);
    // Older than 30 days: not offered.
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await listPinnableBlocks({ ...deps, now: () => later }, f.owner.id, f.org.id)).toEqual([]);
  });

  test("a private channel's charts only for its members", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const ch = await createChannel(f.db, f.owner.id, f.org.id, { name: "finance", visibility: "private" });
    await message(ch.id, fence(KPI), { agentId: f.agent.id });
    expect((await listPinnableBlocks(deps, f.owner.id, f.org.id)).map((b) => b.place)).toEqual([
      { kind: "channel", name: "finance" },
    ]);
    expect(await listPinnableBlocks(deps, nina.id, f.org.id)).toEqual([]);
  });

  test("the instructions of a pinned chart: keep it up to date, with what the message said", () => {
    const prompt = pinnedWidgetPrompt(
      { title: "Revenue today", subtitle: "Store orders" },
      `Here:\n${fence(KPI)}\nUp   from\n yesterday.`,
    );
    expect(prompt).toContain('"Revenue today"');
    expect(prompt).toContain("Store orders");
    expect(prompt).toContain("Here: Up from yesterday.");
    expect(pinnedWidgetPrompt({ title: "X" }, fence(KPI))).toBe('Keep this chart up to date with fresh data: "X".');
  });
});
