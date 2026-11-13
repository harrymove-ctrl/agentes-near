import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  AGENT_CHIME_IN_SCORE,
  addChannelMember,
  createAgent,
  createAgentRuns,
  createChannel,
  createJevJudge,
  createJevKey,
  createJevRouterStrategy,
  createJobHandlers,
  createLlmJudge,
  DEFAULT_PICKS_PER_HOUR,
  DEFAULT_ROUTER_POLICY,
  drainOutbox,
  insertMessage,
  JevOffError,
  jevCostNanoUsd,
  loadReplyPolicy,
  messageRouter,
  postPersonMessage,
  RouterChainEnd,
  RouterSkip,
  type RouterStrategy,
  type RoutingCandidate,
  type RoutingInput,
  routeChain,
  routeMessage,
  SPOKEN_TO,
  selectAgents,
  standingJudge,
  withJudgeFallback,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const cand = (agentId: string): RoutingCandidate => ({ agentId, handle: agentId, name: agentId, role: "", about: "" });
const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3, continuityMinScore: 0.3, singleAgentMinScore: 0.35 };

describe("policy in code", () => {
  test("continuity lowers the bar for the agent the person was just talking to, even past a low need score", () => {
    const result = {
      agents: [
        { agentId: "a", score: 0.32 },
        { agentId: "b", score: 0.45 },
      ],
      needsAgent: 0.3,
    };
    expect(selectAgents([cand("a"), cand("b")], result, policy)).toEqual([]);
    expect(selectAgents([cand("a"), cand("b")], result, policy, { continuityAgentId: "a" })).toEqual(["a"]);
    expect(
      selectAgents([cand("a"), cand("b")], { ...result, agents: [{ agentId: "a", score: 0.2 }] }, policy, {
        continuityAgentId: "a",
      }),
    ).toEqual([]);
  });

  test("the only agent of a room answers a greeting at a lower bar; with two agents it doesn't", () => {
    expect(selectAgents([cand("a")], { agents: [{ agentId: "a", score: 0.4 }], needsAgent: 0.4 }, policy)).toEqual([
      "a",
    ]);
    expect(
      selectAgents([cand("a"), cand("b")], { agents: [{ agentId: "a", score: 0.4 }], needsAgent: 0.4 }, policy),
    ).toEqual([]);
  });
});

describe("routeChain", () => {
  const input = { orgId: "o", candidates: [cand("a")] } as unknown as RoutingInput;
  const step = (name: string, decide: RouterStrategy["decide"]): RouterStrategy => ({ name, decide });
  const decides = (name: string) => step(name, async () => ({ agents: [{ agentId: "a", score: 0.9 }] }));
  const fails = (name: string, message: string) => step(name, async () => Promise.reject(new Error(message)));
  const skips = (name: string, error: Error) => step(name, async () => Promise.reject(error));

  test("the first step that decides wins, under its own name, with the failures before it; a skip leaves no trace", async () => {
    const timings: unknown[][] = [];
    const chain = routeChain(
      [
        skips("jev", new JevOffError()),
        fails("llm", "no answer in 8 s"),
        skips("x", new RouterSkip()),
        decides("plan"),
      ],
      {
        onTiming: (name, ms, attrs) => {
          if (name === "router_step_ms" && ms >= 0) timings.push([attrs.step, attrs.outcome]);
        },
      },
    );
    expect(await chain.decide(input)).toEqual({
      agents: [{ agentId: "a", score: 0.9 }],
      strategy: "plan",
      failures: ["llm: no answer in 8 s"],
    });
    expect(timings).toEqual([
      ["jev", "skipped"],
      ["llm", "failed"],
      ["x", "skipped"],
      ["plan", "decided"],
    ]);
    // The first step decides: no failures at all.
    expect(await routeChain([decides("jev"), fails("llm", "never asked")]).decide(input)).toEqual({
      agents: [{ agentId: "a", score: 0.9 }],
      strategy: "jev",
    });
  });

  test("no step decides: what failed goes to the rules", async () => {
    const error = await routeChain([fails("jev", "TypeSafe answered 529"), skips("llm", new RouterSkip())])
      .decide(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouterChainEnd);
    expect((error as RouterChainEnd).failures).toEqual(["jev: TypeSafe answered 529"]);
  });
});

/**
 * A fake TypeSafe endpoint: records requests, answers with scripted nouls per handle, `choice`, the tie-break
 * Choice's probabilities by handle (default 0.9 for `best`), and `to`, the addressee Choice's (none: "none").
 */
function fakeJev(
  script: (state: Record<string, unknown>) =>
    | {
        nouls: Record<string, number>;
        needs: number;
        best?: string;
        choice?: Record<string, number>;
        everyone?: number;
        to?: Record<string, number>;
        /** The `social` Choice's pick and confidence. */
        social?: { choice: string; confidence: number };
      }
    | Error,
) {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      state: Record<string, unknown>;
      questions: Record<string, { instructions: { agent?: { handle: string } } }>;
    };
    requests.push({ headers: new Headers(init.headers), body });
    const r = script(body.state);
    if (r instanceof Error) return new Response("boom", { status: 529 });
    const answers: Record<string, unknown> = { needs_agent: { type: "noul", noul: r.needs } };
    for (const [key, q] of Object.entries(body.questions)) {
      if (key.startsWith("agent_"))
        answers[key] = { type: "noul", noul: r.nouls[q.instructions.agent?.handle ?? ""] ?? 0 };
    }
    if (body.questions.for_everyone) answers.for_everyone = { type: "noul", noul: r.everyone ?? 0 };
    if (body.questions.best_agent) {
      answers.best_agent = {
        type: "choice",
        choice: r.best ?? "none",
        probabilities: r.choice ?? { [r.best ?? "none"]: 0.9 },
        confidence: r.choice?.[r.best ?? "none"] ?? 0.8,
      };
    }
    if (body.questions.addressee) {
      const to = r.to ?? { none: 1 };
      const [choice] = Object.entries(to).sort((a, b) => b[1] - a[1])[0] ?? ["none"];
      answers.addressee = { type: "choice", choice, probabilities: to, confidence: 0.8 };
    }
    if (body.questions.social && r.social)
      answers.social = { type: "choice", ...r.social, probabilities: { [r.social.choice]: r.social.confidence } };
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 1200, output_tokens: 30 } });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });

