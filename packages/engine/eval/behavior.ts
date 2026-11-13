/**
 * Behavior eval: does an agent investigate before answering, cite what it
 * found, propose a concrete next step, ask only for decisions that are the
 * person's, and never act on sensitive things without approval? Cases come
 * from real failures (anonymized). Run it before shipping prompt changes
 * (context.ts, capabilities.ts, role presets). README.md next to this file
 * explains the case format.
 *
 * Manual, never in CI (it calls the real model and costs a little):
 *
 *   bun run eval:behavior [--only id,id] [--model claude-sonnet-5-5] [--judge jev|llm] [--judge-model claude-haiku-5-5]
 *                         [--no-judge] [--max-turns 12] [--concurrency 5] [--tools-on-demand] [--repeat 3] [--lang en]
 *
 * `--repeat N` runs every case N times; a case passes when most of its runs pass, and each check is reported
 * by its own majority (a model and a judge both vary from run to run: one run alone can't tell a regression
 * from noise).
 *
 * Needs `ANTHROPIC_API_KEY` (in `.env`). `EVAL_AGENT_MODEL` / `EVAL_JUDGE_MODEL`
 * override the models. Cases: `behavior-cases.json`, plus
 * `behavior-cases.local.json` if present (never in git). The JSON report goes
 * to `eval/out/` (ignored by git).
 *
 * The run goes through the real path (`behavior-run.ts`): an in-memory
 * database (PGlite) seeded with the case, `postPersonMessage` → outbox →
 * `executeRun` (context.ts prompt, capabilities, Tool Gateway with scopes and
 * approvals, tool loop). Only the outside world is fake: connector tools
 * return canned results from the case. The model is real.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropicProvider, type ModelProvider } from "@agenteschat/providers";
import { type CheckResult, deterministicChecks } from "./behavior-checks";
import { type BehaviorCase, type CaseRun, clip, judge, runCase } from "./behavior-run";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only")?.split(",");
const agentModel = arg("model") ?? process.env.EVAL_AGENT_MODEL;
const judgeModel = arg("judge-model") ?? process.env.EVAL_JUDGE_MODEL ?? "claude-haiku-5-5";
const useJudge = !process.argv.includes("--no-judge");
/** Tools on demand (ADR 0043) as in production: run it with and without to compare tokens and behavior. */
const toolsOnDemand = process.argv.includes("--tools-on-demand");
const jevKey = process.env.TYPESAFE_API_KEY || undefined;
const judgeKind = arg("judge") ?? "jev";
if (judgeKind !== "jev" && judgeKind !== "llm" && judgeKind !== "both") {
  console.error("--judge is jev, llm or both (grades with Jev and also with the LLM, to compare)");
  process.exit(1);
}
const gradeWithJev = judgeKind !== "llm" && Boolean(jevKey);
/** `--judge both`: the LLM grades too (reported, not counted), to compare verdicts and cost. */
const compareLlm = judgeKind === "both" && gradeWithJev;
let llmNano = 0;
const agreement = { same: 0, total: 0 };
const maxToolTurns = Number(arg("max-turns") ?? 12);
const concurrency = Math.max(1, Number(arg("concurrency") ?? process.env.EVAL_CONCURRENCY ?? 5));
const repeat = Math.max(1, Math.floor(Number(arg("repeat") ?? 1)));
/** The people's lines of cases that give them per language (default: each case's first). */
const lang = arg("lang");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is missing (put it in .env; the eval calls the real model).");
  process.exit(1);
}

const here = import.meta.dir;
const load = async (file: string): Promise<BehaviorCase[]> => {
  const f = Bun.file(join(here, file));
  return (await f.exists()) ? ((await f.json()) as BehaviorCase[]) : [];
};
const local = await load("behavior-cases.local.json");
const cases = [...(await load("behavior-cases.json")), ...local].filter((c) => !only || only.includes(c.id));
const judgeLabel = !useJudge ? "off" : gradeWithJev ? "jev" : judgeModel;
console.log(
  `${cases.length} cases (${local.length} local)${repeat > 1 ? ` × ${repeat} runs` : ""}${lang ? ` · lines in ${lang}` : ""} · agent model ${agentModel ?? "per case"} · judge ${judgeLabel} · addressees ${jevKey ? "jev" : "llm"} · max ${maxToolTurns} turns · ${concurrency} at a time`,
);
if (!jevKey)
  console.log(
    `TYPESAFE_API_KEY is missing: addressees${useJudge && judgeKind === "jev" ? " and grading" : ""} use the LLM judge (${judgeModel}), not Jev as in production.`,
  );
