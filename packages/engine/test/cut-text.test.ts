import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  answerQuestion,
  createFakeJudge,
  drainOutbox,
  followThroughVerdict,
  postPersonMessage,
  type ToolSource,
  truncateOutput,
} from "../src";
import { cutText, cutTextEnd } from "../src/format";
import { type Fixture, setup } from "./fixtures";

/**
 * Text is cut on whole characters wherever the cut is kept as jsonb or read by a judge: half of an emoji (a lone
 * surrogate) is refused by Postgres ("invalid input syntax for type json"), and the run that wrote it never answers.
 */

// PGlite setup on a slow machine.
setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string) => postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body });
const onlyRun = async () => (await f.db.select().from(schema.agentRuns))[0];
const stepsOf = (runId: string) =>
  f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, runId))
    .orderBy(schema.agentRunSteps.seq);
const replies = async (runId: string) =>
  (await f.db.select().from(schema.messages)).filter((m) => m.agentRunId === runId).map((m) => m.body);

const feed = (content: string): ToolSource => ({
  name: "feed",
  tools: async () => [
    {
      name: "read_feed",
      description: "Read the feed",
      scope: "context:read",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content }),
    },
  ],
});

describe("cutText and cutTextEnd", () => {
  test("a pair across the cut is left out whole, from either end", () => {
    expect(cutText("ab🚀", 3)).toBe("ab");
    expect(cutText("ab🚀", 4)).toBe("ab🚀");
    expect(cutTextEnd("🚀ab", 3)).toBe("ab");
    expect(cutTextEnd("🚀ab", 4)).toBe("🚀ab");
    expect(cutTextEnd("abc", 0)).toBe("");
    expect(cutTextEnd("abc", 10)).toBe("abc");
  });

  test("a long output cut in the middle keeps whole characters on both sides", () => {
    const cut = truncateOutput(`${"a".repeat(59)}🚀${"b".repeat(100)}🚀${"c".repeat(39)}`, 100);
    expect(cut).not.toMatch(LONE);
    expect(cut.startsWith("a".repeat(59))).toBe(true);
    expect(cut.endsWith("c".repeat(39))).toBe(true);
  });
});

describe("cuts kept as jsonb", () => {
  test("narration with an emoji across its 4000th unit: its step is stored and the run answers", async () => {
    // Words, not one long run of a letter: that would read as a squashed echo and be dropped (`dropSquashedEcho`).
    f = await setup({
      toolSources: [feed("3 posts novos.")],
      reply: (_req, n) =>
        n === 1
          ? { chunks: [`${"ab ".repeat(1333)}🚀 vou ler o feed.`], toolUses: [{ name: "read_feed", input: {} }] }
          : { chunks: ["Pronto."] },
    });
    await ask("@dev lê o feed");
    await drainOutbox(f.db, f.handlers);

    const run = await onlyRun();
    expect(run).toMatchObject({ status: "done", turns: 2 });
    expect(await replies(run?.id ?? "")).toEqual(["Pronto."]);
    const narration = (await stepsOf(run?.id ?? "")).flatMap((s) =>
      s.kind === "model_call" && typeof s.data.narration === "string" ? [s.data.narration] : [],
    );
    expect(narration).toEqual(["ab ".repeat(1333)]);
  });

  test("a tool result with an emoji across its 4000th unit: its step is stored and the run answers", async () => {
    f = await setup({
      toolSources: [feed(`${"x".repeat(3999)}🚀 lançamento de hoje`)],
      reply: (_req, n) =>
        n === 1 ? { chunks: [], toolUses: [{ name: "read_feed", input: {} }] } : { chunks: ["Pronto."] },
    });
    await ask("@dev lê o feed");
    await drainOutbox(f.db, f.handlers);

    const run = await onlyRun();
    expect(run).toMatchObject({ status: "done", turns: 2 });
    expect(await replies(run?.id ?? "")).toEqual(["Pronto."]);
    const results = (await stepsOf(run?.id ?? "")).filter((s) => s.kind === "tool_result");
    expect(results.map((s) => s.data.content)).toEqual(["x".repeat(3999)]);
  });

  test("a resumed step: an answer with an emoji across the 4000th unit of its result is stored and the run answers", async () => {
    f = await setup({
      askUser: true,
      reply: (req) =>
        JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Recebi."] }
          : {
              chunks: [],
              toolUses: [
                {
                  name: "ask_user",
                  input: {
                    why: "I need a person's answer before I go on: this decides what I write next.",
                    question: "Qual texto?",
                  },
                },
              ],
            },
    });
    await ask("@dev escreve o anúncio");
    await drainOutbox(f.db, f.handlers);
    const [question] = await f.db.select().from(schema.agentQuestions);
    const said = "The person answered: ";
    await answerQuestion(deps(), f.owner.id, f.org.id, question?.id ?? "", {
      text: `${"x".repeat(3999 - said.length)}🚀 lançamento`,
    });
    await drainOutbox(f.db, f.handlers);

    const run = await onlyRun();
    expect(run?.status).toBe("done");
    expect((await replies(run?.id ?? "")).at(-1)).toBe("Recebi.");
    const resumed = (await stepsOf(run?.id ?? "")).filter(
      (s) => s.kind === "tool_result" && (s.data.data as { questionId?: string } | undefined)?.questionId,
    );
    expect(resumed.map((s) => s.data.content)).toEqual([`${said}${"x".repeat(3999 - said.length)}`]);
  });

  test("a quote of a message with an emoji across its excerpt's cut: the reply is posted", async () => {
    f = await setup();
    const quoted = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
      body: `${"x".repeat(198)}🚀 e o resto da mensagem`,
    });
    const reply = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
      body: "Concordo",
      replyTo: quoted.id,
    });
    expect((reply.meta.replyTo as { excerpt?: string }).excerpt).toBe(`${"x".repeat(198)}…`);
  });
});

test("the follow-through judge reads the reply's end without half of a pair at its start", async () => {
  const judge = createFakeJudge();
  await followThroughVerdict(judge, {
    orgId: "org",
    agentId: "agent",
    runId: "run",
    request: "Manda o resumo",
    reply: `a🚀${"x".repeat(2999)}`,
  });
  expect(judge.calls[0]?.state).toEqual({ request: "Manda o resumo", reply: "x".repeat(2999) });
});
