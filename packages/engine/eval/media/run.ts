/**
 * Agents' stickers and GIFs after their replies (ADR 0091 §4): the real Jev on labeled conversations (`cases.ts`),
 * asked exactly what production asks (`judgeAgentMedia`, with `agentMediaState` and `agentMediaQuestions` from
 * `src/agent-media.ts`). Jev leans toward a choice's first option, so every case is asked twice: in production's
 * order (the plainest option first) and with every option list reversed. Prints, for each order, precision and
 * recall of "send" at 0.6, 0.7 and 0.8 (the `often` and `sometimes` bars are 0.6 and 0.8), how often the mood
 * is one that fits, and how often the first option was picked. Exits 1 when, in production's order, a
 * conversation that should get nothing clears the `sometimes` bar: a sticker after bad news is the costly error.
 *
 *   bun run eval:media                 # every case, stickers only (the question set where nobody sends GIFs)
 *   bun run eval:media --gif           # also the GIF question, as where people send GIFs, and its category
 *   bun run eval:media --only pt-outage,en-birthday --repeat 3
 *
 * Manual, never in CI: it calls the real service and costs a little. Needs TYPESAFE_API_KEY (`.env`).
 * `JEV_TIMEOUT_MS` (default 8000) is each request's own limit. The full report goes to `eval/out/media-*.json`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  AGENT_MEDIA_THRESHOLDS,
  type AgentMediaJudgment,
  GIF_CRITERIA,
  judgeAgentMedia,
  MOOD_CRITERIA,
  replyTextSkip,
} from "../../src/agent-media";
import { createJevJudge } from "../../src/judge";
import { CASES, type MediaCase } from "./cases";

const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const withGif = args.includes("--gif");
const only = flagValue("--only")
  ?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const repeat = Math.max(1, Number(flagValue("--repeat") ?? 1) || 1);
const CONCURRENCY = 4;
const BARS = [0.6, 0.7, 0.8];
const ORG = "00000000-0000-0000-0000-000000000000";

const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY is missing (put it in .env: the eval calls the real Jev).");
// No workspace here: usage isn't recorded.
const judge = createJevJudge({
  key,
  gateway: { recordExternalUsage: async () => null },
  timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 8000),
});

const cases = CASES.filter((c) => !only || only.includes(c.id));
if (cases.length === 0) throw new Error("no case matches --only");
// Production never asks Jev about a reply its free checks rule out: such a case would measure nothing.
for (const c of cases) {
  const gated = replyTextSkip(c.reply);
  if (gated) throw new Error(`case ${c.id}: the step's free checks rule its reply out (${gated})`);
}

type Order = "fixed" | "reversed";
const ORDERS: Order[] = ["fixed", "reversed"];
interface Sample {
  c: MediaCase;
  order: Order;
  judged: AgentMediaJudgment | null;
  error?: string;
}

async function judgeOnce(c: MediaCase, order: Order): Promise<Sample> {
  try {
    const judged = await judgeAgentMedia(
      judge,
      { orgId: ORG, input: { agent: c.agent, where: c.where, conversation: c.conversation, reply: c.reply } },
      { gif: withGif, reversed: order === "reversed", timeoutMs: 20_000 },
    );
    return { c, order, judged };
  } catch (error) {
    return { c, order, judged: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the tasks at most `CONCURRENCY` at a time; results in the tasks' order. */
async function pool<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      const task = tasks[i];
      if (task) out[i] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return out;
}

const tasks: (() => Promise<Sample>)[] = [];
for (const c of cases) {
  for (const order of ORDERS) {
    for (let r = 0; r < repeat; r++) tasks.push(() => judgeOnce(c, order));
  }
}
const started = performance.now();
const samples = await pool(tasks);
const seconds = (performance.now() - started) / 1000;

/** The first option Jev saw in each order. */
const firstOf = (criteria: Record<string, string>, order: Order) =>
  order === "fixed" ? Object.keys(criteria)[0] : Object.keys(criteria).at(-1);
const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const mean = (xs: number[]) => (xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length);
const fixed2 = (n: number | undefined) => (n === undefined ? "  — " : n.toFixed(2));

