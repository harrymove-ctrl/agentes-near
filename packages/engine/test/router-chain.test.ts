import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type MachineReplies, type MachineRequest, type RealtimeEvent, ROUTE_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createCredential,
  createJobHandlers,
  drainOutbox,
  getMessage,
  insertMessage,
  type JobDeps,
  type MachineCaller,
  MachineRequestError,
  type MachineStatus,
  postPersonMessage,
  receiptsFor,
  smallModelFor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(() => f?.close());

type Route = Extract<MachineRequest, { op: "brain.route" }>;
type RouteReply = MachineReplies["brain.route"];

/** The first handle the schema allows, picked as a plan would. */
const firstHandle = (request: Route) =>
  (request.schema as { properties: { scores: { items: { properties: { handle: { enum: string[] } } } } } }).properties
    .scores.items.properties.handle.enum[0];

const answer = (request: Route): RouteReply => ({
  json: {
    needs_agent: 0.9,
    scores: [{ handle: firstHandle(request), score: 0.9 }],
    reason: `follow-up: ${"x".repeat(400)}`,
  },
  model: "claude-haiku-5-5",
  usage: { input: 2600, output: 80, cacheRead: 2000, cacheWrite: 0 },
  durationMs: 4200,
});

/** A fake machine hub: every computer online at `protocol`, signed in with a plan; `reply` answers routes. */
function fakeHub(
  over: {
    protocol?: number;
    authMethod?: string;
    status?: Partial<MachineStatus>;
    reply?: (r: Route) => RouteReply | Error;
  } = {},
) {
  const calls: { machineId: string; request: Route }[] = [];
  const hub = {
    calls,
    async status(machineId: string): Promise<MachineStatus> {
      return {
        id: machineId,
        orgId: f.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: over.protocol ?? ROUTE_PROTOCOL,
        executors: {
          claude: { version: "2.1.311", loggedIn: true, authMethod: over.authMethod ?? "claude.ai", plan: "max" },
          detectedAt: new Date().toISOString(),
        },
        ...over.status,
      };
    },
    async call(machineId: string, request: Route) {
      calls.push({ machineId, request });
      const out = (over.reply ?? answer)(request);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return hub as typeof hub & Pick<MachineCaller, "call" | "status">;
}

const post = (userId: string, body: string, extra: { replyTo?: string; threadId?: string } = {}) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body, ...extra });
const byAgent = (agentId: string, body: string, minutesAgo = 0) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
    body,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
/** Drains the outbox, then ends every run: no agent here has a brain, and an open run takes the next message. */
const drain = async (handlers: ReturnType<typeof createJobHandlers>) => {
  await drainOutbox(f.db, handlers);
  await f.db.update(schema.agentRuns).set({ status: "done" });
};
const decisionOf = async (messageId: string) =>
  (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];
const routedOf = (events: RealtimeEvent[], messageId: string) =>
  events.find((e) => e.type === "message.routed" && (e as { messageId?: string }).messageId === messageId) as
    | Record<string, unknown>
    | undefined;

/**
 * No Jev and no API key: Dev thinks with Ana's own Claude account on her computer, and Bruna is in #general too
 * (so a message there isn't Ana alone with one agent).
 */
async function plansOnly(hub = fakeHub(), publicUrl = "http://localhost:3000") {
  f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const bruna = await addMember(f.db, f.org.id, "member", "Bruna");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bruna.id });
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  const accountId = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id: accountId,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    status: "active",
    createdBy: f.owner.id,
    lastUsedAt: new Date(),
  });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId, brainAccountId: accountId })
    .where(eq(schema.agents.id, f.agent.id));
  const deps: JobDeps = {
    ...f.jobDeps,
    machines: hub,
    router: { enabled: true, model: "claude-haiku-5-5", plans: { hub, publicUrl } },
  };
  return { hub, bruna, machineId, accountId, handlers: createJobHandlers(deps) };
}

