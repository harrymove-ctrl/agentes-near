import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  answerQuestion,
  continueRun,
  type createFakeJudge,
  createJevJudge,
  createJobHandlers,
  createLlmJudge,
  drainOutbox,
  noteStep,
  postPersonMessage,
  STUCK_END_REPLY_NOTE,
  STUCK_NOTE,
  type StuckState,
  type ToolSource,
  WRAP_UP_REPLY_NOTE,
  withJudgeFallback,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * Runs that go in circles stop, long legitimate runs don't (ADR 0015 addendum): repetition is found by
 * structure after each step, only then the judge (Jev) is asked, and with no judge the repetition decides.
 * Stuck once, a note; stuck again, the run says where it stands, with Continuar. The cap is a backstop.
 */

// PGlite setup, and runs of over a hundred calls, on a slow machine.
setDefaultTimeout(60_000);

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
const requests = () => f.provider.calls.map((c) => c.request);
const stuckChecks = () =>
  (f.context.judge as ReturnType<typeof createFakeJudge>).calls.filter((c) => c.kind === "stuck_run");
const verdicts = async (runId: string) =>
  (
    await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, runId))
      .orderBy(schema.agentRunSteps.seq)
  ).flatMap((s) => (s.data as { stuckCheck?: unknown }).stuckCheck ?? []);

/** 1 → "b", 10 → "ba": results that differ in words (the numbers in a result don't count). */
const word = (n: number) => String(n).replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "");

/** A refactor's files, a deploy this agent may not do, a build that passes on its 8th check, and web pages. */
function taskTools(): ToolSource {
  const input = (key: string) => ({ type: "object", properties: { [key]: { type: "string" } } });
  let checks = 0;
  return {
    name: "task",
    tools: async () => [
      {
        name: "edit_file",
        description: "Edit a file",
        scope: "context:read",
        inputSchema: input("path"),
        execute: async (args) => ({ content: `Saved ${String(args.path)}.` }),
      },
      {
        name: "deploy",
        description: "Deploy",
        scope: "context:read",
        inputSchema: input("env"),
        execute: async () => ({ content: "Permission denied: this agent can't deploy.", isError: true }),
      },
      {
        name: "check_build",
        description: "Check a build",
        scope: "context:read",
        inputSchema: input("id"),
        execute: async () => ({ content: ++checks < 8 ? "Build 812: running" : "Build 812: passed" }),
      },
      {
        name: "browser_open",
        description: "Open a page",
        scope: "context:read",
        inputSchema: input("url"),
        execute: async (args) => ({ content: `Page ${String(args.url)}` }),
      },
    ],
  };
}

const deploy = { chunks: [], toolUses: [{ name: "deploy", input: { env: "prod" } }] };

