import { randomUUID } from "node:crypto";
import { cutText } from "../format";
import type { Judge, JudgeAnswer } from "../judge";
import {
  describeElement,
  type ScreenChanges,
  type ScreenElement,
  type ScreenImage,
  type ScreenObservation,
  screenText,
} from "./observation";

/**
 * Checks on a screen (ADR 0054), each one judge call instead of a turn of the
 * agent's own model: "is it true now?" (a step's `expect`, a wait `until`),
 * "where on this page is the answer?" (a read with `find`) and "what closes
 * what covers the page?" (a banner in the way of a click).
 */

interface Ids {
  judge: Judge;
  orgId: string;
  agentId?: string | null;
  runId?: string;
}

/** A condition is taken as true from this probability, and as false below `FALSE_BELOW`. */
export const TRUE_AT = 0.6;
const FALSE_BELOW = 0.35;

export type ConditionResult = { met: true; p: number } | { met: false; p: number } | { met: null; p: number };

const changesText = (c: ScreenChanges | null | undefined) =>
  c && !c.newPage
    ? cutText([...c.added.map((l) => `+ ${l.trim()}`), ...c.removed.map((l) => `- ${l.trim()}`)].join("\n"), 6000)
    : null;

/**
 * Whether the screen shows `condition` now ("the order is confirmed", "an
 * error says the card was declined"). With an image, the judge looks at it too
 * (what text alone can't say: a chart drew, a layout broke).
 */
export async function checkCondition(
  input: Ids & {
    condition: string;
    observation: ScreenObservation;
    changes?: ScreenChanges | null;
    image?: ScreenImage | null;
  },
): Promise<ConditionResult> {
  const placeholder = input.image ? `screen_${randomUUID()}` : null;
  const answers = await input.judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "screen_check",
    state: {
      condition: input.condition.trim(),
      screen: {
        address: input.observation.url,
        ...(changesText(input.changes) ? { what_just_changed: changesText(input.changes) } : {}),
        text: screenText(input.observation),
        ...(placeholder ? { screenshot: placeholder } : {}),
      },
    },
    ...(placeholder && input.image ? { images: { [placeholder]: { data: input.image.data, format: "jpeg" } } } : {}),
    questions: {
      holds: {
        type: "noul",
        instructions:
          "An agent just acted on `screen`. Does the screen show, right now, that `condition` is true? Judge only by what the screen shows.",
        criteria: {
          true: "The screen clearly shows it.",
          false: "The screen doesn't show it, shows the opposite, or is still loading.",
        },
      },
    },
  });
  const p = answers.holds?.noul ?? 0;
  if (p >= TRUE_AT) return { met: true, p };
  if (p < FALSE_BELOW) return { met: false, p };
  return { met: null, p };
}

/** Lines one Choice offers when finding an answer in a page (Jev takes 255 options). */
const WINDOW = 200;
/**
 * What one window holds at most, in characters: its lines in `state` (each cut at `LINE_CHARS`) and
 * as options (cut at `OPTION_CHARS`). Jev reads at most 32k tokens per question and 64k per request,
 * so a page goes in windows, each its own request, all asked at once.
 */
const WINDOW_CHARS = 20_000;
const LINE_CHARS = 300;
const OPTION_CHARS = 120;
/** Windows asked at once, at most: on a longer page, those with the most of the question's words. */
const MAX_WINDOWS = 12;
/** Lines of context kept around each hit. */
const AROUND = 3;

export interface FoundInPage {
  /** `yes`: the page answers it; `partly`; `no`: nothing on it does. */
  answered: "yes" | "partly" | "no";
  /** The lines that answer it, with a little context, in page order. */
  text: string;
  /** Only part of a long page was searched (where the question's words are, or a request failed): how much. */
  searched?: { lines: number; of: number };
}

type Window = { from: number; to: number };

/** The page in windows of at most `WINDOW` lines and `WINDOW_CHARS` characters. */
function windowsOf(lines: string[]): Window[] {
  const out: Window[] = [];
  let from = 0;
  let size = 0;
  lines.forEach((line, i) => {
    const n = line.trim().length;
    const cost = Math.min(n, LINE_CHARS) + Math.min(n, OPTION_CHARS) + 12;
    if (i > from && (i - from >= WINDOW || size + cost > WINDOW_CHARS)) {
      out.push({ from, to: i });
      from = i;
      size = 0;
    }
    size += cost;
  });
  out.push({ from, to: lines.length });
  return out;
}

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/** All the windows, or on a page too long for that, the ones with the most of the question's words. */
function windowsToAsk(windows: Window[], lines: string[], question: string): Window[] {
  if (windows.length <= MAX_WINDOWS) return windows;
  const terms = [...new Set(wordsOf(question))];
  return windows
    .map((w, order) => {
      const text = new Set(wordsOf(lines.slice(w.from, w.to).join(" ")));
      return { w, order, score: terms.filter((t) => text.has(t)).length };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_WINDOWS)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.w);
}