describe("the author's own plan", () => {
  test("decides when nothing faster can, says so first, and is recorded on the plan at no cost", async () => {
    const { hub, machineId, accountId, handlers } = await plansOnly();
    const events = f.listen(f.general.id);
    const m = await post(f.owner.id, "alguém sabe se o deploy de ontem saiu?");
    await drain(handlers);

    expect(hub.calls).toHaveLength(1);
    const route = hub.calls[0]?.request;
    expect(hub.calls[0]?.machineId).toBe(machineId);
    expect(route).toMatchObject({
      op: "brain.route",
      agent: { id: f.agent.id, handle: "dev" },
      kind: "claude_code",
      account: accountId,
    });
    expect(route?.system).toContain("This is a quick classification.");
    expect(route?.prompt).toContain("alguém sabe se o deploy de ontem saiu?");

    const decision = await decisionOf(m.id);
    expect(decision).toMatchObject({ strategy: "plan:claude_code", selectedAgentIds: [f.agent.id], error: null });
    // The plan's words come after the step's name, cut: never the follow-up marker, never shown.
    expect(decision?.reason?.startsWith("plan: follow-up: x")).toBe(true);
    expect(decision?.reason?.length).toBeLessThanOrEqual("plan: ".length + 200);

    const routing = events.findIndex((e) => e.type === "message.routing");
    const routed = events.findIndex((e) => e.type === "message.routed");
    expect(events[routing]).toMatchObject({ messageId: m.id, step: "plan" });
    expect(routing).toBeLessThan(routed);
    expect(events[routed]).toMatchObject({
      pickedBy: [f.agent.id],
      decidedBy: { step: "plan", brand: "claude", ownerId: f.owner.id },
    });

    const usage = (await f.db.select().from(schema.usageRecords)).find((u) => u.kind === "router");
    expect(usage).toMatchObject({
      agentId: f.agent.id,
      provider: "claude_code",
      model: "claude-haiku-5-5",
      billedTo: "plan",
      costNanoUsd: 0,
      machineId,
      brainAccountId: accountId,
      inputTokens: 600,
      cacheReadTokens: 2000,
    });
    expect(decision?.usageRecordId).toBe(usage?.id ?? "");
  });

  test("never for someone else's message: a teammate with no plan of their own gets the rules", async () => {
    const { hub, bruna, handlers } = await plansOnly();
    const m = await post(bruna.id, "alguém sabe se o deploy de ontem saiu?");
    await drain(handlers);
    expect(hub.calls).toHaveLength(0);
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
  });

  test("a coding plan's key, a runner too old for routes, the Cloud: no call", async () => {
    const { hub, accountId, handlers } = await plansOnly();
    await f.db.update(schema.machineAccounts).set({ provider: "zai" }).where(eq(schema.machineAccounts.id, accountId));
    await post(f.owner.id, "alguém viu o relatório?");
    await drain(handlers);
    expect(hub.calls).toHaveLength(0);
    await f.close();

    const old = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    await post(f.owner.id, "alguém viu o relatório?");
    await drain(old.handlers);
    expect(old.hub.calls).toHaveLength(0);
    await f.close();

    const cloud = await plansOnly(fakeHub(), "https://app.agentes.chat");
    const m = await post(f.owner.id, "alguém viu o relatório?");
    await drain(cloud.handlers);
    expect(cloud.hub.calls).toHaveLength(0);
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "none" });
  });

  test("a computer that won't route, on Windows or with Claude Code switched off: no call, no 'picking'", async () => {
    const tried = async (status: Partial<MachineStatus>) => {
      const { hub, handlers } = await plansOnly(fakeHub({ status }));
      const events = f.listen(f.general.id);
      const m = await post(f.owner.id, "alguém viu o relatório?");
      await drain(handlers);
      expect(await decisionOf(m.id)).toMatchObject({ strategy: "none", error: null });
      return [hub.calls.length, events.filter((e) => e.type === "message.routing").length];
    };
    expect(await tried({ os: "windows" })).toEqual([0, 0]);
    await f.close();
    const off = { folders: [], tools: { claude: false, codex: true, commands: true } };
    expect(await tried({ access: off })).toEqual([0, 0]);
  });

  test("the computer's own Claude sign-in counts only when made with a plan", async () => {
    const make = async (authMethod: string) => {
      const ctx = await plansOnly(fakeHub({ authMethod }));
      // Dev thinks with the computer's own sign-in, which Ana paired.
      await f.db.update(schema.agents).set({ brainAccountId: null }).where(eq(schema.agents.id, f.agent.id));
      await post(f.owner.id, "alguém viu o relatório?");
      await drain(ctx.handlers);
      return ctx.hub.calls;
    };
    const calls = await make("claude.ai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).not.toHaveProperty("account");
    await f.close();
    expect(await make("api_key")).toHaveLength(0);
  });

  test("a sign-in busy with an agent's process yields to the author's next one; all busy, the rules decide", async () => {
    let busy = 1;
    const hub = fakeHub({ reply: (r) => (busy-- > 0 ? { busy: true } : answer(r)) });
    const { machineId, handlers } = await plansOnly(hub);
    // Ops thinks with the computer's own sign-in: Ana's second one, after the account she used last.
    const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: null })
      .where(eq(schema.agents.id, ops.id));
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const m = await post(f.owner.id, "alguém viu o relatório?");
    await drain(handlers);
    expect(hub.calls.map((c) => c.request.account ?? "own")).toEqual([expect.any(String), "own"]);
    expect(hub.calls[1]?.request.agent?.id).toBe(ops.id);
    expect((await decisionOf(m.id))?.strategy).toBe("plan:claude_code");

    busy = 2;
    const again = await post(f.owner.id, "e o outro relatório?");
    await drain(handlers);
    expect(await decisionOf(again.id)).toMatchObject({ error: "plan: every sign-in is busy" });
    expect((await decisionOf(again.id))?.strategy).not.toStartWith("plan");
  });

  test("an account that thinks for two of the author's agents is one sign-in: one route to it, never one per agent", async () => {
    const hub = fakeHub({ reply: () => ({ busy: true }) });
    const { machineId, accountId, handlers } = await plansOnly(hub);
    await f.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, accountId));
    const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: accountId })
      .where(eq(schema.agents.id, ops.id));
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const m = await post(f.owner.id, "alguém viu o relatório?");
    await drain(handlers);
    // Busy is busy for every agent on it: nothing asks the same sign-in again for Ops.
    expect(hub.calls).toHaveLength(1);
    expect(await decisionOf(m.id)).toMatchObject({ error: "plan: every sign-in is busy" });
  });

  test("a plan that doesn't answer in time leaves it to the rules, and a failure is never silence (R5)", async () => {
    const hub = fakeHub({
      reply: () => new MachineRequestError("timeout", "the computer MacBook did not answer within 30 s"),
    });
    const { handlers } = await plansOnly(hub);
    const m = await post(f.owner.id, "alguém viu o relatório?");
    await drain(handlers);
    expect(hub.calls).toHaveLength(1);
    expect(await decisionOf(m.id)).toMatchObject({
      strategy: "rule:default",
      selectedAgentIds: [f.agent.id],
      error: "plan: the computer MacBook did not answer within 30 s",
    });
    // People talking among themselves still get nobody.
    const lunch = await post(f.owner.id, "boa tarde Bruna, vamos almoçar?");
    await drain(handlers);
    expect(await decisionOf(lunch.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
  });

  test("a reply to an agent, quoted or in its thread, goes by the rule, and the plan isn't asked", async () => {
    const { hub, handlers } = await plansOnly();
    const report = await byAgent(f.agent.id, "O deploy de ontem falhou no passo de migração.");
    const quoted = await post(f.owner.id, "por que falhou?", { replyTo: report.id });
    await drain(handlers);
    const threaded = await post(f.owner.id, "e o rollback?", { threadId: report.id });
    await drain(handlers);
    expect(hub.calls).toHaveLength(0);
    for (const m of [quoted, threaded]) {
      expect(await decisionOf(m.id)).toMatchObject({ strategy: "rule:reply", selectedAgentIds: [f.agent.id] });
    }
  });

  test("in a thread too: a reply to one agent's message goes to that agent, whoever spoke last", async () => {
    const { hub, handlers } = await plansOnly();
    const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const root = await byAgent(f.agent.id, "O deploy de ontem falhou.");
    const inThread = (agentId: string, body: string) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
        body,
      });
    const report = await inThread(f.agent.id, "Falhou na migração.");
    await inThread(ops.id, "Os discos estão bem.");
    await drain(handlers);
    const quoted = await post(f.owner.id, "por que falhou?", { threadId: root.id, replyTo: report.id });
    await drain(handlers);
    expect(hub.calls).toHaveLength(0);
    expect(await decisionOf(quoted.id)).toMatchObject({ strategy: "rule:reply", selectedAgentIds: [f.agent.id] });
  });

  test("an agent's own message goes through Jev or a model only: no plan, no rule", async () => {
    const { hub, handlers } = await plansOnly();
    const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const m = await byAgent(ops.id, "Terminei a migração; alguém confere os números?");
    await drain(handlers);
    expect(hub.calls).toHaveLength(0);
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
  });
});

