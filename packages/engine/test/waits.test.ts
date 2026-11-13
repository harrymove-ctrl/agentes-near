import { afterEach, describe, expect, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  answerQuestion,
  BROWSER_SCOPE,
  createAgent,
  createBrowserHandoffToolSource,
  drainOutbox,
  enqueue,
  finishHandoff,
  grantScopes,
  type JobHandlers,
  type MachineCaller,
  type MachineStatus,
  openConsultationsIn,
  postPersonMessage,
  resumeRunWithResult,
  stopChecksSettled,
} from "../src";
import { currentWaits, detachWaits, onMessageWhileWaiting } from "../src/waits";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const allText = (req: ModelRequest) => JSON.stringify(req.messages);
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const runs = () => f.db.select().from(schema.agentRuns);
const handoffs = () => f.db.select().from(schema.browserHandoffs);
const notices = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => (m.meta as { notice?: unknown }).notice);
/** A person's message, in a thread (`threadId`: reaches the agent's run working there) or the channel. */
const say = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub, judge: f.context.judge }, f.owner.id, f.org.id, f.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });
const waitMessages = (events: RealtimeEvent[]) =>
  events.filter((e) => (e as { type: string }).type === "agent.run.wait_message") as unknown as {
    waitKind: string;
    outcome: string;
  }[];

/** Computers whose browser is ready, as the browser tools see them (no runner socket in these tests). */
const ready = new Set<string>();
const readyHub: MachineCaller = {
  async status(id): Promise<MachineStatus | null> {
    if (!ready.has(id)) return null;
    return {
      id,
      orgId: f.org.id,
      name: "MacBook",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 12,
      executors: { browser: { available: true, version: "0.39.1" } },
      paused: null,
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    } as MachineStatus;
  },
  async call() {
    throw new Error("no runner in these tests");
  },
};

/** "sign in" asks a person for help in the browser; after a tool result it says `after` ("Ok."). */
const browserReply =
  (after = "Ok.") =>
  (req: ModelRequest) => {
    const last = lastText(req);
    if (last.includes("tool_result")) return { chunks: [after] };
    if (last.includes("sign in"))
      return { chunks: [], toolUses: [{ name: "browser_ask_person", input: { instructions: "Sign in to Stripe" } }] };
    return { chunks: ["Noted."] };
  };

/** `followThrough`: what the judge says of a promise at the end of a reply. */
async function startBrowser(
  intent: "done" | "failed" | "other",
  options: { after?: string; followThrough?: string } = {},
) {
  ready.clear();
  f = await setup({
    reply: browserReply(options.after),
    machines: true,
    toolSources: [createBrowserHandoffToolSource({ machines: { hub: readyHub } })],
    judge: (kind, id) =>
      kind === "handoff_reply" && id === "intent"
        ? intent
        : kind === "follow_through"
          ? options.followThrough
          : undefined,
  });
  const machine = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  ready.add(machine.machineId);
  const ask = await say("@dev sign in please");
  await drainOutbox(f.db, f.handlers);
  expect((await runs())[0]?.status).toBe("waiting_input");
  return ask;
}