/**
 * Where on the page `question` is answered ("the order total", "is the
 * export done?"): the lines themselves, not the whole page. Each window of
 * lines is one request (a Choice over its lines, and whether they answer it
 * at all), all at once: a long page takes about as long as a short one.
 */
export async function findInPage(
  input: Ids & { question: string; observation: ScreenObservation; maxChars?: number },
): Promise<FoundInPage> {
  const lines = input.observation.lines;
  if (lines.length === 0) return { answered: "no", text: "" };
  const id = (i: number) => `L${i + 1}`;
  const question = input.question.trim();
  const windows = windowsToAsk(windowsOf(lines), lines, question);
  const asked = await Promise.allSettled(
    windows.map((w) => {
      const numbered: string[] = [];
      const criteria: Record<string, string> = {};
      for (let i = w.from; i < w.to; i++) {
        const line = (lines[i] as string).trim();
        numbered.push(`${id(i)}: ${cutText(line, LINE_CHARS)}`);
        criteria[id(i)] = cutText(line, OPTION_CHARS) || "(empty)";
      }
      criteria.none = "No line here answers it.";
      return input.judge.ask({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        kind: "screen_find",
        state: { question, page: { address: input.observation.url, lines: numbered.join("\n") } },
        questions: {
          answers: {
            type: "noul",
            instructions: "Do the lines of `page` answer `question` (state it, or show it)?",
            criteria: {
              true: "At least one of these lines states or clearly shows the answer.",
              false: "None of these lines addresses it.",
            },
          },
          where: { type: "choice", instructions: "Which line of `page` best answers `question`?", criteria },
        },
      });
    }),
  );
  const failed = asked.find((a): a is PromiseRejectedResult => a.status === "rejected");
  if (failed && asked.every((a) => a.status === "rejected")) throw failed.reason;
  let exists = 0;
  let searched = 0;
  // Each line the judge points at, with its probability: the most likely are kept, then shown in page order.
  const hits = new Map<number, number>();
  asked.forEach((a, k) => {
    if (a.status !== "fulfilled") return;
    const w = windows[k] as Window;
    searched += w.to - w.from;
    exists = Math.max(exists, a.value.answers?.noul ?? 0);
    for (const [key, p] of Object.entries(a.value.where?.probabilities ?? {})) {
      const m = /^L(\d+)$/.exec(key);
      if (m && p >= 0.2) hits.set(Number(m[1]) - 1, p);
    }
  });
  const keep = new Set<number>();
  for (const [i] of [...hits].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    for (let k = Math.max(0, i - AROUND); k <= Math.min(lines.length - 1, i + AROUND); k++) keep.add(k);
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length > 0) out.push("…");
    out.push(lines[i] as string);
    prev = i;
  }
  const text = cutText(out.join("\n"), input.maxChars ?? 6000);
  const answered = exists >= 0.7 && text ? "yes" : exists >= 0.35 && text ? "partly" : "no";
  return { answered, text, ...(searched < lines.length ? { searched: { lines: searched, of: lines.length } } : {}) };
}

/** A dismiss is clicked from this probability: it must clearly be one. */
const DISMISS_AT = 0.7;

/**
 * Something covers the page where the agent clicked (a cookie banner, a
 * dialog): the control that closes it without agreeing to more than needed,
 * or null. Never one that buys, signs up, accepts terms or grants anything.
 */
export async function findDismiss(
  input: Ids & { observation: ScreenObservation; covering: string },
): Promise<ScreenElement | null> {
  const pool = input.observation.elements.filter((e) => e.role === "button" || e.role === "link").slice(0, 200);
  if (pool.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const e of pool) criteria[e.ref] = describeElement(e);
  criteria.none = "None of these just closes it.";
  let answers: Record<string, JudgeAnswer>;
  try {
    answers = await input.judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "screen_dismiss",
      // Clicked on its probability alone: only a calibrated judge answers (the cheap model would say 1).
      calibrated: true,
      state: { covering: cutText(input.covering, 300), screen: { address: input.observation.url } },
      questions: {
        close: {
          type: "choice",
          instructions:
            "`covering` (a banner or dialog) is in the way of the page. Which control only closes it, agreeing to no more than needed: Close, ×, Not now, Reject optional cookies, Continue without accepting? Never one that buys, subscribes, signs up, accepts terms or grants permissions.",
          criteria,
        },
      },
    });
  } catch {
    // Nothing is closed: the click's own error goes back to the agent.
    return null;
  }
  const choice = answers.close?.choice;
  const p = choice ? (answers.close?.probabilities?.[choice] ?? 0) : 0;
  if (!choice || choice === "none" || p < DISMISS_AT) return null;
  return pool.find((e) => e.ref === choice) ?? null;
}
