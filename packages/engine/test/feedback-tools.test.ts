import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type AgentRun,
  addChannelMember,
  createFeedbackToolSource,
  FEEDBACK_JOB,
  FEEDBACK_PER_HOUR,
  type Feedback,
  postPersonMessage,
  renderFeedback,
  type ToolContext,
  toolPolicy,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * ADR 0160 §11: `send_feedback` queues the form's email in the name of the person who asked the agent, says which
 * agent wrote it, and sends none where the server takes no feedback or nobody is behind the run.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const TO = "feedback@example.com";

/** A limiter that counts per key, as the server's does within one window. */
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

const toolOf = async (from = source()) => {
  const [tool] = await from.tools({} as ToolContext);
  if (!tool) throw new Error("no tool");
  return tool;
};

const runOf = async (triggerMessageId: string): Promise<AgentRun> => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.triggerMessageId, triggerMessageId), eq(schema.agentRuns.agentId, f.agent.id)));
  if (!run) throw new Error("no run");
  return run;
};

const ctxOf = (run: AgentRun, toolUseId = "call-1") =>
  ({
    db: f.db,
    orgId: f.org.id,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    toolUseId,
  }) as ToolContext;

const queued = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FEEDBACK_JOB))).map(
    (job) => job.payload.feedback as Feedback,
  );

/** Bia, a member, asks the agent in the channel; the run her message started. */
async function askedByBia() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev manda um feedback: o céu fica escuro demais à noite",
  });
  return { bia, run: await runOf(message.id) };
}

test("listed only where the server takes feedback", async () => {
  expect(await source({ to: undefined }).tools({} as ToolContext)).toEqual([]);
  expect((await source().tools({} as ToolContext)).map((t) => t.name)).toEqual(["send_feedback", "offer_feedback"]);
});

test("a person asks: one email queued in their name, saying which agent wrote it", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await toolOf();
  const out = await tool.execute({ text: "  The sky is too dark at night.  " }, ctxOf(run));
  expect(out.isError).toBeUndefined();
  // The same call run again goes once.
  await tool.execute({ text: "The sky is too dark at night." }, ctxOf(run));
  const [sent, ...more] = await queued();
  expect(more).toEqual([]);
  expect(sent).toMatchObject({
    to: TO,
    name: "bia",
    email: bia.email,
    orgName: "Acme",
    text: "The sky is too dark at night.",
    app: "agent",
    version: "1.2.3",
  });
  const mail = renderFeedback(sent as Feedback);
  expect(mail.subject).toBe("Feedback from bia");
  expect(mail.text).toContain("Written by: Dev (@dev), an agent, when they asked");
  expect(mail.text).toContain("Workspace: Acme");
});

test("it counts toward the person's hour, the form's own", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const rateLimiter = limiter();
  rateLimiter.used.set(`feedback:${bia.id}`, FEEDBACK_PER_HOUR.limit);
  const out = await (await toolOf(source({ rateLimiter }))).execute({ text: "One more." }, ctxOf(run));
  expect(out.isError).toBe(true);
  expect(await queued()).toEqual([]);
});

test("nobody behind the call, or a person who left: nothing sent", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await toolOf();
  const nobody = { ...ctxOf(run), runId: "", triggerMessageId: "" } as ToolContext;
  expect((await tool.execute({ text: "By itself." }, nobody)).isError).toBe(true);
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bia.id)));
  expect((await tool.execute({ text: "After leaving." }, ctxOf(run))).isError).toBe(true);
  expect(await queued()).toEqual([]);
});

test("a routine's run never sends feedback", async () => {
  const tool = await toolOf();
  expect(toolPolicy({ kind: "routine", personId: null, brief: null }, tool).action).toBe("refuse");
});

test("each call asks the person it speaks for, and only them, showing the text", async () => {
  f = await setup();
  const { bia, run } = await askedByBia();
  const tool = await toolOf();
  expect(tool.sensitive).toBe(true);
  expect(tool.describe?.({ text: " Too dark. " }).detail).toBe("Too dark.");
  const asked = await tool.approvers?.({ text: "Too dark." }, ctxOf(run), bia.id);
  expect(asked).toMatchObject({ ok: true, approvers: { userIds: [bia.id], required: true, requestedBy: null } });
  const nobody = { ...ctxOf(run), runId: "", triggerMessageId: "" } as ToolContext;
  expect((await tool.approvers?.({ text: "By itself." }, nobody, null))?.ok).toBe(false);
});
