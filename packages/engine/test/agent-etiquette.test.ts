import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  createAgent,
  createFakeJudge,
  createJevJudge,
  drainOutbox,
  insertMessage,
  isShortFollowUp,
  isStopRequest,
  type JudgeQuestion,
  mentionNeedsNothing,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** The handle a `mention_needs_nothing` question is about ("@qa"). */
const askedHandle = (q: JudgeQuestion) =>
  String((q.instructions as { agent?: { handle?: string } }).agent?.handle ?? "");
const messageText = (state: Record<string, unknown>) => String((state.message as { text?: string })?.text ?? "");

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

async function addQa() {
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
  return qa;
}

describe("an agent's @mention of another agent", () => {
  test("the judge gets one yes/no per mentioned agent, about that agent, with the message as written", async () => {
    const judge = createFakeJudge((kind, _id, _state, q) =>
      kind === "mention_needs_nothing" && askedHandle(q) === "@jorge" ? 0.1 : 0.9,
    );
    const scores = await mentionNeedsNothing(judge, {
      orgId: "o",
      body: "@jorge pode revisar o PR? O @theo já aprovou.",
      author: "@dev",
      targets: [
        { agentId: "a-jorge", handle: "jorge", name: "Jorge", role: null },
        { agentId: "a-theo", handle: "theo", name: "Theo", role: "QA" },
      ],
    });
    expect(scores).toEqual(
      new Map([
        ["a-jorge", 0.1],
        ["a-theo", 0.9],
      ]),
    );
    const [call] = judge.calls;
    expect(Object.keys(call?.questions ?? {})).toEqual(["nothing_0", "nothing_1"]);
    expect(messageText(call?.state ?? {})).toBe("@jorge pode revisar o PR? O @theo já aprovou.");
  });

  test("a reference doesn't start the other agent; a request does, once, and a thanks back starts nobody", async () => {
    let turn = 0;
    f = await setup({
      // The judge reads "pode revisar?" as needing QA; "como o @qa disse" and QA's thanks need nobody.
      judge: (kind, _id, state) =>
        kind === "mention_needs_nothing" && messageText(state).includes("pode revisar") ? 0.1 : 0.9,
      reply: (req) => {
        const mine = systemText(req.system).includes("You are Dev (@dev)");
        if (!mine) return { chunks: ["Valeu, @dev! Revisado."] };
        turn++;
        return { chunks: [turn === 1 ? "Como o @qa disse, está tudo certo." : "@qa pode revisar o PR?"] };
      },
    });
    await addQa();
    const first = await post("@dev e o deploy?");
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentRuns)).map((r) => r.hop)).toEqual([1]); // QA stayed quiet

    await post("@dev pede revisão do PR", first.id);
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
    // Dev (hop 1) asked QA (hop 2); QA's thanks doesn't start Dev again.
    expect(runs.map((r) => r.hop)).toEqual([1, 1, 2]);
  });

  test("with Jev: one request for every mentioned agent, usage recorded", async () => {
    const seen: string[] = [];
    const usage: unknown[] = [];
    const judge = createJevJudge({
      key: "tk",
      gateway: {
        recordExternalUsage: async (u) => {
          usage.push(u);
          return null;
        },
      },
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push(String(init?.body));
        return Response.json({
          model: "jev-1",
          answers: { nothing_0: { type: "noul", noul: 0.83 } },
          usage: { input_tokens: 50 },
        });
      }) as unknown as typeof fetch,
    });
    const scores = await mentionNeedsNothing(judge, {
      orgId: "o",
      body: "Vou alinhar isso com @jorge depois.",
      author: "@dev",
      targets: [{ agentId: "a1", handle: "jorge", name: "Jorge", role: null }],
    });
    expect(scores.get("a1")).toBeCloseTo(0.83);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("@jorge");
    expect(usage).toMatchObject([{ orgId: "o", provider: "typesafe", inputTokens: 50 }]);
  });

  test("a judgment inside an agent's run records that agent and run on its usage", async () => {
    const usage: unknown[] = [];
    const judge = createJevJudge({
      key: "tk",
      gateway: {
        recordExternalUsage: async (u) => {
          usage.push(u);
          return null;
        },
      },
      fetch: (async () =>
        Response.json({ answers: { stop: { noul: 0.9 } }, usage: { input_tokens: 20 } })) as unknown as typeof fetch,
    });
    expect(await isStopRequest(judge, { orgId: "o", text: "para", agentName: "Dev", agentId: "a1", runId: "r1" })).toBe(
      true,
    );
    expect(usage).toMatchObject([{ orgId: "o", agentId: "a1", runId: "r1", provider: "typesafe" }]);
  });
});

