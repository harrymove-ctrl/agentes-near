import { afterEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  ASK_APPROVALS_TOGETHER,
  buildRunContext,
  decideApproval,
  decideApprovals,
  drainOutbox,
  forComputerBrain,
  postPersonMessage,
  REQUEST_PERMISSION_TOOL,
  type ToolSource,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "A pessoa pediu para gravar as metas dos próximos meses no painel.";
const MONTHS = ["2026-11", "2026-12", "2027-01", "2027-02"];

const recorded: string[] = [];
const goals: ToolSource = {
  name: "goals",
  tools: async () => [
    {
      name: "goal_upsert",
      description: "Record a monthly goal",
      scope: "",
      sensitive: true,
      inputSchema: { type: "object", properties: { month: { type: "string" }, revenue: { type: "number" } } },
      describe: (input) => ({ title: `Meta de ${(input as { month: string }).month}` }),
      execute: async (input) => {
        recorded.push((input as { month: string }).month);
        return { content: `recorded ${(input as { month: string }).month}` };
      },
    },
  ],
};

/** One turn asking for the four goals at once, then a closing line. */
const fourAtOnce = (_req: unknown, call: number) =>
  call === 1
    ? {
        chunks: ["Vou gravar as quatro metas."],
        toolUses: MONTHS.map((month) => ({ name: "goal_upsert", input: { month, revenue: 90000, why: WHY } })),
      }
    : { chunks: ["As quatro estão gravadas."] };

const cardsOf = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, f.general.id))).filter(
    (m) => typeof m.meta.approvalId === "string",
  );

async function askFour() {
  recorded.length = 0;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev grava as metas de novembro a fevereiro",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const rows = await f.db.select().from(schema.approvals).orderBy(schema.approvals.createdAt);
  return { run, rows };
}

test("four approvals asked in one turn: one card lists all four, each its own row and hash", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const { run, rows } = await askFour();
  expect(run.status).toBe("waiting_approval");
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((r) => r.actionHash)).size).toBe(4);
  const cards = await cardsOf();
  expect(cards).toHaveLength(1);
  expect(rows.every((r) => r.messageId === cards[0]?.id)).toBe(true);
  // One waiting notification for the card, not one per request.
  const inbox = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, f.owner.id), eq(schema.notifications.kind, "approval")));
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.count).toBe(4);
  expect((inbox[0]?.source as { approvalId?: string } | undefined)?.approvalId).toBe(rows[0]?.id);
});

test("'Aprovar tudo' approves the four rows, resumes the run once, and the card's notification goes away", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const { run, rows } = await askFour();
  const result = await decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    ids: rows.map((r) => r.id),
    decision: "approve",
  });
  expect(result.approvals.map((a) => a.status)).toEqual(["approved", "approved", "approved", "approved"]);
  expect(result.skipped).toEqual([]);
  const resumes = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === "agent_run.execute" && j.dedupeKey?.startsWith(`agent_run.execute:${run.id}:approval:`),
  );
  expect(resumes).toHaveLength(1);
  // Four audit rows, one per decision.
  const audits = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
  expect(audits).toHaveLength(4);
  const open = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, f.owner.id)));
  expect(open.every((n) => n.doneAt !== null)).toBe(true);

  await drainOutbox(f.db, f.handlers);
  expect(recorded.sort()).toEqual([...MONTHS].sort());
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(after?.status).toBe("done");
  // One model call to ask, one after the decisions: the run resumed once.
  expect(f.provider.calls).toHaveLength(2);
});

test("'Aprovar tudo' decides exactly the items it listed: one joining during the click stays waiting", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const { rows } = await askFour();
  const listed = rows.slice(0, 3).map((r) => r.id);
  await decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { ids: listed, decision: "approve" });
  const after = await f.db.select().from(schema.approvals).orderBy(schema.approvals.createdAt);
  expect(after.map((a) => a.status)).toEqual(["approved", "approved", "approved", "pending"]);
  // The card still waits on one: its notification stays.
  const open = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, f.owner.id)));
  expect(open.filter((n) => n.doneAt === null)).toHaveLength(1);
});

test("a request asked later in the same conversation joins the open card, live; another thread gets its own", async () => {
  f = await setup({
    toolSources: [goals],
    reply: (_req, call) =>
      call === 1
        ? { chunks: ["Novembro."], toolUses: [{ name: "goal_upsert", input: { month: "2026-11", why: WHY } }] }
        : call === 2
          ? { chunks: ["Dezembro."], toolUses: [{ name: "goal_upsert", input: { month: "2026-12", why: WHY } }] }
          : { chunks: ["Janeiro."], toolUses: [{ name: "goal_upsert", input: { month: "2027-01", why: WHY } }] },
  });
  const events = f.listen(f.general.id);
  const heard: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => heard.push(e as RealtimeEvent));
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev grava a meta de novembro");
  await drainOutbox(f.db, f.handlers);
  const [card] = await cardsOf();
  if (!card) throw new Error("no card");
  events.length = 0;
  heard.length = 0;

  // A reply under the request is the same conversation: its request joins the card.
  await post("@dev e a de dezembro", ask.id);
  await drainOutbox(f.db, f.handlers);
  expect(await cardsOf()).toHaveLength(1);
  const joined = events.find((e) => e.type === "approval.created");
  expect((joined as { approval?: { messageId: string } } | undefined)?.approval?.messageId).toBe(card.id);
  const posted = events.filter((e) => e.type === "message.created") as { message?: { meta?: object } }[];
  expect(posted.some((e) => "approvalId" in (e.message?.meta ?? {}))).toBe(false);
  // The decider's notification for the card took the new request (no second one).
  const upserted = heard.filter((e) => e.type === "notification.upserted");
  expect(upserted.length).toBeGreaterThan(0);
  const inbox = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, f.owner.id)));
  expect(inbox).toHaveLength(1);
  expect(inbox[0]?.count).toBe(2);

  // Another thread is another conversation: its own card.
  const other = await post("Planejamento de janeiro");
  await post("@dev agora a de janeiro", other.id);
  await drainOutbox(f.db, f.handlers);
  expect(await cardsOf()).toHaveLength(2);
});

