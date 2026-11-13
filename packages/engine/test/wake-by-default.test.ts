import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  createAgent,
  createAgentRuns,
  createFakeJudge,
  createPassToolSource,
  drainOutbox,
  insertMessage,
  type JudgeQuestion,
  mentionNeedsNothing,
  openDm,
  postPersonMessage,
  runAuthority,
  type ToolContext,
  WHY_AN_AGENT_CALLED,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * An agent's @mention wakes the agent it names only when the judge reads a plain request to it (ADR 0089, addendum
 * 2026-11-10), never an agent its run already asked, an agent woken for nothing passes, and a mention of an agent that
 * isn't in the conversation is told to its author. Fake judges answer how sure they are that a message leaves the
 * agent nothing to do; the fake model keys on whose prompt it is and what it may do.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const messageText = (state: Record<string, unknown>) => String((state.message as { text?: string })?.text ?? "");
const isFor = (req: ModelRequest, name: string, handle: string) =>
  systemText(req.system).includes(`You are ${name} (@${handle})`);
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content ?? "");
const toolNames = (req: ModelRequest) => req.tools?.map((t) => t.name) ?? [];
const pass = { chunks: [], toolUses: [{ name: "pass", input: { reason: "nada para mim" } }] };

async function agent(name: string, handle: string, options: { inGeneral: boolean }) {
  const created = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Revisão", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  if (options.inGeneral)
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: created.id });
  return created;
}

const ask = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const runsOf = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));

describe("the judge is asked what must not wake", () => {
  test("credit, a source, what it was asked, a thanks or a plan to ask later need nothing", async () => {
    const judge = createFakeJudge(() => 0.5);
    await mentionNeedsNothing(judge, {
      orgId: "o",
      body: "@qa, o resumo é esse.",
      author: "@dev",
      targets: [{ agentId: "a-qa", handle: "qa", name: "QA", role: null }],
    });
    const [call] = judge.calls;
    expect(call?.kind).toBe("mention_needs_nothing");
    const q = call?.questions.nothing_0 as Extract<JudgeQuestion, { type: "noul" }>;
    for (const nothing of [
      "'via @agent'",
      "'the numbers are from @agent'",
      "'I asked @agent'",
      "corrects it",
      "thanks",
      "'as @agent said'",
      "'I'll ask @agent to review it'",
    ])
      expect(q.criteria.true).toContain(nothing);
    for (const needs of ["plainly asks the agent itself", "a question addressed to it", "the handover"])
      expect(q.criteria.false).toContain(needs);
  });
});

