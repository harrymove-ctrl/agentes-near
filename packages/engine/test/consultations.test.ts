import { afterEach, describe, expect, test } from "bun:test";
import { sealSecret, secretAad } from "@agenteschat/adapters";
import { asc, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  type AgentRun,
  answerNow,
  answerQuestion,
  CONSULTATION_HUNG_MS,
  CONSULTATION_TTL_MS,
  cancelRun,
  consultationConversation,
  consultationsIn,
  createAgent,
  createAgentRuns,
  createIssue,
  decideApproval,
  deleteAgent,
  deleteIssue,
  deliverSecret,
  drainOutbox,
  enqueue,
  expireConsultations,
  grantScopes,
  handOffsFrom,
  insertMessage,
  type JobHandlers,
  LATER_JOB,
  listDms,
  listMessages,
  type MachineHub,
  onConsultedRunFinished,
  openAgentDm,
  postPersonMessage,
  recoverStaleRuns,
  releaseInbox,
  reportHandOffs,
  runAuthority,
  STRETCH,
  sendNote,
  setAgentComputerTarget,
  startNoteRun,
  startOrJoinRun,
  stretchCardOf,
  type ToolContext,
  wakesLater,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
/** The consulted agent's run: its prompt says it is in a conversation between agents. */
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

const consultations = () => f.db.select().from(schema.agentConsultations);
const runs = () => f.db.select().from(schema.agentRuns);

async function addInfra() {
  return createAgent(
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
}

/**
 * @dev asks @infra on "deploy" and carries on (it never waits); @infra answers from its DM; the
 * answer comes back as a notice and @dev relays what it heard.
 */
const consultReply = (infraSays: (req: ModelRequest) => ReturnType<typeof answer>) => (req: ModelRequest) => {
  if (inAgentDm(req)) return infraSays(req);
  const last = lastText(req);
  const heard = /your question to @infra\]: ([^"\\]+)/.exec(last);
  if (heard) return { chunks: [`Relaying: ${heard[1]}`] };
  if (last.includes("tool_result"))
    return { chunks: ["Asked @infra how staging is deployed; I'll tell you when it answers."] };
  if (last.includes("deploy"))
    return {
      chunks: [],
      toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?" } }],
    };
  return { chunks: ["ok"] };
};
const answer = (text: string) => ({ chunks: [text] });

describe("ask_agent", () => {
  test("an agent asks another in their private DM, carries on, and relays the answer when it comes", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    const [c] = await consultations();
    expect(c).toMatchObject({
      askerAgentId: f.agent.id,
      targetAgentId: infra.id,
      question: "How is staging deployed?",
      status: "answered",
      answer: "Staging deploys with deploy.sh",
      chain: [f.agent.id],
    });
    // The DM has the two agents only: no person reads it, nor sees it in their DMs.
    const [dm] = await f.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, c?.channelId ?? ""));
    expect(dm?.kind).toBe("dm");
    expect(dm?.dmKey).not.toContain("u:");
    const members = await f.db
      .select({ agentId: schema.channelMembers.agentId, userId: schema.channelMembers.userId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, c?.channelId ?? ""));
    expect(members.map((m) => m.agentId).sort()).toEqual([f.agent.id, infra.id].sort());
    expect(members.every((m) => m.userId === null)).toBe(true);
    expect((await listDms(f.db, f.owner.id, f.org.id)).map((d) => d.channelId)).not.toContain(c?.channelId);

    // The asking run never paused: it told the person and ended. The answer came as a notice where it
    // was asked, and a run of the asker relayed it there.
    const all = await runs();
    expect(all.every((r) => r.status === "done")).toBe(true);
    expect(all.some((r) => r.status === "waiting_input")).toBe(false);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const told = timeline.findIndex((m) => m.body.startsWith("Asked @infra"));
    const notice = timeline.findIndex(
      (m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "consult_reply",
    );
    expect(told).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(told);
    // The people see it as the consultation it was: who asked whom, the question and the answer apart.
    const meta = timeline[notice]?.meta as { notice?: { refs?: Record<string, string> } } | undefined;
    const refs = meta?.notice?.refs;
    expect(refs).toMatchObject({ askerAgentId: f.agent.id, agentId: infra.id, status: "answered" });
    expect(refs?.question).toBeTruthy();
    expect(refs?.answer).toBeTruthy();
    const reply = timeline.at(-1);
    expect(reply?.body).toBe("Relaying: Staging deploys with deploy.sh");
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consulting", agentId: f.agent.id, consultedAgentId: infra.id }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consulted", agentId: f.agent.id, consultedAgentId: infra.id }),
    );
  });

  test("a consulted agent's approval shows where the person asked, not in the agents' DM", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const ask = await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);

    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({
      agentId: infra.id,
      channelId: f.general.id,
      threadRootId: ask.id,
      status: "pending",
    });
    // The card is in the channel's timeline, where the person asked; the approval keeps the conversation.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.approvalId === approval?.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    expect(github.executed).toHaveLength(0);
    expect((await consultations())[0]?.status).toBe("open");
  });

  test("approved where the person asked: the consulted agent goes on, and that conversation hears so", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const [approval] = await f.db.select().from(schema.approvals);
    const [row] = await consultations();
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.waiting).toBe("approval");
    await Bun.sleep(5);
    const mark = events.length;

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect(github.executed).toHaveLength(1);
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Merged." });
    await Bun.sleep(5);
    // Back at work, the question shows as no longer held (`agent.consultation`), before its answer closes it.
    const later = events.slice(mark);
    const resumed = later.findIndex((e) => e.type === "agent.consultation" && e.consultationId === row?.id);
    expect(resumed).toBeGreaterThanOrEqual(0);
    expect(later[resumed]).toMatchObject({ channelId: f.general.id, runId: row?.askerRunId });
    expect(resumed).toBeLessThan(later.findIndex((e) => e.type === "agent.consulted"));
  });

  test("a consulted agent's question shows where the person asked; answering it there resumes it", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      reply: consultReply((req) => {
        const picked = /The person answered: (\w+)/.exec(lastText(req));
        if (picked) return answer(`Staging deploys from ${picked[1]}.`);
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "Staging can deploy from two branches, and which one changes the steps I give back.",
                question: "Which branch goes to staging?",
                choices: ["main", "release"],
              },
            },
          ],
        };
      }),
    });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    // The question waits where the person asked (the asker replied in the main timeline), not in the agents' DM.
    const [q] = await f.db.select().from(schema.agentQuestions);
    expect(q).toMatchObject({ agentId: infra.id, channelId: f.general.id, threadId: null, status: "open" });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.questionId === q?.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    const target = (await runs()).find((r) => r.agentId === infra.id);
    expect(target?.status).toBe("waiting_input");
    const [held] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(held).toMatchObject({ status: "open", waiting: "input" });
    await Bun.sleep(5);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "question.asked", question: expect.objectContaining({ id: q?.id }) }),
    );
    const mark = events.length;

    // Anyone who reads that conversation answers it there; the consulted run picks it up in its DM.
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "release" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === target?.id)?.status).toBe("done");
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Staging deploys from release." });
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.at(-1)?.body).toBe("Relaying: Staging deploys from release.");
    await Bun.sleep(5);
    const later = events.slice(mark);
    const resumed = later.findIndex((e) => e.type === "agent.consultation");
    expect(resumed).toBeGreaterThanOrEqual(0);
    expect(resumed).toBeLessThan(later.findIndex((e) => e.type === "agent.consulted"));
  });

  test("work handed off asks the person behind it, where they asked, and their answer resumes it", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
      reply: (req) => {
        const last = lastText(req);
        if (inAgentDm(req)) {
          const picked = /The person answered: (\w+)/.exec(last);
          if (picked) return answer(`Watching the ${picked[1]} metrics.`);
          return {
            chunks: [],
            toolUses: [
              {
                name: "ask_user",
                input: {
                  why: "The note doesn't say which deploy finished, and the metrics to watch depend on it.",
                  question: "Which deploy?",
                  choices: ["staging", "production"],
                },
              },
            ],
          };
        }
        if (last.includes("did with the work you handed it")) return answer("Infra is watching the metrics.");
        if (last.includes("tool_result")) return answer("Told Infra.");
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "The deploy finished." } }],
        };
      },
    });
    const infra = await addInfra();
    await post("@dev tell infra the deploy finished");
    await drainOutbox(f.db, f.handlers);
    const [q] = await f.db.select().from(schema.agentQuestions);
    expect(q).toMatchObject({ agentId: infra.id, channelId: f.general.id, threadId: null, status: "open" });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({ kind: "note", waiting: "input" });

    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "staging" });
    await drainOutbox(f.db, f.handlers);
    expect((await consultations())[0]).toMatchObject({
      kind: "note",
      status: "answered",
      answer: "Watching the staging metrics.",
    });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Infra is watching the metrics.");
  });

  test("a consulted agent's secret request goes to the person behind it, where they asked", async () => {
    const VALUE = "npm_s3cr3t_value_0123456789";
    f = await setup({
      askAgent: true,
      machines: true,
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Signed in to the registry.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "request_secret",
                  input: { name: "NPM_TOKEN", purpose: "sign in to the package registry", target: "env" },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    // @infra's own computer, its runner online (the key is made there and the value goes there).
    const deps = { db: f.db, pubsub: f.pubsub };
    const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "Build box", ...RUNNER, exec: true });
    await grantScopes(f.db, f.org.id, infra.id, [{ connectionId: null, scope: "sandbox:run" }]);
    await setAgentComputerTarget(deps, f.owner.id, f.org.id, infra.id, paired.machineId);
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const events = f.listen(f.general.id);
    await post("@dev deploy staging");
    await drainOutbox(f.db, f.handlers);

    const [request] = await f.db.select().from(schema.secretRequests);
    if (!request) throw new Error("no secret request");
    expect(request).toMatchObject({
      agentId: infra.id,
      channelId: f.general.id,
      threadId: null,
      requestedForUserId: f.owner.id,
      status: "pending",
    });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = timeline.find((m) => m.meta.secretRequestId === request.id);
    expect(card?.author).toMatchObject({ type: "agent", id: infra.id });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.waiting).toBe("input");
    await Bun.sleep(5);
    const mark = events.length;

    const box = await sealSecret(
      request.publicKey,
      VALUE,
      secretAad({ requestId: request.id, orgId: f.org.id, name: request.name, target: { kind: "env" } }),
    );
    const sandbox = { ...(f.sandboxDeps as NonNullable<typeof f.sandboxDeps>), pubsub: f.pubsub };
    await deliverSecret(sandbox, f.owner.id, f.org.id, request.id, box);
    expect(runner.secrets.get("NPM_TOKEN")).toBe(VALUE);
    await drainOutbox(f.db, f.handlers);
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Signed in to the registry." });
    await Bun.sleep(5);
    expect(events.slice(mark)).toContainEqual(expect.objectContaining({ type: "agent.consultation" }));
  });

  test("the conversation's list: each question by the run that asked, waiting on a person while held", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);

    const [row] = await consultations();
    const list = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: row?.id,
      runId: row?.askerRunId,
      agentId: f.agent.id,
      consultedAgentId: infra.id,
      status: "open",
      waiting: "approval",
      question: "How is staging deployed?",
      answer: null,
    });
    // The asking reply carries the run the list is grouped by.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.some((m) => m.agentRunId === row?.askerRunId)).toBe(true);
    await Bun.sleep(5);
    // The conversation that asked hears the question is held on a person.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.consultation", runId: row?.askerRunId, consultationId: row?.id }),
    );
    // Another conversation's list doesn't have it.
    const other = await f.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, row?.channelId ?? ""));
    expect(await consultationsIn(f.db, f.org.id, other[0]?.id ?? "")).toEqual([]);

    // What the consulted run posts in the agents' DM meanwhile shows here as its progress (ADR 0097).
    const [target] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, row?.targetRunId ?? ""));
    if (!target) throw new Error("no consulted run");
    const before = list[0]?.progress?.posts ?? 0;
    for (const body of ["Gerei a imagem 1.", "Gerei a imagem 2."])
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: row?.channelId ?? "",
        author: { type: "agent", agentId: infra.id, runId: target.id, hop: target.hop },
        body,
      });
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.progress).toEqual({
      posts: before + 2,
      latest: "Gerei a imagem 2.",
      at: expect.any(Date),
    });
  });

  test("answered and expired questions in the list: the answer once answered, none once expired", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    await addInfra();
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);
    const [answered] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(answered).toMatchObject({
      status: "answered",
      waiting: null,
      answer: "Staging deploys with deploy.sh",
    });
    expect(answered?.answeredAt).toBeInstanceOf(Date);

    await f.db
      .update(schema.agentConsultations)
      .set({ status: "expired", answer: "leftover" })
      .where(eq(schema.agentConsultations.id, answered?.id ?? ""));
    const [expired] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(expired).toMatchObject({ status: "expired", answer: null });
  });

  test("an opened question: the question in the DM, then the consulted run's messages and its card here", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const [row] = await consultations();
    if (!row?.targetRunId) throw new Error("the consulted run didn't start");
    const dm = row.channelId;
    const opened = () => consultationConversation(f.db, f.org.id, f.general.id, row.id);
    // The same DM also holds what the two say for other people: never part of this question.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Another question, for someone else",
    });
    // The consulted run's own words in the DM are.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: infra.id, runId: row.targetRunId, hop: 1 },
      body: "Checking the deploy logs first.",
    });

    const first = await opened();
    expect(first?.consultation).toMatchObject({
      id: row.id,
      status: "open",
      waiting: "approval",
      consultedRunId: row.targetRunId,
    });
    const list = first?.messages ?? [];
    // First the question, as it went into the agents' DM.
    expect(list[0]).toMatchObject({ channelId: dm, body: "How is staging deployed?" });
    // What the consulted run wrote there, and the approval it asked for, on its card where the person asked.
    expect(list.some((m) => m.channelId === dm && m.body === "Checking the deploy logs first.")).toBe(true);
    expect(list.some((m) => m.channelId === f.general.id && typeof m.meta.approvalId === "string")).toBe(true);
    // Nothing else: every other message is the consulted run's.
    expect(list.slice(1).every((m) => m.agentRunId === row.targetRunId)).toBe(true);
    expect(list.some((m) => m.body.startsWith("Another question"))).toBe(false);
    // Opened only from the conversation that asked it.
    expect(await consultationConversation(f.db, f.org.id, dm, row.id)).toBeNull();

    // The run, still at work, takes a question the same person asked from another conversation: its words in the
    // DM may be about that one, so they leave this panel; the question and its card here stay.
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Started elsewhere",
    });
    const asker = (await runs()).find((r) => r.id === row.askerRunId);
    if (!asker) throw new Error("no asking run");
    const [elsewhere] = await f.db
      .insert(schema.agentRuns)
      .values({
        ...asker,
        id: Bun.randomUUIDv7(),
        channelId: dm,
        triggerMessageId: trigger.id,
        threadRootId: trigger.id,
      })
      .returning();
    const otherId = Bun.randomUUIDv7();
    const other = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm,
      author: elsewhere
        ? { type: "agent", agentId: f.agent.id, runId: elsewhere.id, hop: 0 }
        : { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Is production up?",
      meta: { consultation: { id: otherId } },
    });
    await f.db.insert(schema.agentConsultations).values({
      ...row,
      id: otherId,
      askerRunId: elsewhere?.id ?? "",
      messageId: other.id,
      waitId: `${row.waitId}-elsewhere`,
      question: "Is production up?",
    });
    const shared = (await opened())?.messages ?? [];
    expect(shared[0]?.body).toBe("How is staging deployed?");
    expect(shared.some((m) => m.body === "Checking the deploy logs first.")).toBe(false);
    expect(shared.some((m) => m.channelId === f.general.id && typeof m.meta.approvalId === "string")).toBe(true);
  });

  test("no cycles: the consulted agent can't ask back the one asking it", async () => {
    let infraCalls = 0;
    f = await setup({
      askAgent: true,
      reply: consultReply((req) => {
        infraCalls++;
        if (lastText(req).includes("tool_result")) return answer("I don't know more than that.");
        return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "dev", question: "Which app?" } }] };
      }),
    });
    await addInfra();
    await post("@dev deploy staging");
    await drainOutbox(f.db, f.handlers);

    expect(await consultations()).toHaveLength(1);
    expect(infraCalls).toBe(2);
    const infraRetry = f.provider.calls
      .map((c) => c.request)
      .find((r) => inAgentDm(r) && lastText(r).includes("tool_result"));
    expect(lastText(infraRetry as ModelRequest)).toContain("already part of this consultation");
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "I don't know more than that." });
  });

  test("between agents, an answer that ends on a promise nothing keeps gets one more turn, and the kept one goes back", async () => {
    const promised =
      "Staging deploys with deploy.sh on host s1. I'll double-check the staging config and get back to you.";
    const kept = "Staging deploys with deploy.sh on host s1, and its config checks out.";
    let infraCalls = 0;
    f = await setup({
      askAgent: true,
      // A judge that calls @infra's last words an unkept promise.
      judge: (kind, _id, _state, _question, request) =>
        kind === "follow_through" && request.agentId !== f.agent.id ? "continue" : undefined,
      reply: consultReply(() => answer(++infraCalls === 1 ? promised : kept)),
    });
    const infra = await addInfra();
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    // Its last message is its answer and nothing wakes it there again: it does the rest now (ADR 0095).
    expect(infraCalls).toBe(2);
    expect(await consultations()).toMatchObject([{ status: "answered", answer: kept }]);
    const judged = (f.context.judge as unknown as { calls: { kind: string; agentId?: string }[] }).calls;
    // Read again after the nudge: the kept answer is done (ADR 0097).
    expect(judged.filter((j) => j.kind === "follow_through" && j.agentId === infra.id)).toHaveLength(2);
    const nudged = f.provider.calls
      .map((c) => c.request)
      .filter((r) => inAgentDm(r) && lastText(r).includes("your answer goes back as it is"));
    expect(nudged).toHaveLength(1);
  });

  test("an asker that says it will pass the answer on keeps that promise: the answer wakes it, no nudge", async () => {
    let judged = 0;
    f = await setup({
      askAgent: true,
      // Its first reply promises to pass the answer on (unkept), the relay is done.
      // One verdict per judged turn: the same call also asks what the turn taught (ADR 0120).
      judge: (kind, id, state, _question, request) => {
        if (kind !== "follow_through" || id !== "verdict") return undefined;
        judged++;
        return request.agentId === f.agent.id && !String(state.reply).startsWith("Relaying") ? "continue" : "done";
      },
      reply: consultReply(() => answer("Staging deploys with deploy.sh")),
    });
    await addInfra();
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    // The open question keeps the first promise, so it isn't judged (ADR 0097); the consulted run's answer and
    // the relay are.
    expect(judged).toBe(2);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "promise")).toEqual([]);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Relaying: Staging deploys with deploy.sh");
  });

  test("unknown agents and asking yourself are refused", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["fine"] };
        // The second run also reads the first message (replies go to threads): newest request first.
        if (last.includes("self"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@dev", question: "hi?" } }] };
        if (last.includes("ghost"))
          return { chunks: [], toolUses: [{ name: "ask_agent", input: { agent: "@ghost", question: "hi?" } }] };
        return { chunks: ["ok"] };
      },
    });
    await post("@dev ask ghost");
    await drainOutbox(f.db, f.handlers);
    await post("@dev ask self");
    await drainOutbox(f.db, f.handlers);
    expect(await consultations()).toHaveLength(0);
    const results = f.provider.calls.map((c) => lastText(c.request)).filter((t) => t.includes("tool_result"));
    expect(results.some((t) => t.includes("No agent @ghost here."))).toBe(true);
    expect(results.some((t) => t.includes("That is you"))).toBe(true);
  });

  test("an agent with no AI connected is refused at once, saying why and who can fix it; with one it is asked", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("Staging deploys with deploy.sh")) });
    const infra = await addInfra();
    // Its model's provider has no key here: nothing to think with.
    await f.db
      .update(schema.agents)
      .set({ model: "gpt-6-luna", credentialId: null })
      .where(eq(schema.agents.id, infra.id));
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);
    expect(await consultations()).toHaveLength(0);
    expect((await runs()).some((r) => r.agentId === infra.id)).toBe(false);
    const results = f.provider.calls.map((c) => lastText(c.request)).filter((t) => t.includes("tool_result"));
    expect(
      results.some((t) =>
        t.includes("@infra has no AI connected yet, so it can't answer. An owner can connect one on its page."),
      ),
    ).toBe(true);

    await f.db
      .update(schema.agents)
      .set({ model: "claude-sonnet-5-5", credentialId: f.credential.id })
      .where(eq(schema.agents.id, infra.id));
    await post("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);
    expect(await consultations()).toMatchObject([
      { targetAgentId: infra.id, status: "answered", answer: "Staging deploys with deploy.sh" },
    ]);
  });

  test("a question waits as long as its colleague's run is queued; once that run is gone it expires and the asker hears it", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra never runs: its execute jobs are dropped.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    // It never waits: the asking run ended after telling the person.
    const asker = (await runs()).find((r) => r.agentId === f.agent.id);
    expect(asker?.status).toBe("done");

    const later = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);
    expect(await expireConsultations({ db: f.db }, later)).toBe(0);
    const [kept] = await consultations();
    expect(kept?.status).toBe("open");
    expect(kept?.expiresAt.getTime()).toBeGreaterThan(later.getTime());
    expect((await runs()).find((r) => r.agentId === infra.id)?.status).toBe("queued");

    // Its run ended without a word (a lost close): nobody is at it anymore.
    await f.db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.agentId, infra.id));
    expect(await expireConsultations({ db: f.db }, new Date(later.getTime() + CONSULTATION_TTL_MS + 1000))).toBe(1);
    await drainOutbox(f.db, handlers);
    expect((await consultations())[0]?.status).toBe("expired");
    expect((await runs()).filter((r) => r.agentId === f.agent.id).every((r) => r.status === "done")).toBe(true);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("didn't answer within 15 minutes");
  });

  test("the consulted run dies with its worker: the asker hears it at once, not after 15 minutes", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra's job is lost with its worker (a deploy mid-tool): the run stays "running" with no heartbeat.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    const long = new Date(Date.now() - 10 * 60_000);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: long, heartbeatAt: long })
      .where(eq(schema.agentRuns.id, target.id));

    expect((await recoverStaleRuns({ db: f.db })).failed).toEqual([target.id]);
    await drainOutbox(f.db, handlers);
    expect((await consultations())[0]?.status).toBe("failed");
    expect((await runs()).filter((r) => r.agentId === f.agent.id).every((r) => r.status === "done")).toBe(true);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("No answer: it couldn't");
  });

  test("a consulted run waiting for its computer waits on no person; stopped there, it closes at once", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const infra = await addInfra();
    // @infra's job never runs here: its run is then parked the way a run whose computer is offline is.
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    const machineId = Bun.randomUUIDv7();
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        waitingMachineId: machineId,
        transcript: {
          messages: [],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
          waitingForBrain: { kind: "claude_code", machineId, code: "machine_offline", waitId: Bun.randomUUIDv7() },
        },
      })
      .where(eq(schema.agentRuns.id, target.id));
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({
      status: "open",
      waiting: "computer",
    });

    // Stopped while parked (nobody executes it): the question closes now, not after 15 minutes.
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, target.id);
    const [stopped] = await consultations();
    expect(stopped?.status).toBe("failed");
    expect(stopped?.answer).toContain("stopped it on purpose");
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]).toMatchObject({
      status: "failed",
      waiting: null,
    });
  });

  test("a consulted run stopped while held on an approval: the asker hears it at once, and once", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      toolSources: [github.source],
      reply: consultReply((req) =>
        lastText(req).includes("tool_result")
          ? answer("Merged.")
          : {
              chunks: [],
              toolUses: [
                {
                  name: "github_merge_pr",
                  input: {
                    repo: "acme/app",
                    pr: 7,
                    why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                  },
                },
              ],
            },
      ),
    });
    const infra = await addInfra();
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const events = f.listen(f.general.id);
    await post("@dev deploy the fix");
    await drainOutbox(f.db, f.handlers);
    const target = (await runs()).find((r) => r.agentId === infra.id);
    if (!target) throw new Error("no consulted run");
    expect(target.status).toBe("waiting_approval");
    expect((await consultations())[0]?.status).toBe("open");
    await Bun.sleep(5);
    const mark = events.length;

    // Stopped from the app while held: no worker executes it, so no run end closes the question.
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, target.id);
    const [stopped] = await consultations();
    expect(stopped?.status).toBe("failed");
    expect(stopped?.answer).toMatch(/^.+ stopped it on purpose, so don't ask it again/);
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("canceled");
    expect(github.executed).toHaveLength(0);
    // Where the person asked: the usual answer notice, and the "asking…" line ends.
    const isReply = (m: { meta: unknown }) =>
      (m.meta as { notice?: { kind?: string } }).notice?.kind === "consult_reply";
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const meta = timeline.find(isReply)?.meta as { notice?: { refs?: Record<string, string> } } | undefined;
    expect(meta?.notice?.refs).toMatchObject({
      askerAgentId: f.agent.id,
      agentId: infra.id,
      status: "failed",
    });
    await Bun.sleep(5);
    expect(events.slice(mark)).toContainEqual(
      expect.objectContaining({
        type: "agent.consulted",
        agentId: f.agent.id,
        consultedAgentId: infra.id,
        status: "failed",
      }),
    );

    // The asker relays it once; the 15-minute sweep finds nothing left to close.
    await drainOutbox(f.db, f.handlers);
    expect(await expireConsultations({ db: f.db }, new Date(Date.now() + CONSULTATION_TTL_MS + 1000))).toBe(0);
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.filter(isReply)).toHaveLength(1);
    expect(after.at(-1)?.body).toContain("stopped it on purpose");
    expect(github.executed).toHaveLength(0);
  });

  /** @dev asked @infra, whose run never ran: its job is lost here, so a test can put it where it needs it. */
  async function asked() {
    const infra = await addInfra();
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const all = await runs();
    const target = all.find((r) => r.agentId === infra.id);
    const asker = all.find((r) => r.agentId === f.agent.id);
    if (!target || !asker) throw new Error("no runs");
    return { infra, handlers, target, asker };
  }

  const park = (runId: string, wait: Record<string, unknown>) =>
    f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: { messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0, ...wait },
      })
      .where(eq(schema.agentRuns.id, runId));

  test("in line for hours without starting: the ask ends with why, its run stops, the asker hears it plainly", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { handlers, target } = await asked();
    const busy = { kind: "claude_code", machineId: "m", code: "busy", waitId: Bun.randomUUIDv7() };
    const sweep = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);

    // Still within the limit: it gets more time, as before.
    await park(target.id, { waitingForBrain: busy, roomWaitSince: Date.now() });
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(0);
    expect((await consultations())[0]?.status).toBe("open");

    const later = new Date(sweep.getTime() + CONSULTATION_TTL_MS);
    await park(target.id, { waitingForBrain: busy, roomWaitSince: later.getTime() - CONSULTATION_HUNG_MS });
    expect(await expireConsultations({ db: f.db }, later)).toBe(1);
    const [row] = await consultations();
    expect(row?.status).toBe("failed");
    expect(row?.answer).toContain("it stayed in line for room on its computer for over 2 hours");
    expect((await runs()).find((r) => r.id === target.id)?.status).toBe("canceled");
    await drainOutbox(f.db, handlers);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("stayed in line for room");
  });

  test("a sweep that finds it asking from the line reads the wait it is", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target } = await asked();
    const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
    const sweep = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "running",
        waitingMachineId: machine?.id,
        transcript: {
          messages: [],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
          roomWaitSince: sweep.getTime() - CONSULTATION_HUNG_MS,
        },
      })
      .where(eq(schema.agentRuns.id, target.id));
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(1);
    expect((await consultations())[0]?.answer).toContain("it stayed in line for room on its computer");
  });

  test("a turn that worked for hours and only now waits for room isn't hung: the wait's own clock counts", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target } = await asked();
    const sweep = new Date(Date.now() + CONSULTATION_HUNG_MS + 3 * CONSULTATION_TTL_MS);
    await park(target.id, {
      waitingForBrain: { kind: "claude_code", machineId: "m", code: "busy", waitId: Bun.randomUUIDv7() },
      roomWaitSince: sweep.getTime() - 60_000,
    });
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(0);
    expect((await consultations())[0]?.status).toBe("open");
  });

  test("a provider that stays down: the outage's own clock counts, not its last look", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target } = await asked();
    const sweep = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);
    await park(target.id, { outage: { since: sweep.getTime() - CONSULTATION_HUNG_MS, n: 4, waitId: "w" } });
    await f.db
      .update(schema.agentRuns)
      .set({ updatedAt: new Date(sweep.getTime() - 60_000) })
      .where(eq(schema.agentRuns.id, target.id));
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(1);
    expect((await consultations())[0]?.answer).toContain("its AI provider stayed down");
  });

  test("a colleague waiting on a person has no such limit: its card has its own deadline", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target } = await asked();
    await park(target.id, {});
    const sweep = new Date(Date.now() + 3 * CONSULTATION_HUNG_MS);
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(0);
    expect((await consultations())[0]?.status).toBe("open");
    expect((await runs()).find((r) => r.id === target.id)?.status).toBe("waiting_input");
  });

  test("stopping a helper alone: its asker wakes knowing who stopped it and not to ask again", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { handlers, target, asker } = await asked();
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, target.id);
    await drainOutbox(f.db, handlers);
    const sent = lastText(f.provider.calls.at(-1)?.request as ModelRequest);
    expect(sent).toContain("stopped it on purpose");
    expect(sent).toContain("don't ask it again or hand it to anyone else");
    expect((await runs()).filter((r) => r.agentId === f.agent.id && r.id !== asker.id).length).toBe(1);
  });

  test("stopping a run with what it delegated is one action: all stop, each told, and nobody wakes", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { infra, handlers, target, asker } = await asked();
    // The asker still at it, and a question of the same chain unread in the helper's inbox.
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, asker.id));
    const calls = f.provider.calls.length;

    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asker.id, {
      chain: true,
      reason: "Mudou a prioridade",
    });

    expect((await consultations())[0]).toMatchObject({ status: "failed" });
    expect((await consultations())[0]?.reportedAt).not.toBeNull();
    const ended = await runs();
    expect(ended.find((r) => r.id === target.id)?.status).toBe("canceled");
    expect(ended.find((r) => r.id === asker.id)?.status).toBe("canceled");
    // Nobody picks it up: no new run for either agent, and no model call.
    await drainOutbox(f.db, handlers);
    expect(await runs()).toHaveLength(ended.length);
    expect(f.provider.calls.length).toBe(calls);
    const notices = await f.db
      .select({ channelId: schema.messages.channelId, body: schema.messages.body })
      .from(schema.messages)
      .where(sql`${schema.messages.meta}->'notice'->>'kind' = 'run_stopped'`);
    expect(notices).toHaveLength(2);
    expect(notices.find((n) => n.channelId === f.general.id)?.body).toContain(`What you asked of @${infra.handle}`);
    for (const n of notices) expect(n.body).toContain("Their reason, in their words: «Mudou a prioridade»");
  });
});

