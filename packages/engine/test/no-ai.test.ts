import { afterEach, expect, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import {
  addChannelMember,
  addRunStep,
  answerNow,
  type Brain,
  createAgent,
  createAgentRuns,
  createCredential,
  type createFakeJudge,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  type JudgeAnswer,
  listMessages,
  type MachineStatus,
  messageRouter,
  postPersonMessage,
  previewMeta,
  type RouterStrategy,
  runAuthorityById,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0061 §2 and §5: a run that can't think fails with `no_ai` right after its agent is read (no judge,
 * no context, no model call), and the conversation gets one card; "Responder agora" starts it again on the
 * person's own message once an AI is connected, or routes the message again.
 */

let f: Fixture;
afterEach(() => f?.close());

const revokeKeys = () => f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
const restoreKeys = () => f.db.update(schema.providerCredentials).set({ revokedAt: null });

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

const cards = async () => (await f.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "no_ai");
const runs = () => f.db.select().from(schema.agentRuns);
const deps = () => ({ db: f.db, pubsub: f.pubsub, gateway: f.gateway });

/** The judge's calls, by kind (the fixture's fake judge). */
const judgeKinds = () => (f.context.judge as ReturnType<typeof createFakeJudge>).calls.map((c) => c.kind);

const claudeIntent = (kind: string, id: string): JudgeAnswer | undefined =>
  kind !== "ai_intent"
    ? undefined
    : id === "intent"
      ? { choice: "claude", probabilities: { claude: 0.97 } }
      : { choice: "anthropic", probabilities: { anthropic: 0.97 } };

async function addAgent(handle: string, over: { model?: string; credentialId?: string | null } = {}) {
  const agent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: handle, handle, role: "", instructions: "", credentialId: over.credentialId ?? null },
    { model: over.model ?? "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: agent.id });
  return agent;
}

test("no key: the run fails with no_ai before any judge or model call, and one card says so", async () => {
  f = await setup({ judge: claudeIntent, contextTools: true, toolsOnDemand: true });
  // Automático and tools on demand would both ask the judge first.
  await f.db.update(schema.agents).set({ model: "auto" }).where(eq(schema.agents.id, f.agent.id));
  await revokeKeys();
  const events: RealtimeEvent[] = f.listen(f.general.id);
  const asked = await post("@dev quero usar meu plano do Claude");
  await drainOutbox(f.db, f.handlers);

  const [run] = await runs();
  expect(run).toMatchObject({ status: "failed", error: "no_ai", triggerMessageId: asked.id });
  expect(f.provider.calls).toHaveLength(0);
  expect(judgeKinds()).toEqual(["ai_intent"]);
  const [card, ...more] = await cards();
  expect(more).toHaveLength(0);
  expect(card).toMatchObject({
    authorAgentId: f.agent.id,
    channelId: f.general.id,
    threadId: null,
    body: "I can't answer yet: I have no AI connected.",
    meta: {
      bodyCode: "no_ai",
      noAi: {
        agentId: f.agent.id,
        forUserId: f.owner.id,
        reason: "no_key",
        intent: "claude",
        autoOpen: true,
        runId: run?.id,
      },
    },
  });
  expect(events).toContainEqual(expect.objectContaining({ type: "message.created", messageId: card?.id }));
  expect(events).toContainEqual(
    expect.objectContaining({ type: "message.handled", messageId: asked.id, status: "failed", reason: "no_ai" }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: "agent.run", status: "failed", error: "no_ai", errorCode: "run.no_ai" }),
  );
  expect(events.some((e) => e.type === "agent.run" && e.status === "running")).toBe(false);
  // The list's receipts say why (a reload shows the same row as the live event).
  const listed = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === asked.id);
  expect(listed?.receipts?.handled).toEqual([
    { agentId: f.agent.id, runId: run?.id ?? "", status: "failed", reason: "no_ai" },
  ]);
  // The card routes nobody (like a notice).
  const decided = await f.db
    .select()
    .from(schema.routingDecisions)
    .where(eq(schema.routingDecisions.messageId, card?.id ?? ""));
  expect(decided).toHaveLength(0);

  // The next message in the conversation fails the same way, without a second card.
  await post("@dev e agora?");
  await drainOutbox(f.db, f.handlers);
  expect((await runs()).map((r) => r.error)).toEqual(["no_ai", "no_ai"]);
  expect(await cards()).toHaveLength(1);
  // Another conversation (a thread) gets its own.
  await post("@dev aqui também?", asked.id);
  await drainOutbox(f.db, f.handlers);
  expect((await cards()).map((c) => c.threadId)).toEqual([null, asked.id]);
});