describe("short follow-ups without a mention", () => {
  /** A router that hears "vocês" as for every agent and says so (`forEveryone`), and anything else as for Dev only. */
  const scoreAll: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      const everyone = input.message.body.includes("vocês");
      return {
        agents: input.candidates.map((c) => ({
          agentId: c.agentId,
          score: everyone || c.handle === "dev" ? 0.9 : 0.2,
        })),
        needsAgent: 0.9,
        forEveryone: everyone ? 0.9 : 0.1,
        reason: "t",
      };
    },
  };
  const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };

  test("go only to the agent the person last talked to, unless the router hears several", async () => {
    f = await setup({ reply: () => ({ chunks: ["Deploy feito."] }) });
    const qa = await addQa();
    await post("@dev status do deploy?");
    await drainOutbox(f.db, f.handlers); // Dev answers in the channel
    const followUp = await post("e agora?");
    const one = await routeMessage(
      { db: f.db, strategy: scoreAll, policy },
      { orgId: f.org.id, messageId: followUp.id },
    );
    expect(one.runs.map((r) => r.agentId)).toEqual([f.agent.id]);
    // Dev answers it (while it works, a new message for Dev would join that run instead).
    await drainOutbox(f.db, f.handlers);

    const both = await post("e agora, vocês dois?");
    const several = await routeMessage(
      { db: f.db, strategy: scoreAll, policy },
      { orgId: f.org.id, messageId: both.id },
    );
    expect(several.runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, qa.id].sort());
  });

  test("a short message the router hears as for a person wakes nobody, even right after an agent spoke", async () => {
    f = await setup({ reply: () => ({ chunks: ["Oi!"] }) });
    await post("@dev tá acordado?");
    await drainOutbox(f.db, f.handlers); // Dev answers in the channel
    const quiet: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.1 })), needsAgent: 0.05 };
      },
    };
    const greeting = await post("boa noite walter");
    const routed = await routeMessage(
      { db: f.db, strategy: quiet, policy },
      { orgId: f.org.id, messageId: greeting.id },
    );
    expect(routed.continuityAgentId).toBe(f.agent.id);
    expect(routed.runs).toEqual([]);
  });

  test("go to the agent that spoke right before; a name the router is sure of goes to that agent", async () => {
    f = await setup({ reply: () => ({ chunks: ["Deploy feito."] }) });
    const qa = await addQa();
    await post("@dev status do deploy?");
    await drainOutbox(f.db, f.handlers); // Dev answers in the channel
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: qa.id, runId: null, hop: 1, stretchId: null },
      body: "Os testes de integração falharam no deploy.",
    });
    // "você" is ambiguous to the router (Dev a bit ahead): it's for QA, who just spoke.
    // "dev, tenta de novo" names Dev: the router is sure, so it goes to Dev.
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        const named = input.message.body.startsWith("dev,");
        return {
          agents: input.candidates.map((c) => ({
            agentId: c.agentId,
            score: c.handle === "dev" ? (named ? 0.95 : 0.6) : 0.3,
          })),
          needsAgent: 0.9,
        };
      },
    };
    const route = async (body: string) =>
      (
        await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: (await post(body)).id })
      ).runs.map((r) => r.agentId);
    expect(await route("você confirmou no código?")).toEqual([qa.id]);
    expect(await route("dev, tenta de novo")).toEqual([f.agent.id]);
  });

  test("a short follow-up is judged by length and mentions, not by words", () => {
    expect(isShortFollowUp("e aí?")).toBe(true);
    expect(isShortFollowUp("and now?")).toBe(true);
    expect(isShortFollowUp("@qa e agora?")).toBe(false);
    expect(isShortFollowUp("preciso que alguém revise todo o fluxo de pagamento antes da release de sexta")).toBe(
      false,
    );
  });

  test("a short follow-up reads the same in Portuguese, English, Japanese and German, spaces or not", () => {
    expect(["e agora?", "and now?", "で、今は？", "und jetzt?"].map(isShortFollowUp)).toEqual([true, true, true, true]);
    expect(
      [
        "preciso que alguém revise todo o fluxo de pagamento antes da release",
        "someone needs to review the whole payment flow before the release",
        "決済フローの全体をリリース前に誰かにレビューしてもらう必要があります",
        "jemand muss vor dem Release den ganzen Zahlungsablauf prüfen",
      ].map(isShortFollowUp),
    ).toEqual([false, false, false, false]);
  });
});

