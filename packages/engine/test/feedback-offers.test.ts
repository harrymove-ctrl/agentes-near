import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type AgentRun,
  absorbToolData,
  addChannelMember,
  createFeedbackToolSource,
  decideFeedbackOffer,
  FEEDBACK_JOB,
  FEEDBACK_OFFER_EVERY_MS,
  FEEDBACK_PER_HOUR,
  type Feedback,
  type FeedbackOfferView,
  feedbackOfferOf,
  getMessage,
  insertMessage,
  isUnexpectedError,
  NotFoundError,
  type PendingFeedbackOffer,
  pendingFeedbackOfferOf,
  postPersonMessage,
  renderFeedback,
  saveChatPrefs,
  type ToolContext,
  type ToolSideEffects,
  toolKind,
  toolPolicy,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * ADR 0160 §12: `offer_feedback` sends nothing by itself. The report rides on the agent's reply as a row the person
 * it is for sends or puts away, once; one a day in a conversation; "Always send" makes it go with the reply.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const TO = "feedback@example.com";
const INPUT = {
  summary: "  the browser closed while\nopening a page ",
  text: "The agent's browser closed twice while opening a page.",
};

const limiter = () => {
  const used = new Map<string, number>();
  return {
    used,
    async consume(key: string, rule: { limit: number; windowMs: number }) {
      const count = (used.get(key) ?? 0) + 1;
      used.set(key, count);
      return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count), resetAt: new Date(0) };
    },
  };
};

const source = (over: Partial<Parameters<typeof createFeedbackToolSource>[0]> = {}) =>
  createFeedbackToolSource({ to: TO, version: "1.2.3", ...over });

const offerTool = async (from = source()) => {
  const tool = (await from.tools({} as ToolContext)).find((t) => t.name === "offer_feedback");
  if (!tool) throw new Error("no tool");
  return tool;
};

const ctxOf = (run: AgentRun) =>
  ({
    db: f.db,
    orgId: f.org.id,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    toolUseId: "call-1",
  }) as ToolContext;

const queued = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FEEDBACK_JOB))).map(
    (job) => job.payload.feedback as Feedback,
  );

/** Bia, a member, writes to the agent in the channel; the run her message started. */
async function askedByBia() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev open the pricing page and tell me the cheapest plan",
  });
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.triggerMessageId, message.id), eq(schema.agentRuns.agentId, f.agent.id)));
  if (!run) throw new Error("no run");
  return { bia, run };
}

/** The agent's reply carrying `offer`, as the executor posts it. */
const replyWith = (run: AgentRun, offer: FeedbackOfferView, createdAt?: Date) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: 0 },
    body: "I couldn't open the page.",
    meta: { feedbackOffer: offer },
    ...(createdAt ? { createdAt } : {}),
  });

const pendingOf = (data: Record<string, unknown> | undefined) => {
  const pending = pendingFeedbackOfferOf(data?.feedbackOffer);
  if (!pending) throw new Error("no offer");
  return pending;
};

test("it speaks in the run's own conversation, asks no approval and sends nothing", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await offerTool();
  expect(tool.sensitive).toBeUndefined();
  expect(toolKind(tool)).toEqual({ kind: "here" });
  const out = await tool.execute(INPUT, ctxOf(run));
  expect(out.isError).toBeUndefined();
  const { view, send } = pendingOf(out.data);
  expect(send).toBeUndefined();
  expect(view).toMatchObject({
    forUserId: bia.id,
    summary: "the browser closed while opening a page",
    text: INPUT.text,
    state: "offered",
  });
  expect(await queued()).toEqual([]);
});

test("the offer waits on the run for its next reply", () => {
  const effects: ToolSideEffects = {};
  const pending: PendingFeedbackOffer = {
    view: { id: "o1", forUserId: "u1", summary: "s", text: "t", state: "offered" },
  };
  absorbToolData(effects, { feedbackOffer: pending });
  expect(effects.feedbackOffer).toEqual(pending);
  absorbToolData(effects, { feedbackOffer: { view: { id: "broken" } } });
  expect(effects.feedbackOffer).toEqual(pending);
});

test("nobody behind the run, a routine, or a server that takes no feedback: nothing offered", async () => {
  f = await setup();
  const { run } = await askedByBia();
  const tool = await offerTool();
  const nobody = { ...ctxOf(run), runId: "", triggerMessageId: "" } as ToolContext;
  expect((await tool.execute(INPUT, nobody)).isError).toBe(true);
  expect(toolPolicy({ kind: "routine", personId: null, brief: null }, tool).action).not.toBe("approve");
  expect(await source({ to: undefined }).tools({} as ToolContext)).toEqual([]);
});

test("one a day in a conversation, and none for a week after the person turned one down", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await offerTool();
  const offer: FeedbackOfferView = {
    id: crypto.randomUUID(),
    forUserId: bia.id,
    summary: "s",
    text: "t",
    state: "sent",
  };
  await replyWith(run, offer, new Date(Date.now() - FEEDBACK_OFFER_EVERY_MS - 60_000));
  // Yesterday's, sent: today's goes.
  expect((await tool.execute(INPUT, ctxOf(run))).isError).toBeUndefined();
  // Today's is on a reply: a second one is refused.
  await replyWith(run, { ...offer, id: crypto.randomUUID(), state: "offered" });
  expect((await tool.execute(INPUT, ctxOf(run))).content).toContain("already offered in this conversation today");
});

