import { afterEach, expect, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { and, asc, eq, schema } from "@agenteschat/db";
import { ProviderError, systemText } from "@agenteschat/providers";
import { drainOutbox, listMessages, type OutboxJob, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });

test("vertical slice: @mention → outbox → run → streamed reply → persisted message + usage", async () => {
  f = await setup({
    reply: () => ({ chunks: ["Sure, ", "I'll check ", "the build."], usage: { inputTokens: 500, outputTokens: 30 } }),
  });
  const events: RealtimeEvent[] = f.listen(f.general.id);

  // 1. A person posts a message mentioning the agent. Message and outbox event are one transaction.
  const question = await post(f, "@dev can you look at the failing build?");
  // …and, in the same statement, the mentioned agent's run and its job.
  expect((await f.db.select().from(schema.outbox)).map((j) => [j.kind, j.status]).sort()).toEqual([
    ["agent_run.execute", "pending"],
    ["message.posted", "pending"],
    ["search.index", "pending"],
  ]);

  // 2–7. Workers claim the event, create the run, build context, call the gateway, stream, persist.
  await drainOutbox(f.db, f.handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run).toMatchObject({
    status: "done",
    agentId: f.agent.id,
    triggerMessageId: question.id,
    threadRootId: question.id,
    hop: 1,
  });

  // The model saw org context, agent instructions and the conversation.
  const request = f.provider.calls[0]?.request;
  expect(systemText(request?.system ?? "")).toContain("Acme builds rockets.");
  expect(systemText(request?.system ?? "")).toContain("Answer briefly.");
  expect(request?.messages.at(-1)).toEqual({ role: "user", content: "[ana]: @dev can you look at the failing build?" });

  // Events went out through PubSub to channel subscribers, in order, then the final message.
  // Ordering: the message is out first, "thinking" is shown before any routing or model work,
  // then the claim, typing on the first text (none of its words: the reply shows them whole), the reply, and the
  // finish + receipt.
  expect(events.map((e) => e.type)).toEqual([
    "message.created",
    "message.routed", // at post time: the run was created with the message
    "agent.thinking", // run created
    "agent.thinking", // run claimed
    "message.claimed",
    "agent.run",
    "agent.typing",
    "message.created",
    "agent.run",
    "agent.idle",
    "run.finished",
    "message.handled",
  ]);
  expect(events[1]).toMatchObject({
    messageId: question.id,
    seenBy: [f.agent.id],
    pickedBy: [f.agent.id],
    strategy: "mention",
  });
  // Asked in the channel: the run's events and reply are in the main timeline.
  expect(events[2]).toMatchObject({ agentId: f.agent.id, runId: run?.id, threadId: null });
  expect(events.at(-1)).toMatchObject({ type: "message.handled", messageId: question.id, status: "done" });
  expect([...events].reverse().find((e) => e.type === "agent.run")).toMatchObject({ status: "done", runId: run?.id });

  // The reply is persisted in the main timeline, under the question, authored by the agent.
  const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(main.map((m) => [m.author.type, m.body, m.threadId])).toEqual([
    ["person", "@dev can you look at the failing build?", null],
    ["agent", "Sure, I'll check the build.", null],
  ]);
  expect(main[1]?.agentRunId).toBe(run?.id ?? "");
  expect(run?.replyMessageId).toBe(main[1]?.id ?? "");

  // Usage is recorded with org and agent, linked to the run.
  const usage = await f.db.select().from(schema.usageRecords);
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id,
    inputTokens: 500,
    outputTokens: 30,
  });

  // Steps trail, and every outbox row is done.
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""))
    .orderBy(asc(schema.agentRunSteps.seq));
  // The second `context` is how the turn ended (`decideTurnEnd`, ADR 0097).
  expect(steps.map((s) => s.kind)).toEqual(["context", "model_call", "context", "message"]);
  expect(
    (await f.db.select().from(schema.outbox))
      // The thread's assessment is due minutes later (threads.assess).
      .filter((j) => j.kind !== "threads.assess")
      .every((j) => j.status === "done"),
  ).toBe(true);
});

