import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { ProviderError, systemText, textOf } from "@agenteschat/providers";
import {
  buildRunContext,
  createAgent,
  createJobHandlers,
  createLlmRouterStrategy,
  DEFAULT_PICKS_PER_HOUR,
  DEFAULT_ROUTER_POLICY,
  decidedByOf,
  drainOutbox,
  insertMessage,
  insertMessageWithRuns,
  listMessages,
  parseRouterOutput,
  postPersonMessage,
  ROUTER_QUIET_MS,
  ROUTER_SLICE,
  RouterOutputError,
  type RouterStrategy,
  type RoutingCandidate,
  type RoutingInput,
  type RoutingResult,
  routeMessage,
  routerPrompt,
  SPOKEN_TO,
  scoresOf,
  selectAgents,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const cand = (agentId: string): RoutingCandidate => ({ agentId, handle: agentId, name: agentId, role: "", about: "" });
const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

describe("selectAgents (policy)", () => {
  test("threshold, best first, at most two, candidates only", () => {
    const candidates = ["a", "b", "c", "d"].map(cand);
    const result = {
      agents: [
        { agentId: "a", score: 0.6 },
        { agentId: "b", score: 0.9 },
        { agentId: "c", score: 0.7 },
        { agentId: "d", score: 0.2 },
        { agentId: "intruder", score: 1 },
      ],
      forEveryone: 0.9,
    };
    expect(selectAgents(candidates, result, policy)).toEqual(["b", "c"]);
  });

  test("a message with one answer goes to one agent, even when several could take it", () => {
    // "quantas assinaturas tivemos hoje?" to the PM (0.8) and the researcher (0.75), 2026-10-28: both answered the same.
    const candidates = ["pm", "research"].map(cand);
    const agents = [
      { agentId: "pm", score: 0.8 },
      { agentId: "research", score: 0.75 },
    ];
    expect(selectAgents(candidates, { agents, needsAgent: 0.9, forEveryone: 0.1 }, policy)).toEqual(["pm"]);
    expect(selectAgents(candidates, { agents, needsAgent: 0.9 }, policy)).toEqual(["pm"]);
    expect(selectAgents(candidates, { agents, needsAgent: 0.9, forEveryone: 0.8 }, policy)).toEqual(["pm", "research"]);
  });

  test("a low need-any-agent score means nobody", () => {
    expect(selectAgents([cand("a")], { agents: [{ agentId: "a", score: 0.9 }], needsAgent: 0.1 }, policy)).toEqual([]);
  });

  test("a clear pick answers even when the need-any-agent score disagrees", () => {
    // "theo, tell everyone our best TikTok campaign": Theo 1.0, needs_agent 0.22 (2026-10-17).
    const result = {
      agents: [
        { agentId: "theo", score: 1 },
        { agentId: "iris", score: 0.025 },
      ],
      needsAgent: 0.22,
    };
    expect(selectAgents([cand("theo"), cand("iris")], result, policy)).toEqual([]);
    expect(selectAgents([cand("theo"), cand("iris")], result, { ...policy, clearPickScore: 0.8 })).toEqual(["theo"]);
    expect(
      selectAgents(
        [cand("theo"), cand("iris")],
        { ...result, agents: [{ agentId: "theo", score: 0.7 }] },
        { ...policy, clearPickScore: 0.8 },
      ),
    ).toEqual([]);
  });

  test("a message to the room may wake up to four agents by default", () => {
    const candidates = ["a", "b", "c", "d", "e"].map(cand);
    const result = {
      agents: candidates.map((c) => ({ agentId: c.agentId, score: 0.9 })),
      needsAgent: 0.9,
      forEveryone: 0.9,
    };
    expect(selectAgents(candidates, result, { ...DEFAULT_ROUTER_POLICY, maxHops: 3 })).toHaveLength(4);
  });
});

describe("parseRouterOutput", () => {
  test("keeps well-formed scores; an answer that isn't JSON is a failure, so the next step decides", () => {
    expect(
      parseRouterOutput('{"needs_agent":0.8,"scores":[{"handle":"dev","score":0.9},{"x":1}],"reason":"r"}'),
    ).toEqual({
      needs_agent: 0.8,
      for_everyone: 0,
      already_answered: 0,
      scores: [{ handle: "dev", score: 0.9 }],
      reason: "r",
    });
    expect(parseRouterOutput('```json\n{"needs_agent":0}\n```').needs_agent).toBe(0);
    expect(() => parseRouterOutput("not json")).toThrow(RouterOutputError);
    expect(() => parseRouterOutput("[1]")).toThrow(RouterOutputError);
  });
});

describe("routerPrompt", () => {
  test("names a message to the room in both languages, and asks whether each agent has its own answer", () => {
    const { system, schema: answer } = routerPrompt({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "e agora, vocês dois?" },
      thread: [],
      candidates: [cand("dev"), cand("qa")],
    });
    const room = system.split("\n").find((line) => line.includes("the whole room"));
    for (const phrase of ["everyone", "all of you", "gente", "vocês", "agentes"]) expect(room).toContain(`"${phrase}"`);
    expect(room).toContain("score every agent high");
    expect(system).toContain("And `for_everyone`:");
    expect(answer.required).toContain("for_everyone");
  });

  test("marks who each message names, what it decides on, and a person alone with its agent", () => {
    const { prompt } = routerPrompt({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "Ana", body: "boa tarde walter\ncomo esta hoje", names: ["Walter"] },
      thread: [{ author: "@ada", body: "Campanha publicada." }],
      candidates: [cand("ada")],
      aloneWith: "ada",
    });
    expect(prompt).toContain("<history>\n[@ada]: Campanha publicada.\n</history>");
    expect(prompt).toContain("<message>\n[Ana, names Walter]: boa tarde walter\ncomo esta hoje\n</message>");
    expect(prompt).toContain("This person is the only one here with @ada");
  });
});