describe("stopping a chain, at its edges (ADR 0128)", () => {
  /** @dev asked @infra, whose run never ran. */
  async function asked() {
    const infra = await addInfra();
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, String(job.payload.runId)));
        if (run?.agentId === infra.id) return;
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    await post("@dev deploy staging");
    await drainOutbox(f.db, handlers);
    const all = await runs();
    const target = all.find((r) => r.agentId === infra.id);
    const asker = all.find((r) => r.agentId === f.agent.id);
    if (!target || !asker) throw new Error("no runs");
    return { infra, handlers, target, asker };
  }

  test("the task a run asked of an agent was on is deleted: who asked hears it now, not when the question expires", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target } = await asked();
    const issue = await createIssue({ db: f.db }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Deploy",
    });
    await f.db.update(schema.agentRuns).set({ issueId: issue.id }).where(eq(schema.agentRuns.id, target.id));

    await deleteIssue({ db: f.db, pubsub: f.pubsub, hub: null } as never, f.owner.id, f.org.id, issue.id);

    expect((await runs()).find((r) => r.id === target.id)?.status).toBe("canceled");
    expect((await consultations())[0]).toMatchObject({ status: "failed" });
  });

  test("the run asked ended as the stop came: what it asked still stops, and its agent reads that", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { infra, target, asker } = await asked();
    expect((await runs()).find((r) => r.id === asker.id)?.status).toBe("done");

    const out = await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asker.id, { chain: true });

    expect(out.status).toBe("done");
    expect((await runs()).find((r) => r.id === target.id)?.status).toBe("canceled");
    const told = await f.db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(
        sql`${schema.messages.meta}->'notice'->>'kind' = 'run_stopped' and ${schema.messages.channelId} = ${f.general.id}`,
      );
    expect(told[0]?.body).toContain(`What you asked of @${infra.handle} stopped with it`);
  });

  test("nothing left to stop under a run that ended: it says so", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { asker, target } = await asked();
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, target.id));
    await f.db.update(schema.agentConsultations).set({ status: "answered" });
    await expect(
      cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asker.id, { chain: true }),
    ).rejects.toMatchObject({ code: "run_finished" });
  });

  test("a helper someone else's ask still waits on goes on, and so does what it asked", async () => {
    f = await setup({ askAgent: true, reply: consultReply(() => answer("never sent")) });
    const { target, asker } = await asked();
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, asker.id));
    const [ask] = await consultations();
    if (!ask) throw new Error("no ask");
    // Another run of @dev waits on @infra's run too, and that run asked @dev's other run something.
    const other = Bun.randomUUIDv7();
    await f.db
      .insert(schema.agentRuns)
      .values({ ...asker, id: other, triggerMessageId: ask.messageId, status: "running" });
    const row = (over: Partial<typeof ask>) => ({
      ...ask,
      id: Bun.randomUUIDv7(),
      messageId: Bun.randomUUIDv7(),
      ...over,
    });
    await f.db
      .insert(schema.agentConsultations)
      .values([
        row({ askerRunId: other, waitId: `async:${Bun.randomUUIDv7()}` }),
        row({ askerRunId: target.id, targetRunId: other, waitId: `async:${Bun.randomUUIDv7()}` }),
      ]);

    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asker.id, { chain: true });

    const after = await runs();
    expect(after.find((r) => r.id === asker.id)?.status).toBe("canceled");
    expect(after.find((r) => r.id === target.id)?.status).not.toBe("canceled");
    expect(after.find((r) => r.id === other)?.status).toBe("running");
    expect((await consultations()).filter((c) => c.status === "open")).toHaveLength(2);
  });
});

