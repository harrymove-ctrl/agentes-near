import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  type ContentBlock,
  contextLimitsFor,
  contextWindowWithin,
  IMAGE_CHARS,
  isContextLimit,
  type ModelMessage,
  type ModelRequest,
  promptChars,
} from "@agenteschat/providers";
import {
  createFakeJudge,
  createJobHandlers,
  drainOutbox,
  type Judge,
  postPersonMessage,
  type ToolSource,
} from "../src";
import {
  CHARS_PER_TOKEN,
  compactToolResults,
  contextBudgetTokens,
  dropOldImages,
  estimateRequestTokens,
  fitContextWindow,
  MAX_CONTEXT_TOKENS,
  removableToolResults,
  removedPlaceholder,
} from "../src/context-budget";
import { type Fixture, setup } from "./fixtures";

const system = [{ text: "You are Dev, a developer of Acme." }];
const big = (label: string, chars: number) => `${label}:${"x".repeat(chars)}`;

/** A run's messages: the request, then one tool call and its result per entry (the last entry is the latest turn). */
function conversation(results: { id: string; name: string; content: string }[]): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "Summarize the three reports." }];
  for (const r of results) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Reading ${r.id}.` },
        { type: "tool_use", id: r.id, name: r.name, input: { path: `${r.id}.md` } },
      ],
    });
    messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: r.id, content: r.content }] });
  }
  return messages;
}

const results = (messages: ModelMessage[]) =>
  messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result"),
  );
const removed = (messages: ModelMessage[]) =>
  results(messages)
    .filter((b) => b.content.startsWith("[Result removed"))
    .map((b) => b.toolUseId);

/** Three 30k-char results (~10k tokens each) and a window where only about two fit. */
const three = () =>
  conversation([
    { id: "a", name: "read_file", content: big("a", 30_000) },
    { id: "b", name: "read_file", content: big("b", 30_000) },
    { id: "c", name: "read_file", content: big("c", 30_000) },
  ]);
const input = (messages: ModelMessage[], windowTokens = 28_000) => ({
  orgId: "org",
  model: "claude-sonnet-5-5",
  windowTokens,
  maxOutputTokens: 1000,
  system,
  messages,
});

describe("estimate", () => {
  test("grows with every part of the request, at about CHARS_PER_TOKEN", () => {
    const base = { system, messages: conversation([]) };
    const t0 = estimateRequestTokens(base);
    const longer = estimateRequestTokens({ ...base, system: [...system, { text: "y".repeat(3000) }] });
    expect(longer - t0).toBe(Math.ceil(3000 / CHARS_PER_TOKEN));
    const withResult = estimateRequestTokens({
      ...base,
      messages: conversation([{ id: "a", name: "read_file", content: "z".repeat(900) }]),
    });
    expect(withResult).toBeGreaterThan(t0 + 300);
    const tool = { name: "read_file", description: "Read a file.", inputSchema: { type: "object" } };
    expect(estimateRequestTokens({ ...base, tools: [tool] })).toBeGreaterThan(t0);
  });

  test("past the images a request carries, the oldest results' images go first, a note in their place", () => {
    const result = (id: string, data: string): ModelMessage => ({
      role: "user",
      content: [{ type: "tool_result", toolUseId: id, content: id, images: [{ mediaType: "image/png", data }] }],
    });
    const messages = [result("old", "x".repeat(6)), result("new", "y".repeat(6))];
    expect(dropOldImages(messages, 12)).toBe(messages);
    const [old, recent] = dropOldImages(messages, 10);
    expect(old?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "old",
        content: "old\n[Image removed to save space. Read the file again if you need it.]",
      },
    ]);
    expect(recent).toBe(messages[1]);
  });

  test("an image counts as about a large image's tokens, never its base64; removing its result drops it", () => {
    const messages = conversation([{ id: "a", name: "read_skill_file", content: "diagram.png" }]);
    const image = { mediaType: "image/png", data: "x".repeat(1_000_000) };
    const shown: ModelMessage[] = [
      ...messages.slice(0, -1),
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "diagram.png", images: [image] }] },
    ];
    const extra = estimateRequestTokens({ system, messages: shown }) - estimateRequestTokens({ system, messages });
    expect(Math.abs(extra - IMAGE_CHARS / CHARS_PER_TOKEN)).toBeLessThanOrEqual(1);
    expect(promptChars({ system, messages: shown }) - promptChars({ system, messages })).toBeLessThan(IMAGE_CHARS + 20);
    const compacted = compactToolResults(shown, new Set(["a"]));
    expect(results(compacted)[0]).toEqual({
      type: "tool_result",
      toolUseId: "a",
      content: removedPlaceholder(IMAGE_CHARS + 11),
    });
  });

  test("budget is the window minus the output and the margin, capped for cost", () => {
    expect(contextBudgetTokens(200_000, 16_000)).toBe(174_000);
    expect(contextBudgetTokens(1_000_000, 16_000)).toBe(MAX_CONTEXT_TOKENS);
    expect(contextBudgetTokens(1000, 5000)).toBe(0);
    // An agent that chose 1M chose to pay for it: no cap.
    expect(contextBudgetTokens(1_000_000, 16_000, Number.POSITIVE_INFINITY)).toBe(934_000);
  });

  test("the limits an agent may choose: those under the model's window; the smaller one wins", () => {
    expect(contextLimitsFor(1_048_576)).toEqual([200_000, 400_000, 1_000_000]);
    expect(contextLimitsFor(400_000)).toEqual([200_000, 400_000]);
    expect(contextLimitsFor(128_000)).toEqual([]);
    expect([isContextLimit(400_000), isContextLimit(300_000), isContextLimit("400000")]).toEqual([true, false, false]);
    expect([contextWindowWithin(1_000_000, 400_000), contextWindowWithin(200_000, 400_000)]).toEqual([
      400_000, 200_000,
    ]);
    expect(contextWindowWithin(200_000, null)).toBe(200_000);
  });
});

describe("fitContextWindow", () => {
  test("under budget: nothing changes and the judge isn't asked", async () => {
    const judge = createFakeJudge(() => 0.5);
    expect(await fitContextWindow(judge, input(three(), 200_000))).toBeNull();
    expect(judge.calls).toHaveLength(0);
  });

  test("the agent's limit is the window when smaller", async () => {
    expect(await fitContextWindow(null, input(three(), 200_000))).toBeNull();
    const limited = await fitContextWindow(null, { ...input(three(), 200_000), limitTokens: 28_000 });
    expect(limited?.report).toMatchObject({ windowTokens: 28_000, removed: 1, fits: true });
    // A limit past the window changes nothing.
    expect(await fitContextWindow(null, { ...input(three(), 200_000), limitTokens: 1_000_000 })).toBeNull();
  });

  test("over budget without a judge: the oldest results go first, the latest turn's never", async () => {
    const messages = three();
    const fitted = await fitContextWindow(null, input(messages));
    expect(fitted).not.toBeNull();
    expect(removed(fitted?.messages ?? [])).toEqual(["a"]);
    expect(fitted?.report).toMatchObject({ removed: 1, removedChars: 30_002, source: "none", fits: true });
    expect(results(fitted?.messages ?? []).find((b) => b.toolUseId === "a")?.content).toBe(removedPlaceholder(30_002));
    // The input is untouched; texts and tool calls are the same objects.
    expect(removed(messages)).toEqual([]);
    expect(fitted?.messages[1]).toBe(messages[1] as ModelMessage);
    // Already removed results aren't candidates again.
    expect(removableToolResults(fitted?.messages ?? []).map((c) => c.toolUseId)).toEqual(["b"]);
  });

  test("with the judge: the result it least expects the agent to need goes first", async () => {
    const judge = createFakeJudge((kind, _id, _state, q) => {
      if (kind !== "context_budget" || typeof q.instructions !== "string") return 0;
      return q.instructions.includes("a.md") ? 0.9 : 0.2;
    });
    const fitted = await fitContextWindow(judge, { ...input(three()), task: "Summarize the three reports." });
    expect(removed(fitted?.messages ?? [])).toEqual(["b"]);
    expect(fitted?.report).toMatchObject({ source: "judge", scores: { b: 0.2 } });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({
      kind: "context_budget",
      calibrated: true,
      state: { task: "Summarize the three reports.", now: "Reading c." },
    });
    // One question per old result: the latest turn's isn't asked about.
    expect(Object.keys(judge.calls[0]?.questions ?? {})).toHaveLength(2);
  });

  test("the judge too slow or failing: oldest first", async () => {
    const slow: Judge = { name: "slow", ask: () => new Promise(() => {}) };
    const late = await fitContextWindow(slow, { ...input(three()), timeoutMs: 5 });
    expect(late?.report.source).toBe("timeout");
    expect(removed(late?.messages ?? [])).toEqual(["a"]);
    const broken: Judge = { name: "broken", ask: async () => Promise.reject(new Error("down")) };
    expect((await fitContextWindow(broken, input(three())))?.report.source).toBe("error");
  });

  test("never the latest turn's results: still over budget, the call goes as it is", async () => {
    const judge = createFakeJudge(() => 0);
    const fitted = await fitContextWindow(judge, input(three(), 10_000));
    expect(removed(fitted?.messages ?? [])).toEqual(["a", "b"]);
    expect(fitted?.report).toMatchObject({ source: "all", fits: false });
    // Every old result had to go: no point asking.
    expect(judge.calls).toHaveLength(0);
    expect(results(fitted?.messages ?? []).at(-1)?.content).toBe(big("c", 30_000));
    // Only the latest turn's result is big: nothing to remove.
    const one = conversation([{ id: "a", name: "read_file", content: big("a", 60_000) }]);
    expect(await fitContextWindow(judge, input(one, 10_000))).toBeNull();
  });
});

describe("in a run", () => {
  let f: Fixture;
  afterEach(async () => {
    const current = f;
    f = undefined as unknown as Fixture;
    await current?.close();
  });

  const reader: ToolSource = {
    name: "reader",
    tools: async () => [
      {
        name: "read_report",
        description: "Read a report",
        scope: "",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
        async execute(input) {
          return { content: big(String(input.name), 45_000) };
        },
      },
    ],
  };

  test("old tool results give way when the window fills: saved on the transcript, with a context step", async () => {
    f = await setup({
      toolSources: [reader],
      reply: (_req: ModelRequest, call: number) =>
        call <= 3
          ? { chunks: [`Reading r${call}.`], toolUses: [{ name: "read_report", input: { name: `r${call}` } }] }
          : { chunks: ["All three read."] },
    });
    // ~15k tokens per result; fewer than two fit.
    const handlers = createJobHandlers({ ...f.jobDeps, contextWindowTokens: 30_000 });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev read the three reports",
    });
    await drainOutbox(f.db, handlers);

    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    const sent = f.provider.calls
      .filter((c) => c.request.tools?.some((t) => t.name === "read_report"))
      .map((c) => results(c.request.messages));
    expect(sent).toHaveLength(4);
    const isRemoved = (b: { content: string }) => b.content.startsWith("[Result removed");
    // Third call: the first result gave way, the latest is whole.
    expect(sent[2]?.map(isRemoved)).toEqual([true, false]);
    // Fourth: the first two, the latest whole.
    expect(sent[3]?.map(isRemoved)).toEqual([true, true, false]);
    expect(sent[3]?.at(-1)?.content.length).toBeGreaterThanOrEqual(45_000);
    // The transcript keeps the compaction (a resume sends the same history).
    const stored = run?.transcript as unknown as { messages: ModelMessage[] };
    expect(removed(stored.messages)).toHaveLength(2);
    const steps = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, run?.id ?? ""))
      .orderBy(asc(schema.agentRunSteps.seq));
    const budget = steps.filter((s) => s.kind === "context" && "contextBudget" in s.data);
    expect(budget).toHaveLength(2);
    expect(budget[0]?.data.contextBudget).toMatchObject({ removed: 1, windowTokens: 30_000 });
  });
});
