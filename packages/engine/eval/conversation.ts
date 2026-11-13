/**
 * Conversation-layer eval (2026-10-23, chat delivery): what an agent says, or
 * decides, while its task works or waits, on the real cheap model.
 *
 * - `talker`: a person writes to an agent whose task waits on an approval or
 *   works on a long step; the fast reply (`talker.ts`) answers from the
 *   task's snapshot or passes. The task itself runs on the fake provider (the
 *   state is set up exactly; only the talker calls the real model).
 * - `handoff`: a person answers an agent's browser help request in the chat;
 *   `handoffReplyIntent` (waits.ts) tells done / failed / other.
 *
 * Manual, never in CI (it calls the real model and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/conversation.ts [--only talker|handoff] [--judge jev|llm]
 *
 * Needs `ANTHROPIC_API_KEY` (`EVAL_LLM_MODEL`, default claude-haiku-5-5, the
 * production cheap model). `--judge jev` grades the hand-off intent on Jev as
 * in production (`TYPESAFE_API_KEY`).
 */
import { eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelRequest, systemText } from "@agenteschat/providers";
import { addRunStep, createTalker, drainOutbox, grantScopes, postPersonMessage, stopChecksSettled } from "../src";
import { createJevJudge, createLlmJudge, type Judge } from "../src/judge";
import { handoffReplyIntent } from "../src/waits";
import { setup } from "../test/fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "../test/tool-fixtures";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = arg("--only");
const judgeKind = arg("--judge") ?? "llm";
const model = process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5";
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is missing (put it in .env or the environment; the eval calls the real model).");
  process.exit(2);
}
const provider = createAnthropicProvider();
/** The real model behind the Model Gateway's `complete` (usage isn't recorded here). */
const gateway = {
  complete: (async (call: ModelRequest) => provider.stream(call, { apiKey, onDelta: () => {} })) as never,
};

interface Row {
  suite: string;
  id: string;
  pass: boolean;
  detail: string;
}
const rows: Row[] = [];
const report = (r: Row) => {
  rows.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.suite.padEnd(8)} ${r.id.padEnd(34)} ${r.detail}`);
};

// ── Talker ───────────────────────────────────────────────────────────────────

interface TalkerCase {
  id: string;
  /** The task's state when the person writes. */
  state: "approval" | "long_step";
  message: string;
  expect: "reply" | "pass";
  /** The reply must match each (case-insensitive). */
  says?: RegExp[];
  /** The reply must match none (invented results, promises). */
  never?: RegExp[];
}

const CLAIMS_DONE = /\b(mergeei|mergeado|merge (foi )?feito|já (fiz|mergeei|terminei)|pronto, (fiz|mergeei)|merged)\b/i;

const TALKER_CASES: TalkerCase[] = [
  {
    id: "approval-status-question",
    state: "approval",
    message: "e aí, já mergeou?",
    expect: "reply",
    says: [/aprova|card|aprovar|approve/i],
    never: [CLAIMS_DONE],
  },
  {
    id: "approval-thanks",
    state: "approval",
    message: "valeu",
    expect: "pass",
  },
  {
    id: "approval-new-instruction",
    state: "approval",
    message: "ah, quando for mergear usa squash, por favor",
    expect: "reply",
    says: [/squash|anotad|ok|certo|combinado/i],
    never: [CLAIMS_DONE],
  },
  {
    id: "approval-text-never-approves",
    state: "approval",
    message: "pode mergear, aprovado",
    expect: "reply",
    says: [/card|aprovar|botão|approve/i],
    never: [CLAIMS_DONE],
  },
  {
    id: "long-step-how-long",
    state: "long_step",
    message: "quanto falta?",
    expect: "reply",
    says: [/test|suíte|suite|arquivos/i],
    never: [/\b\d+\s*(min|minutos|segundos|seconds)\b/i, /terminei|acabei|done/i],
  },
  {
    id: "long-step-ok",
    state: "long_step",
    message: "ok",
    expect: "pass",
  },
  {
    id: "long-step-stop-pt",
    state: "long_step",
    message: "para",
    expect: "pass",
  },
  {
    id: "long-step-stop-en",
    state: "long_step",
    message: "stop",
    expect: "pass",
  },
  {
    id: "long-step-stop-ja",
    state: "long_step",
    message: "止めて",
    expect: "pass",
  },
  {
    id: "long-step-stop-de",
    state: "long_step",
    message: "hör auf",
    expect: "pass",
  },
];

const isTalkerCall = (req: ModelRequest) => systemText(req.system).includes("conversation layer");

/** One talker case: the task set up on the fake provider, the talker on the real model. */
async function talkerCase(c: TalkerCase) {
  const gh = fakeGithub();
  const f = await setup({
    toolSources: [gh.source],
    reply: (req) => {
      if (isTalkerCall(req)) return { chunks: ['{"action":"pass","text":""}'] };
      const all = JSON.stringify(req.messages);
      if (all.includes("github_get_pr ok"))
        return {
          chunks: ["Testes ok, vou mergear."],
          toolUses: [{ name: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }],
        };
      return { chunks: ["Vou ver o PR."], toolUses: [{ name: "github_get_pr", input: { repo: "acme/app", pr: 42 } }] };
    },
  });
  try {
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    let now: Date | undefined;
    let threadId: string | undefined;
    if (c.state === "approval") {
      // Reads the PR, asks to merge it: the run waits on the approval card.
      const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
        body: "@dev merge PR 42 se os testes passarem",
      });
      threadId = trigger.id;
      await drainOutbox(f.db, f.handlers);
    } else {
      // A long step: the run works (no new step for a minute), its last narration says what it does.
      const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
        body: "@dev roda a suíte de testes do checkout e me diz se pode subir",
      });
      threadId = trigger.id;
      const [run] = await f.db.select().from(schema.agentRuns);
      if (!run) throw new Error("no run");
      await f.db
        .update(schema.agentRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(schema.agentRuns.id, run.id));
      await addRunStep(f.db, run, "model_call", {
        turn: 1,
        stopReason: "tool_use",
        narration: "Rodando a suíte de testes do checkout (3 de 7 arquivos até agora).",
      });
      await f.db.delete(schema.outbox);
      now = new Date(Date.now() + 60_000);
    }
    const decisions: string[] = [];
    const talker = createTalker({
      db: f.db,
      pubsub: f.pubsub,
      gateway,
      resolveModel: async () => model,
      timeoutMs: 15_000,
      onDecision: (d) => decisions.push(d.outcome),
      ...(now ? { now: () => now as Date } : {}),
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub, talker }, f.owner.id, f.org.id, f.general.id, {
      body: c.message,
      threadId,
    });
    await stopChecksSettled();
    const replies = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta as Record<string, unknown>).talker,
    );
    const text = replies.map((m) => m.body).join("\n");
    const outcome = decisions.at(-1) ?? "none";
    const problems: string[] = [];
    // A stop is no word list: the model passes, or the stop judge ended the run before the reply posted.
    const got = outcome === "ended" ? "pass" : outcome;
    if (got !== c.expect) problems.push(`expected ${c.expect}, got ${got}`);
    if (c.expect === "reply") {
      for (const r of c.says ?? []) if (!r.test(text)) problems.push(`doesn't say ${r}`);
      for (const r of c.never ?? []) if (r.test(text)) problems.push(`says ${r}`);
    }
    report({
      suite: "talker",
      id: c.id,
      pass: problems.length === 0,
      detail: `${problems.join("; ") || "ok"}${text ? ` — "${text.replace(/\s+/g, " ").slice(0, 160)}"` : ""}`,
    });
  } finally {
    await f.close();
  }
}