describe("a person's message while a run waits for help in the browser", () => {
  test('"pronto, loguei" ends the help as done and the run goes on, reading the message', async () => {
    const ask = await startBrowser("done");
    const events = f.listen(f.general.id);
    await say("pronto, loguei", ask.id);
    await stopChecksSettled();

    expect((await handoffs())[0]?.status).toBe("done");
    expect(waitMessages(events)).toEqual([
      expect.objectContaining({ waitKind: "browser_handoff", outcome: "resolved" }),
    ]);
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    const resumed = f.provider.calls.at(-1)?.request as ModelRequest;
    expect(allText(resumed)).toContain("The person says it's done");
    expect(allText(resumed)).toContain("pronto, loguei");
    expect(f.context.judge).toBeDefined();
  });

  test("anything else wakes the run; the help stays open and its result comes later as a notice", async () => {
    const ask = await startBrowser("other");
    const [h] = await handoffs();
    const events = f.listen(f.general.id);
    await say("while you wait: which account is it?", ask.id);
    await stopChecksSettled();
    expect(waitMessages(events)).toEqual([expect.objectContaining({ waitKind: "browser_handoff", outcome: "woke" })]);
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run?.status).toBe("done");
    const detached = (run?.transcript as { detachedWaits?: { waitId: string }[] } | null)?.detachedWaits;
    expect(detached?.map((d) => d.waitId)).toEqual([String(h?.id)]);
    const woke = f.provider.calls.at(-1)?.request as ModelRequest;
    expect(allText(woke)).toContain("Still open: your request for a person's help in your browser");
    expect(allText(woke)).toContain("which account is it?");
    // Still open: the card stays.
    expect((await handoffs())[0]?.status).toBe("pending");

    // The person finishes it on the card later: the agent hears it as a notice (a new run, the old one ended).
    await finishHandoff({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, h?.id ?? "", { result: "done" });
    const [notice] = await notices();
    expect(notice?.meta.notice).toMatchObject({
      kind: "wait_result",
      from: "Your request for help in the browser",
      refs: { waitId: h?.id, runId: run?.id },
    });
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.status === "done")).toBe(true);
    expect(allText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person says it's done");
    // Once: a sweep resuming again finds it delivered.
    expect(
      await resumeRunWithResult(f.db, { runId: run?.id ?? "", waitId: h?.id ?? "", result: { content: "again" } }),
    ).toBeNull();
    expect(await notices()).toHaveLength(1);
  });

  test("a promise to go on once the help is done gets no nudge: the help's result will wake the agent", async () => {
    const ask = await startBrowser("other", {
      after: "It's the Stripe account. I'll continue as soon as you finish signing in.",
      followThrough: "continue",
    });
    await say("while you wait: which account is it?", ask.id);
    await stopChecksSettled();
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    // What the run waits on brings it back: not judged, no more turns (ADR 0097).
    const judged = (f.context.judge as unknown as { calls: { kind: string }[] }).calls;
    expect(judged.filter((j) => j.kind === "follow_through").length).toBe(0);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "promise")).toEqual([]);
  });

  test('no judge: even "pronto" only wakes the run (the help stays open)', async () => {
    const ask = await startBrowser("done");
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "pronto",
      threadId: ask.id,
    });
    await stopChecksSettled();
    expect(waitMessages(events)).toEqual([expect.objectContaining({ waitKind: "browser_handoff", outcome: "woke" })]);
    expect((await handoffs())[0]?.status).toBe("pending");
  });
});