test("one card per conversation while the organization has no AI; one per agent while it has some", async () => {
  f = await setup();
  const own = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "dev",
    apiKey: "sk-ant-test-key-5678",
  });
  await f.db.update(schema.agents).set({ credentialId: own.id }).where(eq(schema.agents.id, f.agent.id));
  // Ops thinks with the workspace's key; QA's model is OpenAI's, with no OpenAI key.
  const ops = await addAgent("ops");
  const qa = await addAgent("qa", { model: "gpt-6.1-sol" });
  await f.db
    .update(schema.providerCredentials)
    .set({ revokedAt: new Date() })
    .where(eq(schema.providerCredentials.id, own.id));
  await post("@dev @qa @ops oi");
  await drainOutbox(f.db, f.handlers);
  expect((await cards()).map((c) => c.authorAgentId).sort()).toEqual([f.agent.id, qa.id].sort());
  expect((await runs()).filter((r) => r.status === "done").map((r) => r.agentId)).toEqual([ops.id]);

  // No AI anywhere: three agents, one more card in a new conversation (a thread), not three.
  await revokeKeys();
  const root = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id))[0];
  await post("@dev @qa @ops e agora?", root?.id);
  await drainOutbox(f.db, f.handlers);
  expect((await cards()).filter((c) => c.threadId === root?.id)).toHaveLength(1);
  expect((await runs()).filter((r) => r.error === "no_ai")).toHaveLength(5);
});

test("background work fails with no_ai and posts nothing", async () => {
  f = await setup();
  await revokeKeys();
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Resuma o canal",
    meta: { background: true },
  });
  await f.db.transaction((tx) => createAgentRuns(tx, trigger, [f.agent.id], "mention", { background: true }));
  await drainOutbox(f.db, f.handlers);
  expect(await runs()).toMatchObject([{ status: "failed", error: "no_ai", background: true }]);
  expect(await cards()).toHaveLength(0);
});

test("a computer brain signed out with nothing to fall back on: the card, not a wait that never ends", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: paired.machineId })
    .where(eq(schema.agents.id, f.agent.id));
  await revokeKeys();
  const status: MachineStatus = {
    id: paired.machineId,
    orgId: f.org.id,
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: 8,
    executors: { claude: { version: "2.1.300", loggedIn: false }, detectedAt: new Date().toISOString() },
  };
  const handlers = createJobHandlers({ ...f.jobDeps, machines: { status: async () => status } });
  await post("@dev oi");
  await drainOutbox(f.db, handlers);
  expect(await runs()).toMatchObject([{ status: "failed", error: "no_ai" }]);
  const [card] = await cards();
  expect(card?.meta.noAi).toMatchObject({ reason: "not_signed_in", intent: "task" });
  // It says Claude Code isn't signed in on its computer (it has no account of its own), not that nothing is
  // connected, and so does the conversation list's preview of it.
  expect(card?.body).toBe("I can't answer yet: Claude Code isn't signed in on my computer.");
  expect(previewMeta(card?.meta)).toMatchObject({ bodyCode: "no_ai", noAi: { reason: "not_signed_in" } });
  expect(previewMeta(card?.meta)?.noAi).toEqual({ reason: "not_signed_in", own: "claude_code" });
});

