import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, typingTopic } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelMessage, type ModelRequest, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  type BrainTurn,
  bridgeToolsFor,
  computerPrompt,
  createAgent,
  createBlockToolSource,
  createContextToolSource,
  createJobHandlers,
  createWorkToolSource,
  drainOutbox,
  EVERY_TOOL,
  flattenContent,
  getMessage,
  grantScopes,
  historyStart,
  insertMessage,
  type MachineStatus,
  type Message,
  openDm,
  postPersonMessage,
  presentTools,
  type ToolContext,
  toTurns,
} from "../src";
import { TYPING_GRACE_MS, typingLogFor, waitForBurst } from "../src/burst";
import {
  compactToolResults,
  cutOldToolSteps,
  cutResultIds,
  fitContextWindow,
  KEEP_TOOL_STEPS,
} from "../src/context-budget";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** Token-trim items B3, B5, B8–B11 (ADR 0043): the model reads less, or reads it from the cache. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const agentCalls = (fx: Fixture) =>
  fx.provider.calls.map((c) => c.request).filter((r) => (r.tools?.length ?? 0) > 0 && r.maxTokens > 0);
const names = (r: ModelRequest) => (r.tools ?? []).map((t) => t.name);

/** The Anthropic request body a captured request becomes (the transport refuses after reading it: no network). */
async function anthropicBody(request: ModelRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    throw new Error("captured");
  }) as unknown as typeof fetch;
  await createAnthropicProvider({ fetch: fetcher, maxRetries: 0 })
    .stream(request, { apiKey: "k", onDelta: () => {} })
    .catch(() => {});
  return body;
}