describe("Jev's questions", () => {
  const socialOf = async (social: { choice: string; confidence: number } | undefined, needs = 0.05) => {
    const jev = fakeJev(() => ({ nouls: {}, needs, ...(social ? { social } : {}) }));
    const decided = await createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher }).decide(
      {
        orgId: "o",
        channel: { id: "c", name: "geral", topic: "" },
        message: { id: "m", author: "ana", body: "boa noite pessoal" },
        thread: [],
        candidates: [cand("dev"), cand("qa")],
        authorUserId: "u",
      },
    );
    return { decided, jev };
  };

  test("a clear pick from the set reacts; an unsure one, none or a choice outside the set doesn't", async () => {
    expect((await socialOf({ choice: "🌙", confidence: 0.9 })).decided.social).toEqual({ react: true, emoji: "🌙" });
    expect((await socialOf({ choice: "🌙", confidence: 0.3 })).decided.social).toEqual({ react: false, emoji: "🌙" });
    expect((await socialOf({ choice: "none", confidence: 0.9 })).decided.social).toEqual({ react: false, emoji: "" });
    expect((await socialOf({ choice: "🖕", confidence: 0.9 })).decided.social).toEqual({ react: false, emoji: "" });
    expect((await socialOf(undefined)).decided.social).toBeUndefined();
  });

  test("insisting that nobody answered is a yes to 'should any agent reply?'", async () => {
    const { jev } = await socialOf(undefined);
    const questions = jev.requests[0]?.body.questions as { needs_agent: { instructions: string } };
    expect(questions.needs_agent.instructions).toContain(
      'Also yes when the person insists or complains that nobody answered ("alô???", "ninguém vai responder?", a greeting again after nobody answered the first)',
    );
  });

  test("name a message to the room in both languages, for every agent and for each one", async () => {
    const jev = fakeJev(() => ({ nouls: {}, needs: 0.9 }));
    await createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher }).decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "e agora, vocês dois?" },
      thread: [],
      candidates: [cand("dev"), cand("qa")],
    });
    const questions = jev.requests[0]?.body.questions as {
      for_everyone: { instructions: string };
      agent_0: { instructions: { question: string } };
    };
    for (const phrase of ["everyone", "all of you", "gente", "vocês", "agentes"]) {
      expect(questions.for_everyone.instructions).toContain(`"${phrase}"`);
      expect(questions.agent_0.instructions.question).toContain(`"${phrase}"`);
    }
  });

  test("read who each message names and a person's messages in a row as one, and say who those are for", async () => {
    const jev = fakeJev(() => ({ nouls: {}, needs: 0.1 }));
    await createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher }).decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "boa tarde walter\ncomo esta hoje", names: ["Walter"] },
      thread: [{ author: "@ada", body: "Campanha publicada." }],
      candidates: [cand("ada")],
      aloneWith: "ada",
    });
    const body = jev.requests[0]?.body as {
      state: Record<string, unknown>;
      questions: { needs_agent: { instructions: string }; agent_0: { instructions: { question: string } } };
    };
    expect(body.state).toMatchObject({
      latest_message: { from: "ana", names: ["Walter"], text: "boa tarde walter\ncomo esta hoje" },
      recent_messages: [{ from: "@ada", names: [], text: "Campanha publicada." }],
      alone_with: "@ada",
    });
    for (const text of [body.questions.needs_agent.instructions, body.questions.agent_0.instructions.question]) {
      expect(text).toContain("Messages a person sends in a row continue the same address");
      expect(text).toContain("A message to a person, by @ or by name, is for that person, not for an agent.");
      expect(text).toContain("Greetings and small talk between people get no agent.");
    }
  });
});

