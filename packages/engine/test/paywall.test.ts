import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  answerNow,
  createAgent,
  createAgentRuns,
  createCredential,
  createJobHandlers,
  drainOutbox,
  emailArtAt,
  getMessage,
  insertMessage,
  noAiCardOf,
  OrgPausedError,
  postPersonMessage,
  type RouterStrategy,
  receiptsFor,
  renderEmail,
  rotateCredential,
  routeMessage,
  runRoutineNow,
  sendPlanWaitingEmail,
  setBillingHold,
  setOrgStanding,
  useTeamTemplate,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const hold = (code: "payment" | "unpaid" | "ended" | null) => setBillingHold({ db: f.db }, f.org.id, code);
const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const cards = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter((m) =>
    noAiCardOf({ authorType: m.authorType, meta: m.meta }),
  );
const reminders = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "plan.waiting"));
const answerDeps = () => ({ db: f.db, pubsub: f.pubsub, gateway: f.gateway });

describe("the first send on a hold", () => {
  test("the agent keeps the message with no model call, and after the plan the same message is answered", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    await hold("payment");
    await post("@dev reply to this customer");
    await drainOutbox(f.db, f.handlers);

    expect(f.provider.calls).toHaveLength(0);
    const [card] = await cards();
    expect(card?.meta.noAi).toMatchObject({ reason: "plan_hold", intent: "task" });
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ status: "failed", error: "no_ai" });

    // A key saved earlier reads as ready: the card must not restart a run that would only be refused again.
    const refused = await answerNow(answerDeps(), f.owner.id, f.org.id, card?.id as string).catch((e) => e);
    expect(refused).toBeInstanceOf(OrgPausedError);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);

    await hold(null);
    const { runs } = await answerNow(answerDeps(), f.owner.id, f.org.id, card?.id as string);
    expect(runs).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });

  test("two agents called in one message share a card, and both answer after the plan", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops", role: "", instructions: "", credentialId: null },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    const keys = (revokedAt: Date | null) =>
      f.db.update(schema.providerCredentials).set({ revokedAt }).where(eq(schema.providerCredentials.orgId, f.org.id));
    await keys(new Date());
    await hold("payment");
    await post("@dev @ops look at this");
    await drainOutbox(f.db, f.handlers);
    const kept = await cards();
    expect(kept).toHaveLength(1);

    await hold(null);
    await keys(null);
    const { runs } = await answerNow(answerDeps(), f.owner.id, f.org.id, kept[0]?.id as string);
    expect(runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, ops.id].sort());
  });

  test("a second message within the 6 hours gets no second card, and the reminders are queued once", async () => {
    f = await setup();
    await hold("payment");
    await post("@dev one");
    await drainOutbox(f.db, f.handlers);
    await post("@dev two");
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(1);
    expect((await reminders()).map((r) => r.payload.step).sort()).toEqual([0, 1]);
  });

  test("a trust hold still ends the run saying why, with no card", async () => {
    f = await setup();
    await setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      state: "hold",
      reason: "review",
      notice: "shown",
    });
    await post("@dev hello");
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(0);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.error).not.toBe("no_ai");
  });
});

describe("what isn't a person's message to keep", () => {
  const person = () =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "hi",
    });
  const runOf = async (messageId: string) =>
    (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId)))[0];

  test("background work ends saying why, with no card and no word about an AI", async () => {
    f = await setup();
    const m = await person();
    await hold("unpaid");
    await f.db.transaction((tx) => createAgentRuns(tx, m, [f.agent.id], "mention", { background: true }));
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(0);
    const run = await runOf(m.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).not.toBe("no_ai");
  });

  test("an agent's call to another agent is no kept message of anyone's", async () => {
    f = await setup();
    const m = await person();
    const [first] = await f.db.transaction((tx) => createAgentRuns(tx, m, [f.agent.id], "mention"));
    await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
    const handed = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: first?.id as string, hop: 1 },
      body: "over to you",
    });
    await hold("unpaid");
    await f.db.transaction((tx) => createAgentRuns(tx, handed, [f.agent.id], "mention"));
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(0);
    const run = await runOf(handed.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).not.toBe("no_ai");
  });
});

