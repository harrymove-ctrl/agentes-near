/**
 * Memory eval (docs/adr/0028-memory-judgments-with-jev.md §7): how well each
 * strategy tells whether a new memory item is the same as, refines, updates,
 * contradicts, relates to or has nothing to do with an existing one.
 *
 * Manual, never in CI (it calls real services and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/memory.ts [--only words,llm,jev]
 *
 * Needs `TYPESAFE_API_KEY` for `jev` and `ANTHROPIC_API_KEY` for `llm`
 * (`EVAL_LLM_MODEL`, default the router's cheap model). Cases: the synthetic
 * set next to this file, plus `memory-cases.local.json` if present: anonymized
 * real cases that never go in git (`*.local.json` is ignored).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropicProvider } from "@agenteschat/providers";
import type { ContextItem, NewContextItem } from "../src/context/items";
import { similarity } from "../src/context/items";
import { decide, judgeRelations, type Plan, RELATIONS, type Relation } from "../src/context/judgments";
import { createJevJudge, createLlmJudge, type Judge } from "../src/judge";
import { jevCostNanoUsd } from "../src/router-jev";

interface Case {
  id: string;
  label: Relation;
  existing: { kind: ContextItem["kind"]; content: string };
  new: { kind: ContextItem["kind"]; content: string };
}

const here = import.meta.dir;
const load = (file: string): Case[] =>
  existsSync(join(here, file)) ? (JSON.parse(readFileSync(join(here, file), "utf8")) as Case[]) : [];
const cases = [...load("memory-cases.json"), ...load("memory-cases.local.json")];

const ORG = "00000000-0000-0000-0000-000000000000";
const existingItem = (c: Case) =>
  ({
    id: `${c.id}-old`,
    kind: c.existing.kind,
    title: "",
    content: c.existing.content,
    channelIds: [],
    evidence: [],
    verified: true,
    trust: "high",
    updatedAt: new Date(Date.now() - 30 * 86_400_000),
  }) as unknown as ContextItem;
const newItem = (c: Case): NewContextItem => ({
  orgId: ORG,
  kind: c.new.kind,
  scopeType: "org",
  channelIds: [],
  content: c.new.content,
});

/** What the policy would do with a relation at that probability. */
const action = (plan: Plan) => plan.action;
const goldAction = (c: Case) => action(decide(newItem(c), [{ candidate: existingItem(c), relation: c.label, p: 1 }]));

interface Strategy {
  name: string;
  judge(c: Case): Promise<{ relation: Relation; p: number }>;
}

let jevTokens = 0;
let llmTokens = { input: 0, output: 0 };

const strategies: Record<string, () => Strategy | null> = {
  /** Today's rule: word Jaccard ≥ 0.8 is the same item; nothing else is understood. */
  words: () => ({
    name: "words",
    judge: async (c) =>
      similarity(c.existing.content, c.new.content) >= 0.8
        ? { relation: "same", p: 1 }
        : { relation: "unrelated", p: 1 },
  }),
  llm: () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const provider = createAnthropicProvider();
    const judge = createLlmJudge({
      gateway: {
        complete: (async (call: Parameters<typeof provider.stream>[0]) => {
          const result = await provider.stream(call, { apiKey, onDelta: () => {} });
          llmTokens = {
            input: llmTokens.input + result.usage.inputTokens,
            output: llmTokens.output + result.usage.outputTokens,
          };
          return result;
        }) as never,
      },
      resolveModel: async () => process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5",
    });
    // Measured as if it were allowed to answer: in the product memory never takes the LLM's word (it has no real probabilities).
    return viaJudge("llm", { name: "llm", ask: (request) => judge.ask({ ...request, calibrated: false }) });
  },
  jev: () => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) return null;
    const judge = createJevJudge({
      key: apiKey,
      timeoutMs: 10_000,
      gateway: {
        recordExternalUsage: (async (u: { inputTokens: number }) => {
          jevTokens += u.inputTokens;
        }) as never,
      },
    });
    return viaJudge("jev", judge);
  },
};

function viaJudge(name: string, judge: Judge): Strategy {
  return {
    name,
    async judge(c) {
      const [j] = await judgeRelations(judge, newItem(c), [existingItem(c)]);
      return { relation: j?.relation ?? "unrelated", p: j?.p ?? 0 };
    },
  };
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : null;
const labels = Object.keys(RELATIONS) as Relation[];
const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${((100 * n) / d).toFixed(0).padStart(3)}%`);

console.log(`${cases.length} cases (${load("memory-cases.local.json").length} local)\n`);
for (const [key, make] of Object.entries(strategies)) {
  if (only && !only.includes(key)) continue;
  const s = make();
  if (!s) {
    console.log(`${key}: skipped (no key)\n`);
    continue;
  }
  let right = 0;
  let rightAction = 0;
  /** Merged or archived something it shouldn't have (joined wrongly, or archived as outdated or outvoted). */
  let harmful = 0;
  /** Left a duplicate or a stale item active (memory gets noisy, nothing is lost). */
  let missed = 0;
  let failed = 0;
  const per = new Map(labels.map((l) => [l, { tp: 0, fp: 0, fn: 0 }]));
  const wrong: string[] = [];
  const started = performance.now();
  for (const c of cases) {
    let got: { relation: Relation; p: number };
    try {
      got = await s.judge(c);
    } catch (error) {
      failed++;
      wrong.push(`  ${c.id}: error ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const gold = goldAction(c);
    const predicted = action(decide(newItem(c), [{ candidate: existingItem(c), relation: got.relation, p: got.p }]));
    if (got.relation === c.label) right++;
    else wrong.push(`  ${c.id}: expected ${c.label}, got ${got.relation} (${got.p.toFixed(2)})`);
    if (predicted === gold) rightAction++;
    else {
      if (predicted === "merge" || predicted === "supersede" || predicted === "resolve") harmful++;
      else missed++;
      if (got.relation === c.label)
        wrong.push(
          `  ${c.id}: right relation (${got.relation} ${got.p.toFixed(2)}) but ${predicted} instead of ${gold}`,
        );
    }
    for (const l of labels) {
      const m = per.get(l);
      if (!m) continue;
      if (got.relation === l && c.label === l) m.tp++;
      else if (got.relation === l) m.fp++;
      else if (c.label === l) m.fn++;
    }
  }
  const ms = (performance.now() - started) / Math.max(1, cases.length);
  console.log(`── ${s.name}`);
  console.log(`relation right: ${pct(right, cases.length)}   action right: ${pct(rightAction, cases.length)}`);
  console.log(`harmful moves: ${harmful}   missed moves: ${missed}   errors: ${failed}   ${ms.toFixed(0)} ms/case`);
  for (const l of labels) {
    const m = per.get(l);
    if (!m) continue;
    console.log(`  ${l.padEnd(12)} precision ${pct(m.tp, m.tp + m.fp)}  recall ${pct(m.tp, m.tp + m.fn)}`);
  }
  if (s.name === "jev")
    console.log(`  cost: ${jevTokens} input tokens ≈ US$ ${(jevCostNanoUsd(jevTokens) / 1e9).toFixed(6)}`);
  if (s.name === "llm") console.log(`  tokens: ${llmTokens.input} in, ${llmTokens.output} out`);
  if (wrong.length > 0) console.log(wrong.join("\n"));
  console.log("");
}