test("a report the person turned down keeps the agent quiet there", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await offerTool();
  await replyWith(
    run,
    { id: crypto.randomUUID(), forUserId: bia.id, summary: "s", text: "t", state: "dismissed" },
    new Date(Date.now() - 3 * FEEDBACK_OFFER_EVERY_MS),
  );
  const out = await tool.execute(INPUT, ctxOf(run));
  expect(out.isError).toBe(true);
  expect(out.content).toContain("turned down");
});

test("the person sends it: one email in their name with the agent's text, the row says so", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const { view } = pendingOf((await (await offerTool()).execute(INPUT, ctxOf(run))).data);
  const message = await replyWith(run, view);
  const events = f.listen(run.channelId);
  const deps = { db: f.db, pubsub: f.pubsub, to: TO, version: "1.2.3" };
  const sent = await decideFeedbackOffer(deps, {
    orgId: f.org.id,
    messageId: message.id,
    userId: bia.id,
    decision: "send",
  });
  expect(sent.state).toBe("sent");
  // Decided again (another device): how it stands, and nothing more goes.
  const again = await decideFeedbackOffer(deps, {
    orgId: f.org.id,
    messageId: message.id,
    userId: bia.id,
    decision: "dismiss",
  });
  expect(again.state).toBe("sent");
  const [mail, ...more] = await queued();
  expect(more).toEqual([]);
  expect(mail).toMatchObject({ to: TO, name: "bia", email: bia.email, text: INPUT.text, app: "agent" });
  expect(renderFeedback(mail as Feedback).text).toContain(
    "Written by: Dev (@dev), an agent, on its own; they read it and sent it",
  );
  expect(feedbackOfferOf((await getMessage(f.db, f.org.id, message.id))?.meta)?.state).toBe("sent");
  expect(events.filter((e) => e.type === "feedback_offer.updated")).toHaveLength(1);
});

test("only the person it is for decides it, and putting it away sends nothing", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const { view } = pendingOf((await (await offerTool()).execute(INPUT, ctxOf(run))).data);
  const message = await replyWith(run, view);
  const deps = { db: f.db, pubsub: f.pubsub, to: TO, version: "1.2.3" };
  const decide = (userId: string, decision: "send" | "dismiss", messageId = message.id) =>
    decideFeedbackOffer(deps, { orgId: f.org.id, messageId, userId, decision });
  // Not even the workspace's owner sends it in her name.
  await expect(decide(f.owner.id, "send")).rejects.toThrow("someone else's");
  await expect(decide(bia.id, "send", crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  expect((await decide(bia.id, "dismiss")).state).toBe("dismissed");
  expect(await queued()).toEqual([]);
});

test("sending counts toward the person's hour, the form's own", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const { view } = pendingOf((await (await offerTool()).execute(INPUT, ctxOf(run))).data);
  const message = await replyWith(run, view);
  const rateLimiter = limiter();
  rateLimiter.used.set(`feedback:${bia.id}`, FEEDBACK_PER_HOUR.limit);
  await expect(
    decideFeedbackOffer(
      { db: f.db, pubsub: f.pubsub, to: TO, version: "1.2.3", rateLimiter },
      { orgId: f.org.id, messageId: message.id, userId: bia.id, decision: "send" },
    ),
  ).rejects.toThrow("Too much feedback");
  expect(feedbackOfferOf((await getMessage(f.db, f.org.id, message.id))?.meta)?.state).toBe("offered");
  expect(await queued()).toEqual([]);
});

test("Always send: the report goes with the reply, within the person's hour", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  await saveChatPrefs(f.db, f.org.id, bia.id, { feedbackAuto: true });
  const rateLimiter = limiter();
  const tool = await offerTool(source({ rateLimiter }));
  const { view, send } = pendingOf((await tool.execute(INPUT, ctxOf(run))).data);
  expect(view).toMatchObject({ state: "sent", auto: true });
  expect(send).toMatchObject({ to: TO, email: bia.email, text: INPUT.text });
  expect(renderFeedback(send as Feedback).text).toContain("they chose to always send these");
  // The tool queues nothing itself: the email goes with the message that says it went.
  expect(await queued()).toEqual([]);
  // Past the hour's ten, it asks again.
  rateLimiter.used.set(`feedback:${bia.id}`, FEEDBACK_PER_HOUR.limit);
  const asked = pendingOf((await tool.execute(INPUT, ctxOf(run))).data);
  expect(asked.view.state).toBe("offered");
  expect(asked.send).toBeUndefined();
});

test("only an error nobody wrote for the model reads as the app's own fault", () => {
  expect(isUnexpectedError(new TypeError("x is not a function"))).toBe(true);
  expect(isUnexpectedError("boom")).toBe(true);
  expect(isUnexpectedError(new Error("No issue with that number"))).toBe(false);
  expect(isUnexpectedError(new NotFoundError("Not found"))).toBe(false);
});