describe("a run that goes in circles", () => {
  test("repeating one failing call: one note, then it is told to stop, then it ends saying it got stuck, with Continuar", async () => {
    f = await setup({
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: () => deploy,
    });
    await ask("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);

    // Stuck at its 3rd call: the 4th reads the note. Stuck again at its 6th: two more calls, and the run ends.
    expect(requests()).toHaveLength(8);
    expect(requests().findIndex((r) => lastText(r).includes(STUCK_NOTE))).toBe(3);
    expect(requests().findIndex((r) => lastText(r).includes(STUCK_END_REPLY_NOTE))).toBe(6);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", error: null, turns: 8 });
    const posted = await agentMessages(run?.id ?? "");
    expect(posted.map((m) => [m.body, m.meta.bodyCode, m.meta.stepLimit])).toEqual([
      ["I got stuck and stopped before finishing.", "stuck", { stuck: true }],
    ]);
    expect(await verdicts(run?.id ?? "")).toEqual([
      { sign: "same_call", stuck: true, by: "fake", action: "note" },
      { sign: "same_call", stuck: true, by: "fake", action: "end" },
    ]);
    // Continuar picks up from there, once. Its trigger is that line: the judge still reads what the person asked.
    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, run?.id ?? "");
    const [line] = await agentMessages(run?.id ?? "");
    expect(line?.meta.stepLimit).toMatchObject({ stuck: true, continuedRunId: runId });
    await drainOutbox(f.db, f.handlers);
    const asked = stuckChecks().filter((c) => c.runId === runId);
    expect(asked.map((c) => c.state.request)).toEqual(["@dev faz o deploy", "@dev faz o deploy"]);
  });

  test("told to stop, it says what it did, what it tried and what is left: that reply carries Continuar", async () => {
    const said = "Tentei o deploy 6 vezes e a permissão foi negada em todas. Falta alguém liberar o deploy para mim.";
    f = await setup({
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: (req) => (lastText(req).includes(STUCK_END_REPLY_NOTE) ? { chunks: [said] } : deploy),
    });
    await ask("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);

    expect(requests()).toHaveLength(7);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", turns: 7 });
    const posted = await agentMessages(run?.id ?? "");
    expect(posted.map((m) => [m.body, m.meta.stepLimit])).toEqual([[said, { stuck: true }]]);
    expect(run?.replyMessageId).toBe(posted[0]?.id ?? "");
  });

  test("a person's answer to its question starts it over: stuck again after it, a note, not the end", async () => {
    const why = "I need a person's answer before I go on: this decides what I write next.";
    const said = "Sem permissão para o deploy em prod: alguém precisa liberar.";
    f = await setup({
      askUser: true,
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: (_req, n) =>
        n === 4
          ? { chunks: [], toolUses: [{ name: "ask_user", input: { why, question: "Qual ambiente?" } }] }
          : n <= 7
            ? deploy
            : { chunks: [said] },
    });
    await ask("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);
    const [question] = await f.db.select().from(schema.agentQuestions);
    await answerQuestion(deps(), f.owner.id, f.org.id, question?.id ?? "", { text: "prod" });
    await drainOutbox(f.db, f.handlers);

    // Stuck at its 3rd call, it asks after the note; the same call 3 times after the answer is a first time again.
    const [run] = await runs();
    expect(await verdicts(run?.id ?? "")).toEqual([
      { sign: "same_call", stuck: true, by: "fake", action: "note" },
      { sign: "same_call", stuck: true, by: "fake", action: "note" },
    ]);
    const posted = await agentMessages(run?.id ?? "");
    expect(posted.map((m) => [m.body, m.meta.stepLimit]).at(-1)).toEqual([said, undefined]);
  });

  test("with no Jev and no small model to ask, the repetition decides", async () => {
    f = await setup({ toolSources: [taskTools()], reply: () => deploy });
    f.context.judge = withJudgeFallback(
      createJevJudge({ key: { key: async () => null, report: () => {}, usable: () => false }, gateway: f.gateway }),
      createLlmJudge({ gateway: f.gateway, resolveModel: async () => null }),
    );
    await ask("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);

    expect(requests()).toHaveLength(8);
    const [run] = await runs();
    expect(await verdicts(run?.id ?? "")).toEqual([
      { sign: "same_call", stuck: true, by: "structural", action: "note" },
      { sign: "same_call", stuck: true, by: "structural", action: "end" },
    ]);
    const [line] = await agentMessages(run?.id ?? "");
    expect(line?.meta).toMatchObject({ bodyCode: "stuck", stepLimit: { stuck: true } });
  });
});

describe("a run that keeps going", () => {
  test("a long varied run of 120 calls is never stopped, and nobody is asked about it", async () => {
    f = await setup({
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: (_req, n) =>
        n <= 120
          ? { chunks: [], toolUses: [{ name: "edit_file", input: { path: `src/${word(n)}.ts` } }] }
          : { chunks: ["Refatorei os 120 arquivos."] },
    });
    await ask("@dev refatora o projeto");
    await drainOutbox(f.db, f.handlers);

    expect(requests()).toHaveLength(121);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", error: null, turns: 121 });
    const posted = await agentMessages(run?.id ?? "");
    expect(posted.map((m) => [m.body, m.meta.stepLimit])).toEqual([["Refatorei os 120 arquivos.", undefined]]);
    expect(stuckChecks()).toEqual([]);
  });

  test("a poll Jev reads as progress goes on until the build passes: Jev read its last calls", async () => {
    f = await setup({
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.1 : undefined),
      reply: (_req, n) =>
        n <= 8
          ? { chunks: [], toolUses: [{ name: "check_build", input: { id: "812" } }] }
          : { chunks: ["O build 812 passou."] },
    });
    await ask("@dev me avisa quando o build 812 passar");
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", turns: 9 });
    expect((await agentMessages(run?.id ?? "")).map((m) => m.body)).toEqual(["O build 812 passou."]);
    expect(requests().some((r) => lastText(r).includes(STUCK_NOTE))).toBe(false);
    // Asked at the 3rd and the 6th check, each time about new calls only.
    const checks = stuckChecks();
    expect(checks.map((c) => [c.agentId, c.runId])).toEqual([
      [f.agent.id, run?.id],
      [f.agent.id, run?.id],
    ]);
    const running = { tool: "check_build", input: '{"id":"812"}', result: "Build 812: running" };
    expect(checks[0]?.state).toEqual({
      request: "@dev me avisa quando o build 812 passar",
      repeated: "the same call with the same input, 3 times in a row",
      steps: [running, running, running],
    });
    expect(Object.keys(checks[0]?.questions ?? {})).toEqual(["stuck"]);
  });

  test("the backstop still ends a run that never repeats, its browser steps counted like any other", async () => {
    f = await setup({
      toolSources: [taskTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: (_req, n) => ({
        chunks: [],
        toolUses: [{ name: "browser_open", input: { url: `https://${word(n)}.example` } }],
      }),
    });
    await ask("@dev posta nos sites");
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 6 }));

    expect(requests()).toHaveLength(6);
    expect(requests().findIndex((r) => lastText(r).includes(WRAP_UP_REPLY_NOTE))).toBe(4);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", turns: 6 });
    const posted = await agentMessages(run?.id ?? "");
    expect(posted.map((m) => [m.meta.bodyCode, m.meta.stepLimit])).toEqual([["step_limit", {}]]);
    expect(stuckChecks()).toEqual([]);
  });

  test("a tool result with an emoji across its 300th unit: the step is kept without half of it, and the run answers", async () => {
    const feed: ToolSource = {
      name: "feed",
      tools: async () => [
        {
          name: "read_feed",
          description: "Read the feed",
          scope: "context:read",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          execute: async () => ({ content: `${"x".repeat(299)}🚀 lançamento de hoje` }),
        },
      ],
    };
    // Its input as the judge reads it, `{"q":"…"}`, has an emoji across its 200th unit.
    const q = `${"x".repeat(193)}🚀`;
    f = await setup({
      toolSources: [feed],
      reply: (_req, n) =>
        n === 1 ? { chunks: [], toolUses: [{ name: "read_feed", input: { q } }] } : { chunks: ["Pronto."] },
    });
    await ask("@dev lê o feed");
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", turns: 2 });
    expect((await agentMessages(run?.id ?? "")).map((m) => m.body)).toEqual(["Pronto."]);
    const kept = (run?.transcript as { stuck?: StuckState } | null)?.stuck?.steps[0]?.said;
    expect(kept).toEqual([{ tool: "read_feed", input: `{"q":"${"x".repeat(193)}`, result: "x".repeat(299) }]);
  });
});