test("Codex saved on the workspace's computer's own sign-in: the run fails at once, Connect, never a wait", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Computador" });
  // The workspace's own computer: nobody connected it, so nobody signs in at its terminal.
  await f.db
    .update(schema.machines)
    .set({ kind: "managed", pairedByUserId: null })
    .where(eq(schema.machines.id, paired.machineId));
  await f.db
    .update(schema.agents)
    .set({ brain: "codex", machineId: paired.machineId, brainAccountId: null })
    .where(eq(schema.agents.id, f.agent.id));
  await revokeKeys();
  const status: MachineStatus = {
    id: paired.machineId,
    orgId: f.org.id,
    name: "Computador",
    kind: "managed",
    pairedByUserId: null,
    online: true,
    execAllowed: true,
    os: "linux",
    protocol: 26,
    executors: { codex: { version: "codex-cli 0.163.0" }, detectedAt: new Date().toISOString() },
  };
  const handlers = createJobHandlers({ ...f.jobDeps, machines: { status: async () => status } });
  await post("@dev oi");
  await drainOutbox(f.db, handlers);
  expect(await runs()).toMatchObject([{ status: "failed", error: "no_ai" }]);
  const shown = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(shown.some((m) => m.meta.bodyCode === "brain_unavailable")).toBe(false);
  const [card] = await cards();
  // The apps' own words for it: Codex isn't signed in on this computer, connect a ChatGPT account.
  expect(card?.meta.noAi).toMatchObject({ reason: "not_signed_in", own: "codex" });
  // Its text, and the conversation list's preview of it: nothing was ever signed in there to sign out of.
  expect(card?.body).toBe("I can't answer yet: Codex isn't signed in on my computer.");
  expect(previewMeta(card?.meta)?.noAi).toEqual({ reason: "not_signed_in", own: "codex" });
});

test("a turn its computer's own sign-in refuses says so on the card, as the computer's, not an account's", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: paired.machineId })
    .where(eq(schema.agents.id, f.agent.id));
  await revokeKeys();
  const status: MachineStatus = {
    id: paired.machineId,
    orgId: f.org.id,
    name: "MacBook",
    pairedByUserId: f.owner.id,
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: 26,
    executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  };
  // The CLI said it was signed in; the turn finds out it isn't.
  const refused: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "error", code: "not_logged_in", message: "Not logged in · Please run /login", retryable: true };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => refused },
    machines: { status: async () => status },
  });
  await post("@dev oi");
  await drainOutbox(f.db, handlers);
  expect(await runs()).toMatchObject([{ status: "failed", error: "no_ai" }]);
  const [card] = await cards();
  expect(card?.meta.noAi).toMatchObject({ reason: "not_signed_in", own: "claude_code" });
});

test("Responder agora: 409 while there's no AI; then the person's own message is answered, once", async () => {
  f = await setup();
  await revokeKeys();
  const asked = await post("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  const [card] = await cards();
  const [failed] = await runs();
  if (!card || !failed) throw new Error("no card");

  const refused = await answerNow(deps(), f.owner.id, f.org.id, card.id).catch((e) => e);
  expect(refused).toMatchObject({ name: "ConflictError", code: "ai.still_missing" });
  // Who asked, the agent's owner or an admin: not any member of the channel.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await restoreKeys();
  const other = await answerNow(deps(), bia.id, f.org.id, card.id).catch((e) => e);
  expect(other).toMatchObject({ name: "ForbiddenError", code: "run.answer_forbidden" });

  const events = f.listen(f.general.id);
  const answered = await answerNow(deps(), f.owner.id, f.org.id, card.id);
  expect(answered.runs).toHaveLength(1);
  const runId = answered.runs[0]?.runId ?? "";
  expect(runId).not.toBe(failed.id);
  expect(await runs()).toMatchObject([{ id: runId, triggerMessageId: asked.id, trigger: "mention", status: "queued" }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.thinking", runId, threadId: null }));
  await drainOutbox(f.db, f.handlers);
  expect(await runs()).toMatchObject([{ id: runId, status: "done" }]);
  expect(f.provider.calls).toHaveLength(1);
  expect(await runAuthorityById(f.db, f.org.id, runId)).toMatchObject({ kind: "person", personId: f.owner.id });
  const [audit] = await f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "run.answered_after_connect")));
  expect(audit).toMatchObject({ actorId: f.owner.id, targetId: runId, details: { oldRunId: failed.id } });

  // Pressed again (or on the person's message): what answers it already, nothing new.
  expect(await answerNow(deps(), f.owner.id, f.org.id, card.id)).toEqual({ runs: [{ agentId: f.agent.id, runId }] });
  expect(await answerNow(deps(), f.owner.id, f.org.id, asked.id)).toEqual({ runs: [{ agentId: f.agent.id, runId }] });
  expect(await runs()).toHaveLength(1);
  // The card still shows, its run gone.
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.some((m) => m.id === card.id)).toBe(true);
});