describe("who a message speaks to, for the small model", () => {
  test("it says first which agent the message speaks to, under the rule every step reads", () => {
    const { system, schema: answer } = routerPrompt({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "ada pergunta pro theo meu email" },
      thread: [],
      candidates: [cand("ada"), cand("theo")],
    });
    expect(system).toContain(`- ${SPOKEN_TO}`);
    expect(system).toContain("First give `addressee`");
    expect(Object.keys(answer.properties)[0]).toBe("addressee");
    expect(answer.properties.addressee).toEqual({ type: "string", enum: ["ada", "theo", "none"] });
    expect(answer.required).toContain("addressee");
  });

  test("like Jev, it counts only for a person's message among two or more agents", () => {
    const answer = {
      addressee: "theo",
      needs_agent: 0.85,
      for_everyone: 0,
      already_answered: 0,
      scores: [{ handle: "theo", score: 0.4 }],
      reason: "",
    };
    const kept = { agents: [{ agentId: "theo", score: 0.4 }], needsAgent: 0.85, forEveryone: 0, alreadyAnswered: 0 };
    expect(scoresOf({ candidates: [cand("ada"), cand("theo")] }, answer)).toMatchObject({
      addressee: "theo",
      agents: [{ agentId: "theo", score: 0.85 }],
    });
    // An agent's message: another agent comes in only past its own bar (ADR 0034).
    expect(scoresOf({ candidates: [cand("ada"), cand("theo")], authorUserId: null }, answer)).toEqual(kept);
    // The only agent of a room: nobody to tell it from, and it keeps its `pass`.
    expect(scoresOf({ candidates: [cand("theo")] }, answer)).toEqual(kept);
  });

  test("its `addressee` decides between the agents a message names; `none` leaves the scores as they are", async () => {
    let addressee = "ada";
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? {
              chunks: [
                JSON.stringify({
                  addressee,
                  needs_agent: 0.8,
                  for_everyone: 0,
                  scores: [
                    { handle: "theo", score: 0.9 },
                    { handle: "ada", score: 0.4 },
                  ],
                  reason: "email",
                }),
              ],
            }
          : { chunks: ["ok"] },
    });
    const make = async (name: string) => {
      const a = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle: name.toLowerCase() },
        { model: "claude-sonnet-5-5" },
      );
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    const ada = await make("Ada");
    const theo = await make("Theo");
    const strategy = createLlmRouterStrategy({ gateway: f.gateway, resolveModel: async () => "claude-haiku-5-5" });
    const route = async (body: string) => {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body,
      });
      const routed = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id });
      const [decision] = await f.db
        .select()
        .from(schema.routingDecisions)
        .where(eq(schema.routingDecisions.messageId, m.id));
      return { routed, decision };
    };
    const toAda = await route("ada pergunta pro theo ai qual meu email mais recente pls");
    expect(toAda.routed.selected).toEqual([ada.id]);
    // Theo only named: nothing. Ada spoken to: as far as an agent is needed, and addressed.
    expect(toAda.decision?.candidates).toContainEqual({ agentId: theo.id, score: 0 });
    expect(toAda.decision?.candidates).toContainEqual({ agentId: ada.id, score: 0.8 });
    expect(toAda.decision?.reason).toBe("follow-up; model: email");
    addressee = "none";
    expect((await route("alguém sabe qual meu email mais recente?")).routed.selected).toEqual([theo.id]);
  });
});

/** A strategy that returns fixed scores by handle and records what it saw. */
function fixedStrategy(scores: Record<string, number>, forEveryone?: number) {
  const seen: RoutingCandidate[][] = [];
  const strategy: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      seen.push(input.candidates);
      return {
        agents: input.candidates.map((c) => ({ agentId: c.agentId, score: scores[c.handle] ?? 0 })),
        ...(forEveryone === undefined ? {} : { forEveryone }),
        reason: "test",
      };
    },
  };
  return { strategy, seen };
}

