import { cutText } from "./format";
import type { Judge, JudgeQuestion } from "./judge";
import { canonicalJson } from "./tools/json-schema";

/**
 * Runs that go in circles (ADR 0015 addendum). After each step of tool calls, the run's latest steps are checked
 * for repetition, structurally and cheaply (`noteStep`). Only then is the judge asked (Jev, with the workspace's
 * small model as its fallback) whether the agent is stuck or making progress, in any language (`isStuck`); when
 * neither can answer, the repetition decides. Stuck once, the agent reads `STUCK_NOTE`; stuck again in the same
 * run, it ends where it stands. Model-brain runs only: a computer brain's own tool calls never reach the server.
 */

/**
 * What counts as repetition, in steps (one model call and the tool calls it made):
 * - `sameCall`: one identical retry is normal (a flaky call, a page not ready yet); a third identical call means
 *   nothing changed between attempts. Polls and paging with a cursor kept elsewhere repeat too: the judge tells.
 * - `sameError`: two tries at fixing an error are normal; the third time the same error comes back (whatever the
 *   call), the changes aren't reaching its cause.
 * - `failing`: errors that echo what was tried ("no such file 'src/a.ts'", "nothing matches 'button b'") never
 *   match each other: four steps in a row where every call failed are variations that end the same way.
 * - `nothingNew`: going back to a page or a list is normal, and a short cycle (A, B, A, B) needs a few rounds to
 *   show: five steps in a row that only repeated earlier calls and got the same back catch a two-step cycle at its
 *   7th step. A new call with the same answer ("Sent." to someone else, the next page of numbers) is new.
 * - `window`: the steps remembered (and the ones the judge reads), enough to see a three-step cycle come round twice.
 * - `verdict`: stuck when the judge gives it this much, as the other judgments that act (a stop, a promise).
 */
export const STUCK = { sameCall: 3, sameError: 3, failing: 4, nothingNew: 5, window: 8, verdict: 0.6 } as const;

export type StuckSign = "same_call" | "same_error" | "failing" | "nothing_new";

/** One step as remembered: fingerprints to compare, and what the judge reads. */
export interface StepPrint {
  /** The run's model calls after this step. */
  turn: number;
  /** The calls: tools and inputs. */
  call: string;
  /** Each call with what it returned, normalized. */
  outcomes: string[];
  /** What its failed calls returned, normalized, when any failed. */
  error?: string;
  /** Every call was made before in a remembered step, and got the same back. */
  stale: boolean;
  /** Each call's tool, input and the start of what came back. */
  said: { tool: string; input: string; result: string; failed?: true }[];
}

/** A run's stuck detection (`Transcript.stuck`). */
export interface StuckState {
  steps: StepPrint[];
  /** Only steps after this turn count as evidence: a verdict needs new evidence for the next one. */
  since: number;
  /** It was found stuck once and read `STUCK_NOTE`. */
  noted?: boolean;
  /** Found stuck again: the run ends at this many model calls, saying where it stands. */
  endAt?: number;
}

/** What a run found stuck reads once. */
export const STUCK_NOTE =
  "Your last steps repeat without getting you closer to done. Try a different approach. If something blocks you, stop and say plainly what it is.";

/** What a conversation run found stuck again reads: the run ends with its answer, and Continuar under it. */
export const STUCK_END_REPLY_NOTE =
  "You are still going in circles, so this run stops here. Stop starting new work and reply with what you did, what you tried and what is left, so the person can let you pick up from there.";

/** What a routine's run found stuck again reads: it hands off what it has, as near its limit of steps. */
export const STUCK_END_NOTE =
  "You are still going in circles, so this run stops here. If the people need to know what you found or what blocks you, call hand_off now with it. Then end with your record (a short summary of what you tried).";

/** A result as compared: spacing and numbers (times, ids, counters) don't count. */
const normalized = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const print = (text: string) => Bun.hash(text).toString(36);