test("Responder agora for a run another agent woke: the member behind the work may press it", async () => {
  f = await setup();
  const qa = await addAgent("qa");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: bia.id },
    body: "@dev resume o canal",
  });
  const [dev] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  const handed = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: asked.id,
    author: { type: "agent", agentId: f.agent.id, runId: dev?.id ?? "", hop: 1 },
    body: "@qa confere os números",
  });
  await revokeKeys();
  await f.db.transaction((tx) => createAgentRuns(tx, handed, [qa.id], "mention"));
  await drainOutbox(f.db, f.handlers);
  const [card] = await cards();
  expect(card?.meta.noAi).toMatchObject({ agentId: qa.id, forUserId: bia.id });

  await restoreKeys();
  const answered = await answerNow(deps(), bia.id, f.org.id, card?.id ?? "");
  expect(answered.runs).toMatchObject([{ agentId: qa.id }]);
});

test("Responder agora for someone the agent no longer answers (a personal plan answers its owner): 403, nothing starts", async () => {
  f = await setup();
  await revokeKeys();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev resume o canal",
  });
  await drainOutbox(f.db, f.handlers);
  const [card] = await cards();
  const [failed] = await runs();
  if (!card || !failed) throw new Error("no card");
  await restoreKeys();
  // As choosing a personal plan does (ADR 0059 §5): only the agent's owner talks to it now.
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
  // Neither Bia, who asked, nor the owner makes it answer her on his plan.
  for (const who of [bia.id, f.owner.id]) {
    const refused = await answerNow(deps(), who, f.org.id, card.id).catch((e) => e);
    expect(refused).toMatchObject({ name: "ForbiddenError", code: "audience.only" });
  }
  expect(await runs()).toMatchObject([{ id: failed.id, status: "failed", error: "no_ai" }]);
});

test("Responder agora never starts over a run that had done something: 409, and the run stays", async () => {
  f = await setup();
  await revokeKeys();
  await post("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  const [card] = await cards();
  const [failed] = await runs();
  if (!card || !failed) throw new Error("no card");
  // As a run that resumed after an approval and only then met no AI: a tool had already run.
  await addRunStep(f.db, failed, "tool_call", { toolUseId: "t1", name: "create_issue", input: {} });
  await restoreKeys();
  const refused = await answerNow(deps(), f.owner.id, f.org.id, card.id).catch((e) => e);
  expect(refused).toMatchObject({ name: "ConflictError", code: "run.not_restartable" });
  expect(await runs()).toMatchObject([{ id: failed.id, status: "failed", error: "no_ai" }]);
  expect(await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, failed.id))).not.toEqual(
    [],
  );
});

test("Responder agora on a message nobody could route: 409, then it is routed again and a run starts", async () => {
  f = await setup();
  const pickAll: RouterStrategy = {
    name: "fake",
    async decide(input) {
      return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.95 })), needsAgent: 0.95 };
    },
  };
  const jobDeps = { ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5", strategy: pickAll } };
  const handlers = createJobHandlers(jobDeps);
  const router = messageRouter(jobDeps);
  await revokeKeys();
  const asked = await post("alguém resume o canal?");
  await drainOutbox(f.db, handlers);
  expect(await runs()).toHaveLength(0);
  const listed = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === asked.id);
  expect(listed?.receipts).toMatchObject({ seenBy: [], noAi: true });

  const refused = await answerNow({ ...deps(), router }, f.owner.id, f.org.id, asked.id).catch((e) => e);
  expect(refused).toMatchObject({ code: "ai.still_missing" });
  await restoreKeys();
  const events = f.listen(f.general.id);
  const answered = await answerNow({ ...deps(), router }, f.owner.id, f.org.id, asked.id);
  expect(answered.runs).toMatchObject([{ agentId: f.agent.id }]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "message.routed",
      messageId: asked.id,
      strategy: "router",
      pickedBy: [f.agent.id],
    }),
  );
  const [decision] = await f.db
    .select()
    .from(schema.routingDecisions)
    .where(eq(schema.routingDecisions.messageId, asked.id));
  expect(decision).toMatchObject({ error: null, selectedAgentIds: [f.agent.id] });
  await drainOutbox(f.db, handlers);
  expect(await runs()).toMatchObject([{ triggerMessageId: asked.id, trigger: "router", status: "done" }]);
  // Again: the run that answers it, no second one.
  expect((await answerNow({ ...deps(), router }, f.owner.id, f.org.id, asked.id)).runs).toEqual(answered.runs);
  expect(await runs()).toHaveLength(1);
});

