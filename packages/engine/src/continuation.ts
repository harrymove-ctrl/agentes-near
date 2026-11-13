import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { type Agent, getAgentCached } from "./agents";
import { answersOthers, audienceOf } from "./audience";
import { accountablePerson, runAuthority } from "./authority";
import { isComputerBrain } from "./brains/types";
import { endsAsking } from "./brakes";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { isAgentOnlyDm } from "./dms";
import { decisionNudge, FOLLOW_THROUGH_NUDGE, FOLLOW_THROUGH_NUDGE_DM, MISSION_ASK_NUDGE } from "./follow-through";
import { cutText, cutTextEnd } from "./format";
import type { Judge } from "./judge";
import type { NoticeKind } from "./notices";
import { notifyRunFailed } from "./notification-producers";
import { ANSWER_NUDGE } from "./reply-policy";
import { deliverNoticeToRun } from "./run-resume";
import type { AgentRun } from "./runs";
import { runStretchOf } from "./stretch";
import { HAND_OVER_STEP } from "./tools/directory";
import { neutralizeUntrusted, untrustedBlock } from "./untrusted";

/**
 * The continuation controller (ADR 0097): every turn of every run kind that reaches its final answer ends in exactly
 * one of continue (the same run keeps working), waiting (something durable brings it back) or done. Cheap rules
 * first, then at most one judgment (`continuationVerdict`). A failed run goes to `reportRunFailure` instead.
 */

/**
 * Extra turns one run may be given, every kind counted together (the decision nudge, the answer nudge and the
 * continue nudges), plus one ask nudge. Worst case: 3 extra turns and 4 judgments, then a question card or done.
 */
export const CONTINUE = { maxPerRun: 2, routineMaxPerRun: 1 } as const;

/** Where the controller stands in a run (`transcript.continuation`). */
export interface ContinuationState {
  count: number;
  /** The run's executed tool calls when it was last told to continue: the next continue needs more. */
  executedAtNudge?: number;
  askNudged?: boolean;
  /**
   * The last turn was told to ask: this one is judged past the cap, and a reply that still asks only in its text
   * becomes the question card.
   */
  askPending?: boolean;
  /** It was told once to say whether it still needs its open requests (`openRequestNudge`). */
  requestNudged?: boolean;
  /** It was told once to ask for a secret securely: the next secret verdict ends the run as it is. */
  secretNudged?: boolean;
}

export type ContinuationVerdict = "done" | "continue" | "ask" | "untried" | "secret" | "unbacked";

/**
 * What a run reads when it ended saying it couldn't while it still had ways to try (ADR 0109): its means and what it
 * already tried, so it varies the attempt instead of handing the problem to a person.
 */
export function untriedNudge(means: string[], tried: string[]) {
  const have = means.length > 0 ? means.join("; ") : "your tools and find_tools";
  return `You ended saying you couldn't, but you still have ways to try. Your means: ${have}. Already tried:\n${triedBlock(tried)}\nUse the ones that fit; when a search or a page gives nothing or is blocked, change the words, the source or the tool. Missing an access or a login? Look in the workspace first (your memory, search_context for who signed in or holds it) and ask the teammate who has it. ${SAFETY_FINAL} ${HAND_OVER_STEP} If no way is left at all, say what you tried and the one step a person must do.`;
}

/**
 * The `untried` nudge as a conversation run reads it: its reply was held back (`Transcript.held`), so it must never
 * read as said ("already answered above"), and it still goes out if nothing better comes.
 */
export const heldNudge = (nudge: string) =>
  `Not posted yet: nobody has seen your reply above. ${nudge} If that reply already gives them what they asked, end your turn without any text and it is posted as it is; otherwise write the whole reply they will read.`;

/** What a run posts after a reply it held back: its new words alone, both, or only the held ones. */
export type HeldReplyRead = "reply" | "both" | "held";

/**
 * One judge call when a run that held a reply back writes again (kind `held_reply`): whether the new words stand on
 * their own, build on the held reply, or add nothing to it ("nothing to add", "see above").
 */
export async function heldReplyRead(
  judge: Judge,
  input: { orgId: string; agentId: string; runId: string; held: string; reply: string },
): Promise<HeldReplyRead> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "held_reply",
    state: { held: cutText(input.held, 2000), reply: cutText(input.reply, 2000) },
    questions: {
      read: {
        type: "choice",
        instructions:
          "An AI agent in a team chat wrote `held`, a reply nobody has seen yet, then `reply`. One message goes out: which words must it carry?",
        criteria: {
          reply:
            "`reply` stands on its own: it gives the answer, or what it did and what is left, so the person needs nothing from `held`.",
          both: "`reply` builds on `held`: it adds to it, corrects a part of it or leaves the rest to it, so the person needs `held` too.",
          held: "`reply` adds nothing: it only says there is nothing to add, that it already answered, or to see the message above.",
        },
      },
    },
  });
  const choice = answers.read?.choice;
  return choice === "both" || choice === "held" ? choice : "reply";
}