describe("routeMessage", () => {
  test("each candidate's `can` names the connections it may use (a question about Sentry goes to who has it)", async () => {
    f = await setup();
    const make = (handle: string) =>
      createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
    const atlas = await make("atlas");
    const ada = await make("ada");
    for (const a of [atlas, ada])
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
    const [sentry] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "sentry",
        label: "Sentry",
        toolPrefix: "sentry",
        serverUrl: "https://mcp.sentry.dev",
        authType: "none",
      })
      .returning();
    await f.db.insert(schema.agentScopes).values([
      { orgId: f.org.id, agentId: atlas.id, connectionId: sentry?.id, scope: "connector:*" },
      { orgId: f.org.id, agentId: ada.id, connectionId: sentry?.id, scope: "deny:sentry_list_issues" },
    ]);
    const { strategy, seen } = fixedStrategy({});
    const message = await post("nenhum erro novo no sentry gente?");
    await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    const can = Object.fromEntries((seen[0] ?? []).map((c) => [c.handle, c.can]));
    expect(can.atlas).toContain("Sentry");
    expect(can.ada).not.toContain("Sentry");
  });

  test("candidates are filtered by code: channel members, active, auto-reply on", async () => {
    f = await setup();
    const make = (handle: string) =>
      createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
    const qa = await make("qa");
    const ops = await make("ops");
    await make("outsider"); // not in #general
    const archived = await make("old");
    for (const a of [qa, ops, archived])
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
    await f.db.update(schema.channelMembers).set({ autoReply: false }).where(eq(schema.channelMembers.agentId, ops.id));
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));

    // Heard as for every agent: both answer.
    const { strategy, seen } = fixedStrategy({ qa: 0.95, dev: 0.7, outsider: 1 }, 0.9);
    const message = await post("the build is red again");
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    expect(seen[0]?.map((c) => c.handle).sort()).toEqual(["dev", "qa"]);
    expect(result.runs.map((r) => [r.agentId, r.trigger, r.hop])).toEqual([
      [qa.id, "router", 1],
      [f.agent.id, "router", 1],
    ]);

    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "fixed", messageId: message.id, selectedAgentIds: [qa.id, f.agent.id] });
    expect(decision?.candidates.sort((a, b) => b.score - a.score)).toEqual([
      { agentId: qa.id, score: 0.95 },
      { agentId: f.agent.id, score: 0.7 },
    ]);

    // Each picked agent knows who else answers, so it speaks only for itself.
    const devRun = result.runs.find((r) => r.agentId === f.agent.id);
    if (!devRun) throw new Error("no run");
    const devPrompt = systemText((await buildRunContext(f.db, devRun, f.agent, { maxMessages: 10 })).system);
    expect(devPrompt).toContain("@qa also got this message and is answering right now");
    expect(devPrompt).not.toContain("@ops also got");

    // One decision per message: a redelivered job does nothing.
    expect(
      (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id })).skipped,
    ).toBe("already_routed");
    expect(seen).toHaveLength(1);
  });

  test("an agent's message brings in one more agent only on a clear pick, never itself, never from an answer to an answer", async () => {
    f = await setup();
    const make = async (handle: string) => {
      const a = await createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    const infra = await make("infra");
    await make("qa");
    const question = await post("why is staging slow?");
    const byDev = (body: string, hop: number) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: question.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop, stretchId: null },
        body,
      });

    const { strategy, seen } = fixedStrategy({ dev: 1, infra: 0.9, qa: 0.85 });
    const answer = await byDev("Looks like the database; infra would know.", 1);
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: answer.id });
    expect(seen[0]?.map((c) => c.handle).sort()).toEqual(["infra", "qa"]);
    expect(result.runs.map((r) => [r.agentId, r.hop])).toEqual([[infra.id, 2]]);

    const lukewarm = fixedStrategy({ infra: 0.7, qa: 0.6 });
    const second = await byDev("Also the cache was cold.", 1);
    expect(
      (await routeMessage({ db: f.db, strategy: lukewarm.strategy, policy }, { orgId: f.org.id, messageId: second.id }))
        .selected,
    ).toEqual([]);

    const deep = await byDev("answer to an answer", 2);
    expect((await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: deep.id })).skipped).toBe(
      "hop_limit",
    );
  });

  test("asking the agent you talk to about what it already said still gets its answer; another agent stays quiet", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const question = await post("our timezone is Sao Paulo, note it");
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: question.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Noted. I also moved the hourly reviews routine to Sao Paulo time.",
    });
    const answered = (scores: Record<string, number>): RouterStrategy => ({
      name: "fixed",
      async decide(input) {
        return {
          agents: input.candidates.map((c) => ({ agentId: c.agentId, score: scores[c.handle] ?? 0 })),
          needsAgent: 0.94,
          alreadyAnswered: 0.9,
        };
      },
    });
    // Longer than a short follow-up, about something the agent already said: it answers anyway.
    const again = await post("and what is the interval of that review routine of yours again?");
    const toDev = await routeMessage(
      { db: f.db, strategy: answered({ [f.agent.handle]: 1, ops: 0.05 }), policy },
      { orgId: f.org.id, messageId: again.id },
    );
    expect(toDev.selected).toEqual([f.agent.id]);
    // The router would bring in someone else for an answer already given: nobody.
    const other = await post("who handles the review routine and how often does it run?");
    const toOps = await routeMessage(
      { db: f.db, strategy: answered({ [f.agent.handle]: 0.1, ops: 0.9 }), policy },
      { orgId: f.org.id, messageId: other.id },
    );
    expect(toOps.selected).toEqual([]);
  });

  test("a quote reply to an agent goes to that agent, who the router saw answer under the earlier message", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const question = await post("clone the repo and look at the error");
    const answer = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: question.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "I couldn't read the code: the clone of the repo hung.",
    });
    const inputs: { body: string; thread: string[] }[] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        inputs.push({ body: input.message.body, thread: input.thread.map((m) => m.body) });
        // The router alone would pick ops (it talks about infrastructure).
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: c.handle === "ops" ? 0.9 : 0.2 })) };
      },
    };
    const why = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "why did the clone of the repo hang? was it a timeout, permissions or the network?",
      replyTo: answer.id,
    });
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: why.id });
    expect(result.selected).toEqual([f.agent.id]);
    expect(inputs[0]?.thread).toContain("I couldn't read the code: the clone of the repo hung.");
    expect(inputs[0]?.body).toStartWith("(replying to Dev:");
  });

  test("a reply under an agent's message goes to that agent, long after it, with the message in view", async () => {
    f = await setup();
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "A new loved review came in right after a subscription; that prompt was the one we decided to remove.",
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    const threads: string[][] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        threads.push(input.thread.map((m) => m.body));
        // Without the report in view, a plain statement reads as for nobody.
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.1 })), needsAgent: 0.1 };
      },
    };
    const reply = await post("we haven't shipped that removal yet, I'm still thinking it over", report.id);
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: reply.id });
    expect(result.selected).toEqual([f.agent.id]);
    expect(threads[0]?.[0]).toBe(report.body);
  });

  /** Dev and Ops in #general with Ana and Bia; by default the step hears a short yes as an ok, for nobody. */
  async function room(heard: Partial<RoutingResult> = {}) {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // A handle, so "@bia" mentions her.
    await f.db
      .update(schema.organizationMembers)
      .set({ handle: "bia" })
      .where(eq(schema.organizationMembers.userId, bia.id));
    await f.db.insert(schema.channelMembers).values([
      { orgId: f.org.id, channelId: f.general.id, agentId: ops.id },
      { orgId: f.org.id, channelId: f.general.id, userId: bia.id },
    ]);
    const [me] = await f.db
      .select({ handle: schema.organizationMembers.handle })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    const strategy: RouterStrategy = {
      name: "fixed",
      decide: async (input) => ({
        agents: input.candidates.map((c) => ({ agentId: c.agentId, score: c.agentId === f.agent.id ? 0.4 : 0.1 })),
        needsAgent: 0.2,
        ...heard,
      }),
    };
    /** Dev's message `minutesAgo`, top level or in a thread. */
    const says = (body: string, minutesAgo: number, threadId?: string) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: threadId ?? null,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      });
    const ask = (minutesAgo: number, threadId?: string) =>
      says(`The release notes are ready. Can I send them to the customers list, @${me?.handle}?`, minutesAgo, threadId);
    const decide = (messageId: string) => routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId });
    const route = async (messageId: string) => (await decide(messageId)).selected;
    return { bia, ask, says, decide, route };
  }

  describe("a person's answer to an agent's question to them", () => {
    test("goes to that agent, however low it scores, 20 minutes later", async () => {
      const { ask, route } = await room();
      const question = await ask(20);
      expect(question.mentionedUserIds).toEqual([f.owner.id]);
      const yes = await post("pode sim");
      expect(await route(yes.id)).toEqual([f.agent.id]);
      const [decision] = await f.db
        .select()
        .from(schema.routingDecisions)
        .where(eq(schema.routingDecisions.messageId, yes.id));
      // Addressed: the run it starts answers (reply-policy.ts), it can't pass on the yes.
      expect(decision?.reason).toStartWith("follow-up");
    });

    test("in a thread, the answer under the agent's question goes to it too", async () => {
      const { ask, route } = await room();
      const root = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "look at the release",
        createdAt: new Date(Date.now() - 25 * 60_000),
      });
      await ask(20, root.id);
      const yes = await post("pode sim", root.id);
      expect(await route(yes.id)).toEqual([f.agent.id]);
    });

    test("not once someone else spoke since", async () => {
      const { bia, ask, route } = await room();
      await ask(20);
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, { body: "almoço?" });
      expect(await route((await post("pode sim")).id)).toEqual([]);
    });

    test("not hours later", async () => {
      const { ask, route } = await room();
      await ask(3 * 60);
      expect(await route((await post("pode sim")).id)).toEqual([]);
    });

    test("an answer that also names someone with @ still reaches the agent; only the @ alone is for that person", async () => {
      const { ask, route } = await room();
      await ask(20);
      expect(await route((await post("pode sim, @bia confere depois")).id)).toEqual([f.agent.id]);
      expect(await route((await post("@bia")).id)).toEqual([]);
    });
  });

  describe("a rule never answers for the step", () => {
    test("a message that only @mentions a person is for them, though the agent spoke last in its thread", async () => {
      const { says, route } = await room({ needsAgent: 0.07 });
      const report = await says("Deploy done: 12 services up, no errors since.", 5);
      expect(await route((await post("@bia", report.id)).id)).toEqual([]);
      const [decision] = await f.db.select().from(schema.routingDecisions);
      expect(decision?.reason).toBe("for people");
    });

    test("a thread reply the step needs no agent for gets nobody; one it hears as a question to the agent still does", async () => {
      const { says, route } = await room({ needsAgent: 0.05, social: { react: false, emoji: "" } });
      const report = await says("Deploy done: 12 services up, no errors since.", 5);
      expect(await route((await post("vou almoçar agora, volto em uma hora", report.id)).id)).toEqual([]);
      const asked = await says("Deploy done. Want me to watch the error rate tonight?", 4);
      expect(await route((await post("vou almoçar agora, volto em uma hora", asked.id)).id)).toEqual([f.agent.id]);
    });

    test("an ok or an 'I'll wait' to the agent's update gets its reaction, not a run; after its question, an answer", async () => {
      const { says, decide } = await room({ needsAgent: 0.1, social: { react: true, emoji: "👍" } });
      const update = await says("The migration is still running; I'll post the totals when it ends.", 5);
      const waits = await decide((await post("beleza, aguardo", update.id)).id);
      expect(waits.selected).toEqual([]);
      expect(waits.reacted).toEqual({ agentId: f.agent.id, reaction: "+1" });
      expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
      const question = await says("The migration is still running. Should I post the totals here?", 4);
      expect((await decide((await post("ok", question.id)).id)).selected).toEqual([f.agent.id]);
    });
  });

  test("no candidates: no strategy call", async () => {
    f = await setup();
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(eq(schema.channelMembers.agentId, f.agent.id));
    const { strategy, seen } = fixedStrategy({});
    const message = await post("hi");
    expect(
      (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id })).skipped,
    ).toBe("no_candidates");
    expect(seen).toHaveLength(0);
  });

  test("a failing strategy never goes back to the outbox: it is recorded, and the rules decide", async () => {
    f = await setup();
    const failing = (error: Error): RouterStrategy => ({ name: "boom", decide: async () => Promise.reject(error) });
    // Ana is alone in #general with Dev: the rule sends it there.
    const alone = await post("hi");
    const result = await routeMessage(
      { db: f.db, strategy: failing(new ProviderError("overloaded", true)), policy },
      { orgId: f.org.id, messageId: alone.id },
    );
    expect(result).toMatchObject({ selected: [f.agent.id], decidedBy: { step: "rule", rule: "only_agent" } });
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "rule:only_agent", error: "boom: overloaded" });
  });
});