test("Tentar de novo on a person's message whose run failed: the same message, one new run, no second copy", async () => {
  let broken = true;
  f = await setup({
    reply: () => (broken ? new ProviderError("provider rejected the request (400)", false, 400) : { chunks: ["ok"] }),
  });
  const asked = await post("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  const [failed] = await runs();
  expect(failed).toMatchObject({ status: "failed", triggerMessageId: asked.id });
  const before = (await f.db.select().from(schema.messages)).length;

  // Only who asked, the agent's owner or an admin.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const other = await answerNow(deps(), bia.id, f.org.id, asked.id).catch((e) => e);
  expect(other).toMatchObject({ name: "ForbiddenError", code: "run.answer_forbidden" });

  broken = false;
  const events = f.listen(f.general.id);
  // A double click: the second call returns the run the first started, so the words never go again.
  const [retried, twice] = await Promise.all([
    answerNow(deps(), f.owner.id, f.org.id, asked.id),
    answerNow(deps(), f.owner.id, f.org.id, asked.id),
  ]);
  expect(twice).toEqual(retried);
  const runId = retried.runs[0]?.runId ?? "";
  expect(retried.runs).toEqual([{ agentId: f.agent.id, runId }]);
  expect(runId).not.toBe(failed?.id);
  // The failed run is gone (its line clears in the apps once the new one thinks), the new one on the same message.
  expect(await runs()).toMatchObject([{ id: runId, triggerMessageId: asked.id, status: "queued" }]);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.thinking", runId }));
  // The message's receipt follows the new run at once (the apps take a new run's claim as the news), so its line
  // stops saying the old run failed before any worker claims it.
  expect(events).toContainEqual(
    expect.objectContaining({ type: "message.claimed", messageId: asked.id, agentId: f.agent.id, runId }),
  );
  expect((await f.db.select().from(schema.messages)).length).toBe(before);
  await drainOutbox(f.db, f.handlers);
  expect(await runs()).toMatchObject([{ id: runId, status: "done" }]);
  const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.retried"));
  expect(audit).toMatchObject({ actorId: f.owner.id, targetId: runId, details: { oldRunId: failed?.id } });
  // Only the agent's reply is new.
  const people = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "person");
  expect(people.map((m) => m.id)).toEqual([asked.id]);
});

test("Tentar de novo on a failed run that already did something: 409, nothing deleted", async () => {
  f = await setup({ reply: () => new ProviderError("provider rejected the request (400)", false, 400) });
  const asked = await post("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  const [failed] = await runs();
  if (!failed) throw new Error("no run");
  await addRunStep(f.db, failed, "tool_call", { name: "github_merge" });
  const refused = await answerNow(deps(), f.owner.id, f.org.id, asked.id).catch((e) => e);
  expect(refused).toMatchObject({ name: "ConflictError", code: "run.not_restartable" });
  expect(await runs()).toMatchObject([{ id: failed.id, status: "failed" }]);
});

test("Tentar de novo where no run can start over: nothing failed comes back, so the apps send the words again", async () => {
  f = await setup({ reply: () => new ProviderError("provider rejected the request (400)", false, 400) });
  const asked = await post("@dev resume o canal");
  await drainOutbox(f.db, f.handlers);
  await f.db.update(schema.agentRuns).set({ background: true });
  expect(await answerNow(deps(), f.owner.id, f.org.id, asked.id)).toEqual({ runs: [] });
  expect(await runs()).toMatchObject([{ status: "failed" }]);
});

test("an agent's message: only a no_ai run starts again, never a run that failed otherwise (no fresh stretch)", async () => {
  f = await setup({ reply: () => new ProviderError("provider rejected the request (400)", false, 400) });
  const qa = await addAgent("qa");
  const handed = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: Bun.randomUUIDv7(), hop: 1 },
    body: "@qa confere os números",
  });
  await f.db.transaction((tx) => createAgentRuns(tx, handed, [qa.id], "mention"));
  await drainOutbox(f.db, f.handlers);
  const [failed] = await runs();
  expect(failed).toMatchObject({ agentId: qa.id, status: "failed" });
  expect(await answerNow(deps(), f.owner.id, f.org.id, handed.id)).toEqual({ runs: [] });
  expect(await runs()).toMatchObject([{ id: failed?.id, status: "failed" }]);
});