describe("who a message speaks to", () => {
  const ada = { ...cand("ada"), name: "Ada", role: "Engenharia" };
  const theo = { ...cand("theo"), name: "Theo" };
  const decide = (answer: Parameters<typeof fakeJev>[0], body: string, more: Partial<RoutingInput> = {}) => {
    const jev = fakeJev(answer);
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    const decided = strategy.decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body },
      thread: [],
      candidates: [ada, theo],
      ...more,
    });
    return { jev, decided };
  };
  const scores = (r: { agents: { agentId: string; score: number }[] }) =>
    Object.fromEntries(r.agents.map((a) => [a.agentId, Math.round(a.score * 100) / 100]));

  test("Jev is asked which agent it speaks to, and an agent it only names as someone to ask is a no", async () => {
    const { jev, decided } = decide(() => ({ nouls: {}, needs: 0.8 }), "ada pergunta pro theo ai qual meu email");
    await decided;
    const questions = jev.requests[0]?.body.questions as {
      needs_agent: { instructions: string };
      agent_1: { instructions: { question: string } };
      best_agent: { instructions: string };
      addressee: { type: string; instructions: string; criteria: Record<string, string> };
    };
    expect(questions.addressee.type).toBe("choice");
    expect(questions.addressee.criteria).toEqual({
      ada: "Ada (@ada), Engenharia",
      theo: "Theo (@theo)",
      none: "No agent in particular.",
    });
    for (const text of [
      questions.needs_agent.instructions,
      questions.agent_1.instructions.question,
      questions.best_agent.instructions,
      questions.addressee.instructions,
    ])
      expect(text).toContain(SPOKEN_TO);
    expect(questions.agent_1.instructions.question).toContain(
      "No when it speaks to another agent, even when it names this one as someone to ask, involve or hand over to",
    );
    // Right after Theo spoke, "pergunta pra Ada se o PR subiu" speaks to Theo.
    expect(SPOKEN_TO).toContain(
      "A follow-up that names another agent only as someone to ask, involve or hand over to still speaks to the agent the person was just talking to",
    );
    expect(questions.addressee.instructions).toContain(
      "The agent the person was just talking to is `agent_just_talking`.",
    );
  });

  test("'ada pergunta pro theo ai qual meu email mais recente pls' is Ada's, not Theo's who has the email", async () => {
    // Jev's answers on 2026-10-31: Theo 0.90, Ada 0.52, needs 0.78, best @theo, and an addressee Choice that
    // hears Ada (assumed: the real Jev hasn't answered it yet).
    const { decided } = decide(
      () => ({
        nouls: { "@theo": 0.9, "@ada": 0.52 },
        needs: 0.78,
        best: "theo",
        to: { ada: 0.86, theo: 0.08, none: 0.06 },
      }),
      "ada pergunta pro theo ai qual meu email mais recente pls",
    );
    const result = await decided;
    expect(result.addressee).toBe("ada");
    // Ada as far as an agent is needed (0.78 × 0.86); Theo only as far as it might speak to him or to nobody.
    expect(scores(result)).toEqual({ ada: 0.67, theo: 0.14 });
    expect(selectAgents([ada, theo], result, policy)).toEqual(["ada"]);
    expect(result.reason).toBe("to @ada (0.86); best @theo (confidence 0.80)");
  });

  test("what worked still does: to Theo by name, to anyone, to everyone, to a person", async () => {
    const to = async (answer: Parameters<typeof fakeJev>[0]) => {
      const result = await decide(answer, "x").decided;
      return { picked: selectAgents([ada, theo], result, policy), addressee: result.addressee };
    };
    // "theo, qual meu email mais recente?"
    expect(
      await to(() => ({
        nouls: { "@theo": 0.92, "@ada": 0.1 },
        needs: 0.9,
        best: "theo",
        to: { theo: 0.9, none: 0.1 },
      })),
    ).toEqual({ picked: ["theo"], addressee: "theo" });
    // "alguém sabe qual meu email mais recente?": whoever can.
    expect(
      await to(() => ({
        nouls: { "@theo": 0.85, "@ada": 0.2 },
        needs: 0.85,
        best: "theo",
        to: { none: 0.9, theo: 0.06, ada: 0.04 },
      })),
    ).toEqual({ picked: ["theo"], addressee: undefined });
    // "agentes, cada um diz seu nome": every agent, whoever the Choice leaned to.
    expect(
      await to(() => ({
        nouls: { "@theo": 0.9, "@ada": 0.9 },
        needs: 0.9,
        everyone: 0.9,
        to: { ada: 0.7, theo: 0.2, none: 0.1 },
      })),
    ).toEqual({ picked: ["ada", "theo"], addressee: undefined });
    // "walter, a ada já terminou o relatório?": a person's.
    expect(
      await to(() => ({ nouls: { "@ada": 0.2, "@theo": 0.05 }, needs: 0.1, to: { none: 0.8, ada: 0.2 } })),
    ).toEqual({ picked: [], addressee: undefined });
  });

  test("unsure which agent it speaks to (under 0.6), the scores stand", async () => {
    // That day's answers with a Choice that only leans to Ada: Theo, as before. Capped and not lifted, nobody was.
    const day = { nouls: { "@theo": 0.9, "@ada": 0.52 }, needs: 0.78, best: "theo" };
    const before = await decide(() => day, "x").decided;
    const leaning = await decide(() => ({ ...day, to: { ada: 0.55, theo: 0.35, none: 0.1 } }), "x").decided;
    expect(leaning.addressee).toBeUndefined();
    expect(leaning.agents).toEqual(before.agents);
    expect(selectAgents([ada, theo], leaning, policy)).toEqual(["theo"]);
    // "alguém sabe qual meu email mais recente?" leaning a little to Ada, who can't help: still Theo, who can.
    const anyone = await decide(
      () => ({ nouls: { "@theo": 0.85, "@ada": 0.2 }, needs: 0.85, best: "theo", to: { ada: 0.53, none: 0.47 } }),
      "x",
    ).decided;
    expect(selectAgents([ada, theo], anyone, policy)).toEqual(["theo"]);
  });

  test("an agent's message isn't asked who it speaks to: another agent chimes in only past its own bar", async () => {
    // "@ada: Theo, confere a agenda?" with Theo at 0.6: the floor from who it speaks to would lift him past 0.75.
    const { jev, decided } = decide(
      () => ({ nouls: { "@theo": 0.6, "@ada": 0.1 }, needs: 0.85, to: { theo: 0.92, none: 0.08 } }),
      "Theo, confere a agenda?",
      { message: { id: "m", author: "@dev", body: "Theo, confere a agenda?" }, authorUserId: null },
    );
    const result = await decided;
    expect(jev.requests[0]?.body.questions).not.toHaveProperty("addressee");
    expect(result.addressee).toBeUndefined();
    expect(scores(result).theo).toBeLessThan(AGENT_CHIME_IN_SCORE);
  });

  /** #general with Ada and Theo besides Dev, and Jev answering as on 2026-10-31 with the addressee Choice. */
  async function team(reply?: NonNullable<Parameters<typeof setup>[0]>["reply"]) {
    f = await setup({ askAgent: true, reply });
    const make = async (name: string, handle: string, role: string) => {
      const a = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle, role, credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    const agents = { ada: await make("Ada", "ada", "Engenharia"), theo: await make("Theo", "theo", "Assistente") };
    const jev = fakeJev((state) =>
      String((state.latest_message as { from: string }).from).startsWith("@")
        ? { nouls: {} as Record<string, number>, needs: 0 }
        : {
            nouls: { "@theo": 0.9, "@ada": 0.52 },
            needs: 0.78,
            best: "theo",
            to: { ada: 0.86, theo: 0.08, none: 0.06 },
          },
    );
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    return { ...agents, jev, strategy };
  }
  const decisionOf = async (messageId: string) =>
    (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];

  test("the agent spoken to answers, may not pass, and asks the other one itself", async () => {
    const asked = /your question to @theo\]: ([^"\\]+)/;
    const t = await team((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (systemText(req.system).includes("A private conversation between agents"))
        return { chunks: ["O mais recente: Lumen, Proposta revisada."] };
      const heard = asked.exec(last);
      if (heard) return { chunks: [`O Theo disse: ${heard[1]}`] };
      if (last.includes("tool_result")) return { chunks: ["Perguntei ao Theo, já te conto."] };
      return {
        chunks: [],
        toolUses: [{ name: "ask_agent", input: { agent: "@theo", question: "Qual o email mais recente da Ana?" } }],
      };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: t.jev.fetcher } },
    });
    const m = await post(f, "ada pergunta pro theo ai qual meu email mais recente pls");
    await drainOutbox(f.db, handlers);

    const decision = await decisionOf(m.id);
    expect(decision?.selectedAgentIds).toEqual([t.ada.id]);
    // Addressed: the follow-up marker, so the reply policy gives Ada no `pass`.
    expect(decision?.reason).toStartWith("follow-up; jev: to @ada (0.86)");
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
    expect(runs.map((r) => r.agentId)).toEqual([t.ada.id]);
    expect((await loadReplyPolicy(f.db, f.org.id, runs[0]?.id ?? ""))?.mayPass).toBe(false);
    // Theo got no run of his own for Ana's message, so Ada's question to him goes through.
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    expect(consultation).toMatchObject({
      askerAgentId: t.ada.id,
      targetAgentId: t.theo.id,
      status: "answered",
      answer: "O mais recente: Lumen, Proposta revisada.",
    });
  });

  test("right after Theo spoke, a short message or a reply to him that speaks to Ada still goes to Ada", async () => {
    const t = await team();
    const say = (body: string, secondsAgo: number, meta?: Record<string, unknown>) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body,
        meta,
        createdAt: new Date(Date.now() - secondsAgo * 1000),
      });
    await say("theo, bom dia", 120);
    const hello = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: t.theo.id, runId: null, hop: 1, stretchId: null },
      body: "Bom dia, Ana! Em que posso ajudar?",
      createdAt: new Date(Date.now() - 60_000),
    });
    const route = async (messageId: string) =>
      routeMessage(
        { db: f.db, strategy: t.strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
        { orgId: f.org.id, messageId },
      );
    // Short enough to be a follow-up of the talk with Theo.
    const short = await say("ada, pergunta pro theo meu email", 30);
    expect(await route(short.id)).toMatchObject({ selected: [t.ada.id], continuityAgentId: t.ada.id });
    // A quote reply to Theo's message.
    const reply = await say("ada, confere com o theo meu email mais recente", 0, {
      replyTo: {
        messageId: hello.id,
        author: { type: "agent", id: t.theo.id },
        authorName: "Theo",
        excerpt: "Bom dia",
      },
    });
    expect((await route(reply.id)).selected).toEqual([t.ada.id]);
    expect((await decisionOf(reply.id))?.reason).toStartWith("follow-up");
  });

  test("a reply to Theo that only hands over to Ada stays Theo's: Ada takes a reply only past her own bar", async () => {
    const t = await team();
    // The Choice hears Ada in "isso do deploy é com a ada", but no agent should answer it as for itself.
    const jev = fakeJev(() => ({ nouls: { "@ada": 0.1, "@theo": 0.2 }, needs: 0.15, to: { ada: 0.65, none: 0.35 } }));
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: t.theo.id, runId: null, hop: 1, stretchId: null },
      body: "Resumo de hoje: 3 emails novos do cliente, e o deploy de ontem falhou no CI.",
      createdAt: new Date(Date.now() - 60_000),
    });
    const handOver = async (where: { threadId?: string; meta?: Record<string, unknown> }) => {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "isso do deploy é com a ada",
        ...where,
      });
      const policy = { ...DEFAULT_ROUTER_POLICY, maxHops: 3 };
      return (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id })).selected;
    };
    const quoted = { messageId: report.id, author: { type: "agent", id: t.theo.id }, authorName: "Theo", excerpt: "" };
    expect(await handOver({ meta: { replyTo: quoted } })).toEqual([t.theo.id]);
    expect(await handOver({ threadId: report.id })).toEqual([t.theo.id]);
  });
});

