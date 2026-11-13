import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ContentBlock, ModelRequest } from "@agenteschat/providers";
import {
  ConflictError,
  cancelRun,
  continuedTranscript,
  continueRun,
  createAgent,
  createAgentRuns,
  createJobHandlers,
  createPassToolSource,
  drainOutbox,
  insertMessage,
  postPersonMessage,
  queueOnRun,
  type ToolSource,
  type Transcript,
  WRAP_UP_REPLY_NOTE,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * A conversation run at its cap of model calls: told once to wrap up near it, it ends done with where it
 * stands and Continuar instead of failing; Continuar replays its conversation with the same tools.
 */

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string) => postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body });
const runs = () => f.db.select().from(schema.agentRuns);
const agentMessages = async (runId: string) =>
  (await f.db.select().from(schema.messages)).filter((m) => m.agentRunId === runId);
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content ?? "");
const handlers = (maxToolTurns: number) => createJobHandlers({ ...f.jobDeps, maxToolTurns });

/** A read tool (core), and one more that tools on demand keep behind `find_tools`. */
function workTools(): ToolSource {
  const schemaless = { type: "object", properties: {} };
  return {
    name: "work",
    tools: async () => [
      {
        name: "look",
        description: "Look at the open pull requests",
        scope: "context:read",
        inputSchema: schemaless,
        execute: async () => ({ content: "3 PRs open" }),
      },
      {
        name: "file_issue",
        description: "File an issue",
        scope: "drive:write",
        inputSchema: schemaless,
        execute: async () => ({ content: "Issue #7 created" }),
      },
    ],
  };
}

/** A thinking block as Claude returns it at low effort: no text, only its signature. */
const thinking = { type: "thinking", thinking: "", signature: "sig-1" };

describe("a conversation run near its step limit", () => {
  test("it is told once to say where it stands, with its tools still there; its reply offers Continuar", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: (req) =>
        lastText(req).includes(WRAP_UP_REPLY_NOTE)
          ? { chunks: ["Vi 3 PRs. Falta revisar o #42."] }
          : { chunks: [], toolUses: [{ name: "look", input: {} }] },
    });
    await ask("@dev revisa os PRs");
    await drainOutbox(f.db, handlers(4));

    const requests = f.provider.calls.map((c) => c.request);
    expect(requests).toHaveLength(3);
    expect(lastText(requests[1] as ModelRequest)).not.toContain(WRAP_UP_REPLY_NOTE);
    expect(lastText(requests[2] as ModelRequest)).toContain(WRAP_UP_REPLY_NOTE);
    expect(requests[2]?.tools?.map((t) => t.name)).toContain("look");
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", error: null, turns: 3 });
    const [reply] = await agentMessages(run?.id ?? "");
    expect(reply?.body).toBe("Vi 3 PRs. Falta revisar o #42.");
    expect(reply?.meta.stepLimit).toEqual({});
    expect(run?.replyMessageId).toBe(reply?.id ?? "");
  });

  test("at the cap, an answer with a message waiting ends the run, and the message gets a run of its own", async () => {
    let queued = "";
    const queueOne = async () => {
      const [run] = await runs();
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: null,
        author: { type: "person", userId: f.owner.id },
        body: "e o staging?",
      });
      queued = m.id;
      await queueOnRun(f.db, run?.id ?? "", m.id);
    };
    f = await setup({
      toolSources: [workTools()],
      reply: (_req, n) =>
        n === 1
          ? { chunks: [], toolUses: [{ name: "look", input: {} }] }
          : n === 2
            ? { chunks: ["Vi 3 PRs."], hold: queueOne() }
            : { chunks: ["Staging ok."] },
    });
    await ask("@dev revisa os PRs");
    await drainOutbox(f.db, handlers(2));

    const [first] = await runs();
    expect(first).toMatchObject({ status: "done", turns: 2 });
    const posted = await agentMessages(first?.id ?? "");
    expect(posted.map((m) => [m.body, m.meta.stepLimit])).toEqual([["Vi 3 PRs.", {}]]);
    const [own] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, queued));
    expect(own).toMatchObject({ trigger: "mention", status: "done" });
  });
});