describe("LLM strategy (end to end through the outbox)", () => {
  test("a message without mentions is routed by the router model; the picked agent replies", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    f = await setup({
      reply: (req) => {
        if (!req.outputSchema) return { chunks: ["On it."] };
        signals.push(req.signal);
        return {
          chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.88}],"reason":"build question"}'],
          usage: { inputTokens: 300, outputTokens: 20 },
        };
      },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("why is the build failing?");
    await drainOutbox(f.db, handlers);

    const routerCall = f.provider.calls[0]?.request;
    expect(routerCall?.model).toBe("claude-haiku-5-5");
    // The least thinking Haiku allows, a short answer, and 8 s at most.
    expect(routerCall?.effort).toBe("none");
    expect(routerCall?.maxTokens).toBe(512);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(systemText(routerCall?.system ?? "")).toContain("Answer at once, without deliberating.");
    expect(JSON.stringify(routerCall?.outputSchema)).toContain('"enum":["dev"]');
    expect(textOf(routerCall?.messages[0]?.content ?? "")).toContain("<message>\n[ana]: why is the build failing?");

    // Asked in the channel: the reply is in the main timeline.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["why is the build failing?", "On it."]);
    const usage = await f.db.select().from(schema.usageRecords);
    expect(usage.map((u) => [u.kind, u.agentId]).sort()).toEqual([
      ["agent", f.agent.id],
      ["router", null],
    ]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({
      strategy: "llm:claude-haiku-5-5",
      needsAgentScore: 0.9,
      reason: "model: build question",
      error: null,
    });
    expect(decision?.usageRecordId).toBe(usage.find((u) => u.kind === "router")?.id ?? "");
  });

  test("after an agent answers, another agent may join on its own; its reply says nobody called it", async () => {
    f = await setup({
      reply: (req) => {
        if (!req.outputSchema)
          return { chunks: [JSON.stringify(req.messages).includes("cache") ? "Ok." : "The cache is cold."] };
        const prompt = textOf(req.messages[0]?.content ?? "");
        // The person's message goes to @dev; @dev's answer brings in @qa.
        return prompt.includes("[@dev]:")
          ? { chunks: ['{"needs_agent":0.3,"scores":[{"handle":"qa","score":0.9}],"reason":"qa owns tests"}'] }
          : { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"dev"}'] };
      },
    });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("why are the tests slow?");
    await drainOutbox(f.db, handlers);

    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const byDev = main.find((m) => m.author.id === f.agent.id);
    const byQa = main.find((m) => m.author.id === qa.id);
    expect(byDev?.meta.joined).toBeUndefined();
    expect(byQa?.meta.joined).toBe(true);
    // QA answers Dev's message: the apps fold a long one (`toAgent`); Dev answers a person.
    expect(byQa?.meta.toAgent).toBe(f.agent.id);
    expect(byDev?.meta.toAgent).toBeUndefined();
    // QA's answer to an answer brings in nobody else.
    expect(main.filter((m) => m.author.type === "agent")).toHaveLength(2);
  });

  test("an org can override the router model; the router is off when disabled", async () => {
    f = await setup({ reply: () => ({ chunks: ['{"needs_agent":0,"scores":[],"reason":"chit-chat"}'] }) });
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, routerModel: "claude-sonnet-5-5" });
    const strategy = createLlmRouterStrategy({
      gateway: f.gateway,
      resolveModel: async () => "claude-sonnet-5-5",
    });
    const message = await post("lunch?");
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    expect(result.selected).toEqual([]);
    expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");

    const off = createJobHandlers({ ...f.jobDeps, router: { enabled: false, model: "claude-haiku-5-5" } });
    await post("anyone?");
    await drainOutbox(f.db, off);
    expect(f.provider.calls).toHaveLength(1);
  });

  test("the org override is resolved per organization by the job handlers", async () => {
    f = await setup({ reply: () => ({ chunks: ['{"needs_agent":0,"scores":[],"reason":""}'] }) });
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, routerModel: "claude-sonnet-5-5" });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("hello");
    await drainOutbox(f.db, handlers);
    expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");
  });
});