/**
 * A refusal for safety ends that path for that data (ADR 0117): the nudges and HOW_YOU_WORK say so, so "take another
 * way" never reads as "send it some other way".
 */
export const SAFETY_FINAL =
  "A refusal for safety (a credential, private data in an address, secrets, sending data out) is final: never send that data another way. Say what was refused.";

/** What a tried line starts with when its call was refused for safety (`triedCalls`). */
export const SAFETY_TAG = "[refused for safety]";

/**
 * Refusal codes (a tool result's `data.code`) that stop data from going out: the gateway's credential check,
 * `remember`'s unasked destination and the outbound checks on web addresses. A command held for a person's approval
 * (`command.approval_needed`) is not one: the person may let it run.
 */
const SAFETY_CODES = new Set([
  "tool.credential",
  "memory.unasked_destination",
  "outbound.private_text",
  "outbound.credential",
  "outbound.long",
]);

const isSafetyCode = (code: unknown) => typeof code === "string" && SAFETY_CODES.has(code);

/**
 * A computer brain's own call the command policy refused because it reads secrets or sends data out
 * (`mission-commands.ts`). Inline code, a remote host or a shell are refused with another way to do it, so they
 * aren't final.
 */
const HARNESS_SAFETY =
  /→ failed: (?:This command was refused because (?:it touches secrets|it sends data)|Agents never read secrets)/;

/** The tried lines as a run reads them: inside the envelope, since their outcomes quote tool results. */
const triedBlock = (tried: string[]) =>
  tried.length > 0 ? untrustedBlock("what you tried", tried.slice(-8).join("\n")) : "nothing yet";

/** Every failed tried line was refused for safety (and at least one failed). */
export function onlySafetyRefusals(tried: string[]): boolean {
  const failed = tried.filter((l) => l.includes("→ failed: "));
  return failed.length > 0 && failed.every((l) => l.startsWith(SAFETY_TAG));
}

/**
 * What an `ask_user` call reads when its question asks for something the run could find itself (ADR 0109
 * addendum): held once, its means and what it already tried, and the next ask goes through.
 */
export function findableNudge(means: string[], tried: string[]) {
  const have = means.length > 0 ? means.join("; ") : "your tools and find_tools";
  return `Not asked yet: ask a person only for what only they can give, and this you can find. Your means: ${have}. Already tried:\n${triedBlock(tried)}\n${SAFETY_FINAL} Find it first: search the web for the docs and read them, try it (on your computer, or with web_fetch), search the workspace for a name the person uses. When something stays unclear, state your assumption and go on with work you can undo; a message to someone else can't be undone, so settle what and to whom from the conversation first. Ask only for what only a person can give (a key through request_secret, a decision, an approval). If you still need to ask, call ask_user again: that one is asked.`;
}

/** What a run reads, once, when it described what only a person can give instead of asking for it. */
export const ASK_NUDGE =
  "You need something only a person can give (a credential, a decision, a test, access). Ask them now with ask_user: one direct question, with choices if it is one of a few; but a sign-in, a QR code, a code or a captcha with browser_ask_person or desktop_ask_person once the page or app is at that step, a key or a password through request_secret, an approval only someone else can give through request_approval, a permission through request_permission. Do not end with a list of what's missing. If you need nothing from them to finish, end your turn without writing anything more: your reply above stands.";

/**
 * What a run reads, once, when its reply asks a person for a secret in the chat (ADR 0109 addendum): its reply is not
 * posted, and a question card is never made of it, since the answer would stay in the conversation in plain text.
 */
export const SECRET_NUDGE =
  "Not posted: never ask for a secret (a key, a token, a password) in the chat, where it stays in plain text. If you have request_secret, call it: the person types it into a secure card. Otherwise say which key is needed and where it is set up, without asking for it here.";

/**
 * What a run reads, once, when its reply says something was made, sent or done that none of its calls did (ADR 0167):
 * its reply is not posted, since it claims a result nobody gets.
 */
export const UNBACKED_NUDGE =
  "Not posted: your reply says something was made, sent or done, but no call of yours in this run did it. Do it now with your tools, or say plainly that you couldn't and why. Never say a result is done, attached or sent when no call produced it.";

/** The run's last judged turn, kept for the mission's keep-going check (`keepGoingBlocker` reads `waiting`). */
export const verdictRecord = (v: ContinuationVerdict) =>
  v === "continue" || v === "untried" || v === "unbacked" ? "unkept" : v === "ask" || v === "secret" ? "waiting" : v;

