import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  CONTINUE_THE_CONVERSATION,
  createAgent,
  createAskUserToolSource,
  HOW_YOU_WORK,
  insertMessage,
  openAgentDm,
  postPersonMessage,
  WHY_AN_AGENT_CALLED,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * What agents read so a person's question gets one answer, asked once: an approval asked with the action itself, no
 * "already answered", no relaying or public corrections between agents, numbers computed and kept in their units, a
 * chart and a linked message where they help.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function channelRun(body = "@dev quantos pedidos entraram hoje?") {
  const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  if (!run) throw new Error("no run");
  return run;
}

test("an approval is asked with the action itself: its card is the question, never a text before it", async () => {
  expect(HOW_YOU_WORK).toContain("is asked with the action itself: write what and why, then call its tool");
  expect(HOW_YOU_WORK).toContain("a yes in the chat approves nothing, and they would be asked twice");
  expect(HOW_YOU_WORK).not.toContain("don't call its tool or `ask_user` for it");
  const [askUser] = await createAskUserToolSource().tools({} as never);
  expect(askUser?.description).toContain("Never to approve an action whose own card asks: call it.");
  expect(askUser?.description).not.toContain("a sensitive or irreversible action is next");
});

test("a question gets its answer directly, never 'already answered', with the earlier message linked", () => {
  expect(CONTINUE_THE_CONVERSATION).toContain("A question asked of you gets its answer, even one an earlier message");
  expect(CONTINUE_THE_CONVERSATION).toContain("never with 'already answered' or 'as I said'");
  expect(CONTINUE_THE_CONVERSATION).toContain("link that message without implying they missed it");
});

test("numbers are computed with code, kept in their source's units and currency, and the whole source is read", () => {
  expect(HOW_YOU_WORK).toContain("Compute ratios, totals and comparisons with code, never in your head");
  expect(HOW_YOU_WORK).toContain("unit and currency as its source has it, also when you relay it");
  expect(HOW_YOU_WORK).toContain("read the whole source before saying something isn't there");
});

test("with tools: a chart without being asked, earlier messages linked, questions on a card", async () => {
  f = await setup();
  const run = await channelRun();
  const text = systemText(
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable: true, askUser: true })).system,
  );
  expect(text).toContain("Numbers you compare (categories, periods, a trend, a ranking, parts of a whole) get a chart");
  expect(text).toContain("To a message, also one you only mention ('in my report this morning'), paste its link");
  expect(text).toContain("what you need answered before going on goes on that card, not in your text");
  expect(text).toContain("Never for an approval an action's card asks");
  expect(text).toContain("Mention another agent with @handle only to ask it to act; to credit or cite it, write its");
});

const qaAgent = () =>
  createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, { model: "claude-sonnet-5-5" });

test("an ok, a thanks or an 'I'll wait' gets at most a reaction; a question card's question is never in the text too", async () => {
  expect(HOW_YOU_WORK).toContain("A thanks or an ok asks nothing, nor an 'I'll wait': at most a reaction, no text");
  const [askUser] = await createAskUserToolSource().tools({} as never);
  expect(askUser?.description).toContain("The card shows the question, its choices and your `why`: never write any");
  f = await setup();
  const run = await channelRun();
  const options = { maxMessages: 10, toolsAvailable: true, askUser: true, react: true };
  const text = systemText((await buildRunContext(f.db, run, f.agent, options)).system);
  expect(text).toContain(
    '"ok, go ahead", "I\'ll wait"; in Portuguese "valeu", "perfeito", "ok, pode seguir", "aguardo"',
  );
  expect(text).toContain("Never react and also reply, not even to say what you'll do next");
  expect(text).toContain("Never for an approval an action's card asks, and never the question in your text too.");
});

test("with other agents in the channel: ask them with ask_agent, never restate, correct in private", async () => {
  f = await setup();
  const qa = await qaAgent();
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
  const run = await channelRun();
  const context = await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable: true });
  const text = systemText(context.system);
  expect(text).toContain("Ask another agent with ask_agent and hand it work with tell_agent, not with an @mention");
  expect(text).toContain("Never restate or confirm another agent's answer to the person: add only what is new");
  expect(text).toContain("tell an agent whose answer is wrong privately (tell_agent), not here");
  expect(text).not.toContain("never to thank or confirm");
});

test("a consulted agent answers the agent that asked, never the people too; a woken one never restates", async () => {
  f = await setup();
  const qa = await qaAgent();
  const asking = await channelRun();
  const dm = await openAgentDm(f.db, f.org.id, f.agent.id, qa.id);
  const question = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: f.agent.id, runId: asking.id, hop: 1 },
    body: "Quantos pedidos entraram hoje?",
  });
  const [consulted] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: qa.id,
      channelId: dm.id,
      threadRootId: question.id,
      triggerMessageId: question.id,
      trigger: "dm",
      hop: 2,
    })
    .returning();
  if (!consulted) throw new Error("no run");
  const text = systemText((await buildRunContext(f.db, consulted, qa, { maxMessages: 10 })).system);
  expect(text).toContain("Never also answer the people yourself where they asked.");
  expect(WHY_AN_AGENT_CALLED).toContain("never answer it again, restate its answer, confirm it or nitpick it here");
  expect(WHY_AN_AGENT_CALLED).toContain("tell that agent privately with tell_agent and pass");
});