describe("rules, when nothing can read the message", () => {
  test("R1 in a thread: for the agent it is under, only while no other agent spoke there", async () => {
    const { handlers } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const report = await byAgent(f.agent.id, "O deploy de ontem falhou no passo de migração.");
    const hit = await post(f.owner.id, "por que falhou?", { threadId: report.id });
    await drain(handlers);
    expect(await decisionOf(hit.id)).toMatchObject({ strategy: "rule:reply", selectedAgentIds: [f.agent.id] });

    const backup = await byAgent(f.agent.id, "A rotina de backup terminou.");
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: backup.id,
      author: { type: "agent", agentId: ops.id, runId: null, hop: 1, stretchId: null },
      body: "Aqui o backup do banco falhou.",
    });
    const miss = await post(f.owner.id, "e agora?", { threadId: backup.id });
    await drain(handlers);
    expect(await decisionOf(miss.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
  });

  test("R2: a person alone in the channel with its one agent; not with someone else there", async () => {
    const { handlers, bruna } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, bruna.id));
    const alone = await post(f.owner.id, "bom dia");
    await drain(handlers);
    expect(await decisionOf(alone.id)).toMatchObject({ strategy: "rule:only_agent", selectedAgentIds: [f.agent.id] });

    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bruna.id });
    const company = await post(f.owner.id, "bom dia de novo");
    await drain(handlers);
    expect(await decisionOf(company.id)).toMatchObject({ strategy: "none" });
  });

  test("R3: a follow-up of the author's own talk with an agent, unless it names another person", async () => {
    const { handlers } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    await post(f.owner.id, "@dev olha o deploy");
    await drain(handlers);
    await byAgent(f.agent.id, "Olhei: está verde.");
    const followUp = await post(f.owner.id, "e os testes?");
    await drain(handlers);
    expect(await decisionOf(followUp.id)).toMatchObject({
      strategy: "rule:follow_up",
      selectedAgentIds: [f.agent.id],
      reason: "follow-up",
    });
    const greeting = await post(f.owner.id, "boa noite BRÚNA");
    await drain(handlers);
    expect(await decisionOf(greeting.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
  });

  test("R3 trusts only the author's own talk: Dev answered Ana, so Bruna's lunch call goes to nobody", async () => {
    const { handlers, bruna } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    await post(f.owner.id, "@dev como está o deploy?");
    await drain(handlers);
    await byAgent(f.agent.id, "Verde.");
    const lunch = await post(bruna.id, "vamos almoçar?");
    await drain(handlers);
    expect(await decisionOf(lunch.id)).toMatchObject({ strategy: "none", selectedAgentIds: [] });
  });

  test("R3 outside its 10 minutes: nobody", async () => {
    const { handlers } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "dev, olha o deploy",
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    await byAgent(f.agent.id, "Olhei: está verde.", 29);
    const late = await post(f.owner.id, "e os testes?");
    await drain(handlers);
    expect(await decisionOf(late.id)).toMatchObject({ strategy: "none" });
  });

  test("nobody keeps its candidates, and the receipt says why after a reload", async () => {
    const { handlers } = await plansOnly(fakeHub({ protocol: ROUTE_PROTOCOL - 1 }));
    const events = f.listen(f.general.id);
    const m = await post(f.owner.id, "alguém viu o relatório?");
    await drain(handlers);
    expect(routedOf(events, m.id)).toMatchObject({ seenBy: [f.agent.id], pickedBy: [], reason: "mention_needed" });
    expect(routedOf(events, m.id)).not.toHaveProperty("decidedBy");
    const message = await getMessage(f.db, f.org.id, m.id);
    const receipts = await receiptsFor(f.db, f.org.id, message ? [message] : []);
    expect(receipts.get(m.id)).toMatchObject({ seenBy: [f.agent.id], pickedBy: [], reason: "mention_needed" });
    expect(receipts.get(m.id)).not.toHaveProperty("decidedBy");
  });
});

