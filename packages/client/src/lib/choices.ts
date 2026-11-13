import { ApiError } from "../api/http";
import type { ChoiceQuestion } from "../api/types";

/**
 * Choice cards (ADR 0124), the same on the web and the phone: options lettered A, B, C…, then "Outra resposta" (a
 * written answer, picked as the index past the last option), one question at a time with Back and Next, and the answer
 * sent once every question has its pick. Pure.
 */

export const choiceLetter = (i: number) => String.fromCharCode(65 + i);

/** The option a letter key picks ("b" → 1), or null when the key names none of `count` options. */
export function choiceOfKey(key: string, count: number): number | null {
  if (key.length !== 1) return null;
  const i = key.toUpperCase().charCodeAt(0) - 65;
  return i >= 0 && i < count ? i : null;
}

export interface ChoiceDraft {
  step: number;
  picks: (number | null)[];
  /** What was written for a question answered in words, at its place. */
  others: (string | null)[];
}

/** What a card sends: the pick of each question, and what was written where one was answered in words. */
export interface ChoiceAnswer {
  picks: number[];
  others?: (string | null)[];
}

export const emptyDraft = (questions: readonly ChoiceQuestion[]): ChoiceDraft => ({
  step: 0,
  picks: questions.map(() => null),
  others: questions.map(() => null),
});

/** The pick that is "Outra resposta" on a question: the one past its last option. */
export const otherChoice = (q: ChoiceQuestion) => q.options.length;

/** The longest written answer the server takes. Mirror: `ARTIFACT_LIMITS.choiceOtherChars` in packages/engine/src/artifacts.ts. */
export const CHOICE_OTHER_MAX = 1000;

/**
 * A pick on the current question (`written`: what was written for "Outra resposta"). It goes to the next question
 * still open, and `send` holds every pick once none is left: a one-question card answers on the first click.
 */
export function pickChoice(
  draft: ChoiceDraft,
  option: number,
  written?: string,
): { draft: ChoiceDraft; send: ChoiceAnswer | null } {
  const picks = draft.picks.map((p, i) => (i === draft.step ? option : p));
  const others = draft.picks.map((_, i) => (i === draft.step ? (written ?? null) : (draft.others[i] ?? null)));
  const open = picks.findIndex((p, i) => p === null && i > draft.step);
  const anyOpen = picks.indexOf(null);
  if (anyOpen === -1) {
    const send = { picks: picks as number[], ...(others.some((o) => o !== null) ? { others } : {}) };
    return { draft: { ...draft, picks, others }, send };
  }
  return { draft: { step: open === -1 ? anyOpen : open, picks, others }, send: null };
}

/** Back and Next: Next only past a question already answered. */
export function moveStep(draft: ChoiceDraft, by: -1 | 1): ChoiceDraft {
  const step = draft.step + by;
  if (step < 0 || step >= draft.picks.length) return draft;
  if (by === 1 && draft.picks[draft.step] === null) return draft;
  return { ...draft, step };
}

/** What was picked, or written instead, question by question, as the answered card shows it. */
export function choiceSummary(
  questions: readonly ChoiceQuestion[],
  picks: readonly number[],
  others: readonly (string | null)[] = [],
) {
  return questions.map((q, i) => {
    const pick = picks[i] ?? -1;
    const written = pick === otherChoice(q) ? others[i] : null;
    return {
      question: q.question,
      letter: pick >= 0 ? choiceLetter(pick) : "",
      label: written ?? q.options[pick]?.label ?? "",
      ...(written ? { written: true } : {}),
    };
  });
}

/** The person's reply as its compact line shows it: without the agent's @handle the server put in front. */
export const choiceReplyLine = (body: string) => body.replace(/^@[\w.-]+\s+/, "");

/** Someone answered first (409 `choices.answered`): not a failure to retry, the card just shows their pick. */
export const answeredFirst = (e: unknown) => e instanceof ApiError && e.code === "choices.answered";