test("transient provider failures retry the job; the run completes on a later attempt", async () => {
  f = await setup({ reply: (_req, n) => (n === 1 ? new ProviderError("overloaded", true, 529) : { chunks: ["ok"] }) });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("running"); // waiting for the retry's backoff

  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect([job?.status, job?.attempts]).toEqual(["pending", 1]);
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(1);
});

/** What the outbox's `onError` hears about the run's job (`attempt outcome: message`), over `rounds` drains. */
async function toldAboutRun(fx: Fixture, rounds = 1) {
  const told: string[] = [];
  const onError = (job: OutboxJob, error: unknown, outcome: "retry" | "failed") => {
    if (job.kind === "agent_run.execute") told.push(`${job.attempts} ${outcome}: ${(error as Error).message}`);
  };
  for (let i = 0; i < rounds; i++) {
    await drainOutbox(fx.db, fx.handlers, { onError });
    // A retry's backoff, over at once.
    await fx.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  }
  return told;
}

test("a run that keeps failing on a provider outage parks on its last attempt, never told as a failed job", async () => {
  f = await setup({ reply: () => new ProviderError("overloaded", true, 529) });
  await post(f, "@dev hi");
  const told = await toldAboutRun(f, 5);
  const [run] = await f.db.select().from(schema.agentRuns);
  // The last attempt parks the run on the outage ladder (it answers once the provider is back): no failure to report.
  // Woken and refused again, it parks at once: one try per wake.
  expect([run?.status, run?.error]).toEqual(["waiting_input", null]);
  expect(told.slice(0, 3)).toEqual(["1 retry: overloaded", "2 retry: overloaded", "3 retry: overloaded"]);
  expect(told.filter((line) => line.includes("failed"))).toEqual([]);
});

test("a request the provider rejects fails the run and is told as a failed job", async () => {
  f = await setup({ reply: () => new ProviderError("provider rejected the request (400)", false, 400) });
  await post(f, "@dev hi");
  expect(await toldAboutRun(f)).toEqual(["1 failed: provider rejected the request (400)"]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual([
    "failed",
    "provider_error: said@Claude: provider rejected the request (400)",
  ]);
});

test("the account's own refusal (an invalid key) fails the run untold: the person sees why", async () => {
  f = await setup({ reply: () => new ProviderError("invalid provider API key", false, 401) });
  await post(f, "@dev hi");
  expect(await toldAboutRun(f)).toEqual([]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["failed", "provider_error: invalid_key@Claude: invalid provider API key"]);
});

test("a refused request fails the run with the provider's words, credentials masked, on the run and its error step", async () => {
  f = await setup({
    reply: () =>
      new ProviderError(
        "provider rejected the request (400 invalid_request_error): key sk-ant-test-key-in-the-error is not allowed",
        false,
        400,
      ),
  });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  const reason =
    "provider_error: said@Claude: provider rejected the request (400 invalid_request_error): key •••• is not allowed";
  expect([run?.status, run?.error]).toEqual(["failed", reason]);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "error"));
  expect(steps.map((s) => s.data)).toEqual([{ reason }]);
});

test("thinking a call went without is on its model_call step, the refusal's credentials masked", async () => {
  f = await setup({
    reply: () => ({
      chunks: ["ok"],
      thinking: {
        refused:
          "provider rejected the request (400 invalid_request_error): key sk-ant-test-key-in-the-error is not allowed",
      },
    }),
  });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "model_call"));
  expect(steps.map((s) => s.data.thinking)).toEqual([
    { refused: "provider rejected the request (400 invalid_request_error): key •••• is not allowed" },
  ]);
});

test("an agent over budget waits for its budget without calling the model", async () => {
  f = await setup({ budgetNanoUsd: 0 });
  const events = f.listen(f.general.id);
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["waiting_input", null]);
  expect(f.provider.calls).toHaveLength(0);
  expect([...events].reverse().find((e) => e.type === "agent.run")).toMatchObject({ status: "waiting_input" });
  // The job itself succeeded; only the resume at the next month waits.
  const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind !== "threads.assess");
  expect(jobs.filter((j) => j.status !== "done").map((j) => j.kind)).toEqual(["agent_run.execute"]);
});

test("a model refusal fails the run but still records usage", async () => {
  f = await setup({
    reply: () => ({ chunks: [], stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 0 } }),
  });
  await post(f, "@dev hi");
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["failed", "model_refused"]);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(1);
});