/**
 * One judge call on a turn's end (kind `follow_through`, recorded on the agent's and the workspace's usage like
 * every judgment, not billed to the agent's budget). `continue` at p ≥ 0.45 and at least p(ask); `untried` at
 * p ≥ 0.45, above p(done) and at least p(continue) and p(ask); `ask` at p ≥ 0.45; otherwise done. A missed
 * continuation is silent lost work, a needless one is one turn. `untried` holds the reply back, so it must also read
 * as more likely than done: an answer with a caveat reads as both.
 */
export async function continuationVerdict(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    request: string;
    reply: string;
    /** What the turn really has (`turnMeans`, its computer's own tools on a computer brain). */
    means: string[];
    /**
     * Each tool call of the run with its argument and outcome (`triedCalls`): the gateway's run steps (API brains,
     * and computer brains through the MCP bridge) plus a computer brain's own tools (`transcript.harnessTried`).
     */
    tried: string[];
    runKind: TurnKind;
    /** Agents and people its reply @named that aren't in the conversation (`unreachedNote`), "" none. */
    unreached?: string;
    /** A personal workspace (ADR 0159): what is worth keeping is about the person, not a company. */
    personal?: boolean;
    /**
     * Asks the same call whether the turn taught something worth keeping (ADR 0120) and hands the answer here: no
     * extra model call on any turn.
     */
    onLearn?: (signal: LearnSignal) => void;
    /** The call with the `learn` question failed and the verdict was asked again without it (error reports). */
    onLearnFailed?: (error: unknown) => void;
  },
): Promise<ContinuationVerdict> {
  const ask = (learn: boolean) =>
    judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "follow_through",
      state: {
        request: cutText(input.request, 2000),
        reply: cutTextEnd(input.reply, 3000),
        means: input.means,
        tried: input.tried.slice(-20).map(neutralizeUntrusted),
        runKind: input.runKind,
        ...(input.unreached ? { unreached: input.unreached } : {}),
      },
      questions: {
        verdict: {
          type: "choice",
          instructions:
            "An AI agent in a team chat was asked `request` and ended its turn with `reply`, its last message. `tried`: each tool call it made in this run, with its argument and outcome. `means`: the general ways it has (web search, browser, terminal, tool directory, teammates). It won't act again until someone writes to it or something it set up wakes it. Is it done, should it go on by itself, does it still have untried ways, or does it need something only a person can give?",
          criteria: {
            done: "It gave the result or the answer `request` asked for, also when it adds a caveat, a limit of the data or a part it couldn't get. Or it said what it couldn't do, and either `tried` shows several different attempts (another query, another source, another tool or the browser), or what blocks it is something only a person can give (a code, a sign-in, a payment, a permission, a decision) and it already asked them for it (with its request: `tried` shows browser_ask_person, desktop_ask_person, request_secret, request_approval, request_permission or ask_user; for a decision, one direct question) or `means` has no way to hand it to them. A reply that says it can't, stops, or only offers in passing, because a step needs the person (a sign-in, a QR code, a code, a captcha, an approval, a permission) is not done while `means` can hand that step to them: that is untried. When the request left open how to do it, one direct question offering to start a way it names, with the step the person will do ('I can do it in my browser: you'll scan a QR code. Shall I start?'), is done. A refusal because the account or the data is someone else's, not the asking person's own, is done. Saying it or the team has no access, or asking people for one, without having looked in the workspace (search_context, find_agent, ask_agent or tell_agent in `tried`) is not done: that is untried. An offer that needs someone else's decision (a sensitive or external action, a choice between their options) counts as done only when asked as one direct question.",
            untried:
              "What `request` asked for is still missing: it said it couldn't or that it lacks a tool, or asked a person to do or connect something, or asked a person for information its means could find (an address, docs, what a name refers to), while `means` has ways that fit the task it hasn't used in `tried`, or it gave up after one empty or failed attempt without varying it. Handing the work to a teammate counts as an attempt. Also when it said it or the team lacks an access, a login or an account, or asked people for one or who has it, without first looking in the workspace (`tried` has no search_context, find_agent, ask_agent or tell_agent): a teammate or an earlier conversation may hold it. Also when it said it couldn't, stopped, or only offered in passing ('one option would be…', 'only if you want'), because a step needs the person (a sign-in, a QR code scanned with their phone, a code sent to them, a captcha, an approval, a permission, their consent to their own account) instead of doing everything up to it and handing that step over, while `means` can hand it over: a step that needs the person is never a blocker. A call refused for safety ([refused for safety]) is final for that data: counting it as a way left to try is wrong. A caveat beside an answer it gave is not this: that answer is done.",
            continue:
              "It said it will do more itself (next, later, after a build), or stopped midway, and nothing it set up brings it back. A reply that asks the person whether to do something ('want me to…?', 'quer que eu faça?') is not this: it waits for their answer. Also when `unreached` is set and the reply hands work or a question to an agent it names, or says it told a person it names (that mention reached nobody); merely naming one is not that.",
            ask: "To go on it needs something only a person can give (a decision, a test, access) that its `means` can't find, but it described the need or listed what's missing instead of asking one direct question. Not when it says it needs nothing from them, or what's missing only blocks optional extra work the request doesn't need, or `request` asked what is missing or left to do and the list answers it: that is done. A way to do the request itself, even worded 'only if you want', is never optional extra work.",
            secret:
              "It asks a person to type or paste a secret into the chat (a password, an API key, a token, a private key), or it needs one from a person and hasn't asked for it through a secure request (`tried` has no request_secret call).",
            unbacked:
              "Its reply says it made, sent, created, posted, saved or did something (an image, a file, a message or an email sent, a task opened, a change made, 'done', 'here it is') that no call in `tried` did. Not when the reply only plans, offers or asks, says plainly it couldn't, or reports what someone did before and says so.",
          },
        },
        ...(learn ? { learn: input.personal ? LEARN_QUESTION_PERSONAL : LEARN_QUESTION } : {}),
      },
    });
  let learned = input.onLearn !== undefined;
  let answers: Awaited<ReturnType<typeof ask>>;
  try {
    answers = await ask(learned);
  } catch (error) {
    // Some providers' filters refuse a wording (a Claude subscription sign-in's misleading 400): the follow-through
    // verdict must never fail because of the extra question, so it is asked again alone.
    if (!learned) throw error;
    learned = false;
    input.onLearnFailed?.(error);
    answers = await ask(false);
  }
  if (input.onLearn) {
    const choice = learned ? answers.learn?.choice : undefined;
    input.onLearn(LEARN_SIGNALS.includes(choice as LearnSignal) ? (choice as LearnSignal) : "none");
  }
  const a = answers.verdict;
  const p = (k: ContinuationVerdict) => a?.probabilities?.[k] ?? (a?.choice === k ? 1 : 0);
  const verdict: ContinuationVerdict =
    p("secret") >= 0.45 && (["untried", "continue", "ask", "unbacked"] as const).every((k) => p("secret") >= p(k))
      ? "secret"
      : p("unbacked") >= 0.45 && (["untried", "continue", "ask"] as const).every((k) => p("unbacked") >= p(k))
        ? "unbacked"
        : p("untried") >= 0.45 && p("untried") > p("done") && p("untried") >= p("continue") && p("untried") >= p("ask")
          ? "untried"
          : p("continue") >= 0.45 && p("continue") >= p("ask")
            ? "continue"
            : p("ask") >= 0.45
              ? "ask"
              : "done";
  // What failed was only refused for safety: no way is left to try for that data. Work it said it will still do
  // (`continue`) goes on.
  return verdict === "untried" && onlySafetyRefusals(input.tried) ? "done" : verdict;
}