describe("a conversation run that reaches its step limit mid-work", () => {
  /** A run that never stops calling tools, each turn with a thinking block, under tools on demand. */
  async function cappedRun() {
    f = await setup({
      toolSources: [workTools()],
      toolsOnDemand: true,
      reply: (_req, n) =>
        n <= 3
          ? { chunks: ["Olhando os PRs."], opaque: [thinking], toolUses: [{ name: "look", input: {} }] }
          : { chunks: ["Revisei o #42 também."] },
    });
    await ask("@dev revisa os PRs");
    await drainOutbox(f.db, handlers(3));
    const [run] = await runs();
    return run as NonNullable<typeof run>;
  }

  test("ends done with a line that says it ran out of steps, never a failure", async () => {
    const run = await cappedRun();
    expect(f.provider.calls).toHaveLength(3);
    expect(run).toMatchObject({ status: "done", error: null, turns: 3 });
    const posted = await agentMessages(run.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toBe("I ran out of steps before finishing.");
    expect(posted[0]?.meta).toMatchObject({ bodyCode: "step_limit", stepLimit: {} });
    expect(run.replyMessageId).toBe(posted[0]?.id ?? "");
  });

  test("Continuar replays its conversation with the same system and tools, then who asked to go on", async () => {
    const stopped = await cappedRun();
    const last = f.provider.calls.at(-1)?.request as ModelRequest;
    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped.id);
    const [reply] = await agentMessages(stopped.id);
    expect(reply?.meta.stepLimit).toMatchObject({ continuedRunId: runId, continuedByUserId: f.owner.id });
    await expect(continueRun(deps(), f.owner.id, f.org.id, stopped.id)).rejects.toMatchObject({
      code: "run.not_continuable",
    });
    await drainOutbox(f.db, handlers(3));

    const [, next] = (await runs()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(next).toMatchObject({ id: runId, status: "done", turns: 1 });
    const sent = f.provider.calls[3]?.request as ModelRequest;
    // A thinking block stays valid only while everything before it is unchanged: the same system and tools,
    // its messages as they were (thinking blocks included), and only then the line from the person.
    expect(sent.system).toEqual(last.system);
    expect(sent.tools).toEqual(last.tools);
    const before = (stopped.transcript as unknown as Transcript).messages;
    const results = before.at(-1)?.content as ContentBlock[];
    expect(sent.messages).toEqual([
      ...before.slice(0, -1),
      {
        role: "user",
        content: [...results, { type: "text", text: "[ana asked you to continue from where you stopped.]" }],
      },
    ]);
    expect(JSON.stringify(sent.messages)).toContain('"signature":"sig-1"');
  });

  test("Continuar deep in agents' work starts at hop 1 in a stretch of its own (ADR 0089)", async () => {
    const stopped = await cappedRun();
    await f.db.update(schema.agentRuns).set({ hop: 7 }).where(eq(schema.agentRuns.id, stopped.id));
    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped.id);
    const [next] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    expect(next).toMatchObject({ hop: 1, stretchId: runId });
  });

  test("a run the router brought in: Continuar sends the same tools, `pass` included, though it may no longer pass", async () => {
    f = await setup({
      toolSources: [createPassToolSource(), workTools()],
      reply: (_req, n) =>
        n <= 3
          ? { chunks: [], opaque: [thinking], toolUses: [{ name: "look", input: {} }] }
          : n === 4
            ? { chunks: [], toolUses: [{ name: "pass", input: { reason: "nada a acrescentar" } }] }
            : { chunks: ["Revisei o #42 também."] },
    });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "alguém olha os PRs?",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "router"));
    await drainOutbox(f.db, handlers(3));
    const [stopped] = await runs();
    const last = f.provider.calls.at(-1)?.request as ModelRequest;
    expect(last.tools?.map((t) => t.name)).toContain("pass");

    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped?.id ?? "");
    await drainOutbox(f.db, handlers(3));
    const sent = f.provider.calls[3]?.request as ModelRequest;
    expect(sent.tools).toEqual(last.tools);
    expect(JSON.stringify(sent.messages)).toContain('"signature":"sig-1"');
    // A person asked it to go on: its `pass` is refused, and it answers.
    expect((await agentMessages(runId)).map((m) => m.body)).toEqual(["Revisei o #42 também."]);
  });

  test("a member who pressed Continuar asked for the run it started: they may continue it again, and stop it", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: () => ({ chunks: [], toolUses: [{ name: "look", input: {} }] }),
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: bia.id },
      body: "@dev olha os PRs",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "mention"));
    await drainOutbox(f.db, handlers(2));
    const [first] = await runs();

    const { runId: second } = await continueRun(deps(), bia.id, f.org.id, first?.id ?? "");
    await drainOutbox(f.db, handlers(2));
    expect((await agentMessages(second))[0]?.meta.bodyCode).toBe("step_limit");
    const { runId: third } = await continueRun(deps(), bia.id, f.org.id, second);
    await expect(cancelRun(deps(), bia.id, f.org.id, third)).resolves.toMatchObject({ status: "canceled" });
  });

  test("a run another agent woke: the member behind the work may stop it and continue it, another member may not", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: () => ({ chunks: [], toolUses: [{ name: "look", input: {} }] }),
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "QA", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: bia.id },
      body: "@dev olha os PRs",
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
    const devWakesTheo = async (body: string) => {
      const handed = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: asked.id,
        author: { type: "agent", agentId: f.agent.id, runId: dev?.id ?? "", hop: 1 },
        body,
      });
      const [run] = await f.db.transaction((tx) => createAgentRuns(tx, handed, [theo.id], "mention"));
      return run?.id ?? "";
    };

    const queued = await devWakesTheo("@theo roda os testes");
    await expect(cancelRun(deps(), bia.id, f.org.id, queued)).resolves.toMatchObject({ status: "canceled" });
    const capped = await devWakesTheo("@theo revisa o #42");
    await drainOutbox(f.db, handlers(2));
    expect((await agentMessages(capped))[0]?.meta.bodyCode).toBe("step_limit");
    await expect(continueRun(deps(), carl.id, f.org.id, capped)).rejects.toMatchObject({
      code: "run.continue_forbidden",
    });
    await expect(continueRun(deps(), bia.id, f.org.id, capped)).resolves.toMatchObject({ runId: expect.any(String) });
  });

  test("a run that ended done any other way can't be continued", async () => {
    f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
    await ask("@dev oi");
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    expect(run?.status).toBe("done");
    const refused = continueRun(deps(), f.owner.id, f.org.id, run?.id ?? "");
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(continueRun(deps(), f.owner.id, f.org.id, run?.id ?? "")).rejects.toMatchObject({
      code: "run.not_continuable",
    });
  });
});

test("Continuar keeps the tools and the model the run chose: the same request, so its thinking blocks stay valid", () => {
  const stopped: Transcript = {
    system: [{ text: "You are Dev." }],
    messages: [{ role: "assistant", content: [{ type: "text", text: "Vi 3 PRs." }] }],
    toolGroups: ["drive"],
    autoModel: { tier: "small", effort: "low", reason: "simple", source: "judge" },
    postedUpTo: 1,
    postedCount: 1,
    deltaSeq: 4,
  };
  const next = continuedTranscript(stopped, "[ana asked you to continue from where you stopped.]");
  expect(next.toolGroups).toEqual(["drive"]);
  expect(next.autoModel).toEqual(stopped.autoModel);
});