test("an agent knows what the other agents here can do and points to them", async () => {
  f = await setup();
  await addQa();
  const trigger = await post("@dev o QA consegue mexer no Drive?");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  const prompt = systemText(ctx.system);
  expect(prompt).toContain("Other agents here and what they can do: QA (@qa, Testes):");
  expect(prompt).toContain("Files (Drive)");
  expect(prompt).toContain("ask it yourself (ask_agent)");
  expect(prompt).toContain("Never name your tools to people.");
  expect(prompt).not.toMatch(/Dev \(@dev, [^)]*\):/); // not itself
});

describe("the judge decides every agent-to-agent mention (the 20:35 loop)", () => {
  test("a question to three agents gets one answer each and at most one hand-off; decisions are recorded", async () => {
    // "fale com o @qa ou o @ops" names them; QA's "@ops você consegue…?" needs Ops; the rest needs nobody.
    f = await setup({
      judge: (kind, _id, state, q) =>
        kind === "mention_needs_nothing" &&
        messageText(state).includes("você consegue ver os logs") &&
        askedHandle(q) === "@ops"
          ? 0.1
          : 0.9,
      reply: (req) => {
        const system = systemText(req.system);
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (system.includes("You are Dev (@dev)")) return { chunks: ["Não sei, fale com o @qa ou o @ops."] };
        if (system.includes("You are QA (@qa)")) return { chunks: ["@ops você consegue ver os logs?"] };
        // Ops: first its own answer to the person, then (if asked by QA) its sign-off to QA and Dev.
        return {
          chunks: [
            last.includes("você consegue ver os logs")
              ? "@dev @qa sim, já vi, está tudo certo."
              : "Eu vejo os logs, @qa.",
          ],
        };
      },
    });
    await addQa();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Infra", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const handlers = f.handlers;

    // A person's @mentions always start the mentioned agents.
    await post("@dev @qa @ops quem consegue ver os logs de produção?");
    await drainOutbox(f.db, handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.hop === 1)).toHaveLength(3); // one answer per addressed agent
    expect(runs.filter((r) => r.hop === 2).map((r) => r.agentId)).toEqual([ops.id]); // QA → Ops, once
    expect(runs.filter((r) => r.hop >= 3)).toEqual([]);

    const decisions = await f.db.select().from(schema.routingDecisions);
    const judged = decisions.filter((d) => d.strategy.startsWith("mention-"));
    expect(judged.length).toBeGreaterThanOrEqual(2);
    // QA spoke to @ops by name (its message opens with it): Ops is the one hand-off.
    expect(judged.find((d) => d.selectedAgentIds.length === 1)?.selectedAgentIds).toEqual([ops.id]);
  });

  test("when the judge is sure the message needs nothing, a mention alone starts nobody", async () => {
    f = await setup({
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.9 : undefined),
      reply: (req) =>
        systemText(req.system).includes("You are Dev (@dev)")
          ? { chunks: ["Vou alinhar isso com @qa depois."] }
          : { chunks: ["ok"] },
    });
    await addQa();
    await post("@dev e os testes?");
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentRuns)).map((r) => r.hop)).toEqual([1]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "mention-fake", selectedAgentIds: [] });
  });
});