describe("the agent a person last talked to", () => {
  /**
   * `by`: an agent (in `runId`, when given), else Ana; `routedTo`: the agents the router sent it to, `working` when
   * their runs on it are still at work; `thread`: in the thread of that line of the talk.
   */
  type Said = [
    by: { id: string; runId?: string } | null,
    text: string,
    minutesAgo: number,
    routedTo?: { id: string }[],
    more?: { working?: boolean; thread?: number; strategy?: string },
  ];

  /** Ana alone with Theo (PM) and Ada (Dev), as in #private on 2026-10-31. */
  async function privateRoom() {
    f = await setup();
    const make = (name: string, role: string) =>
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle: name.toLowerCase(), role, credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
    const theo = await make("Theo", "PM");
    const ada = await make("Ada", "Dev");
    let n = 0;
    /**
     * In a channel of their own: `before` (Ana's, or an agent's), then `body` by Ana (or `by`), routed on Jev's
     * `answer` after the router's quiet wait (`quietMs`, none by default).
     */
    async function talk(
      before: Said[],
      body: string,
      answer: Parameters<typeof fakeJev>[0],
      by: Said[0] = null,
      quietMs = 0,
    ) {
      n += 1;
      const now = Date.now();
      const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: `private-${n}` });
      for (const a of [theo, ada]) await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: a.id });
      const said: string[] = [];
      const say = async ([author, text, minutesAgo, routedTo, more]: Said) => {
        const m = await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: channel.id,
          threadId: more?.thread === undefined ? null : said[more.thread],
          author: author
            ? { type: "agent", agentId: author.id, runId: author.runId ?? null, hop: 1, stretchId: null }
            : { type: "person", userId: f.owner.id },
          body: text,
          createdAt: new Date(now - minutesAgo * 60_000),
        });
        if (routedTo) {
          const selectedAgentIds = routedTo.map((a) => a.id);
          await f.db.insert(schema.routingDecisions).values({
            orgId: f.org.id,
            channelId: channel.id,
            messageId: m.id,
            strategy: more?.strategy ?? "jev",
            candidates: [],
            selectedAgentIds,
          });
          if (more?.working) await f.db.transaction((tx) => createAgentRuns(tx, m, selectedAgentIds, "router"));
        }
        said.push(m.id);
        return m;
      };
      for (const line of before) await say(line);
      const m = await say([by, body, 0]);
      const strategy = createJevRouterStrategy({
        key: "k",
        recordUsage: async () => {},
        fetch: fakeJev(answer).fetcher,
      });
      const policy = { ...DEFAULT_ROUTER_POLICY, maxHops: 3 };
      const { selected } = await routeMessage(
        { db: f.db, strategy, policy, quietMs },
        { orgId: f.org.id, messageId: m.id },
      );
      const [decision] = await f.db
        .select()
        .from(schema.routingDecisions)
        .where(eq(schema.routingDecisions.messageId, m.id));
      return { selected, decision };
    }
    return { theo, ada, talk };
  }

  /** Jev on "me de bom dia todo dia ás 8:30 da manha" (2026-10-31): the same Noul for both, the Choice for `best`. */
  const bomDia = (best: string, other: string) => () => ({
    nouls: { "@theo": 0.576, "@ada": 0.576 },
    needs: 0.54,
    best,
    choice: { [best]: 0.83, [other]: 0.12, none: 0.05 },
  });
  const BOM_DIA = "me de bom dia todo dia ás 8:30 da manha";

  test("'me de bom dia todo dia ás 8:30 da manha' 23 minutes after a talk with Ada is hers, though Theo scored a little more", async () => {
    const t = await privateRoom();
    const talkWithAda = (minutesAgo: number): Said[] => [
      [null, "ada quanto ta seu limite de uso?", minutesAgo + 0.4, [t.ada]],
      [t.ada, "Heitor, não consigo consultar meu saldo de uso por aqui.", minutesAgo],
    ];
    const { selected, decision } = await t.talk(talkWithAda(22.8), BOM_DIA, bomDia("theo", "ada"));
    // The scores stored that day: Theo 0.626, Ada 0.555.
    const scores = Object.fromEntries(decision?.candidates.map((c) => [c.agentId, Math.round(c.score * 1000)]) ?? []);
    expect(scores).toEqual({ [t.theo.id]: 626, [t.ada.id]: 555 });
    expect(selected).toEqual([t.ada.id]);
    // Kept with the agent she talks to, by code: Ada may not pass, and the reason says why.
    expect(decision?.reason).toBe("follow-up; last talked to; jev: best @theo (confidence 0.83)");
    // A thank-you the router sent to nobody since doesn't end the talk.
    const thanked = await t.talk([...talkWithAda(22.8), [null, "valeu", 20, []]], BOM_DIA, bomDia("theo", "ada"));
    expect(thanked.selected).toEqual([t.ada.id]);
    // Past what the router reads (30 minutes), the scores decide, as they did that day.
    expect((await t.talk(talkWithAda(30.5), BOM_DIA, bomDia("theo", "ada"))).selected).toEqual([t.theo.id]);
    // Sooner, while she is still the agent just talking (5 minutes), the same, though it is no short follow-up.
    expect((await t.talk(talkWithAda(5), BOM_DIA, bomDia("theo", "ada"))).selected).toEqual([t.ada.id]);
    // Right after Theo spoke on his own, he is the one just talking: the scores decide, as before.
    const afterTheo = await t.talk(
      [...talkWithAda(5), [t.theo, "Lembrete: a daily começa em 10 minutos.", 1]],
      BOM_DIA,
      bomDia("theo", "ada"),
    );
    expect(afterTheo.selected).toEqual([t.theo.id]);
  });

  test("a message that clearly fits the other agent still goes to it", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23],
      [t.ada, "Não consigo ver meu saldo por aqui.", 22],
    ];
    // Ada could do it too, but Theo is a clear pick, 0.3 over her (0.96 to 0.52).
    const roadmap = await t.talk(talkWithAda, "resume a discussão de ontem no #produto e atualiza o roadmap", () => ({
      nouls: { "@theo": 0.9, "@ada": 0.55 },
      needs: 0.85,
      best: "theo",
    }));
    expect(roadmap.selected).toEqual([t.theo.id]);
    expect(roadmap.decision?.reason).not.toContain("follow-up");
    // Ada could do it nearly as well (0.72 to 0.96, under 0.3 apart), but the tie-break is sure it fits Theo, the PM.
    const sprint = await t.talk(talkWithAda, "cria uma task pro sprint de amanhã com os itens do roadmap", () => ({
      nouls: { "@theo": 0.9, "@ada": 0.75 },
      needs: 0.9,
      best: "theo",
      choice: { theo: 0.95, ada: 0.03, none: 0.02 },
    }));
    expect(sprint.selected).toEqual([t.theo.id]);
    expect(sprint.decision?.reason).toBe("jev: best @theo (confidence 0.95)");
    // Ada can't do it: under her bar.
    const tasks = await t.talk(talkWithAda, "e o roadmap, como está?", () => ({
      nouls: { "@theo": 0.7, "@ada": 0.2 },
      needs: 0.8,
      best: "theo",
    }));
    expect(tasks.selected).toEqual([t.theo.id]);
  });

  test("a message the team's coordinator took (before ADR 0137) isn't a talk with it", async () => {
    const t = await privateRoom();
    // Theo took Ana's question as the coordinator and handed it to Ada, who did the work.
    const handedOver = await t.talk(
      [
        [null, "alguém consegue ver se o PR do checkout subiu?", 15, [t.theo], { strategy: "rule:coordinator" }],
        [t.theo, "@ada pode olhar o PR do checkout?", 14.6],
        [t.ada, "Subiu sim, está verde.", 14],
      ],
      "e os testes de integração passaram?",
      () => ({ nouls: { "@theo": 0.55, "@ada": 0.72 }, needs: 0.8, best: "ada" }),
    );
    expect(handedOver.selected).toEqual([t.ada.id]);
    expect(handedOver.decision?.reason).toBe("jev: best @ada (confidence 0.80)");
    // A greeting the coordinator answered doesn't keep the next request with it.
    const greeted = await t.talk(
      [
        [null, "bom dia", 12.4, [t.theo], { strategy: "rule:coordinator" }],
        [t.theo, "Bom dia, Ana!", 12],
      ],
      "o checkout está dando 500",
      () => ({ nouls: { "@theo": 0.5, "@ada": 0.75 }, needs: 0.9, best: "ada" }),
    );
    expect(greeted.selected).toEqual([t.ada.id]);
  });

  test("a message nobody picked goes to the agent last talked to", async () => {
    const t = await privateRoom();
    // Nobody picked, 23 minutes after a talk with Ada: she gets it (R5), addressed.
    const nobody = await t.talk(
      [
        [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 23],
      ],
      BOM_DIA,
      () => ({
        nouls: { "@theo": 0.3, "@ada": 0.45 },
        needs: 0.7,
        best: "theo",
        choice: { theo: 0.83, ada: 0.12, none: 0.05 },
      }),
    );
    expect(nobody.selected).toEqual([t.ada.id]);
    expect(nobody.decision?.strategy).toBe("rule:default");
    expect(nobody.decision?.reason).toBe("follow-up; default; talking to; jev: best @theo (confidence 0.83)");
  });

  test("with no pick between agents to settle, nothing changes", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
      [t.ada, "Não consigo ver meu saldo por aqui.", 23],
    ];
    // The router picks Ada on its own: she may still pass.
    const build = await t.talk(talkWithAda, "alguém sabe se o build de ontem passou?", () => ({
      nouls: { "@theo": 0.2, "@ada": 0.6 },
      needs: 0.6,
      best: "ada",
    }));
    expect(build.selected).toEqual([t.ada.id]);
    expect(build.decision?.reason).toBe("jev: best @ada (confidence 0.80)");
    // No agent needed, and Theo picked only as a clear pick (0.84): Ada (0.62) wouldn't pass the need check alone.
    const remark = await t.talk(talkWithAda, "o roadmap ficou bom", () => ({
      nouls: { "@theo": 0.82, "@ada": 0.62 },
      needs: 0.3,
      best: "theo",
      choice: { theo: 0.5, ada: 0.3, none: 0.2 },
    }));
    expect(remark.selected).toEqual([t.theo.id]);
    expect(remark.decision?.reason).toBe("jev: best @theo (confidence 0.50)");
  });

  test("after another agent was addressed, the message doesn't go back to the one before", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 28],
      [t.ada, "Não consigo ver meu saldo por aqui.", 27],
    ];
    // This time Jev leans to Ada, as it leaned to Theo that day.
    const leansToAda = bomDia("ada", "theo");
    // Theo @mentioned, still working on it.
    const mentioned = await t.talk(
      [...talkWithAda, [null, "@theo cria uma task pra revisar o PR do checkout", 15]],
      BOM_DIA,
      leansToAda,
    );
    expect(mentioned.selected).toEqual([t.theo.id]);
    // Theo asked by name, and he answered.
    const answered = await t.talk(
      [...talkWithAda, [null, "theo, cria uma task pra revisar o PR do checkout", 15], [t.theo, "Criei a task.", 14]],
      BOM_DIA,
      leansToAda,
    );
    expect(answered.selected).toEqual([t.theo.id]);
    // Theo asked by name a minute ago, and the router sent it to him: still at work, he hasn't answered yet.
    const working = await t.talk(
      [...talkWithAda, [null, "theo, cria uma task pra revisar o PR do checkout", 1, [t.theo], { working: true }]],
      BOM_DIA,
      leansToAda,
    );
    expect(working.selected).toEqual([t.theo.id]);
  });

  test("a message that names another agent isn't kept for the one before, even when the step isn't sure it speaks to it", async () => {
    const t = await privateRoom();
    // Jev only 0.55 sure it speaks to Theo (under 0.6), and Theo at 0.80, just under a clear pick.
    const { selected } = await t.talk(
      [
        [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 23],
      ],
      `theo ${BOM_DIA}`,
      () => ({
        nouls: { "@theo": 0.75, "@ada": 0.576 },
        needs: 0.7,
        best: "theo",
        choice: { theo: 0.83, ada: 0.12, none: 0.05 },
        to: { theo: 0.55, none: 0.45 },
      }),
    );
    expect(selected).toEqual([t.theo.id]);
  });

  test("an agent the router sent a message to that stayed quiet wasn't talked to", async () => {
    const t = await privateRoom();
    // The room asked since; the router sent it to Theo, who passed. This time Jev leans to Ada.
    const { selected } = await t.talk(
      [
        [null, "ada quanto ta seu limite de uso?", 23.2, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 22.8],
        [null, "alguém viu o jogo ontem?", 15, [t.theo]],
      ],
      BOM_DIA,
      bomDia("ada", "theo"),
    );
    expect(selected).toEqual([t.ada.id]);
  });

  test("a message of theirs the router hasn't decided on yet leaves whom they talk to unknown", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
      [t.ada, "Não consigo ver meu saldo por aqui.", 23],
    ];
    // Four seconds ago, past the quiet wait, and still being routed: the step decides, as it did that day.
    const pending = await t.talk(
      [...talkWithAda, [null, "cria uma task pra revisar o PR do checkout", 4 / 60]],
      BOM_DIA,
      bomDia("theo", "ada"),
    );
    expect(pending.selected).toEqual([t.theo.id]);
    expect(pending.decision?.reason).toBe("jev: best @theo (confidence 0.83)");
    // A thank-you in two messages, decided as one (on the second) and sent to nobody, doesn't end the talk.
    const thanked = await t.talk(
      [...talkWithAda, [null, "valeu", 20], [null, "ajudou muito", 20 - 1 / 600, []]],
      BOM_DIA,
      bomDia("theo", "ada"),
      null,
      500,
    );
    expect(thanked.selected).toEqual([t.ada.id]);
  });

  test("a talk in another thread is that thread's, not the channel's", async () => {
    const t = await privateRoom();
    // Ana talked to Ada in the channel, then to Theo in the thread of an older message. Jev leans to Ada.
    const { selected } = await t.talk(
      [
        [null, "pessoal, revisão do contrato", 40],
        [null, "ada quanto ta seu limite de uso?", 23.2, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 22.8],
        [null, "theo, pode revisar isso?", 15, [t.theo], { thread: 0 }],
        [t.theo, "Revisei.", 14, undefined, { thread: 0 }],
      ],
      BOM_DIA,
      bomDia("ada", "theo"),
    );
    expect(selected).toEqual([t.ada.id]);
  });

  test("an agent's message is unchanged: only a clear pick, the best one, and it may pass", async () => {
    const t = await privateRoom();
    // Ana last talked to Ada (who hasn't answered, so she can still be brought in), and the agent writes for her.
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "pede pra alguém criar minha rotina de bom dia às 8:30",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    const { selected, decision } = await t.talk(
      [[null, "@ada quanto ta seu limite de uso?", 23]],
      "alguém cria a rotina de bom dia do Heitor às 8:30?",
      () => ({ nouls: { "@theo": 0.9, "@ada": 0.85 }, needs: 0.9, best: "theo" }),
      { id: f.agent.id, runId: run?.id },
    );
    expect(selected).toEqual([t.theo.id]);
    expect(decision?.reason).toBe("jev: best @theo (confidence 0.80)");
  });
});

