import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, executeRun, getMessage, listMessages, openDm, postPersonMessage, type ToolSource } from "../src";
import { waitForBurst } from "../src/burst";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
const runs = async () =>
  (await f.db.select().from(schema.agentRuns)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

/** A tool that, while it runs, lets the test do something (a person writes in the thread). */
function slowTool(during: () => Promise<unknown>): ToolSource {
  return {
    name: "slow",
    tools: async () => [
      {
        name: "build",
        description: "Build the project",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: "build ok" };
        },
      },
    ],
  };
}

describe("mid-round queueing (ADR 0029 section 1)", () => {
  test("a reply in the thread of the message it works on joins that run: no mention, no second run", async () => {
    let threadId = "";
    const requests: string[] = [];
    f = await setup({
      toolSources: [slowTool(() => post("also bump the version", threadId))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, version bumped."] };
      },
    });
    const ask = await post("@dev build the project");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(2);
    expect(requests[1]).toContain("New message from ana, while you were working");
    expect(requests[1]).toContain("also bump the version");
    // Asked in the channel: it answers in the main timeline.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.at(-1)?.body).toBe("Built, version bumped.");
  });

  test("a new message in the channel calling the agent while it works there joins that run: one agent, not two", async () => {
    const requests: string[] = [];
    f = await setup({
      // While the first answer runs, someone else calls the same agent with a new message in the channel.
      toolSources: [slowTool(() => post("@dev and fix the login too"))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, and the login is fixed."] };
      },
    });
    await post("@dev build the project");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("and fix the login too");
  });

  test("a new message in the channel doesn't join a run working in a thread", async () => {
    f = await setup({
      toolSources: [slowTool(() => post("@dev something else"))],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Done."] },
    });
    const root = await post("the release");
    // Asked in the thread: its run answers there, not in the channel.
    await post("@dev build the project", root.id);
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(2);
  });

  test("after the run ended, a new message to the agent starts a run as usual", async () => {
    f = await setup({ reply: (_req, call) => ({ chunks: [call === 1 ? "First." : "Second."] }) });
    const ask = await post("@dev first thing");
    await drainOutbox(f.db, f.handlers);
    await post("@dev one more thing", ask.id);
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["done", "done"]);
    expect(all[1]?.threadRootId).toBe(ask.id);
    // Each answers where it was asked: the first in the main timeline, the second in the thread.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["@dev first thing", "First."]);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    expect(thread.map((m) => m.body)).toEqual(["@dev first thing", "@dev one more thing", "Second."]);
  });

  test("a message queued into a run that then fails is not lost: it gets a run of its own", async () => {
    let threadId = "";
    let followUp = "";
    f = await setup({
      reply: (_req: ModelRequest, call: number) => {
        if (call === 1) {
          // Written while the model answers; the answer then fails (a refusal).
          const posting = post("are you there?", threadId).then((m) => {
            followUp = m.id;
          });
          return { chunks: ["Hmm"], hold: posting, stopReason: "refusal" as const };
        }
        return { chunks: ["Yes, here."] };
      },
    });
    const ask = await post("@dev do the risky thing");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["failed", "done"]);
    expect(all[0]?.error).toBe("model_refused");
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(followUp);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId });
    expect(thread.at(-1)?.body).toBe("Yes, here.");
  });
});