describe("approvals hold the run, never the agent", () => {
  test("a message never decides an approval, nor waits behind it: the agent answers it in a run of its own", async () => {
    const github = fakeGithub();
    f = await setup({
      toolSources: [github.source],
      reply: (req) =>
        lastText(req).includes("tool_result")
          ? { chunks: ["Merged."] }
          : lastText(req).includes("merge the fix") && !lastText(req).includes("approved")
            ? {
                chunks: [],
                toolUses: [
                  {
                    name: "github_merge_pr",
                    input: {
                      repo: "acme/app",
                      pr: 7,
                      why: "The fix passed CI and review; merging ships it to production.",
                    },
                  },
                ],
              }
            : { chunks: ["Use the card to approve it."] },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const ask = await say("@dev merge the fix");
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("waiting_approval");
    const events = f.listen(f.general.id);
    // A reply in its thread, no mention: the waiting run takes nothing new.
    const sent = await say("yes go ahead, approved", ask.id);
    await stopChecksSettled();
    await drainOutbox(f.db, f.handlers);

    expect(waitMessages(events)).toEqual([]);
    const all = (await runs()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(all).toHaveLength(2);
    expect(all[0]?.status).toBe("waiting_approval");
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(sent.id);
    expect(all[1]?.status).toBe("done");
    expect(github.executed).toHaveLength(0);
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("pending");
  });
});

describe("waits of a computer brain (bridged calls)", () => {
  test("a bridged wait is seen and detached like the model brain's", async () => {
    f = await setup({});
    const message = await say("@dev hi");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    const waitId = "decision-1";
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: {
          system: [],
          messages: [],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
          pending: {
            calls: [
              { toolUseId: "t1", name: "ask_decision", bridged: true, waitId },
              { toolUseId: "t2", name: "ask_user", bridged: true, questionId: "q-1" },
            ],
          },
        },
      })
      .where(eq(schema.agentRuns.id, run.id));
    const [waiting] = await runs();
    if (!waiting) throw new Error("no run");
    expect(await currentWaits(f.db, waiting)).toEqual([
      { kind: "mission", id: waitId, toolName: "ask_decision", bridged: true },
      { kind: "question", id: "q-1", toolName: "ask_user", bridged: true },
    ]);
    // A mission's own wait is never detached by a message (null: read when it resumes).
    const [row] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
    if (!row) throw new Error("no message");
    expect(await onMessageWhileWaiting({ db: f.db, pubsub: f.pubsub }, waiting, row)).toBeNull();

    expect(
      await detachWaits(f.db, run.id, [{ waitId, kind: "mission", text: "Still open: x.", from: "Your decision" }]),
    ).toBe(true);
    const [after] = await runs();
    const t = after?.transcript as {
      pending: { calls: { waitId?: string; result?: unknown }[] };
      detachedWaits: unknown[];
    };
    expect(t.pending.calls[0]?.result).toEqual({ content: "Still open: x.", isError: false });
    expect(t.detachedWaits).toEqual([expect.objectContaining({ waitId, kind: "mission", from: "Your decision" })]);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
    expect(jobs.some((j) => j.dedupeKey?.startsWith(`agent_run.execute:${run.id}:detach:`))).toBe(true);
    // Detached once: nothing left to detach.
    expect(await detachWaits(f.db, run.id, [{ waitId, kind: "mission", text: "again", from: "Your decision" }])).toBe(
      false,
    );
  });
});

// ── Agents talking to each other ─────────────────────────────────────────────

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

/** Drops @infra's execute jobs (it never runs) until `release` re-queues them. */
function holdInfra(infraId: string) {
  const held: string[] = [];
  const handlers: JobHandlers = {
    ...f.handlers,
    "agent_run.execute": async (job, ctx) => {
      const runId = String(job.payload.runId);
      const [run] = await f.db
        .select({ agentId: schema.agentRuns.agentId })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runId));
      if (run?.agentId === infraId && !held.includes(runId)) {
        held.push(runId);
        return;
      }
      await f.handlers["agent_run.execute"]?.(job, ctx);
    },
  };
  const release = async () => {
    for (const runId of held) {
      await enqueue(f.db, {
        orgId: f.org.id,
        kind: "agent_run.execute",
        payload: { runId },
        dedupeKey: `test:release:${runId}`,
      });
    }
  };
  return { handlers, release };
}