describe("an agent's @mention wakes the other agent only when it plainly asks it something", () => {
  test("a request and a handover wake it; credit, a source, a correction or an unsure judge don't", async () => {
    // How sure the judge is that each message leaves QA nothing to do: QA wakes only at 0.4 or less.
    const cases = [
      { body: "@qa, revisa o PR #12 por favor.", nothing: 0.05 },
      { body: "@qa, aqui está o documento completo da passagem: a partir de agora é com você.", nothing: 0.3 },
      { body: "Os números são do painel de vendas, via @qa.", nothing: 0.9 },
      { body: "Perguntei ao @qa e ele confirmou.", nothing: 0.85 },
      { body: "Ana, o PR #12 está aberto. Vou pedir para o @qa revisar antes de chegar até você.", nothing: 0.75 },
      { body: "O @qa está certo, refiz a conta.", nothing: 0.5 },
      { body: "Valeu, @qa!", nothing: 0.95 },
      { body: "Como o @qa disse, o timeout está no frete.", nothing: 0.88 },
    ];
    f = await setup({
      judge: (kind, _id, state) =>
        kind === "mention_needs_nothing" ? cases.find((c) => c.body === messageText(state))?.nothing : undefined,
      reply: () => ({ chunks: ["Feito."] }),
    });
    const qa = await agent("QA", "qa", { inGeneral: true });
    await ask("@dev cuida da revisão com o QA");
    const [devRun] = await runsOf();
    if (!devRun) throw new Error("no run");
    const written: { id: string }[] = [];
    for (const c of cases)
      written.push(
        await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: f.general.id,
          author: { type: "agent", agentId: f.agent.id, runId: devRun.id, hop: 1 },
          body: c.body,
        }),
      );
    await drainOutbox(f.db, f.handlers);

    const woken = (await runsOf()).filter((r) => r.agentId === qa.id).map((r) => r.triggerMessageId);
    expect(written.map((m) => woken.includes(m.id))).toEqual([true, true, false, false, false, false, false, false]);
    const decisions = await f.db.select().from(schema.routingDecisions);
    const handover = decisions.find((d) => d.messageId === written[1]?.id);
    expect(handover).toMatchObject({ strategy: "mention-fake", selectedAgentIds: [qa.id] });
    // The score kept is how likely the message asks the agent: 1 − the judge's "nothing".
    expect(handover?.candidates[0]?.score).toBeCloseTo(0.7);
    const unsure = decisions.find((d) => d.messageId === written[5]?.id);
    expect(unsure).toMatchObject({ selectedAgentIds: [] });
  });

  test("an agent woken for nothing passes: one call, no message, nothing woken after it", async () => {
    f = await setup({
      toolSources: [createPassToolSource()],
      // The judge wrongly reads a request in a plain report.
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.3 : undefined),
      reply: (req) => {
        if (isFor(req, "QA", "qa")) return toolNames(req).includes("pass") ? pass : { chunks: ["Ok, anotado."] };
        return { chunks: ["Subi a v2.3.1 agora há pouco, @qa."] };
      },
    });
    const qa = await agent("QA", "qa", { inGeneral: true });
    await ask("@dev sobe a v2.3.1");
    await drainOutbox(f.db, f.handlers);

    const runs = await runsOf();
    expect(runs.map((r) => [r.agentId === qa.id ? "qa" : "dev", r.hop, r.status])).toEqual([
      ["dev", 1, "done"],
      ["qa", 2, "done"],
    ]);
    const qaCalls = f.provider.calls.map((c) => c.request as ModelRequest).filter((r) => isFor(r, "QA", "qa"));
    expect(qaCalls).toHaveLength(1);
    expect(qaCalls.map((r) => systemText(r.system)).join("")).toContain(WHY_AN_AGENT_CALLED);
    const said = (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId === qa.id);
    expect(said).toEqual([]);
  });

  test("a thanks the judge gets wrong wakes the other agent once, and it passes: no thanks-for-thanks loop", async () => {
    f = await setup({
      toolSources: [createPassToolSource()],
      // Sure "pode revisar?" asks QA; wrong about the thanks back (0.3), so Dev wakes on it.
      judge: (kind, _id, state) =>
        kind === "mention_needs_nothing" ? (messageText(state).includes("pode revisar") ? 0.1 : 0.3) : undefined,
      reply: (req) => {
        const thanked = lastText(req).includes("Valeu");
        if (isFor(req, "QA", "qa"))
          return thanked && toolNames(req).includes("pass")
            ? pass
            : { chunks: ["Revisei o PR #12: está ok. Valeu, @dev!"] };
        if (thanked) return toolNames(req).includes("pass") ? pass : { chunks: ["Valeu você, @qa!"] };
        return { chunks: ["@qa pode revisar o PR #12?"] };
      },
    });
    const qa = await agent("QA", "qa", { inGeneral: true });
    await ask("@dev pede para o QA revisar o PR #12");
    await drainOutbox(f.db, f.handlers, { maxBatches: 200 });

    const runs = await runsOf();
    expect(runs.map((r) => [r.agentId === qa.id ? "qa" : "dev", r.hop, r.status])).toEqual([
      ["dev", 1, "done"],
      ["qa", 2, "done"],
      ["dev", 3, "done"],
    ]);
    const devSaid = (await f.db.select().from(schema.messages))
      .filter((m) => m.authorAgentId === f.agent.id)
      .map((m) => m.body);
    expect(devSaid).toEqual(["@qa pode revisar o PR #12?"]);
  });
  test("a judge that fails wakes only an agent the message opens with: no thanks loop while it is down", async () => {
    f = await setup({
      judge: (kind) => {
        if (kind === "mention_needs_nothing") throw new Error("judge timed out");
        return undefined;
      },
      reply: () => ({ chunks: ["Feito."] }),
    });
    const qa = await agent("QA", "qa", { inGeneral: true });
    await ask("@dev cuida da revisão com o QA");
    const [devRun] = await runsOf();
    if (!devRun) throw new Error("no run");
    const thanks = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: devRun.id, hop: 1 },
      body: "Valeu pela ajuda, @qa!",
    });
    const handOff = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: devRun.id, hop: 1 },
      body: "@qa, revisa o #13 por favor.",
    });
    await drainOutbox(f.db, f.handlers);

    const woken = (await runsOf()).filter((r) => r.agentId === qa.id).map((r) => r.triggerMessageId);
    expect(woken).toEqual([handOff.id]);
    const decisions = await f.db.select().from(schema.routingDecisions);
    const of = (id: string) => decisions.find((d) => d.messageId === id);
    expect(of(thanks.id)?.error).toBe("judge timed out");
    expect(of(thanks.id)?.selectedAgentIds).toEqual([]);
    expect(of(handOff.id)?.selectedAgentIds).toEqual([qa.id]);
  });
  test("an agent the run already asked with ask_agent isn't woken again by its mention here", async () => {
    // The judge reads a plain request: without the consultation, QA would answer the person here too.
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
      reply: () => ({ chunks: ["Feito."] }),
    });
    const qa = await agent("QA", "qa", { inGeneral: true });
    const person = await ask("@dev quantos pedidos entraram hoje?");
    const [devRun] = await runsOf();
    if (!devRun || !f.tools) throw new Error("no run or tools");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: devRun.id,
      channelId: f.general.id,
      threadRootId: person.id,
      triggerMessageId: person.id,
    };
    await f.tools.invoke(ctx, {
      toolUseId: "tu_ask",
      name: "ask_agent",
      input: { agent: "@qa", question: "Quantos pedidos entraram hoje?" },
    });
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: devRun.id, hop: 1 },
      body: "Perguntei ao @qa. @qa, confere os pedidos de hoje?",
    });
    await drainOutbox(f.db, f.handlers);

    const qaRuns = (await runsOf()).filter((r) => r.agentId === qa.id);
    expect(qaRuns.map((r) => r.trigger)).toEqual(["dm"]);
    expect(qaRuns.some((r) => r.channelId === f.general.id)).toBe(false);
  });
});