describe("Jev strategy end to end", () => {
  test("one request with a Noul per agent, a need Noul, a tie-break Choice and an addressee Choice; usage billed to the platform", async () => {
    f = await setup({ reply: () => ({ chunks: ["Deploy is green."] }) });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", role: "Testing" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.81, "@qa": 0.2 }, needs: 0.9, best: "dev" }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "ts_secret", fetch: jev.fetcher } },
    });
    const m = await post(f, "is the deploy green?");
    await drainOutbox(f.db, handlers);

    const req = jev.requests[0];
    expect(req?.headers.get("authorization")).toBe("Bearer ts_secret");
    expect(req?.body).toMatchObject({ model: "jev-latest" });
    expect(Object.keys((req?.body.questions as object) ?? {}).sort()).toEqual([
      "addressee",
      "agent_0",
      "agent_1",
      "best_agent",
      "for_everyone",
      "needs_agent",
      "social",
    ]);
    expect(JSON.stringify(req?.body.state)).toContain("is the deploy green?");
    expect(f.provider.calls).toHaveLength(1); // only the agent's reply: no LLM router call

    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({
      strategy: "jev",
      messageId: m.id,
      selectedAgentIds: [f.agent.id],
      needsAgentScore: 0.9,
    });
    const usage = (await f.db.select().from(schema.usageRecords)).find((u) => u.provider === "typesafe");
    expect(usage).toMatchObject({
      kind: "router",
      agentId: null,
      billedTo: "platform",
      inputTokens: 1200,
      costNanoUsd: jevCostNanoUsd(1200),
    });
    expect(jevCostNanoUsd(1_000_000)).toBe(42_000_000); // $0.042 per million input tokens
  });

  test("on a Jev error the LLM strategy decides, and the decision says so", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"r"}'] }
          : { chunks: ["ok"] },
    });
    const jev = fakeJev(() => new Error("down"));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    await post(f, "help with the build?");
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({
      strategy: "llm:claude-haiku-5-5",
      error: "jev: TypeSafe answered 529",
      selectedAgentIds: [f.agent.id],
    });
  });

  test("conversation continuity: a follow-up without a mention goes to the agent just spoken to", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi!"] }) });
    const jev = fakeJev((state) => ({
      nouls: { "@dev": state.agent_just_talking === "@dev" ? 0.35 : 0.2 },
      needs: 0.3,
    }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    await post(f, "oi @dev");
    await drainOutbox(f.db, handlers);
    const followUp = await post(f, "e aí, tudo certo com o deploy?");
    await drainOutbox(f.db, handlers);
    expect(JSON.stringify(jev.requests.at(-1)?.body.state)).toContain('"agent_just_talking":"@dev"');
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.trigger, r.triggerMessageId === followUp.id])).toContainEqual(["router", true]);
  });

  test("no pick: no agent.thinking, and message.routed with pickedBy []", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.2 }, needs: 0.1 }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    const events = f.listen(f.general.id);
    const m = await post(f, "pessoal, almoço?");
    await drainOutbox(f.db, handlers);
    expect(events.some((e) => e.type === "agent.thinking")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.routed", messageId: m.id, seenBy: [f.agent.id], pickedBy: [] }),
    );
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
  });

  test("with no Jev key the LLM strategy decides at once, under its own name, and nothing calls TypeSafe", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"r"}'] }
          : { chunks: ["ok"] },
    });
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.9 }, needs: 0.9 }));
    const key = createJevKey({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper] });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key, fetch: jev.fetcher } },
    });
    await post(f, "help with the build?");
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "llm:claude-haiku-5-5", error: null, selectedAgentIds: [f.agent.id] });
    expect(jev.requests).toEqual([]);
  });

  test("named for who decides now: the cheap model with no key, Jev once one is saved", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: {}, needs: 0 }));
    const key = createJevKey({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper], fetch: jev.fetcher });
    await key.ready();
    const routing = messageRouter({ ...f.jobDeps, router: { enabled: true, model: "m", jev: { key } } });
    const llm = createLlmJudge({ gateway: f.gateway, resolveModel: async () => "m" });
    const judge = standingJudge(
      f.db,
      withJudgeFallback(createJevJudge({ key, gateway: f.gateway }), llm, () => key.usable()),
    );
    expect([routing?.strategy.name, judge.name]).toEqual(["llm", "llm"]);
    await key.save("ts_named_key_1", f.owner.id);
    expect([routing?.strategy.name, judge.name]).toEqual(["jev", "jev"]);
  });

  test("out of credit: the LLM strategy decides, and Jev isn't called again for 30 minutes", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema ? { chunks: ['{"needs_agent":0.1,"scores":[],"reason":"r"}'] } : { chunks: ["ok"] },
    });
    let clock = Date.now();
    const key = createJevKey({
      db: f.db,
      keyWrapper: f.keyWrapper,
      keyWrappers: [f.keyWrapper],
      envKey: "ts_broke_key",
      now: () => clock,
    });
    let calls = 0;
    const broke = (async () => {
      calls++;
      return Response.json({ detail: { error_type: "billing_error", message: "No credit left" } }, { status: 402 });
    }) as unknown as typeof fetch;
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key, fetch: broke } },
    });
    await post(f, "anyone around?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(1);
    expect((await key.view()).state).toBe("no_credit");
    await post(f, "still there?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(1);
    clock += 30 * 60_000;
    await post(f, "and now?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(2);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.map((d) => d.strategy)).toEqual(Array(3).fill("llm:claude-haiku-5-5"));
    expect(decisions.map((d) => d.error).sort()).toEqual([
      "jev: TypeSafe answered 402",
      "jev: TypeSafe answered 402",
      null,
    ]);
  });

  test("agents' messages never reach the router", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: {}, needs: 1 }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "m", jev: { key: "k", fetch: jev.fetcher } },
    });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "done",
      }),
    );
    await drainOutbox(f.db, handlers);
    expect(jev.requests).toEqual([]);
  });
});

