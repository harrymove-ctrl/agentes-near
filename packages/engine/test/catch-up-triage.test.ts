import { expect, test } from "bun:test";
import {
  CATCH_UP_CLOSE_AT,
  CATCH_UP_CLOSE_AT_STRICT,
  catchUpDecision,
  closedNoteOf,
  createJevJudge,
  type JudgeAnswer,
  TRIAGE_MAX_CALLS,
  TRIAGE_REFRESH_MS,
  type TriageSnapshot,
  triageBrief,
  triageGate,
  triageQuestions,
} from "../src";

const now = Date.UTC(2026, 10, 3, 15);
const since = now - 3 * 24 * 3600_000;
const at = (ms: number) => new Date(since + ms);

/** Ana (and Bruno) asked Theo; Nina and Ada posted after; Ana reacted; Nina may have moved the task. */
function snapshot(over: Partial<TriageSnapshot> = {}, two = false): TriageSnapshot {
  return {
    agent: "Theo",
    since,
    notPeople: false,
    askers: [
      {
        key: "a1",
        userId: "u-ana",
        name: "Ana",
        asks: [{ text: "@Theo o deploy saiu?", at: at(0), editedSincePause: false }],
      },
      ...(two
        ? [
            {
              key: "a2",
              userId: "u-bruno",
              name: "Bruno",
              asks: [{ text: "@Theo e o relatório?", at: at(1), editedSincePause: false }],
            },
          ]
        : []),
    ],
    posts: [
      { id: "m1", key: "p3", kind: "person", from: "Nina", text: "Saiu às 14h.", at: at(3600_000) },
      { id: "m2", key: "p4", kind: "agent", from: "Ada", text: "Confirmado.", at: at(7200_000) },
      { id: "m3", key: null, kind: "app", from: "GitHub", text: "resolved", at: at(9000_000) },
    ],
    reactions: [],
    task: null,
    participants: [
      { key: "p1", kind: "person", id: "u-ana", name: "Ana" },
      { key: "p2", kind: "person", id: "u-bruno", name: "Bruno" },
      { key: "p3", kind: "person", id: "u-nina", name: "Nina" },
      { key: "p4", kind: "agent", id: "ag-ada", name: "Ada" },
      { key: "p5", kind: "person", id: "u-carla", name: "Carla" },
    ],
    latest: since + 9000_000,
    ...over,
  };
}

const status = (p: Partial<Record<"needs_agent" | "solved" | "not_needed", number>>): JudgeAnswer => ({
  choice: Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0],
  probabilities: { needs_agent: 0, solved: 0, not_needed: 0, ...p },
});
const who = (key: string, p = 0.9): JudgeAnswer => ({ choice: key, probabilities: { [key]: p, nobody: 1 - p } });

test("one asker: 0.79 runs, 0.8 closes, crediting who gave the answer", () => {
  const s = snapshot();
  expect(
    catchUpDecision({ status_a1: status({ solved: 0.79, needs_agent: 0.21 }), who_a1: who("p3") }, s, 0.8).outcome,
  ).toBe("unsure");
  const v = catchUpDecision({ status_a1: status({ solved: 0.8, needs_agent: 0.2 }), who_a1: who("p3") }, s, 0.8);
  expect(v).toMatchObject({ outcome: "closed", askers: [{ reason: "solved", who: "p3" }] });
  expect(closedNoteOf(s, v, now)).toEqual({
    reason: "solved",
    who: { name: "Nina", userId: "u-nina" },
    askers: ["u-ana"],
    at: new Date(now).toISOString(),
  });
});

test("two askers close only on the product: 0.9 each closes (0.81), 0.85 each doesn't (0.72), one open runs", () => {
  const s = snapshot({}, true);
  const both = (p: number) => ({
    status_a1: status({ solved: p }),
    who_a1: who("p3"),
    status_a2: status({ solved: p }),
    who_a2: who("p4"),
  });
  expect(catchUpDecision(both(0.9), s, CATCH_UP_CLOSE_AT).outcome).toBe("closed");
  expect(catchUpDecision(both(0.85), s, CATCH_UP_CLOSE_AT).outcome).toBe("unsure");
  const v = catchUpDecision(
    { ...both(0.95), status_a2: status({ needs_agent: 0.7, solved: 0.3 }), who_a2: who("nobody") },
    s,
    CATCH_UP_CLOSE_AT,
  );
  expect(v.outcome).toBe("run");
  expect(triageBrief(s, v)).toBe(
    "A quick check judged Bruno's ask still open and Ana's handled by Nina. It can be wrong, so read below.",
  );
  // Different sources: the note says it generally.
  expect(closedNoteOf(s, catchUpDecision(both(0.95), s, 0.8), now).reason).toBe("mixed");
});