test("B3: rarely used conversation tools wait behind find_tools; the team block and the everyday ones stay", async () => {
  f = await setup({
    toolsOnDemand: true,
    contextTools: true,
    askAgent: true,
    mediaTools: true,
    followUps: true,
    react: true,
    askUser: true,
    reply: () => ({ chunks: ["ok"] }),
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  const [request] = agentCalls(f);
  if (!request) throw new Error("no call");
  const listed = names(request);
  for (const rare of ["send_sticker", "cancel_follow_up", "find_agent", "propose_instruction_change"])
    expect(listed).not.toContain(rare);
  for (const kept of ["react", "ask_user", "ask_agent", "follow_up", "remember", "find_tools"])
    expect(listed).toContain(kept);
  const system = systemText(request.system);
  expect(system).toContain("# Your team");
  expect(system).toContain("Use `find_agent` to see who knows or can do something");
  expect(system).toContain("- On demand: More of the conversation");
});

test("B5: two agents of a workspace send the same bytes up to the organization's breakpoint", async () => {
  f = await setup({ contextTools: true, react: true, askUser: true, reply: () => ({ chunks: ["ok"] }) });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "Keep it up.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  // Each one's first message in its DM: no history yet, so the organization's breakpoint is sent (with history the
  // fourth breakpoint goes to it, and the lookback still finds the organization's).
  for (const agentId of [f.agent.id, ops.id]) {
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi" });
    await drainOutbox(f.db, f.handlers);
  }
  const [dev, op] = agentCalls(f);
  if (!dev || !op) throw new Error("two calls expected");
  const shared = (body: Record<string, unknown>) => {
    const system = body.system as Record<string, unknown>[];
    const at = system.findIndex((b) => b.cache_control);
    expect(String(system[at]?.text)).toStartWith('You work in "Acme"');
    return JSON.stringify([body.tools, system.slice(0, at + 1)]);
  };
  const [a, b] = await Promise.all([anthropicBody(dev), anthropicBody(op)]);
  expect(shared(b)).toBe(shared(a));
  // The agents' own blocks differ after it.
  expect(JSON.stringify(b.system)).not.toBe(JSON.stringify(a.system));
});

test("B8: the per-turn notes follow the history, and the next run reads this run's history from the cache", async () => {
  f = await setup({ contextTools: true, react: true, reply: () => ({ chunks: ["Oi!"] }) });
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  for (const body of ["oi", "tudo bem?"]) {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
    await drainOutbox(f.db, f.handlers);
  }
  const [first, second] = agentCalls(f);
  if (!first || !second) throw new Error("two calls expected");
  const [a, b] = await Promise.all([anthropicBody(first), anthropicBody(second)]);
  for (const body of [a, b]) {
    const system = JSON.stringify(body.system);
    expect(system).not.toContain("# Now");
    expect(system).not.toContain("# Where you are");
    const last = (body.messages as { content: { text?: string }[] }[]).at(-1)?.content.at(-1)?.text;
    expect(last).toStartWith("# This turn\n\nWhat is true now, for this turn");
    expect(last).toContain("## Now\n");
  }
  // The second run: the history before its trigger is the first run's, its trigger's text a cache point.
  const messages = (body: Record<string, unknown>) => body.messages as { role: string; content: unknown }[];
  const trigger = messages(b).at(-1)?.content as Record<string, unknown>[];
  // With the prompt's hour: a message after a pause still reads the conversation.
  expect(trigger[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  const firstTrigger = messages(a)[0]?.content as Record<string, unknown>[];
  expect(firstTrigger[0]?.cache_control).toBeUndefined();
  expect(messages(b)[0]?.content).toBe(firstTrigger[0]?.text as string);
  // Tools, the stable tools' mark, one system mark (the history's takes the other), the automatic one: 4.
  expect((b.system as Record<string, unknown>[]).filter((s) => s.cache_control)).toHaveLength(1);
});

test("B8: in a turn of several messages, the cached text is unmarked; the current one is named in the notes", async () => {
  f = await setup({ contextTools: true, react: true, reply: () => ({ chunks: ["Vou ver."] }) });
  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  await post("deploy falhou");
  await post("@dev olha isso");
  await drainOutbox(f.db, f.handlers);
  await post("@dev e agora?");
  await drainOutbox(f.db, f.handlers);
  const [first, second] = agentCalls(f);
  if (!first || !second) throw new Error("two calls expected");
  const [a, b] = await Promise.all([anthropicBody(first), anthropicBody(second)]);
  const turns = (body: Record<string, unknown>) =>
    body.messages as { role: string; content: string | { text?: string; cache_control?: unknown }[] }[];
  const cached = turns(a).at(-1)?.content as { text?: string; cache_control?: unknown }[];
  expect(cached[0]?.text).toContain("deploy falhou\n\n[");
  expect(cached[0]?.text).not.toContain("(current message)");
  expect(cached.at(-1)?.text).toContain("## The current message");
  expect(cached.at(-1)?.text).toContain("(current message) [");
  expect(cached.at(-1)?.text).toContain("@dev olha isso");
  // The next run reads that turn exactly as cached (no longer the last, so unmarked).
  const again = turns(b)[0]?.content;
  expect(typeof again === "string" ? again : again?.[0]?.text).toBe(cached[0]?.text as string);
});

test("B8: a cut history starts at an anchor that stays while the window slides", () => {
  const ids = Array.from(
    { length: 60 },
    (_, i) => `00000000-0000-7000-8000-${(i * 7919).toString(16).padStart(12, "0")}`,
  );
  const starts = Array.from({ length: 30 }, (_, k) => {
    const window = ids.slice(k, k + 30);
    return window[historyStart(window)];
  });
  // The same first message for several windows in a row, not a new one every time.
  const changes = starts.filter((id, i) => i > 0 && id !== starts[i - 1]).length;
  expect(changes).toBeLessThan(15);
  for (const [k, id] of starts.entries()) expect(ids.indexOf(id as string) - k).toBeLessThan(12);
});

test("B9: long messages before the last eight read cut, with the id expand reopens them by", async () => {
  const at = Date.now() - 60_000;
  const long = "relatório ".repeat(400);
  const history = Array.from(
    { length: 12 },
    (_, i) =>
      ({
        id: `00000000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`,
        authorType: "person",
        authorUserId: "u1",
        authorAgentId: null,
        body: i === 1 || i === 10 ? long : `m${i}`,
        meta: {},
        createdAt: new Date(at + i * 1000),
      }) as unknown as Message,
  );
  const names = new Map([["u1", "Ana"]]);
  const text = JSON.stringify(toTurns(history, "agent", names, history.at(-1)?.id, { cutOld: true }));
  expect(text).toContain(`more characters; expand ${history[1]?.id} reopens it`);
  // In the last eight: whole.
  expect(text).not.toContain(`expand ${history[10]?.id}`);
  expect(text.split(long).length - 1).toBe(1);
  // The cut moves at anchors, a few messages at a time: the cached history changes on few runs, not on every one.
  const reports = Array.from(
    { length: 40 },
    (_, i) =>
      ({
        ...history[0],
        id: `00000000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
        body: long,
        createdAt: new Date(at + i * 1000),
      }) as unknown as Message,
  );
  const cut = (k: number) => {
    const seen = JSON.stringify(toTurns(reports.slice(0, k), "agent", names, reports[k - 1]?.id, { cutOld: true }));
    return reports.slice(0, k).map((m) => seen.includes(`expand ${m.id} reopens`));
  };
  let moved = 0;
  for (let k = 21; k <= 30; k++) {
    const before = cut(k - 1);
    if (cut(k).some((c, j) => j < k - 1 && c !== before[j])) moved++;
  }
  expect(moved).toBeLessThanOrEqual(3);
  // Without expand, nothing is cut.
  expect(JSON.stringify(toTurns(history, "agent", names, history.at(-1)?.id))).not.toContain("reopens it");

  f = await setup({
    contextTools: true,
    reply: (_r, n) =>
      n === 1 ? { chunks: [], toolUses: [{ name: "expand", input: { item_id: posted.id } }] } : { chunks: ["ok"] },
  });
  const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: long,
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev resume" });
  await drainOutbox(f.db, f.handlers);
  const results = (f.provider.calls.at(-1)?.request.messages ?? [])
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
  expect(results).toEqual([long.trim()]);
});

/** A run's transcript of `steps` tool steps, each a large log read (an error and a question's answer among them). */
const toolRun = (steps: number): ModelMessage[] => [
  { role: "user", content: "[Ana]: @dev por que o deploy falhou?" },
  ...Array.from({ length: steps }, (_, i): ModelMessage[] => {
    const name = i === 1 ? "ask_user" : i === 3 ? "load_skill" : "read_log";
    return [
      {
        role: "assistant",
        content: [
          { type: "text", text: `Lendo a parte ${i}.` },
          { type: "tool_use", id: `toolu_${i}`, name, input: { page: i, note: "x".repeat(i === 0 ? 2000 : 10) } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: `toolu_${i}`,
            content: `${i === 1 ? "Ana answered: " : ""}linha ${i} `.repeat(400),
            ...(i === 2 ? { isError: true } : {}),
          },
        ],
      },
    ];
  }).flat(),
];
const withExpand = [{ name: "expand" }, { name: "read_log" }];

test("B12: old tool calls and results read cut, reopened by expand; the last steps, errors and answers whole", () => {
  const steps = 14;
  const run = toolRun(steps);
  const cut = cutOldToolSteps(run, withExpand);
  const text = JSON.stringify(cut);
  // The first eight steps cut (an anchor), the last six whole.
  for (let i = 0; i < steps; i++) {
    const old = i < 8 && i !== 1 && i !== 2 && i !== 3;
    expect(text.includes(`expand toolu_${i} reopens it whole`), `step ${i}`).toBe(old);
  }
  expect(text).toContain("expand toolu_0 reopens the call");
  // An error and a person's answer stay whole however old; so does every text people and the agent wrote.
  expect(text).toContain(JSON.stringify(`Ana answered: linha 1 `.repeat(400)));
  expect(text).toContain(JSON.stringify(`linha 2 `.repeat(400)));
  expect(text).toContain(JSON.stringify(`linha 3 `.repeat(400)));
  expect(text).toContain("[Ana]: @dev por que o deploy falhou?");
  for (let i = 0; i < steps; i++) expect(text).toContain(`Lendo a parte ${i}.`);
  // Byte-stable: two builds of the same history give the same bytes, and the input is left as it was.
  expect(JSON.stringify(cutOldToolSteps(structuredClone(run), withExpand))).toBe(text);
  expect(JSON.stringify(run)).not.toContain("reopens it whole");
  // The last KEEP_TOOL_STEPS are never cut, and the cut moves at anchors: few changes as the run grows.
  let moved = 0;
  for (let k = 1; k <= 30; k++) {
    const seen = cutOldToolSteps(toolRun(k), withExpand);
    const shown = JSON.stringify(seen);
    for (let i = k - KEEP_TOOL_STEPS; i < k; i++) if (i >= 0) expect(shown).not.toContain(`toolu_${i} reopens`);
    const before = JSON.stringify(cutOldToolSteps(toolRun(k - 1), withExpand));
    if (k > 1 && !shown.startsWith(before.slice(0, -1))) moved++;
  }
  expect(moved).toBeLessThanOrEqual(7);
  // Without expand, nothing is cut.
  expect(cutOldToolSteps(run, [{ name: "read_log" }])).toBe(run);
  const size = (m: ModelMessage[]) => JSON.stringify(m).length;
  const flat = (m: ModelMessage[]) =>
    computerPrompt({
      messages: m.map((x) => ({ role: x.role, content: flattenContent(x.content) })),
      trigger: "",
    } as unknown as BrainTurn).length;
  console.log(
    `B12, ${steps} steps of 3.6k-character results: API messages ${size(run)} -> ${size(cut)} chars; computer prompt ${flat(run)} -> ${flat(cut)}`,
  );
  expect(size(cut)).toBeLessThan(size(run) * 0.8);
});

test("B12: a compaction that removes old results keeps every cut one's text whole for expand", async () => {
  const run = toolRun(14);
  // A screenshot on a cut result: the only part of it a compaction may still take.
  const shot = run[2]?.content;
  if (typeof shot !== "string" && shot?.[0]?.type === "tool_result")
    shot[0].images = [{ mediaType: "image/png", data: "A".repeat(200) }];
  const view = cutOldToolSteps(run, withExpand);
  const cut = cutResultIds(view);
  expect([...cut].sort()).toEqual(["toolu_0", "toolu_4", "toolu_5", "toolu_6", "toolu_7"]);
  const fitted = await fitContextWindow(null, {
    orgId: "org",
    model: "claude-sonnet-4-5",
    windowTokens: 4_000,
    maxOutputTokens: 1_000,
    system: [],
    messages: view,
  });
  expect(fitted?.removed.has("toolu_0")).toBe(true);
  const kept = compactToolResults(run, fitted?.removed ?? new Set(), cut);
  const results = new Map(
    kept
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .flatMap((b) => (b.type === "tool_result" ? [[b.toolUseId, b] as const] : [])),
  );
  for (const id of cut) expect(results.get(id)?.content, id).toBe(`linha ${id.slice(6)} `.repeat(400));
  expect(results.get("toolu_0")?.images).toBeUndefined();
  // A result the view shows whole may still go, with the placeholder.
  expect([...(fitted?.removed ?? [])].some((id) => results.get(id)?.content.startsWith("[Result removed"))).toBe(true);
});

test("B12: an agent that needs a cut tool result calls expand and reads it whole", async () => {
  const log = (i: number) => `log ${i}: ${"erro de conexão ".repeat(300)}`;
  const reads = 9;
  f = await setup({
    contextTools: true,
    toolSources: [
      {
        name: "logs",
        tools: async () => [
          {
            name: "read_log",
            description: "Read a deploy log page.",
            inputSchema: { type: "object", properties: { page: { type: "number" } }, additionalProperties: false },
            scope: "context:read",
            execute: async (input) => ({ content: log(Number(input.page)) }),
          },
        ],
      },
    ],
    reply: (_r, n) =>
      n <= reads
        ? { chunks: [], toolUses: [{ id: `toolu_read_${n}`, name: "read_log", input: { page: n } }] }
        : n === reads + 1
          ? { chunks: [], toolUses: [{ id: "toolu_expand", name: "expand", input: { item_id: "toolu_read_1" } }] }
          : { chunks: ["ok"] },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev lê os logs",
  });
  await drainOutbox(f.db, f.handlers);
  const calls = agentCalls(f);
  const results = (r: ModelRequest) =>
    r.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .flatMap((b) => (b.type === "tool_result" ? [b] : []));
  // What the expand call saw: the first read cut, with its id.
  const before = calls.at(-2) as ModelRequest;
  expect(results(before)[0]?.content).toContain("expand toolu_read_1 reopens it whole");
  const last = calls.at(-1) as ModelRequest;
  const reopened = results(last).find((b) => b.toolUseId === "toolu_expand");
  expect(reopened?.content).toBe(`Tool call read_log {"page":1}\n\nResult:\n${log(1)}`);
  // The run's transcript keeps every result whole; the request reads the old ones cut.
  const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  const kept = (row?.transcript as { messages: ModelMessage[] } | undefined)?.messages.slice(0, last.messages.length);
  expect(JSON.stringify(kept)).not.toContain("reopens it whole");
  console.log(
    `B12, ${reads} log reads and an expand: messages ${JSON.stringify(kept).length} -> ${JSON.stringify(last.messages).length} chars`,
  );
});

test("B12: expand reopens a cut call from an earlier run of the same computer session, never another session's", async () => {
  f = await setup({ contextTools: true });
  const runOf = async (session: string, messages: ModelMessage[]): Promise<ToolContext> => {
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev lê os logs",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: said.id,
        triggerMessageId: said.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        brainSessionId: session,
        transcript: { messages },
      })
      .returning();
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: said.id,
      triggerMessageId: said.id,
    };
  };
  await runOf("session-a", toolRun(9));
  const later = await runOf("session-a", toolRun(0));
  const other = await runOf("session-b", toolRun(0));
  const expand = async (ctx: ToolContext) => {
    const tool = (await createContextToolSource(f.context).tools(ctx)).find((t) => t.name === "expand");
    return tool?.execute({ item_id: "toolu_4" }, ctx);
  };
  expect((await expand(later))?.content).toBe(
    `Tool call read_log {"note":"xxxxxxxxxx","page":4}\n\nResult:\n${"linha 4 ".repeat(400)}`,
  );
  expect(await expand(other)).toMatchObject({ isError: true, content: "Not found." });
});

test("B10: during the quiet window the first call's prompt is pre-warmed: the same request with no output", async () => {
  f = await setup({
    contextTools: true,
    react: true,
    // Long enough that the run reaches its window while it is still open on a machine busy with other test files:
    // with 300 ms the run sometimes got there after it, and then there is rightly no pre-warm (the test below).
    quietMs: 2000,
    reply: (r) => (r.maxTokens === 0 ? { chunks: [], usage: { outputTokens: 0 } } : { chunks: ["Oi!"] }),
  });
  const handlers = createJobHandlers({ ...f.jobDeps, prewarm: true });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlers);
  const [warm, real] = f.provider.calls.map((c) => c.request);
  expect(warm?.maxTokens).toBe(0);
  expect(real?.maxTokens).toBeGreaterThan(0);
  const same = (r?: ModelRequest) => JSON.stringify([r?.system, r?.messages, r?.tools, r?.cacheTtl, r?.notes]);
  expect(same(warm)).toBe(same(real));
  // Through the gateway: recorded like any call, with the agent.
  const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, f.agent.id));
  expect(usage.filter((u) => u.kind === "agent")).toHaveLength(2);
  // Anthropic: a plain request with max_tokens 0, not a stream.
  const body = await anthropicBody(warm as ModelRequest);
  expect(body.max_tokens).toBe(0);
  expect(body.stream).toBe(false);
});

test("B10: no pre-warm when the quiet window is already over: it would only delay the first call", async () => {
  f = await setup({
    contextTools: true,
    react: true,
    quietMs: 300,
    reply: (r) => (r.maxTokens === 0 ? { chunks: [], usage: { outputTokens: 0 } } : { chunks: ["Oi!"] }),
  });
  const handlers = createJobHandlers({ ...f.jobDeps, prewarm: true });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  // The run starts after its window (a busy worker, a slow context).
  await Bun.sleep(400);
  await drainOutbox(f.db, handlers);
  expect(f.provider.calls.map((c) => c.request.maxTokens > 0)).toEqual([true]);
});

test("B11: the quiet window ends early when the person isn't typing, and lasts while they are", async () => {
  f = await setup({ contextTools: true });
  const log = typingLogFor(f.pubsub);
  const sent = async (body: string) => {
    const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
    });
    const m = await getMessage(f.db, f.org.id, posted.id);
    if (!m) throw new Error("not posted");
    return m;
  };
  const typed = () =>
    f.pubsub.publish(typingTopic, {
      type: "user.typing",
      channelId: f.general.id,
      threadId: null,
      userId: f.owner.id,
      ttlMs: 6000,
    });
  // Typing for the message itself, before it was sent, is no sign of another.
  await typed();
  await Bun.sleep(5);
  const alone = await sent("@dev oi");
  await waitForBurst(f.db, alone, 2500, undefined, log);
  const quiet = Date.now() - alone.createdAt.getTime();
  expect(quiet).toBeGreaterThanOrEqual(TYPING_GRACE_MS - 10);
  expect(quiet).toBeLessThan(2300);

  const typing = await sent("@dev oi");
  setTimeout(() => void typed(), 300);
  await waitForBurst(f.db, typing, 2500, undefined, log);
  expect(Date.now() - typing.createdAt.getTime()).toBeGreaterThanOrEqual(2490);

  // Typed while the run still read its context, before its wait started: still heard.
  const early = await sent("@dev oi");
  await Bun.sleep(300);
  await typed();
  await Bun.sleep(1100);
  await waitForBurst(f.db, early, 2500, undefined, log);
  expect(Date.now() - early.createdAt.getTime()).toBeGreaterThanOrEqual(2490);

  // Sent through a connected AI app (ADR 0119): no typing ever comes from there, so the whole window.
  const viaApp = await sent("@dev oi");
  await waitForBurst(f.db, { ...viaApp, meta: { via: { kind: "app", name: "Claude" } } }, 2500, undefined, log);
  expect(Date.now() - viaApp.createdAt.getTime()).toBeGreaterThanOrEqual(2490);
}, 20_000);

/**
 * The agent on Claude Code on a paired computer, with a teammate and a second person: three turns, a DM from the
 * owner ("oi"), a channel message from the other person (`loadIssues` runs first: the tool-group judge would load the
 * Issues group for it) and a reply in its thread (a resumed session). Each turn keeps its `BrainTurn`, what it would
 * say, and the tools the bridge lists for its run.
 */
async function claudeCodeTurns(fx: Fixture, loadIssues: () => void) {
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Ops", handle: "ops", role: "DevOps", instructions: "", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const status = (id: string): MachineStatus => ({
    id,
    orgId: fx.org.id,
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  });
  const seen: { turn: BrainTurn; prompt: string; tools: string }[] = [];
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: {
      claude_code: () => ({
        kind: "claude_code",
        async *run(turn) {
          const tools = await bridgeToolsFor(
            { db: fx.db, pubsub: fx.pubsub, tools: fx.tools },
            { orgId: fx.org.id, agentId: fx.agent.id, runId: turn.runId, machineId: paired.machineId },
          );
          seen.push({ turn, prompt: computerPrompt(turn), tools: JSON.stringify(tools) });
          yield {
            type: "tool_call",
            id: `ts-${seen.length}`,
            name: "ToolSearch",
            input: { query: "select:mcp__agentes__list_issues" },
            executed: { content: "list_issues" },
          };
          yield {
            type: "usage",
            input: 9040,
            output: 5,
            source: "plan",
            model: "claude-sonnet-5-5",
            cacheRead: 8000,
            calls: 3,
            maxUncached: 700,
          };
          yield { type: "done", text: "ok" };
        },
      }),
    },
    machines: { status: async (id) => status(id) },
  });
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  await addChannelMember(fx.db, fx.owner.id, fx.org.id, fx.general.id, { userId: bia.id });
  const dm = await openDm(fx.db, fx.owner.id, fx.org.id, { agentId: fx.agent.id });
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  loadIssues();
  const asked = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, bia.id, fx.org.id, fx.general.id, {
    body: "@dev quais issues estão abertas?",
  });
  await drainOutbox(fx.db, handlers);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, bia.id, fx.org.id, fx.general.id, {
    body: "@dev e agora?",
    threadId: asked.id,
  });
  await drainOutbox(fx.db, handlers);
  const [dmTurn, channelTurn, followUp] = seen;
  if (!dmTurn || !channelTurn || !followUp) throw new Error(`three turns expected, got ${seen.length}`);
  return { dmTurn, channelTurn, followUp };
}

const conversationOf = (t: BrainTurn) => (t as BrainTurn & { conversation?: string }).conversation ?? "";

/** Every rule line a computer brain reads in its system text and its conversation, headings' levels aside. */
const ruleLines = (t: BrainTurn) =>
  [
    ...new Set(
      `${t.system}\n${conversationOf(t)}`
        .split("\n")
        .map((l) => l.replace(/^#+ /, "").trim())
        // Where those sections come from (the line that names them, the choices line's own heading), not a rule.
        .filter(
          (l) =>
            l &&
            l !== "This conversation" &&
            l !== "Options to pick from" &&
            !l.startsWith('"# This turn" and "# This conversation"'),
        ),
    ),
  ].sort();

const toolsSetup = (judge?: NonNullable<Parameters<typeof setup>[0]>["judge"], toolsOnDemand = true) =>
  setup({
    toolsOnDemand,
    contextTools: true,
    askUser: true,
    askAgent: true,
    react: true,
    followUps: true,
    workTools: true,
    blockTools: true,
    issueTools: true,
    scheduleTools: true,
    artifactTools: true,
    wikiTools: true,
    ...(judge ? { judge } : {}),
    reply: () => ({ chunks: ["ok"] }),
  });

test("Claude Code: two sessions of one agent list the same tools, every one it has, whoever asks and whatever ran before", async () => {
  let issues = 0;
  f = await toolsSetup((kind, _id, _state, q) =>
    kind === "tool_groups" && JSON.stringify(q.instructions).includes("Issues") ? issues : 0,
  );
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "issues:read" },
    { connectionId: null, scope: "issues:write" },
    { connectionId: null, scope: "drive:read" },
    { connectionId: null, scope: "drive:write" },
  ]);
  const { dmTurn, channelTurn } = await claudeCodeTurns(f, () => {
    issues = 0.9;
  });
  // Name, description and schema of every tool, byte for byte: the start of Claude Code's cached prefix.
  expect(channelTurn.tools).toBe(dmTurn.tools);
  const listed = (JSON.parse(dmTurn.tools) as { name: string }[]).map((t) => t.name);
  for (const name of ["list_issues", "create_artifact", "ask_choices", "work_in_background", "find_tools", "use_tool"])
    expect(listed).toContain(name);
  // By name, the search over them last.
  expect(listed.slice(-2)).toEqual(["find_tools", "use_tool"]);
  expect(listed.slice(0, -2)).toEqual(listed.slice(0, -2).sort());
  // "What you can do" names them all, and how to search them.
  expect(dmTurn.turn.system).toContain("`list_issues`");
  expect(dmTurn.turn.system).toContain("- Search all your tools by what you need with `find_tools`");
  expect(dmTurn.turn.system).not.toContain("- On demand:");

  // Listed in a run nobody can answer a card in or move to the background: each says why, and what to do instead.
  const [run] = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt)).limit(1);
  if (!run) throw new Error("no run");
  const groups = (run.transcript as { toolGroups?: string[] } | null)?.toolGroups;
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    background: true,
    loadedGroups: groups ?? null,
  };
  const blocks = await createBlockToolSource(f.artifactDeps).tools(ctx);
  const choices = blocks.find((t) => t.name === "ask_choices");
  const card = { title: "Deploy", questions: [{ question: "When?", options: [{ label: "Now" }, { label: "Later" }] }] };
  expect((await choices?.execute(card, ctx))?.content).toStartWith("Nobody can pick on a card in this run");
  const work = await createWorkToolSource({ pubsub: f.pubsub }).tools(ctx);
  const move = work.find((t) => t.name === "work_in_background");
  expect((await move?.execute({ title: "x", say: "y" }, ctx))?.content).toBe(
    "Only a conversation's run can go to the background: keep working here and answer when it's done.",
  );
}, 20_000);

test("Claude Code: an agent with no tools still lists none (no search over nothing)", () => {
  expect(presentTools([], undefined, [EVERY_TOOL])).toEqual([]);
});

test("Claude Code: the system text is the same in every conversation; what holds for one comes once, not on a resume", async () => {
  f = await toolsSetup();
  const { dmTurn, channelTurn, followUp } = await claudeCodeTurns(f, () => {});
  expect(channelTurn.turn.system).toBe(dmTurn.turn.system);
  // Two new sessions share the tools and the whole system text: the most of their prefix there is to share.
  expect(channelTurn.tools.length + channelTurn.turn.system.length).toBeGreaterThan(30_000);
  for (const t of [dmTurn, channelTurn]) {
    const conversation = conversationOf(t.turn);
    expect(conversation).toStartWith("# This conversation\n\n## Your team\n");
    // Under a heading of its own, not read as part of "## Your team".
    expect(conversation).toContain("\n\n## Options to pick from\n- When you end by asking the person to pick");
    expect(t.turn.system).not.toContain("# Your team");
    expect(t.turn.system).not.toContain("put them on a card with ask_choices");
    expect(t.turn.system).toContain('"# This turn" and "# This conversation" in your messages come from agentes.chat');
  }
  // A follow-up turn in a resumed session: only what is new, under a ceiling (its uncached part).
  expect(followUp.turn.session?.resume).toBe(true);
  expect(followUp.prompt).not.toContain("## Your team\n");
  expect(followUp.prompt.length).toBeLessThan(1200);
  // The turn's calls and its largest uncached one stay on its step, to tell more calls from bigger ones.
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "model_call"));
  expect(steps).toHaveLength(3);
  for (const step of steps) expect(step.data).toMatchObject({ calls: 3, maxUncached: 700, toolSearches: 1 });
}, 20_000);

test("Claude Code: no rule is lost moving what holds for one conversation out of the system text", async () => {
  // Tools on demand off: the tool list (and "What you can do") stays as before, so only where the lines are changes.
  f = await toolsSetup(undefined, false);
  const { dmTurn, channelTurn } = await claudeCodeTurns(f, () => {});
  // Taken from the system text before the move.
  expect(ruleLines(dmTurn.turn)).toMatchSnapshot();
  expect(ruleLines(channelTurn.turn)).toEqual(ruleLines(dmTurn.turn));
}, 20_000);