/** Remembers a step and says what repeats in the evidence since the last verdict, if anything. */
export function noteStep(
  state: StuckState | undefined,
  turn: number,
  calls: { name: string; input: unknown; content: string; isError: boolean }[],
): { state: StuckState; sign: StuckSign | null } {
  const before = state?.steps ?? [];
  const seen = new Set(before.flatMap((s) => s.outcomes));
  const outcomes = calls.map((c) => print(canonicalJson([c.name, c.input ?? null, normalized(c.content)])));
  const failed = calls.filter((c) => c.isError).map((c) => normalized(c.content));
  const step: StepPrint = {
    turn,
    call: print(canonicalJson(calls.map((c) => [c.name, c.input ?? null]))),
    outcomes,
    ...(failed.length > 0 ? { error: print(failed.sort().join("\n")) } : {}),
    stale: outcomes.every((o) => seen.has(o)),
    said: calls.map((c) => ({
      tool: c.name,
      input: cutText(canonicalJson(c.input ?? {}), 200),
      result: cutText(c.content, 300),
      ...(c.isError ? { failed: true as const } : {}),
    })),
  };
  const next: StuckState = { ...state, since: state?.since ?? 0, steps: [...before, step].slice(-STUCK.window) };
  const fresh = next.steps.filter((s) => s.turn > next.since);
  const tail = (n: number) => (fresh.length >= n ? fresh.slice(-n) : null);
  const sign: StuckSign | null = tail(STUCK.sameCall)?.every((s) => s.call === step.call)
    ? "same_call"
    : step.error && fresh.filter((s) => s.error === step.error).length >= STUCK.sameError
      ? "same_error"
      : tail(STUCK.failing)?.every((s) => s.said.every((c) => c.failed))
        ? "failing"
        : tail(STUCK.nothingNew)?.every((s) => s.stale)
          ? "nothing_new"
          : null;
  return { state: next, sign };
}

const REPEATED: Record<StuckSign, string> = {
  same_call: `the same call with the same input, ${STUCK.sameCall} times in a row`,
  same_error: `the same error, ${STUCK.sameError} times`,
  failing: `${STUCK.failing} steps in a row whose calls all failed`,
  nothing_new: `${STUCK.nothingNew} steps in a row that only repeated earlier calls and got the same back`,
};

export const STUCK_QUESTION: JudgeQuestion = {
  type: "noul",
  instructions:
    "An AI agent is working on `request` by calling tools. `steps` are its latest calls, oldest first: each tool, its input, the start of what came back, and `failed` when it failed. `repeated` is what repeats in them. Is the agent stuck, going around in circles instead of getting closer to done?",
  criteria: {
    true: "Stuck: it repeats calls that fail or change nothing, tries variations that end the same way, or keeps getting what it already has, with nothing new to show for it.",
    false:
      "Making progress: its calls move the work forward (the next page or item, a new place, a change that gets a different result), or it checks on something still under way that should change on its own (a build, a job, a page that is loading).",
  },
};

/**
 * Whether a run whose steps repeat is stuck: one judge question (usage recorded with the run, as every judgment),
 * and the repetition itself when there is no judge or it can't answer (`by: "structural"`).
 */
export async function isStuck(
  judge: Judge | undefined,
  input: { orgId: string; agentId: string; runId: string; request: string; sign: StuckSign; steps: StepPrint[] },
): Promise<{ stuck: boolean; by: string }> {
  if (!judge) return { stuck: true, by: "structural" };
  try {
    const answers = await judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "stuck_run",
      state: {
        request: cutText(input.request, 1000),
        repeated: REPEATED[input.sign],
        steps: input.steps.flatMap((s) => s.said),
      },
      questions: { stuck: STUCK_QUESTION },
    });
    return { stuck: (answers.stuck?.noul ?? 0) >= STUCK.verdict, by: judge.name };
  } catch {
    return { stuck: true, by: "structural" };
  }
}