/** What a finished turn taught, as the turn-end judgment reads it (ADR 0120): `none` starts no learning. */
export type LearnSignal = "none" | "method" | "correction" | "fact" | "access";
const LEARN_SIGNALS: readonly LearnSignal[] = ["none", "method", "correction", "fact", "access"];

const LEARN_QUESTION = {
  type: "choice" as const,
  instructions:
    "Did this turn show something durable the agent should keep for next time, as `request`, `reply` and `tried` show it?",
  criteria: {
    method:
      "It worked out a way it will reuse: several tries before one worked, a new API or address, a command or a script it wrote.",
    correction:
      "A person corrected it or said how they want things done from now on ('always…', 'from now on…', 'don't… again').",
    fact: "A person's message or a tool result gave a lasting fact about the company, its people or its systems.",
    access:
      "Someone in the team got, lost or was named for an access: the agent or another signed in to a service, got a login, a key, a connector or a mailbox, or a person said who handles a service.",
    none: "Anything else: a one-off request, a passing error, a plain answer or a story.",
  },
};

/** `LEARN_QUESTION` in a personal workspace (ADR 0159): facts about the person and their life, not a company. */
const LEARN_QUESTION_PERSONAL = {
  ...LEARN_QUESTION,
  criteria: {
    ...LEARN_QUESTION.criteria,
    fact: "A person's message or a tool result gave a lasting fact about the person, their life, the people in it or their things and accounts.",
    access:
      "Someone here got, lost or was named for an access: the agent or another signed in to a service, got a login, a key, a connector or a mailbox, or a person said who handles a service.",
  },
};