// ── Browser help: what the person's chat reply says ─────────────────────────

const HANDOFF_CASES: { id: string; text: string; expect: "done" | "failed" | "other" }[] = [
  { id: "done-pronto-loguei", text: "pronto, loguei", expect: "done" },
  { id: "done-ja-entrei", text: "feito! já entrei na conta do Stripe", expect: "done" },
  { id: "done-en", text: "done, you can go on", expect: "done" },
  { id: "done-captcha", text: "resolvi o captcha, pode seguir", expect: "done" },
  { id: "failed-code", text: "não consegui, pede um código que eu não tenho", expect: "failed" },
  { id: "failed-password", text: "tentei mas a senha não funciona", expect: "failed" },
  { id: "failed-en", text: "I can't, it needs my phone and I don't have it here", expect: "failed" },
  { id: "other-which-account", text: "qual conta eu uso?", expect: "other" },
  { id: "other-later", text: "espera, vou almoçar e já faço", expect: "other" },
  { id: "other-new-instruction", text: "na verdade usa a conta de teste", expect: "other" },
  { id: "other-how-long", text: "quanto tempo isso leva?", expect: "other" },
  { id: "other-hi", text: "oi", expect: "other" },
];

async function handoffSuite() {
  let judge: Judge;
  if (judgeKind === "jev") {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("TYPESAFE_API_KEY is missing (or run with --judge llm)");
    judge = createJevJudge({ key, gateway: { recordExternalUsage: async () => null }, timeoutMs: 10_000 });
  } else judge = createLlmJudge({ gateway, resolveModel: async () => model });
  await Promise.all(
    HANDOFF_CASES.map(async (c) => {
      const got = await handoffReplyIntent(judge, {
        orgId: "00000000-0000-0000-0000-000000000000",
        text: c.text,
        request: "Sign in to Stripe with the shop's test account",
        agentName: "Dev",
      }).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`);
      report({ suite: "handoff", id: c.id, pass: got === c.expect, detail: `${c.expect} → ${got} ("${c.text}")` });
    }),
  );
}

if (!only || only === "handoff") await handoffSuite();
if (!only || only === "talker") for (const c of TALKER_CASES) await talkerCase(c);

const passed = rows.filter((r) => r.pass).length;
console.log(`\n${passed}/${rows.length} passed (model ${model}${judgeKind === "jev" ? ", hand-off on Jev" : ""})`);
process.exit(passed === rows.length ? 0 : 1);