console.log("");

interface CaseReport {
  id: string;
  title: string;
  /** Which run of the case (`--repeat`), from 1. */
  attempt: number;
  pass: boolean;
  checks: CheckResult[];
  run: Omit<CaseRun, "system"> | null;
  /** The system prompt of the first turn, to see what the agent was told. */
  system?: string;
  costUsd: number;
  ms: number;
}

/** Retries a model call the provider refused for load (429, overloaded, 529/503) with backoff. */
function withRetry(inner: ModelProvider): ModelProvider {
  const transient = /\b(429|529|503)\b|rate.?limit|overloaded/i;
  return {
    ...inner,
    async stream(request, options) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.stream(request, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 5 || !transient.test(message)) throw error;
          await Bun.sleep(1000 * 2 ** attempt + Math.random() * 500);
        }
      }
    },
  };
}

const provider = withRetry(createAnthropicProvider());
let totalNano = 0;
let judgeNano = 0;

/** One case, isolated (its own in-memory database and fakes); output buffered, printed when it ends. */
async function evalCase(c: BehaviorCase, attempt: number): Promise<CaseReport> {
  const out: string[] = [];
  const started = performance.now();
  let run: CaseRun | null = null;
  let checks: CheckResult[] = [];
  let nano = 0;
  try {
    run = await runCase(c, {
      apiKey: apiKey as string,
      provider,
      maxToolTurns,
      agentModel,
      jevKey,
      toolsOnDemand,
      lang,
    });
    nano += run.costNanoUsd;
    checks = [...deterministicChecks(c.expect, run), ...(run.stepChecks ?? [])];
    if (useJudge) {
      const j = await judge(c, run, {
        apiKey: apiKey as string,
        provider,
        model: judgeModel,
        agentModel,
        lang,
        ...(gradeWithJev && jevKey ? { jev: { apiKey: jevKey } } : {}),
      });
      checks.push(...j.checks);
      nano += j.costNanoUsd;
      judgeNano += j.costNanoUsd;
      if (compareLlm) {
        const l = await judge(c, run, { apiKey: apiKey as string, provider, model: judgeModel, agentModel, lang });
        llmNano += l.costNanoUsd;
        for (const k of l.checks) {
          const mine = j.checks.find((x) => x.id === k.id);
          if (!mine) continue;
          agreement.total++;
          if (mine.pass === k.pass) agreement.same++;
          else
            out.push(`  judges differ on ${k.id}: jev ${mine.detail} · llm ${k.pass ? "pass" : "fail"}: ${k.detail}`);
        }
      }
    }
  } catch (error) {
    checks.push({ id: "ran", pass: false, detail: error instanceof Error ? error.message : String(error) });
  }
  totalNano += nano;
  const pass = checks.every((k) => k.pass);
  const { system, ...rest } = run ?? ({} as CaseRun);
  const runLabel = repeat > 1 ? ` (run ${attempt}/${repeat})` : "";
  out.unshift(`${pass ? "PASS" : "FAIL"} ${c.id}${runLabel} · ${c.title} · US$ ${(nano / 1e9).toFixed(4)}`);
  if (run) {
    const approval = run.approvals.length ? ` · approval: ${run.approvals.join(", ")}` : "";
    out.push(
      `  tools: ${run.calls.map((t) => t.name).join(", ") || "(none)"}${approval} · runs: ${run.status.join(", ")}`,
    );
    out.push(`  reply: ${clip((run.noReply ? "(silent)" : run.reply).replace(/\s+/g, " "), 240)}`);
  }
  for (const k of checks) out.push(`  ${k.pass ? "ok  " : "FAIL"} ${k.id}: ${k.detail}`);
  console.log(`${out.join("\n")}\n`);
  return {
    id: c.id,
    title: c.title,
    attempt,
    pass,
    checks,
    run: run ? rest : null,
    system,
    costUsd: nano / 1e9,
    ms: Math.round(performance.now() - started),
  };
}

// A small pool: `concurrency` runs at a time; reports keep the cases' order (each case's runs together).
const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, k) => ({ c, attempt: k + 1 })));
const wallStarted = performance.now();
const reports: CaseReport[] = new Array(jobs.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i] as { c: BehaviorCase; attempt: number };
      reports[i] = await evalCase(job.c, job.attempt);
    }
  }),
);
const wallMs = Math.round(performance.now() - wallStarted);

