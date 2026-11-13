import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Issue, IssueWork } from "../src/api/types";
import { dueLabel, dueTone, toYmd } from "../src/lib/format";
import { cardState, cardStateText, cardWaits } from "../src/lib/issues";

const t = (() => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
})();

const now = new Date(2026, 10, 9, 15, 0);
const work = (state: IssueWork["state"], since = new Date(2026, 10, 7, 15, 0).toISOString()): IssueWork => ({
  agentId: "agent-ada",
  runId: null,
  state,
  since,
  steps: [],
});
const task = (over: Partial<Pick<Issue, "status" | "work" | "blocked">> = {}) => ({
  status: "in_progress" as Issue["status"],
  work: null,
  blocked: null,
  ...over,
});
const words = (i: ReturnType<typeof task>, live = false) => {
  const s = cardState(i, live);
  return s ? cardStateText(t, s, now) : null;
};

describe("a task's one state", () => {
  test("from its agent's work: asks, questions, works, stopped", () => {
    expect(words(task({ work: work("waiting_approval") }))).toBe("Pede aprovação");
    expect(words(task({ work: work("waiting_input") }))).toBe("Pergunta algo");
    expect(words(task({ work: work("running") }))).toBe("Trabalhando");
    expect(words(task({ work: work("stalled") }))).toBe("Parado há 2 dias");
  });

  test("the work wins over a turn live in its conversation: one state, never two", () => {
    expect(cardState(task({ work: work("waiting_input") }), true)).toEqual({ kind: "question" });
    expect(cardState(task({ work: work("waiting_approval") }), true)).toEqual({ kind: "approval" });
    // A live turn alone is work going on.
    expect(words(task(), true)).toBe("Trabalhando");
  });

  test("background work stopped on something says why, after the agent's own work", () => {
    const blocked = { reason: "waiting_approval", since: now.toISOString() };
    expect(cardState(task({ blocked }))).toEqual({ kind: "blocked", blocked });
    expect(words(task({ blocked }))).toBeTruthy();
    expect(cardState(task({ blocked, work: work("running") }))?.kind).toBe("running");
    expect(cardState(task({ blocked }), true)?.kind).toBe("blocked");
  });

  test("nothing going on, or a closed task: no state", () => {
    expect(cardState(task())).toBeNull();
    expect(cardState(task({ status: "todo" }))).toBeNull();
    expect(cardState(task({ status: "done", work: work("running") }), true)).toBeNull();
    expect(cardState(task({ status: "canceled", work: work("waiting_input") }))).toBeNull();
  });

  test("only a question or an approval calls on a person (the card's sky)", () => {
    expect(cardWaits(cardState(task({ work: work("waiting_approval") })))).toBe(true);
    expect(cardWaits(cardState(task({ work: work("waiting_input") })))).toBe(true);
    expect(cardWaits(cardState(task({ work: work("running") })))).toBe(false);
    expect(cardWaits(cardState(task({ work: work("stalled") })))).toBe(false);
    expect(cardWaits(null)).toBe(false);
  });
});

describe("a due date", () => {
  const day = (offset: number) => toYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));

  test("says today and tomorrow in words, any other day as a date", () => {
    expect(dueLabel(t, "pt-BR", day(0), now)).toBe("hoje");
    expect(dueLabel(t, "pt-BR", day(1), now)).toBe("amanhã");
    expect(dueLabel(t, "en", day(1), now)).toBe("tomorrow");
    expect(dueLabel(t, "pt-BR", day(-1), now)).not.toBe("ontem");
    expect(dueLabel(t, "pt-BR", day(5), now)).toMatch(/14/);
  });

  test("is soon today and tomorrow, late once past", () => {
    expect(dueTone(day(0), now)).toBe("soon");
    expect(dueTone(day(1), now)).toBe("soon");
    expect(dueTone(day(2), now)).toBeNull();
    expect(dueTone(day(-1), now)).toBe("late");
  });
});