describe("the agents a new person meets first", () => {
  test("Lodi in its own DM keeps the message, and no model is called", async () => {
    f = await setup({ rightHand: true, reply: () => ({ chunks: ["On it."] }) });
    await hold("payment");
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "en");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, used.channelId, { body: "oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    const [card] = await cards();
    expect(card?.channelId).toBe(used.channelId);
    expect(card?.meta.noAi).toMatchObject({ reason: "plan_hold" });
  });

  test("an agent on a plan, with no computer, is kept the same way", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, f.agent.id));
    await hold("payment");
    await post("@dev reply to this customer");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    expect((await cards())[0]?.meta.noAi).toMatchObject({ reason: "plan_hold" });
  });
});

describe("a channel message nobody mentioned", () => {
  const strategy: RouterStrategy = {
    name: "test",
    decide: () => {
      throw new Error("asked a strategy on a hold");
    },
  } as unknown as RouterStrategy;
  const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
  const decision = (messageId: string) =>
    f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId));

  test("with agents there it is stored as `no_ai`, asking nothing", async () => {
    f = await setup();
    await hold("payment");
    const m = await post("anyone there?");
    const routed = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id });
    expect(routed).toMatchObject({ runs: [], reason: "no_ai", held: true });
    expect((await decision(m.id))[0]?.error).toBe("no_ai");
  });

  test("it starts the reminders, says `kept`, and after the plan it is routed to an agent", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const picks: RouterStrategy = {
      name: "fixed",
      decide: async (input) => ({
        agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 1 })),
        reason: "test",
      }),
    };
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy: picks },
    });
    await hold("payment");
    const m = await post("anyone there?");
    await drainOutbox(f.db, handlers);
    expect(f.provider.calls).toHaveLength(0);
    expect((await reminders()).map((r) => r.payload.step).sort()).toEqual([0, 1]);
    const row = await getMessage(f.db, f.org.id, m.id);
    const receipts = await receiptsFor(f.db, f.org.id, row ? [row] : []);
    expect(receipts.get(m.id)).toMatchObject({ noAi: true, kept: true });

    await hold(null);
    const router = { db: f.db, strategy: picks, policy };
    const { runs } = await answerNow({ ...answerDeps(), router }, f.owner.id, f.org.id, m.id);
    expect(runs).toHaveLength(1);
  });

  test("with no agent there nothing is stored, and on an `unpaid` hold nothing is asked or stored either", async () => {
    f = await setup();
    await hold("payment");
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.agentId, f.agent.id)));
    const m = await post("anyone there?");
    expect(await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id })).toEqual({
      runs: [],
      skipped: "org_paused",
    });
    expect(await decision(m.id)).toHaveLength(0);

    await hold("unpaid");
    const other = await post("still there?");
    expect(await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: other.id })).toEqual({
      runs: [],
      skipped: "org_paused",
    });
  });
});

describe("what a hold closes", () => {
  test("no key is saved as a way around it, a new one or a saved one changed", async () => {
    f = await setup();
    const key = { provider: "openai" as const, label: "OpenAI", apiKey: "sk-test-1234567890" };
    const saved = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, key);
    await hold("payment");
    const refused = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, key).catch((e) => e);
    expect(refused).toMatchObject({ code: "credentials.plan_hold" });
    const changed = await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, saved.id, {
      apiKey: "sk-test-0987654321",
    }).catch((e) => e);
    expect(changed).toMatchObject({ code: "credentials.plan_hold" });
  });

  test("embeddings fall back to full text, so search keeps working", async () => {
    f = await setup({ embeddings: true });
    await hold("payment");
    expect(await f.gateway.embed({ orgId: f.org.id, texts: ["hi"], inputType: "query" })).toBeNull();
  });

  test("Rodar agora says so instead of a slot that silently passes", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await hold("payment");
    await expect(runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id)).rejects.toBeInstanceOf(
      OrgPausedError,
    );
  });
});