/** One tool call as the judge reads it: `name(argument) → outcome`, short. */
export function callLine(name: string, input: unknown, result?: { content: string; isError?: boolean } | null) {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // `use_tool` runs another tool: the judge reads that one.
  if (typeof i.tool === "string" && i.arguments && typeof i.arguments === "object")
    return callLine(i.tool, i.arguments, result);
  const arg = ["query", "url", "command", "q", "prompt", "question", "message", "text", "path", "name"]
    .map((k) => i[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  const outcome = !result ? "" : ` → ${result.isError ? "failed: " : ""}${oneLineCut(result.content, 90) || "(empty)"}`;
  return `${name}${arg ? `(${oneLineCut(arg, 80)})` : ""}${outcome}`;
}

const oneLineCut = (text: string, max: number) => cutText(text.replace(/\s+/g, " ").trim(), max);

/**
 * Every tool call of a run, oldest first (the last 20), as the judge reads them (`tried`): the gateway's run steps
 * (every brain's calls to our tools, a computer brain's through the MCP bridge) and then `harness`, a computer
 * brain's own tools (Claude Code's Bash, WebSearch…, Codex's commands), which the runner forwards as `brain.event`
 * `tool_call` events with `executed` and the run keeps in `transcript.harnessTried`.
 */
export async function triedCalls(db: Database, run: { id: string; orgId: string }, harness: string[] = []) {
  const calls = await runCalls(db, run);
  const tag = (line: string, safety: boolean | undefined) => (safety ? `${SAFETY_TAG} ${line}` : line);
  return [
    ...calls.map((c) => tag(callLine(c.name, c.input, c.result), c.safety)),
    ...harness.map((l) => tag(l, !l.startsWith(SAFETY_TAG) && HARNESS_SAFETY.test(l))),
  ].slice(-20);
}

/** A run's tool calls through the gateway, oldest first, each with its result once it came. */
export async function runCalls(db: Database, run: { id: string; orgId: string }) {
  const steps = await db
    .select({ kind: schema.agentRunSteps.kind, data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.runId, run.id),
        inArray(schema.agentRunSteps.kind, ["tool_call", "tool_result"]),
      ),
    )
    .orderBy(schema.agentRunSteps.seq);
  const calls = new Map<string, RunCall>();
  for (const { kind, data } of steps) {
    const id = typeof data.toolUseId === "string" ? data.toolUseId : `step:${calls.size}`;
    const name = typeof data.name === "string" ? data.name : "";
    if (kind === "tool_call") calls.set(id, { name, input: data.input });
    else {
      const call = calls.get(id) ?? { name, input: undefined };
      call.result = {
        content: String(data.content ?? ""),
        isError: data.isError === true,
        // `data.data.outside`: the gateway's mark for any outside read, which survives `shown` dropping the envelope.
        external: data.external === true || (data.data as { outside?: unknown } | undefined)?.outside === true,
      };
      call.safety = data.isError === true && isSafetyCode((data.data as { code?: unknown } | undefined)?.code);
      calls.set(id, call);
    }
  }
  return [...calls.values()];
}

export interface RunCall {
  name: string;
  input: unknown;
  /** `external`: an answer read from outside (an MCP server, a screen), recorded without its envelope. */
  result?: { content: string; isError?: boolean; external?: boolean };
  /** Refused for safety (`SAFETY_CODES`): final for that data. */
  safety?: boolean;
}

export type TurnKind = "conversation" | "agents_dm" | "routine";

export interface TurnEnd {
  state: ContinuationState;
  kind: TurnKind;
  /** Tool calls executed so far in the run. */
  executed: number;
  /** A bound already ended it: stuck, the step backstop, the turn cap. */
  bound: string | null;
  /** It passed, used the silence word, or a reaction, a GIF or a report card is its answer. */
  quiet: boolean;
  /** A person decided what it waited on and it ended without a word: the decision and its result. */
  decided: string | null;
  /** Addressed directly, it wrote nothing (or only the silence word). */
  unanswered: boolean;
  /**
   * Its answer names agents or people outside the conversation (`unreachedNote`, "" none): the mention reached nobody.
   * Judged: a hand-off or a message by that mention goes on with this note, a mention that only names them ends as
   * judged.
   */
  unreached: string;
  /** What is judged ("" skips the judgment: nothing to read, or an agents' DM run that owes no answer). */
  judged: string;
  mission: boolean;
  /**
   * Requests for a person it made in this run and stopped waiting on, still open (`openRequestNudge`, "" none): it
   * says once whether it still needs them before ending.
   */
  openRequest?: string;
  /** Something durable brings it back (`wakesLater`), read only when the judgment would run. */
  wakesLater(): Promise<boolean>;
  /** Whatever run set it, something brings it back to this conversation (`comesBackHere`), read on a promise. */
  comesBack?(): Promise<boolean>;
  /** The judgment; null when the workspace has no judge. */
  verdict: (() => Promise<ContinuationVerdict>) | null;
  /** What an `untried` turn is reminded of (`untriedNudge`): its means and what it tried, filled by `verdict`. */
  evidence?: { means: string[]; tried: string[] };
}

export type TurnEndDecision = {
  outcome: "continue" | "waiting" | "done" | "ask_card";
  rule: string;
  /** What the run reads next (continue only). */
  nudge?: string;
  verdict?: ContinuationVerdict;
  judgeError?: boolean;
};

/**
 * Decides how a turn that reached its final answer ends (rules in order, the first that applies wins). The caller
 * applies it: posts and goes on with the nudge, turns the reply into a question card, or ends the run, and records
 * the decision as the run's `continuation` step.
 */
export async function decideTurnEnd(t: TurnEnd): Promise<TurnEndDecision> {
  const max = t.kind === "routine" ? CONTINUE.routineMaxPerRun : CONTINUE.maxPerRun;
  const canNudge = t.state.count < max;
  if (t.bound) return { outcome: "done", rule: t.bound };
  if (t.quiet) return { outcome: "done", rule: "quiet" };
  if (t.decided && canNudge) return { outcome: "continue", rule: "decision", nudge: decisionNudge(t.decided) };
  if (t.unanswered && canNudge) return { outcome: "continue", rule: "answer", nudge: ANSWER_NUDGE };
  if (t.openRequest && !t.state.requestNudged)
    return { outcome: "continue", rule: "open_request", nudge: t.openRequest };
  if (!t.judged || !t.verdict) return { outcome: "done", rule: t.verdict ? "nothing_to_judge" : "no_judge" };
  if (!canNudge && !t.state.askPending && (t.state.askNudged || t.kind !== "conversation"))
    return { outcome: "done", rule: "cap" };
  if (await t.wakesLater().catch(() => false)) return { outcome: "waiting", rule: "wakes_later" };
  let verdict: ContinuationVerdict;
  try {
    verdict = await t.verdict();
  } catch {
    return { outcome: "done", rule: "judge_error", judgeError: true };
  }
  // No person reads a routine's run or an agents' DM: what it lacks goes out in its report or its answer, and
  // the controller of the run that reads it can ask.
  if ((verdict === "ask" || verdict === "secret") && t.kind !== "conversation")
    return { outcome: "done", rule: "ask_elsewhere", verdict };
  // A secret asked in the chat is never posted nor made a question card: once told the secure way, then as it is.
  if (verdict === "secret")
    return t.state.secretNudged
      ? { outcome: "done", rule: "secret_cap", verdict }
      : { outcome: "continue", rule: "secret", verdict, nudge: SECRET_NUDGE };
  // A result it claims that no call produced (ADR 0167): never posted; once more to do it or say it can't.
  if (verdict === "unbacked")
    return canNudge
      ? { outcome: "continue", rule: "unbacked", verdict, nudge: UNBACKED_NUDGE }
      : { outcome: "done", rule: "unbacked_cap", verdict };
  // A hand-off by mention to an agent that isn't here is an unkept hand-off: it goes on and hands it over.
  if (verdict === "continue" && t.unreached && canNudge)
    return { outcome: "continue", rule: "unreached", verdict, nudge: t.unreached };
  // Asking means waiting (ADR 0131 §1): a reply that ends asking the person whether to go on waits for their answer,
  // never pushed into going ahead. A secret asked in the chat and an unkept hand-off keep their rules above; one told
  // to ask (`askPending`) still becomes its question card below.
  if (verdict === "continue" && t.kind === "conversation" && !t.state.askPending && endsAsking(t.judged))
    return { outcome: "done", rule: "asked", verdict };
  // A promise something already brings it back to (a follow-up still to come here, a reminder, its long work still
  // running here, whatever run set it): it rests on that, and a nudge would only post a second status.
  if (verdict === "continue" && t.kind === "conversation" && (await t.comesBack?.().catch(() => false)))
    return { outcome: "waiting", rule: "comes_back", verdict };
  if (verdict === "continue") {
    const progressed = t.state.count === 0 || t.executed > (t.state.executedAtNudge ?? 0);
    if (canNudge && progressed)
      return {
        outcome: "continue",
        rule: "promise",
        verdict,
        nudge: t.kind === "agents_dm" ? FOLLOW_THROUGH_NUDGE_DM : FOLLOW_THROUGH_NUDGE,
      };
    if (t.kind !== "conversation") return { outcome: "done", rule: "cap", verdict };
    // Nothing brings it back: a person is asked what it needs instead.
  }
  // It said it couldn't with ways left: once more with its means, while it still acts between nudges.
  if (verdict === "untried") {
    const progressed = t.state.count === 0 || t.executed > (t.state.executedAtNudge ?? 0);
    if (canNudge && progressed)
      return {
        outcome: "continue",
        rule: "untried",
        verdict,
        nudge: untriedNudge(t.evidence?.means ?? [], t.evidence?.tried ?? []),
      };
    return { outcome: "done", rule: "untried_cap", verdict };
  }
  if (verdict === "done") return { outcome: "done", rule: "judged", verdict };
  if (!t.state.askNudged)
    return { outcome: "continue", rule: "ask", verdict, nudge: t.mission ? MISSION_ASK_NUDGE : ASK_NUDGE };
  return { outcome: "ask_card", rule: "ask_card", verdict };
}

/** Moves the state on for a `continue` decision (the ask nudge has its own once-flag). */
export function advance(state: ContinuationState, d: TurnEndDecision, executed: number): ContinuationState {
  const { askPending: _, ...rest } = state;
  if (d.outcome !== "continue") return rest;
  if (d.rule === "ask") return { ...rest, askNudged: true, askPending: true };
  if (d.rule === "secret") return { ...rest, secretNudged: true };
  if (d.rule === "open_request") return { ...rest, requestNudged: true };
  return { ...rest, count: state.count + 1, executedAtNudge: executed };
}

/** Run errors the person already sees explained elsewhere, or that no one can act on. */
const UNREPORTED = new Set(["agent_archived", "no_ai", "person_limit", "canceled"]);

/**
 * A conversation run failed for good (I5): the person accountable for it (the person behind it, else the routine's
 * creator, else the agent's owner) gets one `run_failed` notification per agent and conversation, resolved by the
 * agent's next run there that ends well. A run another agent's @mention woke tells that agent once ("couldn't
 * finish"), so it tries another way or tells the person; hand-offs in an agents' DM close through their own rows
 * (`onConsultedRunFinished`) and notify nobody here. Never throws.
 */
export async function reportRunFailure(
  deps: { db: Database; pubsub?: PubSub },
  run: AgentRun,
  reason: string,
  cause?: { code?: string; plan?: string },
) {
  if (run.background || UNREPORTED.has(reason)) return;
  try {
    const channel = await getChannelCached(deps.db, run.orgId, run.channelId);
    if (!channel) return;
    // A hand-off's run in the agents' DM: no person can open that DM, and its failure already reaches the asker
    // and the hand-off's line where the work came from (`onConsultedRunFinished`).
    if (isAgentOnlyDm(channel) && (await handedOffRun(deps.db, run))) return;
    const person = accountablePerson(await runAuthority(deps.db, run));
    await notifyRunFailed(deps, run, person, reason, cause);
    if (isAgentOnlyDm(channel)) return;
    const [trigger] = await deps.db
      .select({ agentId: schema.messages.authorAgentId, runId: schema.messages.agentRunId })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
    if (!trigger?.agentId || !trigger.runId || trigger.agentId === run.agentId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, run.orgId), eq(schema.agentRuns.id, trigger.runId)));
    const agent = await getAgentCached(deps.db, run.orgId, run.agentId);
    if (!sender || sender.background || !agent) return;
    // Its mention of the same agent failing again in the stretch is written, not woken for: a run that names it
    // each time would wake itself each time.
    const again = (await stretchNoticeRefs(deps.db, sender, "consult_reply")).some(
      (r) => r.via === "mention" && r.agentId === run.agentId,
    );
    const delivered = await deps.db.transaction((tx) =>
      deliverNoticeToRun(
        tx,
        sender,
        {
          kind: "consult_reply",
          from: `@${agent.handle}`,
          text: `It couldn't finish what your mention handed it (${reason.split(":")[0]}).`,
          refs: {
            kind: "note",
            via: "mention",
            wake: "1",
            runId: run.id,
            agentId: run.agentId,
            askerAgentId: sender.agentId,
          },
        },
        again ? { wake: false } : {},
      ),
    );
    await publishDelivery(deps.pubsub, delivered);
  } catch {
    // The failure itself is on the run; a report that couldn't go out leaves it there.
  }
}