test("a tell_agent note wakes its recipient at once, for the person behind the sender", async () => {
  f = await setup({ askAgent: true });
  const infra = await agent("Infra", "infra", { inGeneral: false });
  const person = await ask("@dev avisa o infra do deploy");
  const [devRun] = await runsOf();
  if (!devRun || !f.tools) throw new Error("no run or tools");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: devRun.id,
    channelId: f.general.id,
    threadRootId: person.id,
    triggerMessageId: person.id,
  };
  await f.tools.invoke(ctx, {
    toolUseId: "tu_note",
    name: "tell_agent",
    input: { agent: "@infra", message: "Deploy finished; watch the error rate." },
  });
  const [woken] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, infra.id));
  expect(woken).toMatchObject({ trigger: "dm", status: "queued" });
  if (!woken) throw new Error("no run");
  expect(await runAuthority(f.db, woken)).toEqual({ kind: "person", personId: f.owner.id });
});

describe("a mention of an agent that isn't in the conversation is told to its author", () => {
  const asksVera = (req: ModelRequest) =>
    isFor(req, "Dev", "dev") && lastText(req).includes("pede a revisão")
      ? { chunks: ["@vera pode revisar o PR #12?"] }
      : { chunks: ["ok"] };
  const lastContext = () => JSON.stringify((f.provider.calls.at(-1)?.request as ModelRequest | undefined)?.messages);

  test("in its next context, with how to reach it", async () => {
    f = await setup({ reply: asksVera });
    const vera = await agent("Vera", "vera", { inGeneral: false });
    await ask("@dev pede a revisão do PR #12");
    await drainOutbox(f.db, f.handlers);
    const [asked] = (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId === f.agent.id);
    expect(asked?.meta.unreachedAgents).toEqual(["vera"]);
    expect((await runsOf()).filter((r) => r.agentId === vera.id)).toEqual([]);

    await ask("@dev e aí, ela revisou?");
    await drainOutbox(f.db, f.handlers);
    expect(lastContext()).toContain(
      "[Not delivered]: @vera wasn't in this conversation, so your mention didn't reach it. If you meant it to act or answer, use tell_agent or ask_agent, or add it to this conversation with add_agent_to_channel",
    );
  });

  test("only while it is the agent's latest message: a later reply settles it", async () => {
    f = await setup({ reply: asksVera });
    await agent("Vera", "vera", { inGeneral: false });
    await ask("@dev pede a revisão do PR #12");
    await drainOutbox(f.db, f.handlers);
    await ask("@dev e aí, ela revisou?");
    await drainOutbox(f.db, f.handlers);
    await ask("@dev outra coisa: o deploy saiu?");
    await drainOutbox(f.db, f.handlers);
    expect(lastContext()).toContain("@vera pode revisar o PR #12?");
    expect(lastContext()).not.toContain("[Not delivered]");
  });

  test("in a DM, which keeps its participants, only tell_agent and ask_agent", async () => {
    f = await setup({ reply: asksVera });
    await agent("Vera", "vera", { inGeneral: false });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const say = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
    await say("pede a revisão do PR #12");
    await drainOutbox(f.db, f.handlers);
    await say("e aí, ela revisou?");
    await drainOutbox(f.db, f.handlers);
    expect(lastContext()).toContain("If you meant it to act or answer, use tell_agent or ask_agent.");
    expect(lastContext()).not.toContain("add_agent_to_channel");
  });

  test("post_message's result says so", async () => {
    f = await setup({ chatTools: true });
    await agent("Vera", "vera", { inGeneral: false });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const person = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "manda no #general pedindo revisão",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, person, [f.agent.id], "dm"));
    if (!run || !f.tools) throw new Error("no run or tools");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: dm.id,
      threadRootId: person.id,
      triggerMessageId: person.id,
    };
    const result = await f.tools.invoke(ctx, {
      toolUseId: "tu_post",
      name: "post_message",
      input: { channel: "general", text: "@vera pode revisar o PR #12?" },
    });
    expect(result).toMatchObject({
      output: {
        content: expect.stringContaining(
          "@vera wasn't in #general, so your mention didn't reach it. If you meant it to act or answer, use tell_agent or ask_agent, or add it to #general with add_agent_to_channel",
        ),
      },
    });
  });
});

