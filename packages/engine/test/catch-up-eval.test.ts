import { expect, test } from "bun:test";
import { CASES, fooledAnswers, snapshotOf, splitAnswers } from "../eval/catch-up-cases";
import { CATCH_UP_CLOSE_AT, catchUpDecision, triageQuestions, triageState } from "../src";

test("every eval case reads as production reads it: one status and one who per asker, no app among the options", () => {
  for (const c of CASES) {
    const s = snapshotOf(c);
    const q = triageQuestions(s);
    expect(Object.keys(q)).toHaveLength(s.askers.length * 2);
    const options = Object.keys((q.who_a1 as { criteria: Record<string, string> }).criteria);
    for (const p of c.posts ?? []) if (p.kind === "app") expect(options.join(" ")).not.toContain(p.from);
    expect(JSON.stringify(triageState(s))).toContain(c.askers[0]?.asks[0]?.slice(0, 10) ?? "");
  }
});

test("a judge fooled on every must-run case still can't close where code checks the source", () => {
  const held = CASES.filter((c) => !c.closes).filter((c) => {
    const s = snapshotOf(c);
    return catchUpDecision(fooledAnswers(c, s), s, CATCH_UP_CLOSE_AT).outcome !== "closed";
  });
  expect(held.map((c) => c.id).sort()).toEqual(
    [
      "app-injection",
      "someone-else-withdraws-en",
      "task-in-review",
      "third-party-not-needed",
      "third-party-not-needed-es",
      "third-party-reaction",
      "webhook-resolved",
    ].sort(),
  );
});

test("an asker withdrawing in their own words closes on solved and not needed together", () => {
  for (const id of ["asker-olvidalo-es", "asker-daijoubu-ja"]) {
    const s = snapshotOf(CASES.find((c) => c.id === id) as (typeof CASES)[number]);
    expect(catchUpDecision(splitAnswers(s), s, CATCH_UP_CLOSE_AT).outcome).toBe("closed");
  }
});

test("a judge splitting solved and not needed on every must-run case closes only where the asker is the source", () => {
  const closed = CASES.filter((c) => !c.closes).filter((c) => {
    const s = snapshotOf(c);
    return catchUpDecision(splitAnswers(s, c.bait?.who), s, CATCH_UP_CLOSE_AT).outcome === "closed";
  });
  // These rest on Jev's needs_agent, as they do with a fooled solved: the asker's own words still ask.
  expect(closed.map((c) => c.id).sort()).toEqual(
    ["asker-any-update", "asker-eyes-reaction", "asker-thanks-but", "sarcasm-en", "sarcasm-pt"].sort(),
  );
});
