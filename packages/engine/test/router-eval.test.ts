import { expect, test } from "bun:test";
import { ROUTER_CASES, type RouterCase, routerEval, TEAM } from "../eval/router";
import { createJevRouterStrategy, SPOKEN_TO } from "../src";

// The router eval's cases and harness, with a fake Jev (no network). The eval itself is manual:
// `bun run eval:router`.

test("every case is well formed: known agents, no @mention, and each language asks the four ways", () => {
  const handles = new Set(TEAM.map((a) => a.handle));
  const ids = new Set<string>();
  for (const c of ROUTER_CASES) {
    expect(ids.has(c.id), c.id).toBe(false);
    ids.add(c.id);
    for (const h of c.answers) expect(handles.has(h), `${c.id}: ${h}`).toBe(true);
    expect(c.message, c.id).not.toContain("@");
    if (c.replyTo !== undefined) expect(c.before?.[c.replyTo], c.id).toBeDefined();
    if (c.thread || c.pause !== undefined) expect(c.before?.length, c.id).toBeGreaterThan(0);
  }
  // A case can't pass by recalling the rule's own example.
  for (const a of TEAM) expect(SPOKEN_TO, a.name).not.toContain(a.name);
  for (const lang of ["pt", "en", "es", "de", "ja", "ar"])
    for (const kind of ["asks", "direct", "anyone", "about"])
      expect(
        ROUTER_CASES.some((c) => c.lang === lang && c.kind === kind),
        `${lang} ${kind}`,
      ).toBe(true);
});

/** Jev's answers on 2026-10-31 to "ada pergunta pro theo…" (`ASKS`) and to "me de bom dia…" (`BOM_DIA`). */
const ASKS = { nouls: { "@theo": 0.9, "@ada": 0.52 }, needs: 0.78, choice: { theo: 0.79 } };
const BOM_DIA = {
  nouls: { "@theo": 0.576, "@ada": 0.576 },
  needs: 0.54,
  choice: { theo: 0.83, ada: 0.12, none: 0.05 },
};

/** Jev as it answered on 2026-10-31, plus the addressee Choice's probabilities when given. */
function jevThatDay(to?: Record<string, number>, day: typeof ASKS = ASKS) {
  const states: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { state, questions } = JSON.parse(String(init.body)) as {
      state: unknown;
      questions: Record<string, { instructions: { agent?: { handle: string } } }>;
    };
    states.push(state);
    const nouls: Record<string, number> = day.nouls;
    const answers: Record<string, unknown> = {
      needs_agent: { noul: day.needs },
      for_everyone: { noul: 0.1 },
      best_agent: { choice: "theo", probabilities: day.choice, confidence: day.choice.theo },
    };
    for (const [id, q] of Object.entries(questions))
      if (id.startsWith("agent_")) answers[id] = { noul: nouls[q.instructions.agent?.handle ?? ""] ?? 0.05 };
    if (to && questions.addressee) answers.addressee = { choice: "ada", probabilities: to, confidence: 0.8 };
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 1500 } });
  }) as unknown as typeof fetch;
  return { states, strategy: createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: fetcher }) };
}

test("the harness: the day's case fails on that day's answers and passes once the step hears Ada", async () => {
  const day = ROUTER_CASES.find((c) => c.id === "pt-production") as RouterCase;
  const evaluation = await routerEval();
  try {
    const then = jevThatDay();
    expect(await evaluation.run(day, then.strategy)).toMatchObject({ ok: false, picked: ["theo"] });
    // The step reads each agent's apps, as in production.
    expect(JSON.stringify(then.states[0])).toContain("Gmail");
    const now = jevThatDay({ ada: 0.86, theo: 0.08, none: 0.06 });
    expect(await evaluation.run(day, now.strategy)).toMatchObject({ ok: true, picked: ["ada"] });
  } finally {
    await evaluation.close();
  }
});

test("the harness: 'me de bom dia…' 5 and 23 minutes after the talk with Ada is hers on that day's answers", async () => {
  const late = ROUTER_CASES.find((r) => r.id === "pt-last-talked-to") as RouterCase;
  const soon = ROUTER_CASES.find((r) => r.id === "pt-last-talked-to-soon") as RouterCase;
  const evaluation = await routerEval();
  try {
    const day = jevThatDay(undefined, BOM_DIA);
    expect(await evaluation.run(late, day.strategy)).toMatchObject({ ok: true, picked: ["ada"] });
    // Past the continuity window, as that day: nobody is "just talking", and the step still reads the talk.
    expect(day.states[0]).toMatchObject({ agent_just_talking: null });
    expect(JSON.stringify(day.states[0])).toContain("ada quanto ta seu limite de uso?");
    // 5 minutes after it Ada is the agent just talking, and the same answers still give it to her.
    const sooner = jevThatDay(undefined, BOM_DIA);
    expect(await evaluation.run(soon, sooner.strategy)).toMatchObject({ ok: true, picked: ["ada"] });
    expect(sooner.states[0]).toMatchObject({ agent_just_talking: "@ada" });
  } finally {
    await evaluation.close();
  }
});

test("the harness: a reply case quotes the agent's message or answers in its thread, as people do", async () => {
  // Every agent quiet: only the rule for a reply to an agent picks. Some need for an agent, as any reply has: one the
  // step needs no agent for at all is nobody's, rule or not.
  const quiet = createJevRouterStrategy({
    key: "k",
    recordUsage: async () => {},
    fetch: (async (_url: string, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const noul = (id: string) => ({ noul: id === "needs_agent" ? 0.2 : 0.05 });
      return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, noul(id)])) });
    }) as unknown as typeof fetch,
  });
  const evaluation = await routerEval();
  try {
    for (const id of ["pt-reply-hand-over", "en-thread-asks"]) {
      const c = ROUTER_CASES.find((r) => r.id === id) as RouterCase;
      expect((await evaluation.run(c, quiet)).picked, id).toEqual(["theo"]);
    }
  } finally {
    await evaluation.close();
  }
});

test("the harness: the default cases pass on a Jev that gives every agent too little (R5)", async () => {
  // Every agent under the bar and a low need, as Jev answered "vocês se enrolaram muito" (2026-11-01).
  const low = (needs: number) =>
    createJevRouterStrategy({
      key: "k",
      recordUsage: async () => {},
      fetch: (async (_url: string, init: RequestInit) => {
        const { questions } = JSON.parse(String(init.body)) as {
          questions: Record<string, { instructions: { agent?: { handle: string } } }>;
        };
        const answers: Record<string, unknown> = { needs_agent: { noul: needs }, for_everyone: { noul: 0.1 } };
        for (const [id, q] of Object.entries(questions))
          if (id.startsWith("agent_")) answers[id] = { noul: q.instructions.agent?.handle === "@atlas" ? 0.3 : 0.2 };
        return Response.json({ answers });
      }) as unknown as typeof fetch,
    });
  const evaluation = await routerEval();
  try {
    for (const c of ROUTER_CASES.filter((r) => r.kind === "default")) {
      const r = await evaluation.run(c, low(c.id === "pt-default-ack" ? 0.1 : 0.3));
      expect(r.picked, c.id).toEqual(c.answers);
    }
  } finally {
    await evaluation.close();
  }
});
