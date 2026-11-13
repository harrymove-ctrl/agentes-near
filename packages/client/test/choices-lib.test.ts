import { expect, test } from "bun:test";
import { ApiError } from "../src/api/http";
import {
  answeredFirst,
  choiceLetter,
  choiceOfKey,
  choiceReplyLine,
  choiceSummary,
  emptyDraft,
  moveStep,
  otherChoice,
  pickChoice,
} from "../src/lib/choices";

const Q = [
  { question: "Quando?", options: [{ label: "Hoje" }, { label: "Amanhã" }] },
  { question: "Quem revisa?", options: [{ label: "Ana" }, { label: "Theo" }, { label: "Ninguém" }] },
];

test("options are lettered, and a letter key picks one of them", () => {
  expect([0, 1, 5].map(choiceLetter)).toEqual(["A", "B", "F"]);
  expect(choiceOfKey("b", 3)).toBe(1);
  expect(choiceOfKey("C", 3)).toBe(2);
  expect(choiceOfKey("d", 3)).toBeNull();
  expect(choiceOfKey("Enter", 3)).toBeNull();
});

test("one question answers on the first pick", () => {
  expect(pickChoice(emptyDraft([Q[0] as (typeof Q)[0]]), 1).send).toEqual({ picks: [1] });
});

test("several: each pick moves on, Back and Next walk them, and the last open one sends them all", () => {
  let d = emptyDraft(Q);
  expect(moveStep(d, 1)).toBe(d);
  const first = pickChoice(d, 0);
  expect(first).toEqual({ draft: { step: 1, picks: [0, null], others: [null, null] }, send: null });
  d = moveStep(first.draft, -1);
  expect(d.step).toBe(0);
  const changed = pickChoice(d, 1);
  expect(changed).toEqual({ draft: { step: 1, picks: [1, null], others: [null, null] }, send: null });
  expect(pickChoice(changed.draft, 2).send).toEqual({ picks: [1, 2] });
});

test("Outra resposta: the pick past the last option, with what was written; picking an option again drops it", () => {
  const [when, who] = Q as [(typeof Q)[0], (typeof Q)[0]];
  expect(otherChoice(when)).toBe(2);
  expect(choiceOfKey("c", when.options.length + 1)).toBe(otherChoice(when));
  const wrote = pickChoice(emptyDraft(Q), otherChoice(when), "Na sexta, depois do deploy");
  expect(wrote.draft.others).toEqual(["Na sexta, depois do deploy", null]);
  expect(pickChoice(wrote.draft, 1).send).toEqual({ picks: [2, 1], others: ["Na sexta, depois do deploy", null] });
  // Back to the first question and a plain option this time: nothing written goes.
  const again = pickChoice(moveStep(pickChoice(wrote.draft, 1).draft, -1), 0);
  expect(again.send).toEqual({ picks: [0, 1] });
  expect(choiceSummary(Q, [2, otherChoice(who)], ["Na sexta, depois do deploy", "A Lia"])).toEqual([
    { question: "Quando?", letter: "C", label: "Na sexta, depois do deploy", written: true },
    { question: "Quem revisa?", letter: "D", label: "A Lia", written: true },
  ]);
});

test("the answered card and the compact reply", () => {
  expect(choiceSummary(Q, [1, 0])).toEqual([
    { question: "Quando?", letter: "B", label: "Amanhã" },
    { question: "Quem revisa?", letter: "A", label: "Ana" },
  ]);
  expect(choiceReplyLine("@dev Amanhã")).toBe("Amanhã");
  expect(choiceReplyLine("Amanhã")).toBe("Amanhã");
});

test("someone answering first is told apart from a failed pick", () => {
  expect(answeredFirst(new ApiError(409, "choices.answered", "x"))).toBe(true);
  expect(answeredFirst(new ApiError(500, "internal", "x"))).toBe(false);
  expect(answeredFirst(new Error("offline"))).toBe(false);
});