function summary(order: Order) {
  const answered = samples.filter((s) => s.order === order && s.judged);
  const fits = (s: Sample) => s.judged?.fits ?? 0;
  const bars = BARS.map((bar) => {
    const sent = answered.filter((s) => fits(s) >= bar);
    const right = sent.filter((s) => s.c.send).length;
    const light = answered.filter((s) => s.c.send).length;
    return {
      bar,
      precision: sent.length === 0 ? 1 : right / sent.length,
      recall: light === 0 ? 1 : right / light,
      falsePositives: sent.length - right,
    };
  });
  const light = answered.filter((s) => s.c.send);
  const moodFits = light.filter((s) => s.judged?.mood && s.c.moods?.includes(s.judged.mood)).length;
  const firstMood = answered.filter((s) => s.judged?.mood === firstOf(MOOD_CRITERIA, order)).length;
  const gifLabeled = light.filter((s) => s.c.gifs);
  const gifFits = gifLabeled.filter((s) => s.judged?.gif && s.c.gifs?.includes(s.judged.gif)).length;
  const firstGif = answered.filter((s) => s.judged?.gif === firstOf(GIF_CRITERIA, order)).length;
  return {
    order,
    answers: answered.length,
    errors: samples.filter((s) => s.order === order && !s.judged).length,
    bars,
    moodAccuracy: share(moodFits, light.length),
    firstMood: share(firstMood, answered.length),
    ...(withGif ? { gifAccuracy: share(gifFits, gifLabeled.length), firstGif: share(firstGif, answered.length) } : {}),
  };
}

// One line per case: Jev's probability in both orders, the moods picked, what was expected.
const bar = AGENT_MEDIA_THRESHOLDS.sometimes;
for (const c of cases) {
  const of = (order: Order) => samples.filter((s) => s.c === c && s.order === order);
  const fitsOf = (order: Order) => mean(of(order).flatMap((s) => (s.judged ? [s.judged.fits] : [])));
  const moodsOf = (order: Order) => of(order).map((s) => s.judged?.mood ?? (s.error ? "error" : "none"));
  const gifsOf = (order: Order) => of(order).map((s) => s.judged?.gif ?? "—");
  const p = fitsOf("fixed");
  const sends = p !== undefined && p >= bar;
  const verdict = p === undefined ? "ERR " : sends === c.send ? "PASS" : "FAIL";
  const gifs = withGif ? `  gif ${gifsOf("fixed").join(",")}/${gifsOf("reversed").join(",")}` : "";
  console.log(
    `${verdict}  ${fixed2(p)}/${fixed2(fitsOf("reversed"))}  mood ${moodsOf("fixed").join(",")}/${moodsOf("reversed").join(",")}${gifs}  ${c.send ? "send" : "none"}  ${c.id}`,
  );
}

const summaries = ORDERS.map(summary);
for (const s of summaries) {
  console.log(
    `\n${s.order === "fixed" ? "Production's order" : "Every option list reversed"}: ${s.answers} answers, ${s.errors} errors`,
  );
  for (const b of s.bars) {
    const fp = b.falsePositives > 0 ? `, ${b.falsePositives} false positive(s)` : "";
    console.log(`  at ${b.bar.toFixed(1)}: precision ${pct(b.precision)}, recall ${pct(b.recall)}${fp}`);
  }
  console.log(
    `  mood that fits: ${pct(s.moodAccuracy)} of light replies; first option (${firstOf(MOOD_CRITERIA, s.order)}) picked: ${pct(s.firstMood)}`,
  );
  if (s.gifAccuracy !== undefined && s.firstGif !== undefined) {
    console.log(
      `  GIF category that fits: ${pct(s.gifAccuracy)}; first option (${firstOf(GIF_CRITERIA, s.order)}) picked: ${pct(s.firstGif)}`,
    );
  }
}
// How much the order alone moves the mood: cases whose picks differ between the two orders.
const moved = cases.filter((c) => {
  const picks = (order: Order) =>
    samples
      .filter((s) => s.c === c && s.order === order)
      .map((s) => s.judged?.mood ?? "")
      .join(",");
  return picks("fixed") !== picks("reversed");
}).length;
console.log(`\nMood changed with the order in ${moved}/${cases.length} cases. ${seconds.toFixed(1)} s.`);

const OUT = path.join(import.meta.dir, "..", "out");
mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `media-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await Bun.write(
  file,
  `${JSON.stringify(
    {
      thresholds: AGENT_MEDIA_THRESHOLDS,
      gif: withGif,
      repeat,
      summaries,
      samples: samples.map((s) => ({ id: s.c.id, send: s.c.send, order: s.order, ...s.judged, error: s.error })),
    },
    null,
    2,
  )}\n`,
);
console.log(`Report: ${file}`);

// Production's order at production's `sometimes` bar: a conversation that should get nothing must not clear it.
const falseAlarms = samples.filter((s) => s.order === "fixed" && !s.c.send && (s.judged?.fits ?? 0) >= bar).length;
if (falseAlarms > 0) console.log(`${falseAlarms} answer(s) would send a reaction where none fits, at ${bar}.`);
process.exit(falseAlarms > 0 ? 1 : 0);