describe("ask_agent", () => {
  test("by default the asker carries on; the answer reaches it later as a notice (a new run)", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Staging deploys with deploy.sh"] };
        const last = lastText(req);
        if (last.includes("your question to @infra")) return { chunks: ["Infra says: deploy.sh"] };
        if (last.includes("tool_result")) return { chunks: ["I asked Infra; I'll tell you."] };
        if (last.includes("deploy"))
          return {
            chunks: [],
            toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?" } }],
          };
        return { chunks: ["ok"] };
      },
    });
    const infra = await addInfra();
    await say("@dev how do we deploy to staging?");
    await drainOutbox(f.db, f.handlers);

    const [c] = await f.db.select().from(schema.agentConsultations);
    expect(c).toMatchObject({ status: "answered", answer: "Staging deploys with deploy.sh" });
    expect(c?.waitId.startsWith("async:")).toBe(true);
    const asked = f.provider.calls.find((x) => lastText(x.request).includes("Asked @infra."));
    expect(asked).toBeDefined();
    const [notice] = await notices();
    expect(notice?.channelId).toBe(f.general.id);
    expect(notice?.meta.notice).toMatchObject({ kind: "consult_reply", from: "@infra" });
    // No @mention for people: another agent's words never start a run.
    expect(notice?.mentionedAgentIds).toEqual([]);
    const devRuns = (await runs()).filter((r) => r.agentId === f.agent.id);
    expect(devRuns).toHaveLength(2);
    expect(devRuns.every((r) => r.status === "done")).toBe(true);
    expect((await runs()).find((r) => r.agentId === infra.id)?.status).toBe("done");
    expect(allText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain(
      "[Reply to your question to @infra]: Staging deploys with deploy.sh",
    );
  });

  test("a question to an agent whose run waits on an approval doesn't wait behind it; the asker's line stays", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Answer from Infra"] };
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["I asked Infra; I'll tell you."] };
        if (last.includes("deployed"))
          return {
            chunks: [],
            toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "How is it deployed?" } }],
          };
        return { chunks: ["ok"] };
      },
    });
    const infra = await addInfra();
    const hold = holdInfra(infra.id);
    await say("@dev how is staging deployed?");
    await drainOutbox(f.db, hold.handlers);
    const [first] = await f.db.select().from(schema.agentConsultations);
    if (!first?.targetRunId) throw new Error("no consultation");
    expect(first.status).toBe("open");
    // The asking turn ended ("I'll tell you"): the question is still out, and the conversation says so.
    expect(await openConsultationsIn(f.db, f.org.id, f.general.id)).toEqual([
      expect.objectContaining({ runId: first.askerRunId, agentId: f.agent.id, consultedAgentId: infra.id }),
    ]);
    // Infra's run there now waits on an approval (from the person's earlier request).
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_approval" })
      .where(eq(schema.agentRuns.id, first.targetRunId));

    await say("@dev and how is production deployed?");
    await drainOutbox(f.db, hold.handlers);
    const asked = (await f.db.select().from(schema.agentConsultations)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    expect(asked).toHaveLength(2);
    expect(asked[1]?.targetRunId).not.toBeNull();
    expect(asked[1]?.targetRunId).not.toBe(first.targetRunId);
    const held = (await runs()).find((r) => r.id === first.targetRunId);
    expect(held?.status).toBe("waiting_approval");
    expect(held?.pendingMessageIds).toEqual([]);
    expect(await openConsultationsIn(f.db, f.org.id, f.general.id)).toHaveLength(2);
  });

  test("an answer while the asker is still active is read by that run at its next step", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Staging deploys with deploy.sh"] };
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["Done."] };
        if (last.includes("deploy"))
          return {
            chunks: [],
            toolUses: [
              { name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?" } },
              {
                name: "ask_user",
                input: {
                  why: "I need a person's answer before I go on: this decides what I change next.",
                  question: "Which env?",
                  choices: ["staging", "production"],
                },
              },
            ],
          };
        return { chunks: ["ok"] };
      },
    });
    await addInfra();
    await say("@dev deploy please");
    await drainOutbox(f.db, f.handlers);
    const dev = (await runs()).find((r) => r.agentId === f.agent.id);
    expect(dev?.status).toBe("waiting_input");
    const [notice] = await notices();
    expect(dev?.pendingMessageIds).toEqual([String(notice?.id)]);

    const [q] = await f.db.select().from(schema.agentQuestions);
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "staging" });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
    expect((await runs()).find((r) => r.id === dev?.id)?.status).toBe("done");
    expect(allText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain(
      "[Reply to your question to @infra]: Staging deploys with deploy.sh",
    );
  });

  test("ask_agent never pauses: a wait the model asks for is refused by the schema", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Staging deploys with deploy.sh"] };
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["Asked @infra; I'll relay it."] };
        if (last.includes("deploy"))
          return {
            chunks: [],
            toolUses: [
              { name: "ask_agent", input: { agent: "@infra", question: "How is staging deployed?", wait: true } },
            ],
          };
        return { chunks: ["ok"] };
      },
    });
    const infra = await addInfra();
    const { handlers } = holdInfra(infra.id);
    await say("@dev deploy please");
    await drainOutbox(f.db, handlers);
    // The input with `wait` is invalid (no such option): nothing asked, the run never paused.
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(0);
    expect((await runs()).find((r) => r.agentId === f.agent.id)?.status).toBe("done");
  });
});