describe("messages in a row (ADR 0112)", () => {
  const postIn = (channelId: string, body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body, threadId });
  const waitRunning = async () => {
    const start = Date.now();
    while (!(await runs()).some((r) => r.status === "running")) {
      if (Date.now() - start > 5000) throw new Error("the run never started");
      await Bun.sleep(5);
    }
  };

  test.each([
    ["a DM", "dm"],
    ["a thread", "thread"],
  ] as const)(
    "in %s: a burst sent as the run starts gets one run and one answer that read all of it",
    async (_l, where) => {
      const requests: string[] = [];
      f = await setup({
        quietMs: 400,
        reply: (req: ModelRequest) => {
          requests.push(JSON.stringify(req.messages.at(-1)?.content));
          return { chunks: ["Bate sim: 42 tarefas nos dois."] };
        },
      });
      const dm = where === "dm" ? (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id : null;
      const root = where === "thread" ? await post("o relatório de ontem") : null;
      const channelId = dm ?? f.general.id;
      await postIn(channelId, dm ? "oi" : "@dev oi", root?.id);
      const drained = drainOutbox(f.db, f.handlers);
      await waitRunning();
      await postIn(channelId, "preciso de uma coisa", root?.id);
      await postIn(channelId, "olha o relatório de ontem e me diz se bate com o quadro", root?.id);
      await drained;
      await drainOutbox(f.db, f.handlers);
      expect(await runs()).toHaveLength(1);
      expect(f.provider.calls).toHaveLength(1);
      // The rest of the burst reads as plain conversation lines, not as news that came in while it worked.
      expect(requests[0]).toContain("[ana]: preciso de uma coisa");
      expect(requests[0]).toContain("[ana]: olha o relatório de ontem");
      expect(requests[0]).not.toContain("while you were working");
      const [run] = await runs();
      expect(run?.pendingMessageIds).toEqual([]);
      expect((run?.transcript as { request?: string } | undefined)?.request).toContain("se bate com o quadro");
    },
  );

  test("a message to a model-brain run that is still starting never holds the send for a live delivery", async () => {
    f = await setup();
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "oi");
    // Running, but no executor listens yet (it is still building its context).
    await f.db.update(schema.agentRuns).set({ status: "running" });
    const start = Date.now();
    await postIn(dm, "preciso de uma coisa");
    expect(Date.now() - start).toBeLessThan(1500);
    const [run] = await runs();
    expect(run?.pendingMessageIds).toHaveLength(1);
  });

  test("a database error during the wait, on the last try: the run fails and stops listening for live messages", async () => {
    f = await setup({ quietMs: 400 });
    await post("@dev oi");
    const [queued] = await runs();
    const open = new Set<object>();
    const subscribe = f.pubsub.subscribe.bind(f.pubsub);
    const subs = spyOn(f.pubsub, "subscribe").mockImplementation((topic, handler) => {
      const off = subscribe(topic, handler);
      if (!topic.startsWith("run-steer:")) return off;
      const key = {};
      open.add(key);
      return () => {
        open.delete(key);
        off();
      };
    });
    const select = f.db.select.bind(f.db);
    const broken = spyOn(f.db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      if (fields && "latest" in fields) throw new Error("connection reset");
      return select(fields as never);
    }) as typeof f.db.select);
    try {
      await executeRun(f.jobDeps, queued?.id ?? "", { finalAttempt: true });
    } finally {
      broken.mockRestore();
      subs.mockRestore();
    }
    const [run] = await runs();
    expect(run?.status).toBe("failed");
    expect(open.size).toBe(0);
  });

  test("a lone message waits only what is left of the quiet window, measured from when it was sent", async () => {
    f = await setup();
    const row = async (body: string) => {
      const posted = await post(body);
      const m = await getMessage(f.db, f.org.id, posted.id);
      if (!m) throw new Error("not posted");
      return m;
    };
    const sent = await row("@dev oi");
    const [old] = await f.db
      .update(schema.messages)
      .set({ createdAt: sql`now() - interval '10 seconds'` })
      .where(eq(schema.messages.id, sent.id))
      .returning();
    if (!old) throw new Error("not moved");
    const start = Date.now();
    await waitForBurst(f.db, old, 2500);
    expect(Date.now() - start).toBeLessThan(200);
    const fresh = await row("@dev oi de novo");
    await waitForBurst(f.db, fresh, 600);
    // Quiet from when it was sent, not from when the run got to it.
    expect(Date.now() - fresh.createdAt.getTime()).toBeGreaterThanOrEqual(590);
    expect(Date.now() - fresh.createdAt.getTime()).toBeLessThan(1500);
  });

  test("Parar or a shutdown during the quiet window ends the wait at once", async () => {
    f = await setup();
    const posted = await post("@dev oi");
    const sent = await getMessage(f.db, f.org.id, posted.id);
    if (!sent) throw new Error("not posted");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const start = Date.now();
    await waitForBurst(f.db, sent, 5000, stop.signal);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("a routed run never waits again: the router already waited for the burst", async () => {
    f = await setup({ quietMs: 5000 });
    await post("@dev oi");
    const [queued] = await runs();
    await f.db.update(schema.agentRuns).set({ trigger: "router" });
    const start = Date.now();
    await executeRun(f.jobDeps, queued?.id ?? "", { finalAttempt: true });
    expect(Date.now() - start).toBeLessThan(2500);
    expect((await runs())[0]?.status).toBe("done");
  });

  test("an update sent while it works joins the run and becomes part of the request the judges hold the reply to", async () => {
    const requests: string[] = [];
    let dmId = "";
    f = await setup({
      toolSources: [slowTool(() => postIn(dmId, "ah, e inclui a semana passada também"))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Vou montar."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Pronto, com a semana passada também."] };
      },
    });
    dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dmId, "monta o relatório desta semana");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(requests[1]).toContain("while you were working]: ah, e inclui a semana passada");
    const [run] = await runs();
    expect((run?.transcript as { request?: string } | undefined)?.request).toContain("inclui a semana passada");
    // Told how to take it: the system prompt says an update changes the work in progress.
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("updates the task in progress");
  });

  test("a message sent while it writes its answer is never lost: the same run reads it next", async () => {
    let dmId = "";
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call === 1
          ? { chunks: ["Feito."], hold: postIn(dmId, "e manda pro canal também") }
          : { chunks: ["Mandei no canal."] },
    });
    dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dmId, "fecha o relatório");
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
    expect(dm.map((m) => m.body)).toEqual([
      "fecha o relatório",
      "e manda pro canal também",
      "Feito.",
      "Mandei no canal.",
    ]);
  });
});
