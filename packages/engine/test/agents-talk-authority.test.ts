import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  classifyAddressees,
  createAgent,
  createChannel,
  createRoutine,
  createScheduleToolSource,
  drainOutbox,
  insertMessage,
  type Judge,
  listMessages,
  pickAddressees,
  postPersonMessage,
  receiptsFor,
  type ToolContext,
} from "../src";
import { personBehindRun } from "../src/requester";
import { addMember, type Fixture, setup } from "./fixtures";

// ADR 0034 addendum (incident 2026-10-18, #tech): "@atlas … pede para a @ada …" started both agents;
// Ada relayed the same request to Atlas privately, and Atlas's routine tools refused it.

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const isAgent = (req: ModelRequest, handle: string) => systemText(req.system).includes(`(@${handle})`);
const runs = () => f.db.select().from(schema.agentRuns);
const consultations = () => f.db.select().from(schema.agentConsultations);

async function addInfra() {
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Infra",
      handle: "infra",
      role: "Infrastructure",
      instructions: "You run the servers.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
  return infra;
}

/** The fake judge: the person speaks to @dev; anyone else is only referenced. */
const devIsAddressee = (kind: string, _id: string, _state: unknown, q: { instructions: unknown }) =>
  kind === "mention_addressees"
    ? (q.instructions as { agent?: { handle?: string } }).agent?.handle === "@dev"
      ? 0.92
      : 0.08
    : undefined;

describe("addressee vs referenced (several agents mentioned)", () => {
  test("only the agent asked to act runs; the referenced one keeps the message as context", async () => {
    f = await setup({ judge: devIsAddressee, reply: () => ({ chunks: ["Ajustei a rotina."] }) });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    const msg = await postPersonMessage(
      { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
      f.owner.id,
      f.org.id,
      f.general.id,
      { body: "@dev quando entrar algum erro pede para o @infra analisar e escrever na issue" },
    );
    await drainOutbox(f.db, f.handlers);

    expect(msg.mentionedAgentIds.sort()).toEqual([f.agent.id, infra.id].sort());
    expect(msg.meta.referencedAgentIds).toEqual([infra.id]);
    const all = await runs();
    expect(all.map((r) => r.agentId)).toEqual([f.agent.id]);
    // The agent that acts knows Infra got no request.
    expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain(
      "@infra is only mentioned in this message as part of what you are asked",
    );

    // Receipts: Infra is referenced, not blocked ("nobody" never shows for it).
    const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, msg.id));
    const receipts = (await receiptsFor(f.db, f.org.id, [stored as NonNullable<typeof stored>])).get(msg.id);
    expect(receipts).toMatchObject({ pickedBy: [f.agent.id], blocked: [], referenced: [infra.id] });
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.routed",
        messageId: msg.id,
        pickedBy: [f.agent.id],
        referenced: [infra.id],
      }),
    );
    // Audited like a routing decision, with each score.
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ messageId: msg.id, strategy: "addressees-fake", selectedAgentIds: [f.agent.id] });
  });

  test("who acts from the scores: above the threshold, else a clear lead (Jev), else everyone", () => {
    const s = (atlas: number, ada: number) =>
      pickAddressees([
        { agentId: "atlas", score: atlas },
        { agentId: "ada", score: ada },
      ]);
    expect(s(0.9, 0.05)).toEqual(["atlas"]);
    expect(s(0.78, 0.75)).toEqual(["atlas", "ada"]);
    // Jev on "@atlas quando entrar erro pede para a @ada analisar": a lead below 0.5.
    expect(s(0.35, 0.07)).toEqual(["atlas"]);
    expect(s(0.3, 0.2)).toEqual(["atlas", "ada"]);
    expect(s(0.05, 0.02)).toEqual(["atlas", "ada"]);
    expect(s(0, 0)).toEqual(["atlas", "ada"]);
  });

  test("fail-open: no judge, an error, a timeout or nobody clearly addressed: every mentioned agent acts", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const infra = await addInfra();
    const input = { orgId: f.org.id, channelId: f.general.id, userId: f.owner.id, body: "@dev e @infra, olhem isso" };
    const failing: Judge = { name: "broken", ask: async () => Promise.reject(new Error("down")) };
    const hanging: Judge = { name: "slow", ask: () => new Promise(() => {}) };
    const both = [f.agent.id, infra.id].sort();

    const failed = await classifyAddressees(f.db, failing, input);
    expect(failed?.addressees.sort()).toEqual(both);
    expect(failed?.referenced).toEqual([]);
    expect(failed?.error).toContain("down");
    const slow = await classifyAddressees(f.db, hanging, input, { timeoutMs: 20 });
    expect(slow?.addressees.sort()).toEqual(both);
    expect(slow?.error).toContain("timed out");
    // The default fake judge scores everyone 0: nobody clearly addressed → as before.
    expect((await classifyAddressees(f.db, f.context.judge as Judge, input))?.referenced).toEqual([]);
    // One mention: nothing to classify (today's behaviour, no judge call).
    expect(await classifyAddressees(f.db, failing, { ...input, body: "@dev olha isso, o @fulano pediu" })).toBeNull();

    await postPersonMessage({ db: f.db, pubsub: f.pubsub, judge: failing }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev e @infra, olhem isso",
    });
    expect((await runs()).map((r) => r.agentId).sort()).toEqual(both);
  });
});