describe("tell_agent", () => {
  const tellReply =
    (infraSays: (req: ModelRequest) => FakeReply) =>
    (req: ModelRequest): FakeReply => {
      if (inAgentDm(req)) return infraSays(req);
      const last = lastText(req);
      if (last.includes("did with the work you handed it")) return { chunks: ["Infra says the error rate is normal."] };
      if (last.includes("tool_result")) return { chunks: ["Told Infra."] };
      if (last.includes("deployed"))
        return {
          chunks: [],
          toolUses: [
            { name: "tell_agent", input: { agent: "@infra", message: "Deploy finished; watch the error rate." } },
          ],
        };
      return { chunks: ["ok"] };
    };

  test("a note doesn't block; what came of it comes back by itself, as what was done with the work", async () => {
    f = await setup({
      askAgent: true,
      // The judge reads the reply as one that tells the sender something (ADR 0089).
      judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
      reply: tellReply(() => ({ chunks: ["Error rate is 0.1%, normal. I'll keep watching it for the next hour."] })),
    });
    const infra = await addInfra();
    await say("@dev we deployed v2");
    await drainOutbox(f.db, f.handlers);

    const told = f.provider.calls.find((x) => lastText(x.request).includes("Handed to @infra; it's on it"));
    expect(told).toBeDefined();
    const dm = (await f.db.select().from(schema.messages)).find((m) => (m.meta as { agentNote?: unknown }).agentNote);
    expect(dm?.body).toBe("Deploy finished; watch the error rate.");
    expect(dm?.authorAgentId).toBe(f.agent.id);
    expect((await runs()).find((r) => r.agentId === infra.id)).toMatchObject({
      channelId: dm?.channelId,
      status: "done",
    });
    expect(await f.db.select().from(schema.agentConsultations)).toMatchObject([
      { kind: "note", messageId: dm?.id, status: "answered" },
    ]);
    const [notice] = await notices();
    expect(notice?.meta.notice).toMatchObject({ kind: "consult_reply", from: "@infra", refs: { kind: "note" } });
    expect(allText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain(
      "[What @infra did with the work you handed it]: Error rate is 0.1%",
    );
  });

  test("an acknowledgement isn't passed back, and the answering agent can't note back (no ping-pong)", async () => {
    f = await setup({
      askAgent: true,
      reply: tellReply((req) =>
        lastText(req).includes("tool_result")
          ? { chunks: ["Got it."] }
          : { chunks: [], toolUses: [{ name: "tell_agent", input: { agent: "@dev", message: "Thanks, watching." } }] },
      ),
    });
    await addInfra();
    await say("@dev we deployed v2");
    await drainOutbox(f.db, f.handlers);
    expect(await notices()).toHaveLength(0);
    const refused = f.provider.calls.find((x) => inAgentDm(x.request) && lastText(x.request).includes("tool_result"));
    expect(lastText(refused?.request as ModelRequest)).toContain("You are answering @dev already");
    expect((await runs()).every((r) => r.status === "done")).toBe(true);
  });
});