test("an asker the run owes an answer is never closed and keeps it running; one who joined after still clears", () => {
  const two = snapshot({}, true);
  const s = { ...two, askers: two.askers.map((a, i) => (i === 0 ? { ...a, owed: true as const } : a)) };
  const v = catchUpDecision(
    { status_a1: status({ solved: 0.97 }), who_a1: who("p3"), status_a2: status({ solved: 0.95 }), who_a2: who("p4") },
    s,
    CATCH_UP_CLOSE_AT,
  );
  expect(v.outcome).toBe("run");
  expect(v.askers[0]?.reason).toBeUndefined();
  expect(v.askers[1]).toMatchObject({ reason: "solved", who: "p4", sure: 0.95 });
  expect(triageBrief(s, v)).toBe(
    "A quick check judged Ana's ask still open and Bruno's handled by Ada. It can be wrong, so read below.",
  );
});

test("the strict bar is 0.9", () => {
  expect(CATCH_UP_CLOSE_AT_STRICT).toBe(0.9);
  const s = snapshot();
  const a = { status_a1: status({ solved: 0.85 }), who_a1: who("p3") };
  expect(catchUpDecision(a, s, CATCH_UP_CLOSE_AT).outcome).toBe("closed");
  expect(catchUpDecision(a, s, CATCH_UP_CLOSE_AT_STRICT).outcome).toBe("unsure");
});

test("solved and not needed add up only when the asker themselves is the source", () => {
  const split = status({ solved: 0.5, not_needed: 0.45, needs_agent: 0.05 });
  // Nina posted the answer: a split from someone else is doubt.
  expect(catchUpDecision({ status_a1: split, who_a1: who("p3") }, snapshot(), 0.8).outcome).toBe("unsure");
  // Ana's one ask alone is never the asker closing it.
  expect(catchUpDecision({ status_a1: split, who_a1: who("p1") }, snapshot(), 0.8).outcome).toBe("unsure");
  // Ana wrote "olvídalo, ya lo hice": 0.95 together closes, credited to the larger reason, and counts in the product.
  const s = snapshot({
    posts: [{ id: "m4", key: "p1", kind: "person", from: "Ana", text: "olvídalo, ya lo hice", at: at(60_000) }],
  });
  expect(catchUpDecision({ status_a1: split, who_a1: who("p1") }, s, 0.8)).toMatchObject({
    outcome: "closed",
    askers: [{ reason: "solved", who: "p1" }],
    p: 0.95,
  });
  expect(
    catchUpDecision({ status_a1: status({ solved: 0.3, not_needed: 0.6 }), who_a1: who("p1") }, s, 0.8),
  ).toMatchObject({ outcome: "closed", askers: [{ reason: "withdrawn" }] });
  // The bar still holds on the sum.
  expect(
    catchUpDecision(
      { status_a1: status({ solved: 0.4, not_needed: 0.39, needs_agent: 0.21 }), who_a1: who("p1") },
      s,
      0.8,
    ).outcome,
  ).toBe("unsure");
});

test("a close needs a source code checks", () => {
  const s = snapshot();
  const solved = status({ solved: 0.97 });
  // Unsure who.
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p3", 0.55) }, s, 0.8).outcome).toBe("unsure");
  // Carla never posted, reacted or moved the task.
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p5") }, s, 0.8).outcome).toBe("unsure");
  // Nobody.
  expect(catchUpDecision({ status_a1: solved, who_a1: who("nobody") }, s, 0.8).outcome).toBe("unsure");
  // An app is never an option, and a key that isn't one of them doesn't count either.
  expect(triageQuestions(s).who_a1).toMatchObject({ type: "choice" });
  expect(Object.keys((triageQuestions(s).who_a1 as { criteria: object }).criteria)).not.toContain("GitHub");
  expect(catchUpDecision({ status_a1: solved, who_a1: who("m3") }, s, 0.8).outcome).toBe("unsure");
  // Not needed: only the asker withdraws, by something they did after asking.
  const gone = status({ not_needed: 0.95 });
  expect(catchUpDecision({ status_a1: gone, who_a1: who("p3") }, s, 0.8).outcome).toBe("unsure");
  expect(catchUpDecision({ status_a1: gone, who_a1: who("p1") }, s, 0.8).outcome).toBe("unsure");
  const deixa = snapshot({
    posts: [...s.posts, { id: "m4", key: "p1", kind: "person", from: "Ana", text: "deixa", at: at(9500_000) }],
  });
  expect(catchUpDecision({ status_a1: gone, who_a1: who("p1") }, deixa, 0.8)).toMatchObject({
    outcome: "closed",
    askers: [{ reason: "withdrawn" }],
  });
  // Or whoever canceled the task since the pause.
  const canceled = snapshot({ task: { title: "Deploy", status: "canceled", changedAt: at(60_000), changedBy: "p5" } });
  expect(catchUpDecision({ status_a1: gone, who_a1: who("p5") }, canceled, 0.8)).toMatchObject({
    outcome: "closed",
    askers: [{ reason: "task_canceled", who: "p5" }],
  });
  // Canceled before the pause: no source.
  const old = snapshot({ task: { title: "Deploy", status: "canceled", changedAt: at(-60_000), changedBy: "p5" } });
  expect(catchUpDecision({ status_a1: gone, who_a1: who("p5") }, old, 0.8).outcome).toBe("unsure");
  // Moved to done by Carla: she is a source for solved.
  const done = snapshot({ task: { title: "Deploy", status: "done", changedAt: at(60_000), changedBy: "p5" } });
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p5") }, done, 0.8).outcome).toBe("closed");
  // The asker's own ✅ or thanks, not their ask alone.
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p1") }, s, 0.8).outcome).toBe("unsure");
  const tick = snapshot({ reactions: [{ on: "a1", reaction: "✅", key: "p1", at: at(60_000) }] });
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p1") }, tick, 0.8).outcome).toBe("closed");
  expect(catchUpDecision({ status_a1: solved, who_a1: who("p1") }, deixa, 0.8).outcome).toBe("closed");
});

