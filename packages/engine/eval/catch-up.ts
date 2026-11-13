/**
 * Catch-up check eval (ADR 0136): before a conversation's catch-up after a usage pause, Jev answers per asker whether
 * what they asked is still open, and code closes the catch-up only from a source it checks (`catchUpDecision`). Scores
 * every case of `catch-up-cases.ts` (Portuguese, English, Spanish, Japanese) at several bars and prints, per bar, the
 * false closes (a must-run case closed: a missed answer) and the missed closes (a must-close case that runs: one
 * needless turn that ends in `pass`). Ship `CATCH_UP_CLOSE_AT` at the lowest bar with no false close; it exits 1 when the
 * shipped bar has one.
 *
 * `--fooled` needs no key: a judge fooled on every must-run case (sure at 0.99 of the bait's word: "it's solved",
 * "nobody needs this", a webhook's "resolved", a ✅ from someone else) shows which ones code alone refuses and which
 * rest on Jev's reading.
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/catch-up.ts [--fooled] [--only id,id] [--repeat N]
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production), except with `--fooled`.
 */
import { askCatchUp, CATCH_UP_CLOSE_AT, catchUpDecision } from "../src/catch-up-triage";
import { createJevJudge } from "../src/judge";
import { jevCostNanoUsd } from "../src/router-jev";
import { CASES, fooledAnswers, snapshotOf } from "./catch-up-cases";

const BARS = [0.7, 0.75, 0.8, 0.85, 0.9];
const now = Date.now();

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const only = flag("only")?.split(",");
const repeat = Number(flag("repeat") ?? 1) || 1;
const cases = CASES.filter((c) => !only || only.includes(c.id));

if (process.argv.includes("--fooled")) {
  const mustRun = cases.filter((c) => !c.closes);
  const held: string[] = [];
  const onJev: string[] = [];
  for (const c of mustRun) {
    const s = snapshotOf(c, now);
    (catchUpDecision(fooledAnswers(c, s), s, CATCH_UP_CLOSE_AT).outcome === "closed" ? onJev : held).push(c.id);
  }
  console.log(`Fooled judge, ${mustRun.length} must-run cases at ${CATCH_UP_CLOSE_AT}:`);
  console.log(`  code refuses the close (${held.length}): ${held.join(", ")}`);
  console.log(`  rest on Jev's reading (${onJev.length}): ${onJev.join(", ")}`);
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("TYPESAFE_API_KEY is not set (or run with --fooled, no key needed).");
  process.exit(1);
}
let tokens = 0;
const judge = createJevJudge({
  key: apiKey,
  timeoutMs: 10_000,
  gateway: {
    recordExternalUsage: (async (u: { inputTokens: number }) => {
      tokens += u.inputTokens;
    }) as never,
  },
});

/** Per bar: must-run cases that closed, and must-close cases that ran. */
const falseCloses = new Map<number, string[]>(BARS.map((b) => [b, []]));
const missed = new Map<number, string[]>(BARS.map((b) => [b, []]));
const started = Date.now();
for (const c of cases) {
  for (let r = 0; r < repeat; r++) {
    const s = snapshotOf(c, now);
    const answers = await askCatchUp(judge, s, { orgId: "eval", agentId: "eval", runId: "eval" }, now).catch(
      (error: unknown) => {
        console.log(`  ${c.id}: Jev error ${String(error)}`);
        return null;
      },
    );
    if (!answers) continue;
    const line: string[] = [];
    for (const bar of BARS) {
      const v = catchUpDecision(answers, s, bar);
      const closed = v.outcome === "closed";
      if (closed && !c.closes) falseCloses.get(bar)?.push(c.id);
      if (!closed && c.closes) missed.get(bar)?.push(c.id);
      if (bar === CATCH_UP_CLOSE_AT)
        line.push(
          `${closed === c.closes ? "ok " : "BAD"} ${c.id} (${c.lang}) ${v.outcome}`,
          v.askers
            .map(
              (a) =>
                `${a.name}: needs ${a.p.needs_agent.toFixed(2)} solved ${a.p.solved.toFixed(2)} not_needed ${a.p.not_needed.toFixed(2)}${a.reason ? ` → ${a.reason} by ${s.participants.find((p) => p.key === a.who)?.name}` : ""}`,
            )
            .join("; "),
        );
    }
    console.log(line.join("  "));
  }
}
const mustRun = cases.filter((c) => !c.closes).length * repeat;
const mustClose = cases.filter((c) => c.closes).length * repeat;
console.log(`\n${cases.length} cases × ${repeat}: ${mustClose} must close, ${mustRun} must run`);
for (const bar of BARS) {
  const fc = falseCloses.get(bar) ?? [];
  const ms = missed.get(bar) ?? [];
  console.log(
    `  bar ${bar.toFixed(2)}${bar === CATCH_UP_CLOSE_AT ? " (shipped)" : ""}: ${fc.length} false closes${fc.length ? ` (${fc.join(", ")})` : ""}, ${ms.length}/${mustClose} missed closes`,
  );
}
const safe = BARS.find((b) => (falseCloses.get(b) ?? []).length === 0);
console.log(`  lowest bar with no false close: ${safe ?? "none"}`);
console.log(
  `  cost: ${tokens} input tokens ≈ US$ ${(jevCostNanoUsd(tokens) / 1e9).toFixed(5)}, ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
process.exit((falseCloses.get(CATCH_UP_CLOSE_AT) ?? []).length > 0 ? 1 : 0);