const handedOffRun = async (db: Database, run: AgentRun) =>
  (
    await db
      .select({ id: schema.agentConsultations.id })
      .from(schema.agentConsultations)
      .where(and(eq(schema.agentConsultations.orgId, run.orgId), eq(schema.agentConsultations.targetRunId, run.id)))
      .limit(1)
  ).length > 0;

/** The `refs` of the `kind` notices `run`'s agent got in its stretch (ADR 0089), in its conversation. */
async function stretchNoticeRefs(db: Database, run: AgentRun, kind: NoticeKind) {
  const rows = await db
    .select({ refs: sql<Record<string, string> | null>`${schema.messages.meta}->'notice'->'refs'` })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.orgId, run.orgId),
        eq(schema.messages.channelId, run.channelId),
        eq(schema.messages.authorAgentId, run.agentId),
        eq(schema.messages.stretchId, runStretchOf(run)),
        sql`${schema.messages.meta}->'notice'->>'kind' = ${kind}`,
      ),
    );
  return rows.map((r) => r.refs ?? {});
}

/**
 * Tells the run behind `messageId` that its mention didn't wake `skipped` (each with why), once per agent and
 * stretch: the same agent named again there adds nothing (a run that keeps naming it would hear it each time). A
 * self-report (`SELF_REPORT_NOTICES`): it joins the run while live, else waits for the agent's next turn.
 */