describe("no duplicate requests between agents", () => {
  test("ask_agent to an agent the person already asked in the same message creates no consultation", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        if (isAgent(req, "infra")) return { chunks: ["Atualizei a rotina."] };
        if (lastText(req).includes("tool_result")) return { chunks: ["Combinado."] };
        return {
          chunks: [],
          toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "Update your Sentry routine." } }],
        };
      },
    });
    await addInfra();
    // No judge: both agents act (fail-open), as in the incident.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@infra ajusta a rotina de erros; @dev acompanha",
    });
    await drainOutbox(f.db, f.handlers);

    expect(await consultations()).toEqual([]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "tool_result"));
    const result = String((steps[0]?.data as { content?: string } | undefined)?.content ?? "");
    expect(result).toMatch(/@infra (is already working on|already answered) this person's request/);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.some((m) => m.meta.consulted)).toBe(false);
  });
});

describe("on-behalf-of authority and reading across agents", () => {
  const routineFor = (agentId: string, channelId: string, prompt = "Monitore erros novos do Sentry.") =>
    createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      name: "Monitorar erros novos do Sentry",
      agentId,
      prompt,
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "a cada hora", timezone: "UTC" },
    });

  test("an agent consulted for a person's request can edit its own routine as that person", async () => {
    let routineId = "";
    f = await setup({
      askAgent: true,
      scheduleTools: true,
      reply: (req) => {
        if (inAgentDm(req)) {
          return lastText(req).includes("tool_result")
            ? { chunks: ["Ajustei a rotina."] }
            : {
                chunks: [],
                toolUses: [
                  {
                    name: "update_routine",
                    input: { id: routineId, prompt: "Monitore erros novos e peça à @dev uma análise na issue." },
                  },
                ],
              };
        }
        if (lastText(req).includes("tool_result")) return { chunks: ["Feito pelo Infra."] };
        return {
          chunks: [],
          toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: `Update routine ${routineId}.` } }],
        };
      },
    });
    const infra = await addInfra();
    routineId = (await routineFor(infra.id, f.general.id)).id;
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev pede pro Infra pedir análise à dev quando entrar erro",
    });
    await drainOutbox(f.db, f.handlers);

    const [c] = await consultations();
    expect(c).toMatchObject({ status: "answered", answer: "Ajustei a rotina." });
    const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routineId));
    expect(routine?.prompt).toBe("Monitore erros novos e peça à @dev uma análise na issue.");
    // The consulted run's trigger (the question in the agents' DM) resolves to the person at the root.
    expect(await personBehindRun(f.db, f.org.id, c?.messageId ?? "")).toBe(f.owner.id);
  });

  test("no person at the root, no authority: a forged consultation meta resolves to nobody", async () => {
    f = await setup();
    const forged = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "update the routine",
      meta: { consultation: { id: crypto.randomUUID() } },
    });
    expect(await personBehindRun(f.db, f.org.id, forged.id)).toBeNull();
  });

  test("any agent reads another agent's routines; private conversations hide the instructions", async () => {
    f = await setup();
    const infra = await addInfra();
    await routineFor(infra.id, f.general.id);
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: infra.id });
    await routineFor(infra.id, secret.id, "Resumo confidencial da diretoria.");
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: bob.id },
      body: "@dev o infra monitora o sentry?",
    });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    const tools = await createScheduleToolSource({ pubsub: f.pubsub, context: f.context }).tools(ctx);
    const list = tools.find((t) => t.name === "list_routines");
    const out = await list?.execute({ agent: "@infra" }, ctx);
    expect(out?.isError).toBeFalsy();
    expect(out?.content).toContain("@infra");
    expect(out?.content).toContain("Monitore erros novos do Sentry.");
    expect(out?.content).not.toContain("confidencial");
    expect(out?.content).toContain("instructions private");
    // Its own list is still only its own (none here); editing another agent's routine is refused.
    expect((await list?.execute({}, ctx))?.content).toBe("You have no routines.");
    const [infraRoutine] = await f.db.select().from(schema.routines).where(eq(schema.routines.agentId, infra.id));
    const update = tools.find((t) => t.name === "update_routine");
    const refused = await update?.execute(
      { id: infraRoutine?.id, prompt: "x" },
      { ...ctx, triggerMessageId: asked.id },
    );
    expect(refused?.isError).toBe(true);
  });
});