describe("a hand-off held for room (ADR 0131 §7)", () => {
  /** @dev's note to @infra the brakes deferred: its row has no run, and the look that starts it is in the outbox. */
  async function deferred() {
    const infra = await addInfra();
    await post("@dev oi");
    await drainOutbox(f.db, f.handlers);
    const [asker] = await runs();
    if (!asker) throw new Error("no run");
    const sent = await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: asker.id,
      hop: 1,
      targetAgentId: infra.id,
      body: "Olha os bugs novos.",
      chain: [f.agent.id],
      deferStart: true,
    });
    if (!sent) throw new Error("not sent");
    await enqueue(f.db, {
      orgId: f.org.id,
      kind: LATER_JOB,
      payload: { messageId: sent.message.id, agentId: infra.id, look: 1 },
      dedupeKey: `${LATER_JOB}:${sent.message.id}:${infra.id}:1`,
      runAt: new Date(Date.now() + 3600_000),
    });
    return { infra, asker, sent };
  }

  test("it stays open while its wake waits, so the asker never hears it was lost and the run answers it", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["ok"] }) });
    const { infra, asker, sent } = await deferred();
    expect((await handOffsFrom(f.db, asker))[0]).toMatchObject({ target: null, parked: true });

    const sweep = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(0);
    const [row] = await consultations();
    expect(row?.status).toBe("open");
    expect(row?.expiresAt.getTime()).toBeGreaterThan(sweep.getTime());

    await startNoteRun(f.db, sent.message, infra.id);
    const run = (await runs()).find((r) => r.agentId === infra.id);
    expect((await consultations())[0]).toMatchObject({ status: "open", targetRunId: run?.id });
  });

  test("it holds up no other hand-off: what came back is reported, naming the one that waits", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["ok"] }) });
    const { infra, asker } = await deferred();
    const [held] = await consultations();
    if (!held) throw new Error("no row");
    await f.db.insert(schema.agentConsultations).values({
      ...held,
      id: Bun.randomUUIDv7(),
      messageId: Bun.randomUUIDv7(),
      status: "answered",
      answer: "Feito.",
      answeredAt: new Date(),
    });

    const reported = await reportHandOffs({ db: f.db, pubsub: f.pubsub }, asker);

    expect(reported).toHaveLength(1);
    const meta = reported[0]?.message.meta as { notice?: { refs: Record<string, string> } } | undefined;
    expect(meta?.notice?.refs.pending).toBe(`@${infra.handle}`);
  });

  test("past the limit it ends with why, and its wake never starts a run whose answer would go nowhere", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["ok"] }) });
    await deferred();
    const sweep = new Date(Date.now() + CONSULTATION_HUNG_MS + 1000);
    expect(await expireConsultations({ db: f.db }, sweep)).toBe(1);
    const [row] = await consultations();
    expect(row?.status).toBe("failed");
    expect(row?.answer).toContain("it never got to start for over 2 hours");
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, LATER_JOB));
    expect(jobs).toEqual([]);
  });
});