export async function tellWakeSkipped(
  deps: { db: Database; pubsub?: PubSub },
  run: AgentRun,
  messageId: string,
  skipped: { handle: string; why: string }[],
  reason: "audience" | "callable" | "no_ai",
) {
  if (run.background || skipped.length === 0) return;
  const told = new Set(
    (await stretchNoticeRefs(deps.db, run, "wake_skipped")).flatMap((r) => (r.agentHandles ?? "").split(",")),
  );
  const fresh = skipped.filter((s) => !told.has(s.handle));
  if (fresh.length === 0) return;
  const text = `${fresh.map((s) => `@${s.handle} wasn't woken by your mention: ${s.why}.`).join(" ")} ${WAKE_SKIPPED_STEP}`;
  const delivered = await deps.db.transaction((tx) =>
    deliverNoticeToRun(tx, run, {
      kind: "wake_skipped",
      text,
      refs: { runId: run.id, messageId, agentHandles: fresh.map((s) => s.handle).join(","), reason },
    }),
  );
  await publishDelivery(deps.pubsub, delivered);
}

/** What the author does about agents its mention didn't wake: hand it over once, in words, and stop. */
export const WAKE_SKIPPED_STEP =
  "The people here see that under your message. Don't mention it again for this: if the work still needs it, say once what it should do, without the @, so someone who can reach it hands it over, and leave it there.";