test("decided items stay on the card; once nothing waits, the next request opens a new card", async () => {
  f = await setup({
    toolSources: [goals],
    reply: (_req, call) =>
      call === 1
        ? { chunks: ["Novembro."], toolUses: [{ name: "goal_upsert", input: { month: "2026-11", why: WHY } }] }
        : call === 2
          ? { chunks: ["Gravada."] }
          : { chunks: ["Dezembro."], toolUses: [{ name: "goal_upsert", input: { month: "2026-12", why: WHY } }] },
  });
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  const ask = await post("@dev grava a meta de novembro");
  await drainOutbox(f.db, f.handlers);
  const [first] = await f.db.select().from(schema.approvals);
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, first?.id ?? "", { decision: "approve" });
  await drainOutbox(f.db, f.handlers);
  await post("@dev e a de dezembro", ask.id);
  await drainOutbox(f.db, f.handlers);
  expect(await cardsOf()).toHaveLength(2);
});

test("mixed permissions: the agent's owner approves all they may; an admin-only item is left for an admin", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  const { rows } = await askFour();
  // One of them gives the agent new access: only an admin decides that one.
  const adminOnly = rows[3]?.id ?? "";
  await f.db.update(schema.approvals).set({ tool: REQUEST_PERMISSION_TOOL }).where(eq(schema.approvals.id, adminOnly));
  const result = await decideApprovals({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, {
    ids: rows.map((r) => r.id),
    decision: "approve",
  });
  expect(result.approvals).toHaveLength(3);
  expect(result.skipped).toEqual([adminOnly]);
  const [left] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, adminOnly));
  expect(left?.status).toBe("pending");
  // Nothing of theirs left to decide: a refusal.
  await expect(
    decideApprovals({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, { ids: [adminOnly], decision: "approve" }),
  ).rejects.toThrow("Only the agent's owner or an admin");
  // "Agora não para todos" from an admin decides the last one.
  const refused = await decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    ids: [adminOnly],
    decision: "refuse",
  });
  expect(refused.approvals.map((a) => a.status)).toEqual(["refused"]);
});

test("every brain is told to ask for several approvals together, in one turn", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev grava as metas",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  if (!run) throw new Error("no run");
  const text = systemText(
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable: true })).system,
  );
  expect(text).toContain(ASK_APPROVALS_TOGETHER);
  expect(forComputerBrain(text)).toContain(ASK_APPROVALS_TOGETHER);
  expect(ASK_APPROVALS_TOGETHER).toContain("call them all in the same response");
});

test("the card's notification follows its oldest waiting request, and leaves whoever has nothing left to decide", async () => {
  f = await setup({ toolSources: [goals], reply: fourAtOnce });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  const { rows } = await askFour();
  const [a, b, , d] = rows.map((r) => r.id);
  await f.db
    .update(schema.approvals)
    .set({ tool: REQUEST_PERMISSION_TOOL })
    .where(eq(schema.approvals.id, d ?? ""));
  const entry = async (userId: string) =>
    (
      await f.db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.userId, userId)))
    )[0];
  const decide = (ids: (string | undefined)[]) =>
    decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      ids: ids.map((id) => id ?? ""),
      decision: "approve",
    });

  // Bia is the agent's responsável: hers alone; the admin decides it from Aprovações, untold.
  expect(await entry(f.owner.id)).toBeUndefined();
  await decide([a]);
  const biaEntry = await entry(bia.id);
  expect((biaEntry?.source as { approvalId?: string } | undefined)?.approvalId).toBe(b);
  expect((biaEntry?.latest as { title?: string } | undefined)?.title).toBe(rows[1]?.title);
  expect(biaEntry?.doneAt).toBeNull();

  // Only the admin-only request waits: the agent's owner has nothing left there.
  await decide([b, rows[2]?.id]);
  expect((await entry(bia.id))?.doneAt).not.toBeNull();
  expect(d).toBeDefined();
});

test("an action too long for its card is cut with a mark, never passing for the whole", async () => {
  const body = `${"Olá equipe, segue o resumo da semana. ".repeat(80)}Fim.`;
  const notes: ToolSource = {
    name: "notes",
    tools: async () => [
      {
        name: "note_send",
        description: "Send a note outside",
        scope: "",
        sensitive: true,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        describe: (input) => ({ title: "Enviar a nota", detail: String((input as { text: string }).text) }),
        execute: async () => ({ content: "sent" }),
      },
    ],
  };
  f = await setup({
    toolSources: [notes],
    reply: (_req: unknown, call: number) =>
      call === 1
        ? { chunks: [""], toolUses: [{ name: "note_send", input: { text: body, why: WHY } }] }
        : { chunks: ["Enviada."] },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev manda a nota da semana",
  });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.approvals);
  expect(body.length).toBeGreaterThan(2000);
  expect(row?.detail).toHaveLength(2000);
  expect(row?.detail?.endsWith("…")).toBe(true);
});