test("the gates: when no call is made", () => {
  const s = snapshot();
  const gate = (over: Partial<Parameters<typeof triageGate>[0]> = {}) =>
    triageGate({
      snapshot: s,
      prior: undefined,
      mission: false,
      overruled: false,
      noJev: false,
      now,
      ...over,
    });
  expect(gate()).toBeNull();
  for (const over of [{ mission: true }, { overruled: true }, { noJev: true }])
    expect(gate(over)).toEqual({ skip: "skipped_rule" });
  expect(gate({ snapshot: { ...s, notPeople: true } })).toEqual({ skip: "skipped_rule" });
  // Owing its only asker an answer: nobody to check. Someone else who joined still is.
  const owed = (x: TriageSnapshot) => ({
    ...x,
    askers: x.askers.map((a, i) => (i === 0 ? { ...a, owed: true as const } : a)),
  });
  expect(gate({ snapshot: owed(s) })).toEqual({ skip: "skipped_rule" });
  expect(gate({ snapshot: owed(snapshot({}, true)) })).toBeNull();
  const five = Array.from({ length: 5 }, (_, i) => ({
    ...s.askers[0],
    key: `a${i + 1}`,
    userId: `u${i}`,
  })) as TriageSnapshot["askers"];
  expect(gate({ snapshot: { ...s, askers: five } })).toEqual({ skip: "skipped_rule" });
  expect(gate({ snapshot: { ...s, posts: [], latest: 0 } })).toEqual({ skip: "skipped_quiet" });
  // A reaction before the pause is no news.
  expect(
    gate({
      snapshot: { ...s, posts: [], latest: 0, reactions: [{ on: "a1", reaction: "✅", key: "p1", at: at(-1) }] },
    }),
  ).toEqual({ skip: "skipped_quiet" });
  // An earlier "run" holds while nothing new came in, while it is under an hour old, and once the calls are spent.
  const prior = {
    at: now - 2 * TRIAGE_REFRESH_MS,
    outcome: "run" as const,
    calls: 1,
    seenThrough: s.latest,
    brief: "x",
  };
  expect(gate({ prior })).toEqual({ reuse: prior });
  expect(gate({ prior: { ...prior, seenThrough: 0, at: now - 60_000 } })).toEqual({
    reuse: { ...prior, seenThrough: 0, at: now - 60_000 },
  });
  expect(gate({ prior: { ...prior, seenThrough: 0, calls: TRIAGE_MAX_CALLS } })).toMatchObject({ reuse: {} });
  expect(gate({ prior: { ...prior, seenThrough: 0 } })).toBeNull();
  // Failed calls count toward the cap too.
  const failed = { at: now - 2 * TRIAGE_REFRESH_MS, outcome: "judge_error" as const, calls: 1 };
  expect(gate({ prior: failed })).toBeNull();
  expect(gate({ prior: { ...failed, calls: TRIAGE_MAX_CALLS } })).toEqual({
    reuse: { ...failed, calls: TRIAGE_MAX_CALLS },
  });
});

test("the brief lists reactions and the task moved since the pause", () => {
  const s = snapshot({
    reactions: [{ on: "a1", reaction: "✅", key: "p1", at: at(60_000) }],
    task: { title: "Deploy da API", status: "done", changedAt: at(60_000), changedBy: "p3" },
  });
  expect(triageBrief(s, { outcome: "unsure", askers: [] })).toBe(
    "Since you paused: ✅ from Ana on Ana's ask, task \"Deploy da API\" moved to done. A quick check couldn't tell whether this is still open.",
  );
});

test("a request's own timeout reaches the Jev call", async () => {
  const judge = createJevJudge({
    key: "ts_test_key_not_real",
    timeoutMs: 10_000,
    gateway: { recordExternalUsage: async () => null },
    // Never answers: only the timeout ends it.
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as never,
  });
  const started = Date.now();
  await expect(
    judge.ask({
      orgId: "o",
      kind: "x",
      state: {},
      questions: { q: { type: "noul", instructions: "?", criteria: { true: "a", false: "b" } } },
      timeoutMs: 30,
    }),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
});