describe("a message for the agents always gets one (R5)", () => {
  /** Who wrote a line: Ana, Bruno or an agent; `routedTo` with the `strategy` that sent it there (jev by default). */
  type Line = [
    by: "ana" | "bruno" | { id: string },
    text: string,
    minutesAgo: number,
    routedTo?: string[],
    strategy?: string,
  ];

  /** #engenharia with Ana and Bruno, and Caio (Dev) and Ada (Design); Theo (PM) is in the workspace. */
  async function room() {
    f = await setup();
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno");
    const make = (name: string, role: string) =>
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle: name.toLowerCase(), role, credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
    const caio = await make("Caio", "Dev");
    const ada = await make("Ada", "Design");
    const theo = await make("Theo", "PM");
    let n = 0;
    async function talk(before: Line[], body: string, answer: Parameters<typeof fakeJev>[0], by: Line[0] = "ana") {
      n += 1;
      const now = Date.now();
      const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: `engenharia-${n}` });
      await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { userId: bruno.id });
      for (const a of [caio, ada]) await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: a.id });
      const say = async ([author, text, minutesAgo, routedTo, strategy]: Line) => {
        const m = await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: channel.id,
          author:
            typeof author === "object"
              ? { type: "agent", agentId: author.id, runId: null, hop: 1, stretchId: null }
              : { type: "person", userId: author === "bruno" ? bruno.id : f.owner.id },
          body: text,
          createdAt: new Date(now - minutesAgo * 60_000),
        });
        if (routedTo) {
          await f.db.insert(schema.routingDecisions).values({
            orgId: f.org.id,
            channelId: channel.id,
            messageId: m.id,
            strategy: strategy ?? "jev",
            candidates: [],
            selectedAgentIds: routedTo,
            createdAt: new Date(now - minutesAgo * 60_000),
          });
        }
        return m;
      };
      for (const line of before) await say(line);
      const m = await say([by, body, 0]);
      const strategy = createJevRouterStrategy({
        key: "k",
        recordUsage: async () => {},
        fetch: fakeJev(answer).fetcher,
      });
      const routed = await routeMessage(
        { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
        { orgId: f.org.id, messageId: m.id },
      );
      const [decision] = await f.db
        .select()
        .from(schema.routingDecisions)
        .where(eq(schema.routingDecisions.messageId, m.id));
      return { ...routed, decision };
    }
    return { caio, ada, theo, talk };
  }

  /** Low need, every agent under the bar: what Jev said for "vocês se enrolaram muito". */
  const low =
    (needs: number, best = "none", confidence = 0.46) =>
    () => ({
      nouls: { "@caio": 0.25, "@ada": 0.2, "@theo": 0.15 },
      needs,
      best,
      choice: { [best]: confidence },
    });

  test("a complaint to the agents and a short 'Entenderam?' go to the agent the person talks with", async () => {
    const r = await room();
    const talk: Line[] = [
      ["ana", "caio, olha o build que quebrou", 6, [r.caio.id]],
      [{ id: r.caio.id }, "Olhei, é o teste de login.", 5],
    ];
    const complaint = await r.talk(
      talk,
      "Eu mesmo peguei e fiz tudo no meu computador, vocês se enrolaram muito.",
      low(0.3, "caio"),
    );
    expect(complaint.selected).toEqual([r.caio.id]);
    expect(complaint.decidedBy).toEqual({ step: "rule", rule: "default" });
    expect(complaint.decision?.strategy).toBe("rule:default");
    expect(complaint.decision?.reason).toStartWith("follow-up; default; talking to; jev:");
    // Right after it, with a pick of nobody and a need under the bar: the question mark keeps it out of the ack guard.
    const asked = await r.talk(
      [...talk, ["ana", "Eu mesmo fiz tudo, vocês se enrolaram muito.", 1, [r.caio.id], "rule:default"]],
      "Entenderam?",
      low(0.2),
    );
    expect(asked.selected).toEqual([r.caio.id]);
    expect(asked.decision?.reason).toStartWith("follow-up; default; talking to");
  });

  test("a thank-you after the answer gets nobody (the ack guard)", async () => {
    const r = await room();
    const thanks = await r.talk(
      [
        ["ana", "caio, olha o build que quebrou", 6, [r.caio.id]],
        [{ id: r.caio.id }, "Corrigi, já está verde.", 1],
      ],
      "valeu",
      low(0.1),
    );
    expect(thanks.selected).toEqual([]);
    expect(thanks.runs).toEqual([]);
  });

  test("people talking among themselves get nobody: an answer right after a colleague, or a message to a person", async () => {
    const r = await room();
    const answer = await r.talk([["ana", "bruno, consegue revisar até amanhã?", 1]], "consigo sim", low(0.3), "bruno");
    expect(answer.selected).toEqual([]);
    // The same words with no colleague before them are for the agents: the best placed answers.
    expect((await r.talk([], "consigo sim", low(0.3), "bruno")).selected).toEqual([r.caio.id]);
    expect((await r.talk([], "boa tarde bruno", low(0.3))).selected).toEqual([]);
  });

  test("'vocês viram o erro?' right after a colleague: nobody, unless Jev hears it said to every agent", async () => {
    const r = await room();
    const before: Line[] = [["bruno", "o deploy quebrou de novo", 1]];
    const said = (everyone: number) => () => ({ ...low(0.4)(), everyone });
    expect((await r.talk(before, "vocês viram o erro no deploy?", said(0.2))).selected).toEqual([]);
    const toAll = await r.talk(before, "vocês viram o erro no deploy?", said(0.6));
    expect(toAll.selected).toEqual([r.caio.id]);
    expect(toAll.decision?.reason).toStartWith("default; best");
  });

  test("no talk: the best placed agent; a talk with an agent comes first", async () => {
    const r = await room();
    const toAda = await r.talk([], "alguém consegue olhar a tela de login?", low(0.3, "ada", 0.4));
    expect(toAda.selected).toEqual([r.ada.id]);
    expect(toAda.decidedBy).toEqual({ step: "rule", rule: "default" });
    expect(toAda.decision?.reason).toStartWith("default; best; jev:");
    const backToAda = await r.talk(
      [
        ["ana", "ada, revisa o layout da tela de login", 12.4, [r.ada.id]],
        [{ id: r.ada.id }, "Revisei, mandei os ajustes.", 12],
      ],
      "e a tela de cadastro, consegue olhar também?",
      low(0.3, "caio", 0.4),
    );
    expect(backToAda.selected).toEqual([r.ada.id]);
    expect(backToAda.decision?.reason).toStartWith("follow-up; default; talking to");
  });

  test("a default pick is no talk: the next message is picked again, not kept with that agent", async () => {
    const r = await room();
    const next = await r.talk(
      [
        ["ana", "alguém consegue olhar a tela de login?", 15, [r.ada.id], "rule:default"],
        [{ id: r.ada.id }, "Olhei, está ok.", 14],
      ],
      "e o build de ontem passou?",
      low(0.3, "caio", 0.4),
    );
    expect(next.selected).toEqual([r.caio.id]);
    expect(next.decision?.reason).toStartWith("default; best");
  });

  test("at most a few default picks a channel an hour; past them, nobody", async () => {
    const r = await room();
    const picks = (count: number): Line[] =>
      Array.from({ length: count }, (_, i) => ["ana", `pergunta ${i}`, 59 - i, [r.ada.id], "rule:default"] as Line);
    const asked = "alguém consegue olhar a tela de login?";
    expect((await r.talk(picks(DEFAULT_PICKS_PER_HOUR - 1), asked, low(0.3, "ada"))).selected).toEqual([r.ada.id]);
    expect((await r.talk(picks(DEFAULT_PICKS_PER_HOUR), asked, low(0.3, "ada"))).selected).toEqual([]);
  });

  test("an agent's message never gets a default pick; a router failure is never silence for a person", async () => {
    const r = await room();
    const byAgent = await r.talk([], "alguém de infra saberia dizer?", low(0.9, "ada"), { id: r.caio.id });
    expect(byAgent.selected).toEqual([]);
    const down = () => new Error("down");
    // Nothing could read it: the best placed agent, with no scores the oldest.
    const failed = await r.talk([], "alguém viu o relatório?", down);
    expect(failed).toMatchObject({ selected: [r.caio.id], decidedBy: { step: "rule", rule: "default" } });
    expect(failed.decision?.strategy).toBe("rule:default");
    expect(failed.decision?.error).toContain("jev:");
    // ...or the one that spoke here last.
    const spoke = await r.talk([[{ id: r.ada.id }, "Subi o novo layout.", 3]], "alguém viu o relatório?", down);
    expect(spoke.selected).toEqual([r.ada.id]);
    // Still nobody for a person, a colleague's talk or an ack.
    expect((await r.talk([], "boa tarde bruno", down)).selected).toEqual([]);
    expect((await r.talk([["bruno", "bora almoçar?", 1]], "bora sim", down)).selected).toEqual([]);
    expect((await r.talk([], "ok", down)).selected).toEqual([]);
  });
});