describe("tell_agent: what comes of work handed off comes back by itself (ADR 0095)", () => {
  /** The judge reads each note's reply as one its sender needs (a result), unless told otherwise. */
  const notesMatter = (kind: string) => (kind === "note_reply" ? 0.9 : undefined);
  /** Whose model call it is: its prompt says which agent it is, never what anyone wrote. */
  const youAre = (req: ModelRequest, name: string) =>
    systemText(req.system).includes(`You are ${name} (@${name.toLowerCase()})`);
  /** What came of work handed off, as it reaches the sender's conversation. */
  const notesBack = async () =>
    (await f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))).filter(
      (m) => {
        const n = m.meta.notice as { kind?: string; refs?: Record<string, string> } | undefined;
        return n?.kind === "consult_reply" && n.refs?.kind === "note";
      },
    );
  const refsOf = (m: { meta: Record<string, unknown> }) => (m.meta.notice as { refs: Record<string, string> }).refs;
  const runsOf = async (agentId: string) => (await runs()).filter((r) => r.agentId === agentId);
  const ended = (runId: string) =>
    f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, runId));

  async function addAgent(name: string) {
    return createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name, handle: name.toLowerCase(), role: "Operations", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
  }

  /** A run of @dev in #general on Ana's message, and the context its tools get. */
  async function devRun(body: string) {
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body,
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        stretchId: trigger.id,
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  }
  const ctxOf = (run: AgentRun): ToolContext => ({
    db: f.db,
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  });
  const tell = (run: AgentRun, agent: string, message: string) => {
    if (!f.tools) throw new Error("no tools");
    return f.tools.invoke(ctxOf(run), {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "tell_agent",
      input: { agent, message },
    });
  };
  /** The run another agent's note started (or joined). */
  const runFor = async (c: { targetRunId: string | null } | undefined) => {
    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    if (!run) throw new Error("no run for the note");
    return run;
  };
  /** `run` is done with `body`, its last message there, as its end commits (before its end hook). */
  const endsWith = async (run: AgentRun, body: string) => {
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: run.channelId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body,
    });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", replyMessageId: said.id })
      .where(eq(schema.agentRuns.id, run.id));
  };
  /** The end hook of a run in an agents' DM (`executor.ts` runs it after the end commits). */
  const endHook = (run: AgentRun, status: "done" | "failed" = "done", error?: string) =>
    onConsultedRunFinished({ db: f.db, pubsub: f.pubsub, judge: f.context.judge }, run, status, error);
  /** `agent` answered `run`'s note with `body`: its last message there, and its run ends. */
  const answered = async (run: AgentRun, body: string) => {
    await endsWith(run, body);
    return endHook(run);
  };

  /**
   * @dev hands `notes` off in one turn when a person asks, says so in a line, and once what came of them is back,
   * tells the person; each colleague answers with `says[name]`.
   */
  const handing =
    (notes: { agent: string; message: string }[], says: Record<string, (req: ModelRequest) => FakeReply>) =>
    (req: ModelRequest): FakeReply => {
      for (const [name, say] of Object.entries(says)) if (youAre(req, name)) return say(req);
      const last = lastText(req);
      if (last.includes("did with the work you handed it")) return answer("Pronto, voltou tudo.");
      if (last.includes("tool_result")) return answer("Passei adiante; te conto quando voltar.");
      return { chunks: [], toolUses: notes.map((n) => ({ name: "tell_agent", input: n })) };
    };

  /** These agents' runs wait (their jobs are kept) until `release` lets them go, one agent at a time. */
  function holding(...agentIds: string[]) {
    const released = new Set<string>();
    const held = new Map<string, string>();
    const handlers: JobHandlers = {
      ...f.handlers,
      "agent_run.execute": async (job, ctx) => {
        const runId = String(job.payload.runId);
        const [run] = await f.db
          .select({ agentId: schema.agentRuns.agentId })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.id, runId));
        if (run && agentIds.includes(run.agentId) && !released.has(runId)) {
          held.set(runId, run.agentId);
          return;
        }
        await f.handlers["agent_run.execute"]?.(job, ctx);
      },
    };
    const release = async (agentId: string) => {
      for (const [runId, of] of held) {
        if (of !== agentId || released.has(runId)) continue;
        released.add(runId);
        await enqueue(f.db, {
          orgId: f.org.id,
          kind: "agent_run.execute",
          payload: { runId },
          dedupeKey: `test:release:${runId}`,
        });
      }
      await drainOutbox(f.db, handlers);
    };
    return { handlers, release };
  }

  test("a note is a row on the run it starts and on the run at work it joins; the conversation hears it as a note", async () => {
    f = await setup({ askAgent: true });
    const infra = await addInfra();
    const events = f.listen(f.general.id);
    const dev = await devRun("@dev avisa o infra do deploy");
    await tell(dev, "@infra", "O deploy de staging terminou: confere a taxa de erro.");
    const [first] = await consultations();
    const [started] = await runsOf(infra.id);
    expect(first).toMatchObject({
      kind: "note",
      askerRunId: dev.id,
      targetAgentId: infra.id,
      targetRunId: started?.id,
      status: "open",
      question: "O deploy de staging terminou: confere a taxa de erro.",
      chain: [f.agent.id],
    });
    // Its run there for Ana takes the next note at its next step: that row waits on it too.
    await tell(dev, "@infra", "E confere a fila de jobs.");
    const second = (await consultations()).find((c) => c.id !== first?.id);
    expect(second).toMatchObject({ kind: "note", targetRunId: started?.id });
    expect(await runsOf(infra.id)).toHaveLength(1);
    await Bun.sleep(5);
    expect(events.filter((e) => e.type === "agent.consulting")).toEqual([
      expect.objectContaining({ kind: "note", runId: dev.id, consultedAgentId: infra.id }),
      expect.objectContaining({ kind: "note", runId: dev.id, consultedAgentId: infra.id }),
    ]);
  });

  test("what came of it wakes the sender once, as the person's work, which may hand work on again", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: handing([{ agent: "@infra", message: "O deploy terminou: confere a taxa de erro." }], {
        Infra: () => answer("Taxa de erro em 0,1%, normal."),
      }),
    });
    const infra = await addInfra();
    await post("@dev avisa o infra que o deploy terminou");
    await drainOutbox(f.db, f.handlers);

    const [row] = await consultations();
    expect(row).toMatchObject({ kind: "note", status: "answered", answer: "Taxa de erro em 0,1%, normal." });
    expect(row?.reportedAt).toBeInstanceOf(Date);
    const [back, ...more] = await notesBack();
    expect(more).toEqual([]);
    expect(back).toMatchObject({ channelId: f.general.id, authorAgentId: f.agent.id });
    expect(back?.meta.notice).toMatchObject({
      kind: "consult_reply",
      from: "@infra",
      refs: { kind: "note", wake: "1", status: "answered", consultationId: row?.id, runId: row?.askerRunId },
    });
    const woken = (await runsOf(f.agent.id)).find((r) => r.triggerMessageId === back?.id);
    if (!woken) throw new Error("the sender wasn't woken");
    expect(woken.status).toBe("done");
    expect(await runsOf(f.agent.id)).toHaveLength(2);
    expect(await runAuthority(f.db, woken)).toEqual({ kind: "person", personId: f.owner.id });
    const read = f.provider.calls
      .map((c) => c.request)
      .find((r) => lastText(r).includes("[What @infra did with the work you handed it]: Taxa de erro em 0,1%"));
    if (!read) throw new Error("the result wasn't read");
    expect(read.tools?.map((t) => t.name)).toContain("tell_agent");
    expect(lastText(read)).toContain("Everything you handed off in that turn is back");
    // Nothing woke Infra again to read anything.
    expect(await runsOf(infra.id)).toHaveLength(1);
  });

  test("a bare acknowledgement closes as told: no notice and no run", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "note_reply" ? 0.1 : undefined),
      reply: handing([{ agent: "@infra", message: "O deploy terminou." }], { Infra: () => answer("Combinado.") }),
    });
    await addInfra();
    await post("@dev avisa o infra que o deploy terminou");
    await drainOutbox(f.db, f.handlers);
    const [row] = await consultations();
    expect(row).toMatchObject({ status: "answered", answer: "Combinado." });
    expect(row?.reportedAt).toBeInstanceOf(Date);
    expect(await notesBack()).toEqual([]);
    expect(await runsOf(f.agent.id)).toHaveLength(1);
  });

  test("two notes of one turn come back together: the first close writes nothing, the second wakes once with both", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: handing(
        [
          { agent: "@infra", message: "Confere a taxa de erro do deploy." },
          { agent: "@ops", message: "Confere a fila de jobs." },
        ],
        { Infra: () => answer("Taxa de erro normal."), Ops: () => answer("Fila vazia.") },
      ),
    });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    const { handlers, release } = holding(infra.id, ops.id);
    await post("@dev confere o deploy com o infra e o ops");
    await drainOutbox(f.db, handlers);
    expect((await consultations()).map((c) => c.status)).toEqual(["open", "open"]);

    await release(infra.id);
    // Infra is back, Ops still on it: nothing goes out yet.
    expect((await consultations()).find((c) => c.targetAgentId === infra.id)?.status).toBe("answered");
    expect(await notesBack()).toEqual([]);
    expect(await runsOf(f.agent.id)).toHaveLength(1);

    await release(ops.id);
    const back = await notesBack();
    expect(back.map((m) => [refsOf(m).agentId, refsOf(m).wake ?? null])).toEqual([
      [infra.id, null],
      [ops.id, "1"],
    ]);
    const devRuns = await runsOf(f.agent.id);
    expect(devRuns).toHaveLength(2);
    expect(devRuns.some((r) => r.triggerMessageId === back[1]?.id)).toBe(true);
    const read = f.provider.calls.map((c) => JSON.stringify(c.request.messages)).find((m) => m.includes("[What @ops"));
    expect(read).toContain("[What @infra did with the work you handed it]: Taxa de erro normal.");
    expect(read).toContain("[What @ops did with the work you handed it]: Fila vazia.");
    expect(read?.match(/Everything you handed off in that turn is back/g)).toHaveLength(1);
  });

  test("closes and claims interleaved: both closes commit before either claim, and the sender still wakes once", async () => {
    f = await setup({ askAgent: true });
    await addInfra();
    await addAgent("Ops");
    const dev = await devRun("@dev confere com o infra e o ops");
    await ended(dev.id);
    await tell(dev, "@infra", "Confere a taxa de erro.");
    await tell(dev, "@ops", "Confere a fila.");
    await f.db
      .update(schema.agentConsultations)
      .set({ status: "answered", answer: "Tudo certo.", answeredAt: new Date() });
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(ne(schema.agentRuns.agentId, f.agent.id));
    const [asker] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, dev.id));
    if (!asker) throw new Error("no run");
    const first = await reportHandOffs({ db: f.db, pubsub: f.pubsub }, asker);
    const second = await reportHandOffs({ db: f.db, pubsub: f.pubsub }, asker);
    expect(first).toHaveLength(2);
    expect(first.flatMap((d) => d.runs)).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await notesBack()).toHaveLength(2);
  });

  test("a colleague waiting on a person holds up no other result: entering the wait lets them come back", async () => {
    const github = fakeGithub();
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      toolSources: [github.source],
      reply: handing(
        [
          { agent: "@infra", message: "Faz o merge do PR #7." },
          { agent: "@ops", message: "Confere a fila de jobs." },
        ],
        {
          Infra: (req) =>
            lastText(req).includes("tool_result")
              ? answer("Merged.")
              : {
                  chunks: [],
                  toolUses: [
                    {
                      name: "github_merge_pr",
                      input: {
                        repo: "acme/app",
                        pr: 7,
                        why: "The checks passed and the change was reviewed: this action finishes what was asked.",
                      },
                    },
                  ],
                },
          Ops: () => answer("Fila vazia."),
        },
      ),
    });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const { handlers, release } = holding(infra.id, ops.id);
    await post("@dev faz o deploy com o infra e o ops");
    await drainOutbox(f.db, handlers);
    await release(ops.id);
    // Ops is back and Infra hasn't started: Ops's result waits.
    expect(await notesBack()).toEqual([]);

    await release(infra.id);
    expect((await runsOf(infra.id))[0]?.status).toBe("waiting_approval");
    const back = await notesBack();
    expect(back.map((m) => refsOf(m).agentId)).toEqual([ops.id]);
    expect((await consultations()).find((c) => c.targetAgentId === infra.id)?.status).toBe("open");
    // The wake says who is still out, so the agent doesn't tell the people everything is back.
    expect(back[0]?.meta.notice).toMatchObject({ refs: { wake: "1", pending: "@infra" } });
    const read = f.provider.calls.map((c) => lastText(c.request)).find((t) => t.includes("[What @ops did"));
    expect(read).toContain("Still out, waiting on a person or a computer: @infra.");
    expect(read).not.toContain("Everything you handed off in that turn is back");
    // Its approval card is where the person asked.
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({ agentId: infra.id, channelId: f.general.id, status: "pending" });
  });

  test("an agent that handed part on answers once with both parts, and no run starts between agents to read it", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: handing([{ agent: "@infra", message: "Cuida do deploy de staging." }], {
        Infra: (req) =>
          lastText(req).includes("tool_result")
            ? answer("Deploy ok; passei a fila ao Ops.")
            : {
                chunks: [],
                toolUses: [
                  { name: "tell_agent", input: { agent: "@ops", message: "Limpa a fila de jobs de staging." } },
                ],
              },
        Ops: () => answer("Fila limpa."),
      }),
    });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    const { handlers, release } = holding(ops.id);
    await post("@dev pede ao infra para cuidar do deploy");
    await drainOutbox(f.db, handlers);
    const parent = (await consultations()).find((c) => c.targetAgentId === infra.id);
    expect((await runsOf(infra.id))[0]?.status).toBe("done");
    // Its reply joins as it closes: nothing came back yet.
    expect(parent).toMatchObject({ status: "open", answer: null });
    expect((await consultationsIn(f.db, f.org.id, f.general.id)).find((c) => c.id === parent?.id)?.waiting).toBe(
      "agents",
    );
    expect(await notesBack()).toEqual([]);

    await release(ops.id);
    expect((await consultations()).find((c) => c.id === parent?.id)).toMatchObject({
      status: "answered",
      answer: "Deploy ok; passei a fila ao Ops.\n\n[@ops, to whom @infra handed part of it]: Fila limpa.",
    });
    const back = await notesBack();
    expect(back.map((m) => [m.channelId, refsOf(m).agentId])).toEqual([[f.general.id, infra.id]]);
    expect(await runsOf(infra.id)).toHaveLength(1);
    expect(await runsOf(ops.id)).toHaveLength(1);
    expect(await runsOf(f.agent.id)).toHaveLength(2);
  });

  test("what comes back while the agent that handed it on still works is read at its next step, and joins its answer even if it ends first", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    const infra = await addInfra();
    await addAgent("Ops");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const toInfra = (await consultations())[0];
    const infraRun = await runFor(toInfra);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, infraRun.id));
    await tell(infraRun, "@ops", "Limpa a fila de jobs.");
    const toOps = (await consultations()).find((c) => c.askerRunId === infraRun.id);
    await answered(await runFor(toOps), "Fila limpa.");

    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, infraRun.id));
    const pending = await f.db
      .select()
      .from(schema.messages)
      .where(inArray(schema.messages.id, after?.pendingMessageIds ?? []));
    expect(pending.map((m) => (m.meta.notice as { kind?: string } | undefined)?.kind)).toEqual(["consult_reply"]);
    const line = "[@ops, to whom @infra handed part of it]: Fila limpa.";
    expect((await consultations()).find((c) => c.id === toInfra?.id)).toMatchObject({ status: "open", answer: line });

    // It ends after its last look at its inbox: what came back still goes with its answer, and no run starts to read it.
    await answered(infraRun, "Deploy feito.");
    await releaseInbox(f.db, f.pubsub, infraRun, { reason: "done" });
    expect((await consultations()).find((c) => c.id === toInfra?.id)).toMatchObject({
      status: "answered",
      answer: `Deploy feito.\n\n${line}`,
    });
    expect(await runsOf(infra.id)).toHaveLength(1);
    expect((await notesBack()).filter((m) => m.channelId === f.general.id)).toHaveLength(1);
  });

  test("what comes back between the end of the run that handed it on and that run's end hook joins its reply", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    await addAgent("Ops");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const toInfra = (await consultations())[0];
    const infraRun = await runFor(toInfra);
    await tell(infraRun, "@ops", "Limpa a fila de jobs.");
    const toOps = (await consultations()).find((c) => c.askerRunId === infraRun.id);
    await endsWith(infraRun, "Deploy feito; passei a fila ao Ops.");
    await answered(await runFor(toOps), "Fila limpa.");
    await endHook(infraRun);
    expect((await consultations()).find((c) => c.id === toInfra?.id)).toMatchObject({
      status: "answered",
      answer: "Deploy feito; passei a fila ao Ops.\n\n[@ops, to whom @infra handed part of it]: Fila limpa.",
    });
    expect(await notesBack()).toHaveLength(1);
  });

  test("two parts handed on that come back at once both join the answer", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    const ops = await addAgent("Ops");
    const qa = await addAgent("QA");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const toInfra = (await consultations())[0];
    const infraRun = await runFor(toInfra);
    await tell(infraRun, "@ops", "Limpa a fila de jobs.");
    await tell(infraRun, "@qa", "Roda os testes de fumaça.");
    await answered(infraRun, "Deploy feito.");
    const partOf = async (agentId: string) => runFor((await consultations()).find((c) => c.targetAgentId === agentId));
    const [opsRun, qaRun] = [await partOf(ops.id), await partOf(qa.id)];
    await Promise.all([answered(opsRun, "Fila limpa."), answered(qaRun, "Testes verdes.")]);
    const parent = (await consultations()).find((c) => c.id === toInfra?.id);
    expect(parent?.status).toBe("answered");
    expect(parent?.answer?.split("\n\n").sort()).toEqual([
      "Deploy feito.",
      "[@ops, to whom @infra handed part of it]: Fila limpa.",
      "[@qa, to whom @infra handed part of it]: Testes verdes.",
    ]);
    expect(await notesBack()).toHaveLength(1);
  });

  test("people read a part handed on as that agent's words, and not one that couldn't be done; the agent reads both", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    const ops = await addAgent("Ops");
    const qa = await addAgent("QA");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const toInfra = (await consultations())[0];
    const infraRun = await runFor(toInfra);
    await tell(infraRun, "@ops", "Limpa a fila de jobs.");
    await tell(infraRun, "@qa", "Roda os testes de fumaça.");
    await answered(infraRun, "Deploy feito.");
    const partOf = async (agentId: string) => runFor((await consultations()).find((c) => c.targetAgentId === agentId));
    await answered(await partOf(ops.id), "Fila limpa.");
    const qaRun = await partOf(qa.id);
    await f.db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.id, qaRun.id));
    await endHook(qaRun, "failed", "model_error");

    const shown = "Deploy feito.\n\nops: Fila limpa.";
    const listed = (await consultationsIn(f.db, f.org.id, f.general.id)).find((c) => c.id === toInfra?.id);
    expect(listed).toMatchObject({ status: "answered", answer: shown });
    const [back, ...more] = await notesBack();
    expect(more).toEqual([]);
    expect(back?.meta.notice).toMatchObject({
      refs: { answer: shown },
      text: expect.stringContaining(
        "Deploy feito.\n\n[@ops, to whom @infra handed part of it]: Fila limpa.\n\n[@qa, to whom @infra handed part of it]: couldn't: model_error",
      ),
    });
  });

  test("colleagues whose runs both ended before either row closed: the sender still wakes once", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    const dev = await devRun("@dev confere com o infra e o ops");
    await ended(dev.id);
    await tell(dev, "@infra", "Confere a taxa de erro.");
    await tell(dev, "@ops", "Confere a fila.");
    const runOf = async (agentId: string) => runFor((await consultations()).find((c) => c.targetAgentId === agentId));
    const [infraRun, opsRun] = [await runOf(infra.id), await runOf(ops.id)];
    // Both are done about together: each row closes only after its end hook's judge call.
    await endsWith(infraRun, "Taxa de erro normal.");
    await endsWith(opsRun, "Fila vazia.");
    await endHook(infraRun);
    expect(await notesBack()).toEqual([]);
    await endHook(opsRun);
    expect((await notesBack()).map((m) => [refsOf(m).agentId, refsOf(m).wake ?? null])).toEqual([
      [infra.id, null],
      [ops.id, "1"],
    ]);
    expect(await runsOf(f.agent.id)).toHaveLength(2);
  });

  test("a note that joined a run at work and wasn't read when it failed goes to a run of its own, whose answer comes back", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Confere a taxa de erro.");
    const [first] = await consultations();
    const working = await runFor(first);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, working.id));
    await tell(dev, "@infra", "E confere a fila de jobs.");
    const joined = (await consultations()).find((c) => c.id !== first?.id);
    expect(joined?.targetRunId).toBe(working.id);
    // The executor's `fail`: failed, its end hook, then its unread messages get a run of their own.
    await f.db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.id, working.id));
    await endHook(working, "failed", "model_error");
    const released = await releaseInbox(f.db, f.pubsub, working, { reason: "failed" });
    const own = await runFor({ targetRunId: released?.runId ?? null });
    expect((await consultations()).find((c) => c.id === joined?.id)).toMatchObject({
      status: "open",
      targetRunId: own.id,
    });
    expect(await notesBack()).toEqual([]);
    await answered(own, "Fila vazia: 0 jobs.");
    const rowOf = async (id?: string) => (await consultations()).find((c) => c.id === id);
    expect(await rowOf(first?.id)).toMatchObject({ status: "failed", answer: "model_error" });
    expect(await rowOf(joined?.id)).toMatchObject({ status: "answered", answer: "Fila vazia: 0 jobs." });
    expect((await notesBack()).map((m) => refsOf(m).status)).toEqual(["failed", "answered"]);
  });

  test("a note that joined a run at work after its last look at its inbox goes to a run of its own, not into that run's answer", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Confere a taxa de erro.");
    const [first] = await consultations();
    const working = await runFor(first);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, working.id));
    await tell(dev, "@infra", "E confere a fila de jobs.");
    const joined = (await consultations()).find((c) => c.id !== first?.id);
    const rowOf = async (id?: string) => (await consultations()).find((c) => c.id === id);
    // It ends with its answer to the first: its end hook, then what it didn't read gets a run of its own.
    await answered(working, "Taxa de erro normal.");
    expect(await rowOf(first?.id)).toMatchObject({ status: "answered", answer: "Taxa de erro normal." });
    expect(await rowOf(joined?.id)).toMatchObject({ status: "open" });
    const released = await releaseInbox(f.db, f.pubsub, working, { reason: "done" });
    const own = await runFor({ targetRunId: released?.runId ?? null });
    expect(await rowOf(joined?.id)).toMatchObject({ status: "open", targetRunId: own.id });
    await answered(own, "Fila vazia: 0 jobs.");
    expect(await rowOf(joined?.id)).toMatchObject({ status: "answered", answer: "Fila vazia: 0 jobs." });
    expect((await notesBack()).map((m) => [refsOf(m).consultationId, refsOf(m).wake ?? null])).toEqual([
      [first?.id, null],
      [joined?.id, "1"],
    ]);
  });

  test("a note that joined a run at work and wasn't read when it paused on an approval goes to a run of its own; the rest wait for it", async () => {
    const github = fakeGithub();
    let dev: AgentRun | undefined;
    let joining: Promise<unknown> | undefined;
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      toolSources: [github.source],
      reply: (req) => {
        if (youAre(req, "Ops")) return answer("Deploy conferido.");
        if (!youAre(req, "Infra")) return answer("Pronto.");
        if (lastText(req).includes("E confere a fila")) return answer("Fila vazia: 0 jobs.");
        // The second note comes in while it thinks, after its last look at its inbox.
        joining ??= tell(dev as AgentRun, "@infra", "E confere a fila de jobs.");
        return {
          chunks: ["Fazendo o merge."],
          hold: joining,
          toolUses: [
            {
              name: "github_merge_pr",
              input: {
                repo: "acme/app",
                pr: 7,
                why: "The checks passed and the change was reviewed: this action finishes what was asked.",
              },
            },
          ],
        };
      },
    });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    await grantScopes(f.db, f.org.id, infra.id, ALL_GITHUB_SCOPES);
    const { handlers, release } = holding(infra.id);
    dev = await devRun("@dev faz o deploy com o infra e o ops");
    await ended(dev.id);
    await tell(dev, "@infra", "Faz o merge do PR #7.");
    await tell(dev, "@ops", "Confere o deploy.");
    await drainOutbox(f.db, handlers);
    expect(await notesBack()).toEqual([]);

    await release(infra.id);
    const infraRuns = await runsOf(infra.id);
    const paused = infraRuns.find((r) => r.status === "waiting_approval");
    const own = infraRuns.find((r) => r.status === "queued");
    const rowOf = async (question: string) => (await consultations()).find((c) => c.question === question);
    expect(await rowOf("Faz o merge do PR #7.")).toMatchObject({ status: "open", targetRunId: paused?.id });
    expect(await rowOf("E confere a fila de jobs.")).toMatchObject({ status: "open", targetRunId: own?.id });
    // That note is being worked on again: Ops's result waits for it.
    expect(await notesBack()).toEqual([]);

    await release(infra.id);
    expect(await rowOf("E confere a fila de jobs.")).toMatchObject({
      status: "answered",
      answer: "Fila vazia: 0 jobs.",
    });
    const back = await notesBack();
    expect(back.map((m) => [refsOf(m).agentId, refsOf(m).wake ?? null, refsOf(m).pending ?? null])).toEqual([
      [ops.id, null, null],
      [infra.id, "1", "@infra"],
    ]);
    const read = f.provider.calls.map((c) => lastText(c.request)).find((t) => t.includes("Fila vazia: 0 jobs."));
    expect(read).toContain("Still out, waiting on a person or a computer: @infra.");
    expect(await rowOf("Faz o merge do PR #7.")).toMatchObject({ status: "open" });
  });

  test("between agents, only what this run handed on keeps its promise, not what another run there handed on", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    await addInfra();
    await addAgent("Ops");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const first = await runFor((await consultations())[0]);
    await tell(first, "@ops", "Limpa a fila de jobs.");
    await ended(first.id);
    const again = await devRun("@dev pede ao infra outra coisa");
    await ended(again.id);
    await tell(again, "@infra", "Atualiza o certificado do staging.");
    const second = await runFor((await consultations()).find((c) => c.askerRunId === again.id));
    expect(second.id).not.toBe(first.id);
    expect(await wakesLater(f.db, second)).toBe(false);
    await tell(second, "@ops", "Renova o certificado do balanceador.");
    expect(await wakesLater(f.db, second)).toBe(true);
  });

  test("an agent that fails after handing part on: what it owed fails at once, and what comes back later wakes nobody", async () => {
    f = await setup({ askAgent: true, judge: notesMatter });
    const infra = await addInfra();
    await addAgent("Ops");
    const dev = await devRun("@dev pede ao infra");
    await ended(dev.id);
    await tell(dev, "@infra", "Cuida do deploy de staging.");
    const toInfra = (await consultations())[0];
    const infraRun = await runFor(toInfra);
    await tell(infraRun, "@ops", "Limpa a fila de jobs.");
    const toOps = (await consultations()).find((c) => c.askerRunId === infraRun.id);
    await f.db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.id, infraRun.id));
    await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, infraRun, "failed", "model_error");
    expect((await consultations()).find((c) => c.id === toInfra?.id)).toMatchObject({
      status: "failed",
      answer: "model_error",
    });
    const [failed] = await notesBack();
    expect(failed?.meta.notice).toMatchObject({ refs: { status: "failed" } });
    expect(failed?.meta.notice).toMatchObject({ text: expect.stringMatching(/^It couldn't finish \(model_error;/) });
    expect(await runsOf(f.agent.id)).toHaveLength(2);

    await answered(await runFor(toOps), "Fila limpa.");
    expect(await runsOf(infra.id)).toHaveLength(1);
    expect(await runsOf(f.agent.id)).toHaveLength(2);
  });

  test("nothing expires while a colleague is at it, waiting on a person or on what it handed on; one nobody started does", async () => {
    f = await setup({ askAgent: true });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    const qa = await addAgent("QA");
    const max = await addAgent("Max");
    const events = f.listen(f.general.id);
    const dev = await devRun("@dev confere tudo do deploy");
    await ended(dev.id);
    for (const handle of ["@infra", "@ops", "@qa", "@max"]) await tell(dev, handle, `Confere o deploy (${handle}).`);
    const rowOf = async (agentId: string) => (await consultations()).find((c) => c.targetAgentId === agentId);
    const status = (run: AgentRun, s: AgentRun["status"]) =>
      f.db.update(schema.agentRuns).set({ status: s }).where(eq(schema.agentRuns.id, run.id));
    await status(await runFor(await rowOf(infra.id)), "running");
    await status(await runFor(await rowOf(ops.id)), "waiting_approval");
    const qaRun = await runFor(await rowOf(qa.id));
    await tell(qaRun, "@infra", "Quanto tempo o deploy levou?");
    await status(qaRun, "done");
    // Max's run was held by the stretch: nobody started it.
    await f.db
      .update(schema.agentConsultations)
      .set({ targetRunId: null })
      .where(eq(schema.agentConsultations.targetAgentId, max.id));
    await Bun.sleep(5);
    const mark = events.length;

    const later = new Date(Date.now() + CONSULTATION_TTL_MS + 1000);
    expect(await expireConsultations({ db: f.db, pubsub: f.pubsub }, later)).toBe(1);
    for (const agentId of [infra.id, ops.id, qa.id]) {
      const row = await rowOf(agentId);
      expect(row?.status).toBe("open");
      expect(row?.expiresAt.getTime()).toBeGreaterThan(later.getTime());
    }
    expect((await rowOf(max.id))?.status).toBe("expired");
    expect((await runs()).some((r) => r.status === "canceled")).toBe(false);
    await Bun.sleep(5);
    expect(events.slice(mark)).toContainEqual(expect.objectContaining({ type: "agent.consultation", runId: dev.id }));
    // QA still waits on what it handed on: Max's "never got to it" waits to go out with the rest.
    expect(await notesBack()).toEqual([]);
  });

  test("a note the stretch held is taken by the run Continuar starts, and its result comes back", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: (req) => (youAre(req, "Infra") ? answer("Feito: fila limpa.") : answer("ok")),
    });
    const infra = await addInfra();
    const dev = await devRun("@dev pede ao infra para limpar a fila");
    // Ana's stretch is at its limit: agents already started 50 runs on their own.
    await f.db.insert(schema.agentRuns).values(
      Array.from({ length: STRETCH.runs }, () => ({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: dev.threadRootId,
        triggerMessageId: Bun.randomUUIDv7(),
        trigger: "mention" as const,
        hop: 2,
        stretchId: dev.stretchId,
        status: "done" as const,
      })),
    );
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
    const id = Bun.randomUUIDv7();
    // Past the tool's own check, the wake-up is held (another wake-up took the last run meanwhile).
    await f.db.transaction(async (tx) => {
      const note = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: dm.id,
        author: { type: "agent", agentId: f.agent.id, runId: dev.id, hop: dev.hop },
        body: "Limpa a fila de jobs.",
        meta: { agentNote: { runId: dev.id }, consultation: { id } },
      });
      expect(await startOrJoinRun(tx, note, infra.id, "dm")).toBeNull();
      await tx.insert(schema.agentConsultations).values({
        id,
        orgId: f.org.id,
        kind: "note",
        askerRunId: dev.id,
        askerAgentId: f.agent.id,
        targetAgentId: infra.id,
        channelId: dm.id,
        messageId: note.id,
        targetRunId: null,
        waitId: `async:${Bun.randomUUIDv7()}`,
        question: note.body,
        chain: [f.agent.id],
        expiresAt: new Date(Date.now() + CONSULTATION_TTL_MS),
      });
    });
    await drainOutbox(f.db, f.handlers);
    const card = (await f.db.select().from(schema.messages)).find((m) => stretchCardOf(m.meta));
    if (!card) throw new Error("no card");
    const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
    expect((await consultations())[0]?.targetRunId).toBe(go.runs[0]?.runId ?? "");
    await drainOutbox(f.db, f.handlers);
    expect((await consultations())[0]).toMatchObject({ status: "answered", answer: "Feito: fila limpa." });
  });

  test("a note sent before notes were rows still comes back as before; one with a row never comes back that way", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: (req) => (youAre(req, "Infra") ? answer("Taxa de erro normal.") : answer("ok")),
    });
    const infra = await addInfra();
    const dev = await devRun("@dev avisa o infra");
    await ended(dev.id);
    const dm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
    const legacy = () =>
      f.db.select().from(schema.messages).where(sql`${schema.messages.meta}->'notice'->>'kind' = 'agent_note'`);
    await f.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: dm.id,
        author: { type: "agent", agentId: f.agent.id, runId: dev.id, hop: dev.hop },
        body: "O deploy terminou.",
        meta: { agentNote: { runId: dev.id } },
      });
      await createAgentRuns(tx, m, [infra.id], "dm");
    });
    await drainOutbox(f.db, f.handlers);
    expect((await legacy()).map((m) => m.channelId)).toEqual([f.general.id]);

    // A note with a row whose row is already closed (it expired): its run's end adds nothing.
    await tell(dev, "@infra", "E a fila?");
    await f.db
      .update(schema.agentConsultations)
      .set({ status: "expired", answeredAt: new Date(), reportedAt: new Date() });
    await drainOutbox(f.db, f.handlers);
    expect(await legacy()).toHaveLength(1);
  });

  test("stopping or deleting the agent at work closes what it owed as failed, and the sender hears it once", async () => {
    f = await setup({
      askAgent: true,
      judge: notesMatter,
      reply: handing(
        [
          { agent: "@infra", message: "Confere a taxa de erro." },
          { agent: "@ops", message: "Confere a fila." },
        ],
        {},
      ),
    });
    const infra = await addInfra();
    const ops = await addAgent("Ops");
    const { handlers } = holding(infra.id, ops.id);
    await post("@dev confere o deploy com o infra e o ops");
    await drainOutbox(f.db, handlers);
    const [infraRun] = await runsOf(infra.id);
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, infraRun?.id ?? "");
    // Ops is still on its part: nothing goes out yet.
    expect(await notesBack()).toEqual([]);
    await deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, ops.id);
    expect((await consultations()).map((c) => [c.status, c.answer])).toEqual([
      ["failed", expect.stringContaining("stopped it on purpose")],
      ["failed", "agent_archived"],
    ]);
    await drainOutbox(f.db, handlers);
    expect(await expireConsultations({ db: f.db }, new Date(Date.now() + CONSULTATION_TTL_MS + 1000))).toBe(0);
    await drainOutbox(f.db, handlers);
    expect((await notesBack()).map((m) => refsOf(m).status)).toEqual(["failed", "failed"]);
    expect(await runsOf(f.agent.id)).toHaveLength(2);
  });
});