type Tally = { pass: number; total: number };
const majority = (m: Tally) => m.pass * 2 > m.total;
const tally = (m: Tally | undefined, pass: boolean): Tally => ({
  pass: (m?.pass ?? 0) + (pass ? 1 : 0),
  total: (m?.total ?? 0) + 1,
});

/** Per case: how many of its runs passed (it passes when most did), and each check's own count. */
const byCase = new Map<string, Tally & { title: string; checks: Map<string, Tally> }>();
for (const r of reports) {
  const m = byCase.get(r.id) ?? { title: r.title, pass: 0, total: 0, checks: new Map<string, Tally>() };
  Object.assign(m, tally(m, r.pass));
  for (const k of r.checks) m.checks.set(k.id, tally(m.checks.get(k.id), k.pass));
  byCase.set(r.id, m);
}

// Totals per criterion.
const byCriterion = new Map<string, { pass: number; total: number }>();
for (const r of reports)
  for (const k of r.checks) {
    const m = byCriterion.get(k.id) ?? { pass: 0, total: 0 };
    m.total++;
    if (k.pass) m.pass++;
    byCriterion.set(k.id, m);
  }
const passed = [...byCase.values()].filter(majority).length;
if (repeat > 1) {
  console.log(`── per case (passes when most of its ${repeat} runs pass; checks that failed most runs)`);
  for (const [id, m] of byCase) {
    const failing = [...m.checks].filter(([, k]) => !majority(k)).map(([k, t]) => `${k} ${t.pass}/${t.total}`);
    console.log(
      `  ${majority(m) ? "PASS" : "FAIL"} ${id.padEnd(46)} ${m.pass}/${m.total}${failing.length ? ` · ${failing.join(", ")}` : ""}`,
    );
  }
}
const runsPassed = reports.filter((r) => r.pass).length;
console.log(
  `── ${passed}/${byCase.size} cases passed${repeat > 1 ? ` (${runsPassed}/${reports.length} runs)` : ""} · ${(wallMs / 1000).toFixed(0)} s · US$ ${(totalNano / 1e9).toFixed(4)} (grading ${judgeLabel}: US$ ${(judgeNano / 1e9).toFixed(4)})`,
);
if (compareLlm)
  console.log(
    `  LLM grading (${judgeModel}, not counted): US$ ${(llmNano / 1e9).toFixed(4)} · agrees with Jev on ${agreement.same}/${agreement.total} criteria`,
  );
for (const [id, m] of [...byCriterion].sort((x, y) => x[0].localeCompare(y[0])))
  console.log(`  ${id.padEnd(30)} ${m.pass}/${m.total}`);
// What the agent's calls carried: the prompt (uncached + cache read + cache write) and the output.
const tokens = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
for (const r of reports)
  for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[k] += r.run?.tokens?.[k] ?? 0;
const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
console.log(
  `  tools on demand ${toolsOnDemand ? "on" : "off"} · ${tokens.calls} model calls · prompt ${prompt} tokens (${Math.round(prompt / Math.max(tokens.calls, 1))} per call; cache read ${tokens.cacheRead}, write ${tokens.cacheWrite}) · output ${tokens.output}`,
);

const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `behavior-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      agentModel: agentModel ?? null,
      judgeModel: useJudge ? judgeLabel : null,
      addressees: jevKey ? "jev" : "llm",
      judgeCostUsd: judgeNano / 1e9,
      ...(compareLlm ? { llmJudgeCostUsd: llmNano / 1e9, judgesAgree: agreement } : {}),
      maxToolTurns,
      concurrency,
      toolsOnDemand,
      repeat,
      tokens,
      wallMs,
      passed,
      total: byCase.size,
      byCase: Object.fromEntries(
        [...byCase].map(([id, m]) => [
          id,
          { title: m.title, pass: m.pass, total: m.total, passed: majority(m), checks: Object.fromEntries(m.checks) },
        ]),
      ),
      costUsd: totalNano / 1e9,
      criteria: Object.fromEntries(byCriterion),
      cases: reports,
    },
    null,
    2,
  ),
);
console.log(`\nreport: ${file}`);
process.exit(passed === byCase.size ? 0 : 1);