describe("Jev and the small model", () => {
  /** A fake TypeSafe: Dev should answer. */
  const jevFetch = (status = 200) =>
    (async () =>
      status === 200
        ? Response.json({
            model: "jev-1.14.0",
            answers: { needs_agent: { type: "noul", noul: 0.9 }, agent_0: { type: "noul", noul: 0.9 } },
            usage: { input_tokens: 900, output_tokens: 10 },
          })
        : new Response("boom", { status })) as unknown as typeof fetch;

  test("Jev decides, and says so; down, the small model decides and the decision names Jev's failure", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"r"}'] }
          : { chunks: ["ok"] },
    });
    const events = f.listen(f.general.id);
    const handlers = (status: number) =>
      createJobHandlers({
        ...f.jobDeps,
        router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "ts_key", fetch: jevFetch(status) } },
      });
    const m = await post(f.owner.id, "o deploy saiu?");
    await drain(handlers(200));
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "jev", error: null });
    expect(routedOf(events, m.id)).toMatchObject({ decidedBy: { step: "jev" } });

    const down = await post(f.owner.id, "e o de hoje?");
    await drain(handlers(500));
    expect(await decisionOf(down.id)).toMatchObject({
      strategy: "llm:claude-haiku-5-5",
      error: "jev: TypeSafe answered 500",
    });
    expect(routedOf(events, down.id)).toMatchObject({
      decidedBy: { step: "model", model: "claude-haiku-5-5", provider: "anthropic" },
    });
    const message = await getMessage(f.db, f.org.id, down.id);
    const receipts = await receiptsFor(f.db, f.org.id, message ? [message] : []);
    expect(receipts.get(down.id)?.decidedBy).toEqual({
      step: "model",
      model: "claude-haiku-5-5",
      provider: "anthropic",
    });
  });

  test("which small model: any key with one, the default's first; never Kimi's; the workspace's own choice", async () => {
    f = await setup();
    const key = (provider: "openai" | "deepseek" | "moonshot" | "anthropic", makeDefault = false) =>
      createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
        provider,
        label: provider,
        apiKey: `sk-${provider}-test-key-123456`,
        makeDefault,
      });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    expect(await smallModelFor(f, f.org.id)).toBeNull();
    // Kimi alone: no small model, so no model call at all.
    await key("moonshot", true);
    expect(await smallModelFor(f, f.org.id)).toBeNull();
    // An OpenAI key that isn't the default.
    const openai = await key("openai");
    expect(await smallModelFor(f, f.org.id)).toBe("gpt-6-luna");
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.id, openai.id));
    await key("deepseek");
    expect(await smallModelFor(f, f.org.id)).toBe("deepseek-flash");
    // A default Kimi key and a Claude key: Haiku before DeepSeek.
    await key("anthropic");
    expect(await smallModelFor(f, f.org.id)).toBe("claude-haiku-5-5");
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, routerModel: "deepseek-flash" })
      .onConflictDoUpdate({
        target: schema.organizationSettings.orgId,
        set: { routerModel: "deepseek-flash" },
      });
    expect(await smallModelFor(f, f.org.id)).toBe("deepseek-flash");
    // Its own choice on a provider it has no key for doesn't count.
    await f.db
      .update(schema.organizationSettings)
      .set({ routerModel: "gpt-6-luna" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    expect(await smallModelFor(f, f.org.id)).toBe("claude-haiku-5-5");
  });

  test("Kimi alone: no model call, and the rules decide", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi"] }) });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    const kimi = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "moonshot",
      label: "kimi",
      apiKey: "sk-kimi-test-key-123456",
      makeDefault: true,
    });
    await f.db
      .update(schema.agents)
      .set({ model: "kimi-k3.1-pro", credentialId: kimi.id })
      .where(eq(schema.agents.id, f.agent.id));
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const m = await post(f.owner.id, "bom dia");
    await drain(handlers);
    // Ana is alone with Dev: the rule sends it there, and only Dev's own answer reaches a model.
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "rule:only_agent", error: null });
    expect(f.provider.calls.filter((c) => c.request.outputSchema)).toHaveLength(0);
  });
});
