import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  drainOutbox,
  HELLO_GAP_MS,
  listAgents,
  sayTeamHello,
  setBillingHold,
  TEAM_HELLO_JOB,
  useTeamTemplate,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/*
 * The team says hi in #general once it can work (ADR 0162): when the first plan starts, or when a template team is
 * made where no plan is waited for. One line each, Lodi first, no model call, no run, no notification.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const hold = (code: "payment" | "unpaid" | null) => setBillingHold({ db: f.db, pubsub: f.pubsub }, f.org.id, code);
// The lines are 1.1 s apart: drained as if that time had passed.
const drainLater = () => drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 60_000) });
// One moment after another, as the worker meets them: a batch runs its jobs side by side, so lines due together would
// land in any order.
const drainInTime = async () => {
  const t0 = Date.now();
  for (let k = 0; k <= 4; k++) await drainOutbox(f.db, f.handlers, { now: new Date(t0 + 500 + k * HELLO_GAP_MS) });
};
const helloJobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, TEAM_HELLO_JOB));
const hellos = async () => {
  const rows = await f.db
    .select({
      body: schema.messages.body,
      agentId: schema.messages.authorAgentId,
      meta: schema.messages.meta,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.channelId, f.general.id));
  const names = new Map(
    (await f.db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)).map((a) => [
      a.id,
      a.name,
    ]),
  );
  return rows
    .filter((m) => m.meta.greeting === true)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => ({ name: names.get(m.agentId ?? ""), body: m.body }));
};
const makeStore = () => useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "pt-BR");

describe("after the first plan", () => {
  test("Lodi, then each template agent in order, one line each in #general, with no run and no notification", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    await makeStore();
    // On the hold nobody greets yet.
    expect(await helloJobs()).toHaveLength(0);
    await hold(null);
    await drainInTime();
    expect(await hellos()).toEqual([
      { name: "Lodi", body: "Plano ativo. Vamos começar o trabalho." },
      { name: "Iara", body: "Oi, ana. Deixa comigo quem escrever no WhatsApp." },
      { name: "Otto", body: "Cheguei. Fico de olho nos pedidos e aviso se faltar algo no estoque." },
      { name: "Lia", body: "Oi, pessoal. Os posts da semana ficam comigo." },
    ]);
    // The team is in #general, answering there only when called; the right hand stays in no channel.
    const seats = await f.db
      .select({ agentId: schema.channelMembers.agentId, autoReply: schema.channelMembers.autoReply })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, f.general.id));
    const team = await f.db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.orgId, f.org.id));
    const seat = (name: string) => seats.find((s) => s.agentId === team.find((a) => a.name === name)?.id);
    expect(seat("Iara")?.autoReply).toBe(false);
    expect(seat("Lia")?.autoReply).toBe(false);
    expect(seat("Lodi")).toBeUndefined();
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);
    const notified = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.kind, "notifications.message")));
    expect(notified).toHaveLength(0);
  });

  test("while nothing here thinks, Lodi asks for an AI instead of starting the work: the plan brings none", async () => {
    f = await setup({ rightHand: true });
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.orgId, f.org.id));
    await hold("payment");
    await makeStore();
    await hold(null);
    await drainInTime();
    expect((await hellos()).map((h) => h.body)).toEqual([
      "Plano ativo. Conecte uma IA e a gente começa o trabalho.",
      "Oi, ana. Deixa comigo quem escrever no WhatsApp.",
      "Cheguei. Fico de olho nos pedidos e aviso se faltar algo no estoque.",
      "Oi, pessoal. Os posts da semana ficam comigo.",
    ]);
  });

  test("the team made at once keeps its template's order in the agents' list, as every screen lists it", async () => {
    f = await setup({ rightHand: true });
    await makeStore();
    const names = (await listAgents(f.db, f.owner.id, f.org.id)).map((a) => a.name);
    expect(names.filter((n) => ["Iara", "Otto", "Lia"].includes(n))).toEqual(["Iara", "Otto", "Lia"]);
    expect(names[0]).toBe("Lodi");
  });

  test("its computer clause only while the workspace's computer is still on its way", async () => {
    f = await setup({ rightHand: true });
    const [lodi] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));
    const payload = { agentId: lodi?.id, userId: f.owner.id, how: "paid" };
    await sayTeamHello({ db: f.db, workspaceComputer: { billing: true } }, f.org.id, payload);
    expect((await hellos()).map((h) => h.body)).toEqual([
      "Plano ativo. Meu computador já está iniciando. Vamos começar o trabalho.",
    ]);
    // Said once, whatever runs again.
    await sayTeamHello({ db: f.db, workspaceComputer: { billing: true } }, f.org.id, payload);
    expect(await hellos()).toHaveLength(1);
  });

  test("an agent someone already put in #general keeps the auto-reply they gave it", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    await makeStore();
    const [iara] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.handle, "iara")));
    if (!iara) throw new Error("no Iara");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: iara.id, autoReply: true });
    await hold(null);
    await drainInTime();
    expect((await hellos()).map((h) => h.name)).toEqual(["Lodi", "Iara", "Otto", "Lia"]);
    const [seat] = await f.db
      .select({ autoReply: schema.channelMembers.autoReply })
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.agentId, iara.id)));
    expect(seat?.autoReply).toBe(true);
  });

  test("a later lift (a plan that lapsed, then paid) queues nothing", async () => {
    f = await setup({ rightHand: true });
    await hold("unpaid");
    await hold(null);
    expect(await helloJobs()).toHaveLength(0);
  });
});

describe("with no plan to wait for", () => {
  test("a template team says hi as it is made, once, in its maker's language", async () => {
    f = await setup({ rightHand: true });
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, f.owner.id));
    await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "support", "en");
    await drainInTime();
    expect(await hellos()).toEqual([
      { name: "Lodi", body: "The team is here. Let's get to work." },
      { name: "Iara", body: "Hi, ana. Leave whoever writes on WhatsApp to me." },
      { name: "Bia", body: "Hi. I'll keep the answer base up to date with what the team says." },
    ]);
    // A second template team later: the hello was the workspace's start, not each team's.
    await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "en");
    await drainLater();
    expect(await hellos()).toHaveLength(3);
  });

  test("an agent made by hand says nothing", async () => {
    f = await setup({ rightHand: true });
    await sayTeamHello({ db: f.db }, f.org.id, { agentId: f.agent.id, userId: f.owner.id, how: "created" });
    expect(await hellos()).toEqual([]);
  });

  test("a workspace deleted before its lines went out says none", async () => {
    f = await setup({ rightHand: true });
    await makeStore();
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
      .where(eq(schema.organizations.id, f.org.id));
    await drainInTime();
    expect(await hellos()).toEqual([]);
  });
});