describe("Jev on a social message", () => {
  test("end to end: 'boa noite pessoal' gets one 🌙 and no run; 'alô???' after it gets one agent's answer", async () => {
    f = await setup({ reply: () => ({ chunks: ["Boa noite! Tô aqui."] }) });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    // Bruno is here too, silent: alone with the team, the goodnight would get an answer (ADR 0137 §5).
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bruno.id });
    const jev = fakeJev((state) =>
      JSON.stringify(state.latest_message).includes("alô???")
        ? { nouls: { "@dev": 0.3, "@qa": 0.2 }, needs: 0.7, best: "dev", social: { choice: "none", confidence: 0.9 } }
        : { nouls: { "@dev": 0.05, "@qa": 0.05 }, needs: 0.05, social: { choice: "🌙", confidence: 0.9 } },
    );
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    const night = await post(f, "boa noite pessoal");
    await drainOutbox(f.db, handlers);
    const reactions = await f.db.select().from(schema.messageReactions);
    expect(reactions.map((r) => [r.messageId, r.reaction])).toEqual([[night.id, "🌙"]]);
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);

    const insist = await post(f, "alô???");
    await drainOutbox(f.db, handlers);
    expect((await f.db.select().from(schema.messageReactions)).filter((r) => r.messageId === insist.id)).toEqual([]);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.agentId, r.triggerMessageId])).toEqual([[f.agent.id, insist.id]]);
    expect(f.provider.calls).toHaveLength(1); // only the agent's answer: Jev decided both, no LLM router call
  });
});
