import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  approverIds,
  drainOutbox,
  listApprovals,
  notifiedIds,
  postPersonMessage,
  queueApprovalDigests,
  type ToolSource,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const tools: ToolSource = {
  name: "ops",
  tools: async () => [
    {
      name: "goal_upsert",
      description: "Saves a goal",
      scope: "",
      sensitive: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "done" }),
    },
  ],
};

const reply = (_req: unknown, call: number) =>
  call % 2 === 1
    ? {
        chunks: ["Vou pedir."],
        toolUses: [{ name: "goal_upsert", input: { why: "A pessoa pediu para gravar a meta do trimestre agora." } }],
      }
    : { chunks: ["Feito."] };

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** Two admins share the workspace: the owner Ana, and Bruno. */
async function world() {
  f = await setup({ toolSources: [tools], reply });
  const bruno = await addMember(f.db, f.org.id, "admin", "bruno");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bruno.id });
  return { bruno };
}

async function ask(by: string) {
  await postPersonMessage(deps(), by, f.org.id, f.general.id, { body: "@dev grava a meta" });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.approvals).orderBy(schema.approvals.createdAt);
  if (!row) throw new Error("no approval");
  return row;
}

const told = async () =>
  (await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "approval")))
    .map((n) => n.userId)
    .sort();

test("an agent with a responsável tells only them; the other admin still decides it, silently", async () => {
  const { bruno } = await world();
  await f.db.update(schema.agents).set({ ownerUserId: bruno.id }).where(eq(schema.agents.id, f.agent.id));
  const row = await ask(bruno.id);

  expect(await told()).toEqual([bruno.id]);
  expect(await notifiedIds(f.db, row)).toEqual([bruno.id]);
  // Ana may still decide it: it is on her Aprovações, she just isn't pinged.
  expect((await approverIds(f.db, row)).sort()).toEqual([f.owner.id, bruno.id].sort());
  const hers = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(hers.find((a) => a.id === row.id)?.canDecide).toBe(true);

  // A day later, the reminder email goes to Bruno alone too.
  await queueApprovalDigests(f.db, "http://localhost:3000", 1, new Date(Date.now() + 2 * 3600_000));
  const mails = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  const digests = mails.map((m) => m.payload as { to: string[]; template: { kind: string } });
  expect(digests.filter((p) => p.template.kind === "approval_digest").map((p) => p.to)).toEqual([[bruno.email]]);
});

test("with no responsável the admins are told, as the picker says", async () => {
  const { bruno } = await world();
  await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
  await ask(bruno.id);
  expect(await told()).toEqual([f.owner.id, bruno.id].sort());
});

test("handed to another responsável: the inbox item moves to them; with none left, to the admins", async () => {
  const { bruno } = await world();
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  await f.db.update(schema.agents).set({ ownerUserId: bruno.id }).where(eq(schema.agents.id, f.agent.id));
  await ask(bruno.id);
  const open = async () =>
    (await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "approval")))
      .filter((n) => n.doneAt === null)
      .map((n) => n.userId)
      .sort();
  expect(await open()).toEqual([bruno.id]);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: carla.id }, { pubsub: f.pubsub });
  expect(await open()).toEqual([carla.id]);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: null }, { pubsub: f.pubsub });
  expect(await open()).toEqual([f.owner.id, bruno.id].sort());
});
