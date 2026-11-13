import { afterEach, describe, expect, test } from "bun:test";
import { and, countQueries, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  BROWSER_SCOPE,
  createAgent,
  createBrowserHandoffToolSource,
  createChannel,
  createWithdrawRequestToolSource,
  drainOutbox,
  grantScopes,
  listMessages,
  loadReplyPolicy,
  type MachineCaller,
  type MachineStatus,
  NEW_AGENT_DEFAULTS,
  postPersonMessage,
  type ToolContext,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

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

/**
 * "sign in" asks a person in the browser. Woken by "use the API instead", it withdraws the request at once
 * (`eager`), only when told it is still open, or (`keep`) never; after withdrawing it writes nothing more.
 */
function agentReply(eager: boolean, keep = false) {
  return (req: ModelRequest) => {
    const last = JSON.stringify(req.messages.at(-1)?.content);
    if (last.includes("Withdrawn:")) return { chunks: eager ? ["Ok, vou pela API."] : [] };
    if (last.includes("still open, and people still see them waiting")) {
      if (keep) return { chunks: [] };
      return { chunks: [], toolUses: [{ name: "withdraw_request", input: { id: ID.exec(last)?.[1] ?? "" } }] };
    }
    if (last.includes("use the API instead")) {
      if (eager) {
        return {
          chunks: [],
          toolUses: [{ name: "withdraw_request", input: { id: ID.exec(last)?.[1] ?? "", reason: "API instead" } }],
        };
      }
      return { chunks: ["Ok, vou pela API."] };
    }
    if (last.includes("sign in"))
      return { chunks: [], toolUses: [{ name: "browser_ask_person", input: { instructions: "Sign in to Stripe" } }] };
    return { chunks: ["Feito."] };
  };
}

async function start(eager = true, keep = false) {
  ready.clear();
  f = await setup({
    reply: agentReply(eager, keep),
    machines: true,
    toolSources: [createBrowserHandoffToolSource({ machines: { hub: readyHub } }), createWithdrawRequestToolSource()],
  });
  const machine = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
  await f.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  ready.add(machine.machineId);
}

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
const handoffs = () => f.db.select().from(schema.browserHandoffs);
const notificationOf = async (id: string) =>
  (
    await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${id}`))
  )[0];
/** What the agent wrote: not its request's card, nor notices. */
const agentLines = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id)))
    .filter((m) => !(m.meta as { notice?: unknown }).notice && m.meta.bodyCode !== "browser_handoff")
    .map((m) => m.body);

/** The agent asks for a sign-in, then the person picks another way in the thread (no judge: the run wakes). */
async function askThenOtherWay() {
  const ask = await post("@dev sign in please");
  await drainOutbox(f.db, f.handlers);
  const [h] = await handoffs();
  expect(h?.status).toBe("pending");
  expect((await notificationOf(h?.id ?? ""))?.doneAt).toBeNull();
  await post("let's use the API instead", ask.id);
  await drainOutbox(f.db, f.handlers);
  return { ask, id: h?.id ?? "" };
}

describe("withdraw_request", () => {
  test("the person picks another way: the agent withdraws its asked help, the card says so and nobody waits on it", async () => {
    await start(true);
    const { id } = await askThenOtherWay();

    const [h] = await handoffs();
    expect(h).toMatchObject({ status: "withdrawn", note: "API instead" });
    const card = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === id);
    expect(card?.meta.browserHandoff).toMatchObject({ status: "withdrawn", expiresAt: null });
    expect((await notificationOf(id))?.doneAt).not.toBeNull();
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    // Withdrawn in its answer: it isn't told about it again, nor kept "waiting" on it.
    const steps = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
    const ends = steps.flatMap((s) => {
      const c = (s.data as { continuation?: { rule: string } }).continuation;
      return c ? [c.rule] : [];
    });
    expect(ends.length).toBeGreaterThan(0);
    expect(ends).not.toContain("wakes_later");
    expect(f.provider.calls.some((c) => JSON.stringify(c.request.messages).includes("people still see them"))).toBe(
      false,
    );
    expect(await agentLines()).toEqual(["Ok, vou pela API."]);
    const notices = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta as { notice?: { refs?: { waitId?: string } } }).notice?.refs?.waitId === id,
    );
    expect(notices).toEqual([]);
  });

  test("it answered but left its request open: told once at the end of its turn, it withdraws it and posts nothing more", async () => {
    await start(false);
    const { id } = await askThenOtherWay();

    expect((await handoffs())[0]?.status).toBe("withdrawn");
    expect((await notificationOf(id))?.doneAt).not.toBeNull();
    expect(await agentLines()).toEqual(["Ok, vou pela API."]);
    const told = f.provider.calls.filter((c) =>
      JSON.stringify(c.request.messages.at(-1)?.content).includes("people still see them"),
    );
    expect(told).toHaveLength(1);
  });

  test("a new run lists the agent's open requests with their ids; another agent can't withdraw them", async () => {
    await start(true);
    const ask = await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    await post("@dev hello");
    await drainOutbox(f.db, f.handlers);
    const hello = f.provider.calls.find((c) => JSON.stringify(c.request.messages).includes("@dev hello"));
    const system = systemText(hello?.request.system ?? "");
    expect(system).toContain("# Your open requests");
    expect(system).toContain(`- ${h?.id}: help in your browser, "Sign in to Stripe", in #general`);
    expect(hello?.request.tools?.some((t) => t.name === "withdraw_request")).toBe(true);

    const other = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, NEW_AGENT_DEFAULTS);
    const source = createWithdrawRequestToolSource();
    const ctx = (agentId: string): ToolContext => ({
      db: f.db,
      orgId: f.org.id,
      agentId,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
    });
    // Not offered to an agent with nothing open, and refused by id all the same.
    expect(await source.tools(ctx(other.id))).toEqual([]);
    // One cheap check per listing, whatever the agent has open.
    const listed = await countQueries(() => source.tools(ctx(f.agent.id)));
    expect(listed.queries).toBe(1);
    const [tool] = listed.result;
    const out = await tool?.execute({ id: h?.id ?? "" }, ctx(other.id));
    expect(out?.content).toContain("No open request of yours");
    expect(
      (
        await f.db
          .select()
          .from(schema.browserHandoffs)
          .where(and(eq(schema.browserHandoffs.id, h?.id ?? ""), eq(schema.browserHandoffs.status, "pending")))
      ).length,
    ).toBe(1);
  });

  test("a question still open elsewhere: withdrawn, its card closes and the run waiting on it goes on, told so", async () => {
    f = await setup({
      askUser: true,
      toolSources: [createWithdrawRequestToolSource()],
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Ok."] };
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "I need a person's answer before I go on: it decides the deploy.",
                question: "Qual ambiente?",
              },
            },
          ],
        };
      },
    });
    const ask = await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await f.db.select().from(schema.agentQuestions);
    expect(q?.status).toBe("open");
    const source = createWithdrawRequestToolSource();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
    };
    const [tool] = await source.tools(ctx);
    expect((await tool?.execute({ id: q?.id ?? "" }, ctx))?.content).toContain("Withdrawn");
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentQuestions))[0]?.status).toBe("canceled");
    const card = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === q?.messageId);
    expect(card?.meta.question).toMatchObject({ status: "answered", answer: null, withdrawn: true });
    expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
    expect(JSON.stringify(f.provider.calls.at(-1)?.request.messages.at(-1)?.content)).toContain(
      "You withdrew this question",
    );
    expect(await source.tools(ctx)).toEqual([]);
  });

  test("withdrawn in another turn while a run asked by name waits on it: that run owes nobody for it, stays quiet and posts no 'nobody answered'", async () => {
    f = await setup({
      askUser: true,
      toolSources: [createWithdrawRequestToolSource()],
      reply: (req) => {
        if (JSON.stringify(req.messages.at(-1)?.content).includes("You withdrew this question yourself"))
          return { chunks: [] };
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "I need a person's answer before I go on: it decides the deploy.",
                question: "Qual ambiente?",
              },
            },
          ],
        };
      },
    });
    const ask = await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await f.db.select().from(schema.agentQuestions);
    const [asking] = await f.db.select().from(schema.agentRuns);
    expect(asking?.status).toBe("waiting_input");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
    };
    const [tool] = await createWithdrawRequestToolSource().tools(ctx);
    expect((await tool?.execute({ id: q?.id ?? "", reason: "staging already has it" }, ctx))?.content).toContain(
      "Withdrawn",
    );
    await drainOutbox(f.db, f.handlers);
    const read = JSON.stringify(f.provider.calls.at(-1)?.request.messages.at(-1)?.content);
    expect(read).toContain("You withdrew this question yourself (staging already has it)");
    expect(read).toContain("end your turn without writing anything");
    expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
    expect(await loadReplyPolicy(f.db, f.org.id, asking?.id ?? "")).toMatchObject({ mayPass: true });
    // Only its question card.
    const lines = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id));
    expect(lines.filter((m) => !m.meta.questionId && !m.meta.notice)).toEqual([]);
  });

  test("another conversation's run neither reads nor withdraws the request; a routine's run isn't offered the tool", async () => {
    await start(true);
    const ask = await post("@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await handoffs();
    const elsewhere = (await createChannel(f.db, f.owner.id, f.org.id, { name: "random" })).id;
    await addChannelMember(f.db, f.owner.id, f.org.id, elsewhere, { agentId: f.agent.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, elsewhere, { body: "@dev hello" });
    await drainOutbox(f.db, f.handlers);
    const hello = f.provider.calls.find((c) => JSON.stringify(c.request.messages).includes("@dev hello"));
    expect(hello).toBeDefined();
    expect(systemText(hello?.request.system ?? "")).not.toContain("# Your open requests");
    expect(hello?.request.tools?.some((t) => t.name === "withdraw_request")).toBe(false);

    const source = createWithdrawRequestToolSource();
    const ctx = (channelId: string, background?: boolean): ToolContext => ({
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      background,
    });
    expect(await source.tools(ctx(elsewhere))).toEqual([]);
    expect(await source.tools(ctx(f.general.id, true))).toEqual([]);
    const [tool] = await source.tools(ctx(f.general.id));
    expect((await tool?.execute({ id: h?.id ?? "" }, ctx(elsewhere)))?.content).toContain("No open request of yours");
    expect((await handoffs())[0]?.status).toBe("pending");
  });

  test("withdrawn by a later run after the asking run stopped waiting and ended: no notice, no new run", async () => {
    await start(false, true);
    const { id } = await askThenOtherWay();
    expect((await handoffs())[0]?.status).toBe("pending");
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.every((r) => r.status === "done")).toBe(true);
    const calls = f.provider.calls.length;

    const source = createWithdrawRequestToolSource();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: id,
      triggerMessageId: id,
    };
    const [tool] = await source.tools(ctx);
    expect((await tool?.execute({ id }, ctx))?.content).toContain("Withdrawn");
    await drainOutbox(f.db, f.handlers);

    expect((await handoffs())[0]?.status).toBe("withdrawn");
    const notices = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta as { notice?: { refs?: { waitId?: string } } }).notice?.refs?.waitId === id,
    );
    expect(notices).toEqual([]);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(runs.length);
    expect(f.provider.calls.length).toBe(calls);
  });
});