/**
 * Why an agent's mention couldn't reach `a` for the person behind it (`person`, null for nobody): the real cause, so
 * the author says it right. Its owner's own plan answering only its owner (ADR 0059 §5) keeps everyone else out,
 * consultations too.
 */
function unreachableWhy(a: Agent, person: string | null) {
  if (isComputerBrain(a.brain) && !answersOthers({ ...audienceOf(a), consultable: false }, a.ownerUserId))
    return "it thinks with its owner's own AI plan, which answers only its owner";
  const who = person ? "the person you work for isn't one" : "nobody is behind this work";
  return a.consultable
    ? `only certain people may talk to it, and ${who}`
    : `only certain people may talk to it, it takes no requests from other agents for anyone else, and ${who}`;
}

/**
 * Agents an agent's @mention selected that dispatch couldn't wake because only certain people may talk to them and
 * the person behind the message isn't one (nobody, for a run with no requester), and that no consultation reached
 * (`settleReach` asks the ones that take them): the skip goes in the message's routing decision (`settleReach`
 * records the audience ones), and the author hears it once per stretch (`tellWakeSkipped`). Agents not in the
 * conversation are told by `unreachedNote` already. Never throws.
 */
export async function reportDroppedMentions(
  deps: { db: Database; pubsub?: PubSub },
  message: { id: string; orgId: string; agentRunId: string | null },
  dropped: { agentId: string; handle: string; reason: "not_in_channel" | "audience"; noAi?: boolean }[],
) {
  if (dropped.length === 0) return;
  try {
    // `settleReach` records the audience skips; the ones that left the conversation are recorded here, same words.
    const gone = dropped.filter((d) => d.reason === "not_in_channel");
    if (gone.length > 0) {
      const why = gone.map((d) => `${d.reason}: @${d.handle}`).join(", ");
      await deps.db
        .update(schema.routingDecisions)
        .set({ reason: sql`left(concat_ws('; ', ${schema.routingDecisions.reason}, ${why}::text), 1000)` })
        .where(
          and(eq(schema.routingDecisions.orgId, message.orgId), eq(schema.routingDecisions.messageId, message.id)),
        );
    }
    const audience = dropped.filter((d) => d.reason === "audience");
    if (audience.length === 0 || !message.agentRunId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, message.orgId), eq(schema.agentRuns.id, message.agentRunId)));
    if (!sender || sender.background) return;
    const person = (await runAuthority(deps.db, sender)).personId;
    const rows = await deps.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, message.orgId),
          inArray(
            schema.agents.id,
            audience.map((d) => d.agentId),
          ),
        ),
      );
    const noAi = new Set(audience.filter((d) => d.noAi).map((d) => d.agentId));
    // One notice per cause: the app words people read under it come from `refs.reason`.
    await tellWakeSkipped(
      deps,
      sender,
      message.id,
      rows
        .filter((a) => noAi.has(a.id))
        .map((a) => ({ handle: a.handle, why: "it has no AI connected, so nothing could answer it" })),
      "no_ai",
    );
    await tellWakeSkipped(
      deps,
      sender,
      message.id,
      rows.filter((a) => !noAi.has(a.id)).map((a) => ({ handle: a.handle, why: unreachableWhy(a, person) })),
      "audience",
    );
  } catch {
    // The run that mentioned them is unaffected; the decision row keeps what it had.
  }
}