describe("the team before paying", () => {
  const lodiDm = async (channelId: string) =>
    f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));

  test("Criar o time makes the team at once, with no question, no run and no model call", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "pt-BR");
    await drainOutbox(f.db, f.handlers);
    expect(used.state).toBe("created");
    const rows = await lodiDm(used.channelId);
    expect(rows.some((m) => m.authorType === "person")).toBe(false);
    expect(rows.some((m) => m.meta.replyChips)).toBe(false);
    expect(await cards()).toHaveLength(0);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);
    const team = await f.db.select({ name: schema.agents.name }).from(schema.agents);
    expect(team.map((a) => a.name)).toEqual(expect.arrayContaining(["Iara", "Lia", "Otto"]));
  });

  test("with a plan in force the same template is made at once", async () => {
    f = await setup({ rightHand: true });
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "pt-BR");
    expect(used.state).toBe("created");
    const rows = await lodiDm(used.channelId);
    expect(rows.some((m) => m.meta.replyChips)).toBe(false);
  });

  test("making the team on a hold queues the two reminders", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "support", "en");
    expect(await reminders()).toHaveLength(2);
  });
});

describe("the plan_waiting email", () => {
  const sent = () =>
    f.db
      .select()
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.kind, "email.send"), sql`${schema.outbox.payload}->'template'->>'kind' = 'plan_waiting'`),
      );

  test("goes to who can pay at a confirmed address, with the billing page, while it still waits", async () => {
    f = await setup();
    await hold("payment");
    await addMember(f.db, f.org.id, "member");
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));
    await sendPlanWaitingEmail(f.db, "https://app.example.com/", f.org.id, 0);
    const [row] = await sent();
    const payload = row?.payload as { to: string[]; template: { url: string; agents: number } };
    expect(payload.to).toHaveLength(1);
    expect(payload.template.url).toBe(`https://app.example.com/org/${f.org.id}/settings/billing`);
    expect(payload.template.agents).toBeGreaterThan(0);
  });

  test("the job itself: due on time, it sends to the address, and queued twice it sends once per step", async () => {
    f = await setup();
    const handlers = createJobHandlers({ ...f.jobDeps, emailArt: emailArtAt("https://app.example.com") });
    await hold("payment");
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));
    await post("@dev one");
    await drainOutbox(f.db, handlers);
    await post("@dev two");
    await drainOutbox(f.db, handlers);
    expect(await reminders()).toHaveLength(2);
    expect(await sent()).toHaveLength(0);
    await f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, "plan.waiting"));
    await drainOutbox(f.db, handlers);
    expect(await sent()).toHaveLength(2);
    expect(new Set((await reminders()).map((r) => r.status))).toEqual(new Set(["done"]));
  });

  test("nothing at an unconfirmed address, or once the workspace has its plan", async () => {
    f = await setup();
    await hold("payment");
    await f.db.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, f.owner.id));
    await sendPlanWaitingEmail(f.db, "https://app.example.com", f.org.id, 0);
    expect(await sent()).toHaveLength(0);
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));
    await hold(null);
    await sendPlanWaitingEmail(f.db, "https://app.example.com", f.org.id, 1);
    expect(await sent()).toHaveLength(0);
  });
});

test("the computer's ready email sends a kept message's person to that conversation, with Connect open", () => {
  const ready = {
    kind: "computer_ready" as const,
    orgName: "Acme",
    specs: null,
    needsAi: true,
    hasAgents: true,
    url: "https://app.example.com/org/o1",
  };
  const keptUrl = "https://app.example.com/org/o1/dm/agent/a1";
  expect(renderEmail({ ...ready, keptUrl }).html).toContain(`${keptUrl}?connect=ai`);
  expect(renderEmail(ready).html).toContain("/org/o1?connect=ai");
  // With an AI already there, the button still lands where the message waits: opening it starts the answer.
  expect(renderEmail({ ...ready, needsAi: false, keptUrl }).html).toContain(`href="${keptUrl}"`);
});