describe("what counts as repetition", () => {
  type Call = { name: string; input: unknown; content: string; isError?: boolean };
  /** The sign after each step, a verdict at `verdictAt` restarting the evidence as the executor does. */
  const signs = (steps: Call[], verdictAt?: number) => {
    let state: StuckState | undefined;
    return steps.map((call, i) => {
      const noted = noteStep(state, i + 1, [{ ...call, isError: call.isError === true }]);
      state = noted.state;
      if (i + 1 === verdictAt) state.since = i + 1;
      return noted.sign;
    });
  };
  const page = (content: string): Call => ({ name: "next_page", input: {}, content });

  test("the same call a third time in a row, even when what comes back changes (a cursor's next page)", () => {
    expect(signs([page("Page one"), page("Page two"), page("Page three")])).toEqual([null, null, "same_call"]);
  });

  test("the same error a third time, whatever the call: numbers and spacing in it don't count", () => {
    const refused = (env: string, n: number): Call => ({
      name: "deploy",
      input: { env },
      content: `Permission  denied (request ${n})`,
      isError: true,
    });
    const look: Call = { name: "look", input: {}, content: "3 PRs open" };
    expect(signs([refused("a", 11), look, refused("b", 12), refused("c", 13)])).toEqual([
      null,
      null,
      null,
      "same_error",
    ]);
  });

  test("five steps in a row that only repeated earlier calls and got the same back: a two-step cycle at its 7th step", () => {
    const open = (url: string): Call => ({ name: "open", input: { url }, content: `Page ${url}` });
    const cycle = [open("a"), open("b"), open("a"), open("b"), open("a"), open("b"), open("a")];
    expect(signs(cycle)).toEqual([null, null, null, null, null, null, "nothing_new"]);
  });

  test("four steps in a row whose calls all failed, each error naming its own guess", () => {
    const guess = (path: string): Call => ({
      name: "read_file",
      input: { path },
      content: `ENOENT: no such file or directory, open '${path}'`,
      isError: true,
    });
    const guesses = ["src/app.ts", "src/main.ts", "app/main.ts", "lib/main.ts"].map(guess);
    expect(signs(guesses)).toEqual([null, null, null, "failing"]);
  });

  test("a new call that gets the same answer is new: a message sent to ten channels never repeats", () => {
    const send = (channel: string): Call => ({
      name: "send_message",
      input: { channel, text: "Oi" },
      content: "Sent.",
    });
    const sent = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(send);
    expect(signs(sent)).toEqual(sent.map(() => null));
  });

  test("after a verdict, only new steps count", () => {
    const same = page("Page one");
    expect(signs([same, same, same, same, same, same], 3)).toEqual([null, null, "same_call", null, null, "same_call"]);
  });
});