describe("a mention of a person who doesn't read the conversation is told to its author", () => {
  const tellsBruno = (req: ModelRequest) =>
    isFor(req, "Dev", "dev") && lastText(req).includes("avisa o bruno")
      ? { chunks: ["@bruno e @carla, a proposta saiu. @leo, confere?"] }
      : { chunks: ["ok"] };
  const lastContext = () => JSON.stringify((f.provider.calls.at(-1)?.request as ModelRequest | undefined)?.messages);
  /** Bruno and Rita aren't in #general, Leo is, and Carla is an administrator, who hears a mention from any channel. */
  async function people() {
    for (const [role, name] of [
      ["member", "Bruno"],
      ["member", "Leo"],
      ["admin", "Carla"],
      ["member", "Rita Souza"],
    ] as const) {
      const user = await addMember(f.db, f.org.id, role, name);
      await f.db
        .update(schema.organizationMembers)
        .set({ handle: name.split(" ")[0]?.toLowerCase() })
        .where(eq(schema.organizationMembers.userId, user.id));
      if (name === "Leo") await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: user.id });
    }
  }

  test("a reply keeps who it missed and its next context says to use send_dm", async () => {
    f = await setup({ reply: tellsBruno });
    await people();
    await ask("@dev avisa o bruno e a carla que a proposta saiu");
    await drainOutbox(f.db, f.handlers);
    const [told] = (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId === f.agent.id);
    expect(told?.meta.unreachedPeople).toEqual(["bruno"]);
    await ask("@dev e aí?");
    await drainOutbox(f.db, f.handlers);
    expect(lastContext()).toContain(
      "[Not delivered]: @bruno wasn't in this conversation, so your mention didn't notify them. If they should see it, tell them with send_dm.",
    );
  });

  test("post_message's result says so", async () => {
    f = await setup({ chatTools: true });
    await people();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const person = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "avisa no #general",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, person, [f.agent.id], "dm"));
    if (!run || !f.tools) throw new Error("no run or tools");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: dm.id,
      threadRootId: person.id,
      triggerMessageId: person.id,
    };
    const result = await f.tools.invoke(ctx, {
      toolUseId: "tu_post",
      name: "post_message",
      input: { channel: "general", text: "@bruno e @carla, a proposta saiu. @leo, confere? @Rita Souza também." },
    });
    expect(result).toMatchObject({
      output: {
        content: expect.stringContaining(
          "@bruno, @rita weren't in #general, so your mention didn't notify them. If they should see it, tell them with send_dm.",
        ),
      },
    });
    expect(JSON.stringify(result)).not.toContain("@carla wasn't");
    expect(JSON.stringify(result)).not.toContain("@leo wasn't");
  });
});