describe("what the router reads, and a person's messages in a row", () => {
  /** #general with Walter, a person, and Ada, an agent, besides Ana and Dev. */
  async function team(reply?: NonNullable<Parameters<typeof setup>[0]>["reply"]) {
    f = await setup({ reply });
    const walter = await addMember(f.db, f.org.id, "member", "Walter");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: walter.id });
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Marketing", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ada.id });
    return { ada };
  }
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
  const say = (body: string, secondsAgo: number, meta?: Record<string, unknown>) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body,
      meta,
      createdAt: ago(secondsAgo),
    });
  const byAda = (adaId: string, body: string, secondsAgo: number) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: adaId, runId: null, hop: 1, stretchId: null },
      body,
      createdAt: ago(secondsAgo),
    });
  /** A judge that records what it read and, as Jev's question asks it to, follows the agent just talked to. */
  function judge() {
    const inputs: RoutingInput[] = [];
    const strategy: RouterStrategy = {
      name: "judge",
      async decide(input) {
        inputs.push(input);
        return {
          agents: input.candidates.map((c) => ({
            agentId: c.agentId,
            score: c.handle === input.continuityHandle ? 0.6 : 0.1,
          })),
          needsAgent: 0.2,
        };
      },
    };
    return { strategy, inputs };
  }
  const deps = (strategy: RouterStrategy) => ({
    db: f.db,
    strategy,
    policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 },
    quietMs: ROUTER_QUIET_MS,
  });
  const route = (strategy: RouterStrategy, messageId: string) =>
    routeMessage(deps(strategy), { orgId: f.org.id, messageId });

  test("'boa tarde walter' then 'como esta hoje': one decision on both, for Walter, and no agent", async () => {
    const { ada } = await team();
    // Ada spoke here a few minutes ago, to someone else.
    await byAda(ada.id, "Campanha publicada.", 240);
    const greeting = await say("boa tarde walter", 11);
    const then = await say("como esta hoje", 10);
    const { strategy, inputs } = judge();
    expect((await route(strategy, greeting.id)).skipped).toBe("continued");
    expect((await route(strategy, then.id)).selected).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.message).toEqual({
      id: then.id,
      author: "ana",
      body: "boa tarde walter\ncomo esta hoje",
      names: ["Walter"],
    });
    // Speaking to Walter, Ana continues no talk with Ada.
    expect(inputs[0]?.continuityHandle).toBeNull();
    expect(inputs[0]?.thread).toEqual([{ author: "@ada", body: "Campanha publicada." }]);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.map((d) => [d.messageId, d.selectedAgentIds])).toEqual([[then.id, []]]);
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
  });

  test("'boa tarde walter' then '@ada como está hoje': the greeting is decided alone, for nobody, and Ada answers once", async () => {
    const { ada } = await team();
    await byAda(ada.id, "Campanha publicada.", 240);
    const greeting = await say("boa tarde walter", 11);
    const { message: asked } = await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "@ada como está hoje",
        createdAt: ago(10),
      },
      { startRuns: true },
    );
    const { strategy, inputs } = judge();
    // The mention started its run at once and is never routed: the greeting can't wait on it.
    expect((await route(strategy, greeting.id)).selected).toEqual([]);
    expect((await route(strategy, asked.id)).skipped).toBe("has_mentions");
    expect(inputs.map((i) => i.message.body)).toEqual(["boa tarde walter"]);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.map((d) => [d.messageId, d.selectedAgentIds])).toEqual([[greeting.id, []]]);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.agentId, r.trigger, r.triggerMessageId])).toEqual([[ada.id, "mention", asked.id]]);
  });

  test("an answer to an agent's question and a message to a run in progress are no part of a run", async () => {
    await team();
    const question = await say("alguém sabe como configurar o deploy?", 13);
    await say("pode publicar", 12, { answersQuestionId: crypto.randomUUID() });
    const then = await say("e o servidor?", 11);
    await say("manda o link também", 10, { steeredRunIds: [crypto.randomUUID()] });
    const { strategy, inputs } = judge();
    await route(strategy, question.id);
    await route(strategy, then.id);
    // Neither waits on a message the router never decides on, nor reads one as its own.
    expect(inputs.map((i) => i.message.body)).toEqual(["alguém sabe como configurar o deploy?", "e o servidor?"]);
  });

  test("a message stored with microseconds is decided, never taken for its own next message", async () => {
    await team();
    const asked = await say("alguém sabe como configurar o deploy?", 10);
    // Postgres stores now() with microseconds; read back, `createdAt` is cut to milliseconds.
    await f.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} + interval '456 microseconds'` })
      .where(eq(schema.messages.id, asked.id));
    const { strategy, inputs } = judge();
    expect((await route(strategy, asked.id)).skipped).toBeUndefined();
    expect(inputs.map((i) => i.message.body)).toEqual(["alguém sabe como configurar o deploy?"]);
  });

  test("when no step can read it: an earlier talk with Ada, then 'boa tarde walter' and 'como esta hoje', is for nobody", async () => {
    const { ada } = await team();
    await say("@ada faz o relatório", 300);
    await byAda(ada.id, "Feito.", 240);
    const greeting = await say("boa tarde walter", 11);
    const then = await say("como esta hoje", 10);
    const failing: RouterStrategy = { name: "boom", decide: async () => Promise.reject(new Error("down")) };
    expect((await route(failing, greeting.id)).skipped).toBe("continued");
    // R3 would follow Ana's own talk with Ada, but her messages right before this one speak to Walter.
    expect(await route(failing, then.id)).toMatchObject({ selected: [], reason: "mention_needed" });
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
  });

  test("'alguém sabe como configurar o deploy?' goes, after the quiet moment, to the agent it is for", async () => {
    const routerCalls: { system: string; prompt: string }[] = [];
    await team((req) => {
      if (!req.outputSchema) return { chunks: ["Configuro sim."] };
      routerCalls.push({ system: systemText(req.system ?? ""), prompt: textOf(req.messages[0]?.content ?? "") });
      return {
        chunks: [
          '{"needs_agent":0.9,"for_everyone":0.1,"scores":[{"handle":"dev","score":0.9},{"handle":"ada","score":0.1}],"reason":"deploy"}',
        ],
      };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", quietMs: 300 },
    });
    const asked = await post("alguém sabe como configurar o deploy?");
    await drainOutbox(f.db, handlers);
    // The first call is Ana's question (Dev's answer is routed after it, for anyone else to chime in).
    expect(routerCalls[0]?.system).toContain(
      'asks it or anyone something it can help with ("does anyone know…", "alguém sabe…")',
    );
    expect(routerCalls[0]?.prompt).toContain("<message>\n[ana]: alguém sabe como configurar o deploy?\n</message>");
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.agentId, r.trigger, r.triggerMessageId])).toEqual([[f.agent.id, "router", asked.id]]);
  });

  test("the slice: the newest messages of the conversation, oldest first, each with its author and who it names", async () => {
    const { ada } = await team();
    await say("de manhã", 3 * 3600);
    for (let i = 14; i >= 1; i--) {
      if (i === 3) await byAda(ada.id, "Walter, a campanha saiu.", i * 60);
      else await say(i === 2 ? "valeu ada" : `mensagem ${i}`, i * 60);
    }
    const asked = await say("e o deploy?", 0);
    const { strategy, inputs } = judge();
    await route(strategy, asked.id);
    const thread = inputs[0]?.thread ?? [];
    expect(thread).toHaveLength(ROUTER_SLICE.messages);
    expect(thread.slice(0, 2)).toEqual([
      { author: "ana", body: "mensagem 12" },
      { author: "ana", body: "mensagem 11" },
    ]);
    expect(thread.slice(-3)).toEqual([
      { author: "@ada", body: "Walter, a campanha saiu.", names: ["Walter"] },
      { author: "ana", body: "valeu ada", names: ["@ada"] },
      { author: "ana", body: "mensagem 1" },
    ]);
    expect(inputs[0]?.message).toEqual({ id: asked.id, author: "ana", body: "e o deploy?" });
  });

  test("the slice: nothing older than 30 minutes", async () => {
    await team();
    await say("antiga", 31 * 60);
    await say("recente", 60);
    const asked = await say("e agora?", 3);
    const { strategy, inputs } = judge();
    await route(strategy, asked.id);
    expect(inputs[0]?.thread).toEqual([{ author: "ana", body: "recente" }]);
  });

  test("the slice's size: each message cut, about 4,000 characters in all", async () => {
    await team();
    for (let i = 10; i >= 1; i--) await say(`${i} ${"x".repeat(1000)}`, i * 60);
    const asked = await say("e agora?", 0);
    const { strategy, inputs } = judge();
    await route(strategy, asked.id);
    const thread = inputs[0]?.thread ?? [];
    for (const l of thread) expect(l.body).toHaveLength(ROUTER_SLICE.charsPerMessage);
    expect(thread.every((l) => l.body.endsWith("…"))).toBe(true);
    // The newest that fit: 8 messages of 500 characters.
    expect(thread.map((l) => l.body.split(" ")[0])).toEqual(["8", "7", "6", "5", "4", "3", "2", "1"]);
    expect(thread.reduce((n, l) => n + l.body.length, 0)).toBeLessThanOrEqual(ROUTER_SLICE.chars);
  });

  test("two messages within 2 s get one decision, on both, once the person stops", async () => {
    f = await setup();
    const { strategy, inputs } = judge();
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy, quietMs: 600 },
    });
    const events = f.listen(f.general.id);
    await post("o build quebrou");
    const draining = drainOutbox(f.db, handlers);
    await Bun.sleep(150);
    const second = await post("de novo");
    await draining;
    await drainOutbox(f.db, handlers);
    expect(inputs.map((i) => i.message.body)).toEqual(["o build quebrou\nde novo"]);
    // Ana is alone here with Dev: what she writes to the room is for it.
    expect(inputs[0]?.aloneWith).toBe("dev");
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.map((d) => d.messageId)).toEqual([second.id]);
    // The receipt is under the last message only.
    const routed = events.filter((e) => e.type === "message.routed") as unknown as { messageId: string }[];
    expect(routed.map((e) => e.messageId)).toEqual([second.id]);
  });

  test("long messages, then a question right after them: every step reads the question", async () => {
    await team();
    for (let i = 9; i >= 1; i--) await say(`erro ${i}: ${"x".repeat(1000)}`, 10 + i);
    const asked = await say("alguém sabe o que é isso?", 10);
    const { strategy, inputs } = judge();
    await route(strategy, asked.id);
    const input = inputs[0];
    if (!input) throw new Error("not decided");
    // The lines before it are cut like the slice's, and the oldest left out, so the question fits what a step reads.
    const lines = input.message.body.split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toStartWith("erro 7:");
    for (const l of lines.slice(0, -1)) expect(l).toHaveLength(ROUTER_SLICE.charsPerMessage);
    expect(lines.at(-1)).toBe("alguém sabe o que é isso?");
    expect(routerPrompt(input).prompt).toContain("\nalguém sabe o que é isso?\n</message>");
  });

  test("a quote reply to an agent, then one more line: still a reply to that agent when the rules decide", async () => {
    await team();
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "O deploy de ontem falhou na migração.",
    });
    const quoted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "não funcionou de novo",
      replyTo: report.id,
    });
    const more = await post("deu erro 500");
    const failing: RouterStrategy = { name: "boom", decide: async () => Promise.reject(new Error("down")) };
    const quick = { db: f.db, strategy: failing, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 }, quietMs: 300 };
    expect((await routeMessage(quick, { orgId: f.org.id, messageId: quoted.id })).skipped).toBe("continued");
    expect(await routeMessage(quick, { orgId: f.org.id, messageId: more.id })).toMatchObject({
      selected: [f.agent.id],
      decidedBy: { step: "rule", rule: "reply" },
    });
  });
});

describe("a person alone with the team (R2, ADR 0137)", () => {
  /** #general with Ana, Dev, Theo and Ada; nobody else here. */
  async function team() {
    f = await setup();
    const join = async (name: string) => {
      const a = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle: name.toLowerCase() },
        { model: "claude-sonnet-5-5" },
      );
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    return { theo: await join("Theo"), ada: await join("Ada") };
  }
  /** Scores by handle (0.1 for the others), with the step's other answers. */
  const scored = (scores: Record<string, number>, rest: Omit<RoutingResult, "agents"> = {}): RouterStrategy => ({
    name: "fixed",
    async decide(input) {
      return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: scores[c.handle] ?? 0.1 })), ...rest };
    },
  });
  const route = (strategy: RouterStrategy, messageId: string) =>
    routeMessage(
      { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
      { orgId: f.org.id, messageId },
    );
  const DEFAULT = { step: "rule", rule: "default" } as const;

  test("what needs an agent and nobody took goes to the top-scored agent", async () => {
    const { theo } = await team();
    const asked = await post("alguém pode me ajudar com uma coisa?");
    const result = await route(scored({ theo: 0.3 }, { needsAgent: 0.7, reason: "no clear fit" }), asked.id);
    expect(result).toMatchObject({ selected: [theo.id], decidedBy: DEFAULT });
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, asked.id));
    expect(decision).toMatchObject({ strategy: "rule:default", reason: "default; best; fixed: no clear fit" });
    // A decision the team's coordinator stored before ADR 0137 still reads.
    expect(decidedByOf("rule:coordinator", null)).toEqual({ step: "rule", rule: "coordinator" });
  });

  const ALONE = { step: "rule", rule: "alone" } as const;
  const greet = { needsAgent: 0.1, social: { react: true, emoji: "☀️" } };

  test("a greeting nobody took wakes exactly one agent, the best scored, in a run it may pass on", async () => {
    const { ada } = await team();
    const greeting = await post("bom dia!");
    const result = await route(scored({ ada: 0.3, theo: 0.2 }, { ...greet, reason: "a greeting" }), greeting.id);
    expect(result).toMatchObject({ selected: [ada.id], decidedBy: ALONE });
    expect(result.runs).toHaveLength(1);
    expect(result.reacted).toBeUndefined();
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, greeting.id));
    // No "follow-up" marker: the agent may pass.
    expect(decision).toMatchObject({ strategy: "rule:alone", reason: "alone; best; fixed: a greeting" });
    expect(decidedByOf("rule:alone", null)).toEqual(ALONE);
  });

  test("a thanks the step heard gets a reaction, not a run", async () => {
    await team();
    const thanks = await post("valeu");
    const thanked = scored({}, { needsAgent: 0.05, social: { react: true, emoji: "🙏" } });
    expect(await route(thanked, thanks.id)).toMatchObject({ selected: [], runs: [] });
  });

  test("with another person here, a greeting still wakes nobody", async () => {
    await team();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    const greeting = await post("bom dia!");
    expect(await route(scored({ ada: 0.3 }, greet), greeting.id)).toMatchObject({ selected: [], runs: [] });
  });

  test("the hour's default picks cap it", async () => {
    const { ada } = await team();
    for (let i = 0; i < DEFAULT_PICKS_PER_HOUR; i++) {
      const greeting = await post(`bom dia ${i}`);
      expect((await route(scored({ ada: 0.3 }, greet), greeting.id)).selected).toEqual([ada.id]);
    }
    const more = await post("bom dia de novo");
    expect(await route(scored({ ada: 0.3 }, greet), more.id)).toMatchObject({ selected: [], runs: [] });
  });

  test("never on an agent's greeting, a reply in another person's thread, or a greeting to a person", async () => {
    const { ada } = await team();
    const nobody = { selected: [], runs: [] };
    const agentSaid = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: ada.id, runId: null, hop: 1, stretchId: null },
      body: "Bom dia!",
    });
    expect((await route(scored({ theo: 0.3 }, greet), agentSaid.id)).selected ?? []).toEqual([]);
    // Bia wrote the thread's first message and left the channel since.
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const hers = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: bia.id },
      body: "deploy de hoje às 18h",
    });
    const inHers = await post("bom dia!", hers.id);
    expect(await route(scored({ ada: 0.3 }, greet), inHers.id)).toMatchObject(nobody);
    const toBia = await post("bom dia bia");
    expect(await route(scored({ ada: 0.3 }, greet), toBia.id)).toMatchObject(nobody);
  });

  test("never an agent the person can't talk to, however well it scores", async () => {
    const { theo, ada } = await team();
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: null, audienceMode: "owner" })
      .where(eq(schema.agents.id, ada.id));
    const greeting = await post("bom dia!");
    const result = await route(scored({ ada: 0.9, theo: 0.3 }, greet), greeting.id);
    expect(result).toMatchObject({ selected: [theo.id], decidedBy: ALONE });
  });

  test("when no step can read it, the best placed agent answers, in a run it may pass on", async () => {
    await team();
    const failing: RouterStrategy = { name: "boom", decide: async () => Promise.reject(new Error("down")) };
    const asked = await post("alguém viu o relatório?");
    // Nobody scored: the oldest agent here.
    expect(await route(failing, asked.id)).toMatchObject({ selected: [f.agent.id], decidedBy: DEFAULT });
  });
});

describe("a question to each agent, then one fact they share", () => {
  for (const [lang, each, shared] of [
    ["pt-BR", "como tá o limite de uso de vocês?", "quanto de cpu e ram nossa máquina tá usando agora?"],
    ["en", "how are your usage limits looking, all of you?", "how much cpu and ram is our machine using right now?"],
  ] as const) {
    test(`both answer the first; one answers the second, while both are still at work (${lang})`, async () => {
      f = await setup();
      const theo = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name: "Theo", handle: "theo" },
        { model: "claude-sonnet-5-5" },
      );
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
      const deps = (scores: Record<string, number>, forEveryone: number) => ({
        db: f.db,
        strategy: fixedStrategy(scores, forEveryone).strategy,
        policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 },
      });
      const first = await post(each);
      const both = await routeMessage(deps({ dev: 0.9, theo: 0.9 }, 0.9), { orgId: f.org.id, messageId: first.id });
      expect([...(both.selected ?? [])].sort()).toEqual([f.agent.id, theo.id].sort());

      const second = await post(shared);
      const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, second.id));
      // Neither run in progress takes it on its own: the router decides who it is for.
      expect(stored?.meta.steeredRunIds).toBeUndefined();
      const one = await routeMessage(deps({ dev: 0.8, theo: 0.7 }, 0.1), { orgId: f.org.id, messageId: second.id });
      expect(one.selected).toEqual([f.agent.id]);
      const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, theo.id));
      expect(runs.flatMap((r) => r.pendingMessageIds)).not.toContain(second.id);
    });
  }
});
