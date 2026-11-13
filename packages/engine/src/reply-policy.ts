import { and, asc, type Executor, eq, gt, isNull, ne, schema, sql } from "@agenteschat/db";
import { cutText } from "./format";
import type { Message } from "./messages";
import type { AgentRun } from "./runs";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentRuns, messages, agents, routingDecisions } = schema;

/**
 * Who may stay quiet, and the silence word that is never posted.
 *
 * There is no magic word: a run nobody called by name may `pass` (a tool), and
 * a final text that is only the old sentinel (`NO_REPLY` and its variants) is
 * never posted on any run. A run that was addressed directly and answers only
 * the sentinel is told once to answer the person (`ANSWER_NUDGE`).
 */

/** The word models use for "nothing to say" (routines asked for it; models still write it elsewhere). */
export const NO_REPLY = "NO_REPLY";

/** Name of the built-in tool a run not called by name ends with when it has nothing to add. */
export const PASS_TOOL = "pass";

/** What a run that must answer reads after a reply that was only the sentinel (or nothing). */
export const ANSWER_NUDGE = "You were addressed directly; answer the person.";

/** The prompt block of runs that may pass. */
export const WHY_YOU_WERE_CALLED =
  '# Why you were called\nNobody called you by name; you were brought in because you might have something to add. If you don\'t, or another agent already answered, call pass: staying quiet in a room is normal. A thanks, an ok or people talking among themselves asks nothing of you: pass at once, without looking anything up and without re-checking an answer already given. Speak only when the message asks something in your area that nobody has answered yet. A greeting, or someone asking whether anyone is there because nobody answered ("alô???"), gets one short friendly line back, nothing more.';

/** The prompt block of a run another agent's @mention woke (`byAnotherAgent`): it may pass too. */
export const WHY_AN_AGENT_CALLED =
  "# Why you were called\nAnother agent mentioned you, not a person. Do only what its message asks of you: work, a question, or something to act on. If it only names you, credits or cites you, thanks you, agrees or signs off, call pass at once, without looking anything up: nothing is posted, and a thanks never needs one back. The person's question is that agent's to answer: never answer it again, restate its answer, confirm it or nitpick it here. If its answer is wrong in a way that matters, tell that agent privately with tell_agent and pass.";

/**
 * Another agent's message that @mentions it woke the run (`dispatchMentions`), not one of its own lines (a notice, a
 * task's end, a follow-up): an agent's mention wakes when the judge reads a request to it (ADR 0089), so the run may
 * still find nothing for it. Hop 2 or more: a person's click on that message (Continuar on a pause card, "Responder
 * agora") starts the run at hop 1 in a fresh stretch, and then it answers.
 */
export const byAnotherAgent = (
  run: Pick<AgentRun, "agentId" | "trigger" | "hop">,
  trigger: (Pick<Message, "authorType"> & { authorAgentId?: string | null }) | null | undefined,
) =>
  run.trigger === "mention" &&
  run.hop >= 2 &&
  trigger?.authorType === "agent" &&
  !!trigger.authorAgentId &&
  trigger.authorAgentId !== run.agentId;

/** The prompt block of a run only a person's mention of everyone woke (`byEveryone`): it may pass too. */
export const WHY_EVERYONE_CALLED =
  "# Why you were called\nA person mentioned everyone in this conversation (@everyone), not you by name. Answer only if the message asks something of you or in your area that nobody has answered yet; an announcement, a greeting to all or something for the people here asks nothing of you: call pass at once.";

/** A mention of everyone woke the run (`meta.everyoneAgentIds`, written with the message), its name not. */
export const byEveryone = (
  run: Pick<AgentRun, "agentId" | "trigger">,
  trigger: Pick<Message, "meta"> | null | undefined,
) => {
  const ids = trigger?.meta?.everyoneAgentIds;
  return run.trigger === "mention" && Array.isArray(ids) && ids.includes(run.agentId);
};

export interface ReplyPolicy {
  /** Nobody called it by name: it may end without a message (`pass`, an empty or sentinel-only answer). */
  mayPass: boolean;
  /** Background work (`agent_runs.background`): its final answer is never posted (`closeRoutineRun`). */
  background: boolean;
}

/**
 * Notices that only inform the agent (ADR 0053 §10): another agent's note, the late result of a wait it
 * stopped waiting on, its own fast reply, its own follow-up coming due, what happened on GitHub (it answers there),
 * the asks its ended background work took on (the work may have done them). The run one of them wakes may stay quiet.
 */
const INFORMING_NOTICES: ReadonlySet<string> = new Set([
  "agent_note",
  "wait_result",
  "talker_reply",
  "follow_up",
  "github_event",
  "work_follow_up",
]);

/**
 * How a run must answer. Only runs nobody called by name may pass: the router
 * brought them in (a person's message without a mention, or an agent's reply
 * it chimes in on, `meta.joined`), another agent's @mention woke them
 * (`byAnotherAgent`), a person's mention of everyone woke them (`byEveryone`), or a notice that only informs woke them
 * (`INFORMING_NOTICES`). Never a person's mention, a DM, another agent's
 * `ask_agent` consultation (a DM between agents), a routine's
 * call or report, a quote reply to this agent, a router follow-up to the agent
 * the person was talking to, nor a run a person answered or wrote into
 * (`answerOwed`). A run catching up after a usage pause (`catchUp`) may pass whoever called it: what it was asked
 * may have been answered or dropped while it waited. So may one whose own request was withdrawn as moot (`moot`): what
 * met its need may have met the person's too.
 */
export function replyPolicyFor(
  run: Pick<AgentRun, "agentId" | "trigger" | "background" | "hop">,
  trigger: (Pick<Message, "authorType" | "meta"> & { authorAgentId?: string | null }) | null | undefined,
  options: { followUp?: boolean; answerOwed?: boolean; catchUp?: boolean; moot?: boolean } = {},
): ReplyPolicy {
  if (run.background) return { mayPass: false, background: true };
  if (options.answerOwed) return { mayPass: false, background: false };
  // Catching up after a usage pause (`catch-up.ts`): someone else may have answered it meanwhile.
  if (options.catchUp || options.moot) return { mayPass: true, background: false };
  const notice = trigger?.meta?.notice as { kind?: unknown; refs?: { report?: unknown } } | undefined;
  if (typeof notice?.kind === "string" && INFORMING_NOTICES.has(notice.kind))
    return { mayPass: true, background: false };
  // A routine that speaks only when there is news (ADR 0053 §7): the run its report woke may find nothing new
  // for the people (only what it already told them) and stay quiet. One that reports every time always posts.
  if (notice?.kind === "routine_handoff" && notice.refs?.report !== "always")
    return { mayPass: true, background: false };
  // The end of a task a routine started follows the same report policy (`wakeConversationForTask`).
  const task = trigger?.meta?.machineTask as { routine?: { report?: unknown } } | undefined;
  if (task?.routine && task.routine.report !== "always") return { mayPass: true, background: false };
  if (byAnotherAgent(run, trigger) || byEveryone(run, trigger)) return { mayPass: true, background: false };
  if (run.trigger !== "router" || options.followUp) return { mayPass: false, background: false };
  const meta = trigger?.meta ?? {};
  // A routine's call is a person's message written for its creator; an agent's message about a routine's
  // report carries the tag too (§7), and another agent the router brings in may still pass on it.
  if (meta.routine && trigger?.authorType === "person") return { mayPass: false, background: false };
  const replyTo = meta.replyTo as { author?: { type?: unknown; id?: unknown } } | undefined;
  const quotesThisAgent = replyTo?.author?.type === "agent" && replyTo.author.id === run.agentId;
  return { mayPass: !quotesThisAgent, background: false };
}

/**
 * The router's decision for the trigger kept the person with the agent they were talking to: that agent was
 * addressed. Only code starts `routing_decisions.reason` with the marker (router.ts `FOLLOW_UP`): a step's own
 * words come after its name, so a model can't take an agent's right to stay quiet.
 */
const followUpSql = sql<boolean>`exists (select 1 from ${routingDecisions} d
  where d.message_id = ${agentRuns.triggerMessageId} and d.reason like 'follow-up%')`;

/**
 * `replyPolicyFor` from the database (the run, its trigger, the router's decision): one read. `listsPass`:
 * `pass` is in its tools, also once it may no longer pass (`Transcript.passListed`). A moot request lets it pass but
 * never adds `pass` to a run that started without it: its replayed thinking needs the same tools.
 */
export async function loadReplyPolicy(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<(ReplyPolicy & { listsPass: boolean }) | null> {
  if (!runId) return null;
  const [row] = await db
    .select({
      agentId: agentRuns.agentId,
      hop: agentRuns.hop,
      trigger: agentRuns.trigger,
      background: agentRuns.background,
      answerOwed: sql<boolean>`coalesce((${agentRuns.transcript} ->> 'answerOwed')::boolean, false)`,
      passListed: sql<boolean>`coalesce((${agentRuns.transcript} ->> 'passListed')::boolean, false)`,
      catchUp: sql<boolean>`coalesce((${agentRuns.transcript} -> 'catchUp' ->> 'mayPass')::boolean, false)`,
      moot: sql<boolean>`coalesce((${agentRuns.transcript} ->> 'requestMoot')::boolean, false)`,
      authorType: messages.authorType,
      authorAgentId: messages.authorAgentId,
      meta: messages.meta,
      followUp: sql<boolean>`${agentRuns.trigger} = 'router' and ${followUpSql}`,
    })
    .from(agentRuns)
    .leftJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) return null;
  const trigger = row.authorType
    ? { authorType: row.authorType, authorAgentId: row.authorAgentId, meta: row.meta ?? {} }
    : null;
  const options = {
    followUp: row.followUp === true,
    answerOwed: row.answerOwed === true,
    catchUp: row.catchUp === true,
  };
  const policy = replyPolicyFor(row, trigger, { ...options, moot: row.moot === true });
  return { ...policy, listsPass: replyPolicyFor(row, trigger, options).mayPass || row.passListed === true };
}

/** Whether the router sent this run's trigger to it as a follow-up of its own conversation. */
export async function routedAsFollowUp(db: Executor, run: Pick<AgentRun, "id" | "trigger">): Promise<boolean> {
  if (run.trigger !== "router") return false;
  const [row] = await db.select({ followUp: followUpSql }).from(agentRuns).where(eq(agentRuns.id, run.id));
  return row?.followUp === true;
}

// ── The sentinel ─────────────────────────────────────────────────────────────

/** Marks and punctuation a model wraps the word in: `NO_REPLY`, **NO_REPLY**, "NO_REPLY.", [NO_REPLY]. */
const EDGE = /^[\s`*_~"'“”‘’()[\]{}<>.,!?:;#|-]+|[\s`*_~"'“”‘’()[\]{}<>.,!?:;#|-]+$/g;
const core = (s: string) => s.replace(EDGE, "");
/** The word alone, in any case and spelling the models use (not "No reply.", which is a real answer). */
const WORD = /^no[_-]?reply$/i;
const MARKS = "`*_~\"'“”‘’()\\[\\]<>";
/** The exact word glued to real text at the start of a line ("NO_REPLY Sure…"); not part of an identifier. */
const GLUED_START = new RegExp(`^(\\s*)[${MARKS}]*${NO_REPLY}(?!_[A-Za-z0-9]|[0-9])[${MARKS}.!:;,-]*\\s*`);
/** …or at its end ("…done. NO_REPLY", "…done.NO_REPLY"). */
const GLUED_END = new RegExp(`(?<![_0-9])[${MARKS}]*${NO_REPLY}[${MARKS}.!]*\\s*$`);
/** A line still being written that could end as the glued word ("…done. NO_RE"): held while it could. */
const PARTIAL_END = new RegExp(`(?<![_0-9a-z])[${MARKS}]*N(?:O(?:_(?:R(?:E(?:P(?:L(?:Y)?)?)?)?)?)?)?[${MARKS}.!]*$`);
const SPELLINGS = ["no_reply", "no-reply", "noreply"];

/** A line that is only the word (with marks, spacing, punctuation). */
export const isSentinelLine = (line: string) => {
  const c = core(line);
  return WORD.test(c) || c === "NO REPLY";
};

/** The whole text is the word cut short ("NO", "NO_RE"): a model stopped mid-word. */
const isTruncatedSentinel = (text: string) => {
  const c = core(text);
  return c.length >= 2 && NO_REPLY.startsWith(c);
};

/** A line being streamed that may still turn into the word on its own. */
function couldBeSentinelLine(open: string) {
  if (isSentinelLine(open)) return true;
  const r = open.replace(/^[\s`*_~"'“”‘’()[\]{}<>#|-]+/, "");
  if (!r) return true;
  return SPELLINGS.some((s) => s.startsWith(r.toLowerCase())) || "NO REPLY".startsWith(r);
}

const stripGlued = (line: string) => line.replace(GLUED_START, "$1").replace(GLUED_END, "");

/**
 * What of `text` may be shown. Lines that are only the word go, and the word
 * glued to the start or end of a line is cut. While streaming (`final` false)
 * the line being written is held while it could still become the word, and so
 * is a trailing piece that could be the glued word: streamed text never shows
 * it. What was shown stays a prefix of what is shown later.
 */
export function visibleText(text: string, final: boolean): string {
  if (final && isTruncatedSentinel(text)) return "";
  const lines = text.split("\n");
  const open = final ? null : (lines.pop() ?? "");
  const kept = lines.filter((l) => !isSentinelLine(l)).map(stripGlued);
  if (final) return kept.join("\n");
  const tail =
    open === null || couldBeSentinelLine(open) ? "" : open.replace(GLUED_START, "$1").replace(PARTIAL_END, "");
  return kept.map((l) => `${l}\n`).join("") + tail;
}

/**
 * What a run posts beside the approval or secret it stops on. The card already says what it asks, so a line that
 * announces or repeats it ("I'll ask for X", "it's on the card") stays out of the conversation, where it would only
 * push the card up. A longer text is real work written in the same step, and it is posted. A question keeps what
 * leads to it: that text is its context, and it comes first.
 */
const PAUSE_LEAD_MIN_CHARS = 280;
export const pauseLead = (text: string) => (text.length >= PAUSE_LEAD_MIN_CHARS ? text : "");

/** The text without the sentinel, trimmed: what may be posted. */
export const stripSentinel = (text: string) => visibleText(text, true).trim();

/** Nothing but the sentinel (any variant, or the word cut short): there is nothing to post. */
export const isSentinelOnly = (text: string) => text.trim() !== "" && stripSentinel(text) === "";

/**
 * The model meant to stay quiet: only the word, or a note that closes with it
 * ("Nada novo desde ontem.\n\nNO_REPLY"). For runs that may stay quiet.
 */
export function endsWithSentinel(text: string) {
  if (isSentinelOnly(text)) return true;
  const last = text.trim().split("\n").at(-1) ?? "";
  return isSentinelLine(last) || GLUED_END.test(last);
}

// ── The `pass` tool ──────────────────────────────────────────────────────────

/**
 * The built-in `pass` tool: no scope, listed in runs that start able to pass
 * (`loadReplyPolicy`), and in them for good, continuations included: a
 * thinking block replayed after a change to `tools` is a 400 on Claude, so
 * once a person is owed an answer the tool refuses instead of leaving the
 * list. It changes nothing: `data.passed` tells the engine to end the run
 * without a message (a step keeps the reason; `agent.passed`).
 */
export function createPassToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: PASS_TOOL,
    description:
      "Stay quiet: end your turn without posting anything. Only when no person called you by name: use it when you have nothing to add, another agent already answered, or another agent's mention needs nothing from you. Give a short reason (for the record, nobody sees it in the chat). Then end your turn without any text.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 300 } },
      additionalProperties: false,
    },
    describe: () => ({ title: "Stay quiet" }),
    async execute(input, ctx) {
      const policy = await loadReplyPolicy(ctx.db, ctx.orgId, ctx.runId);
      if (!policy?.mayPass) {
        return { content: "You were addressed directly: answer the person instead.", isError: true };
      }
      const reason = typeof input.reason === "string" ? cutText(input.reason.trim(), 300) : "";
      return {
        content: "Passed: nothing is posted. End your turn now without any text.",
        data: { passed: { reason } },
      };
    },
  };
  return {
    name: "reply-policy",
    tools: async (ctx) =>
      (await loadReplyPolicy(ctx.db, ctx.orgId, ctx.runId).catch(() => null))?.listsPass ? [tool] : [],
  };
}

// ── Others already answered ──────────────────────────────────────────────────

/**
 * Other agents' replies to the same message posted after it (where this run
 * answers): a run brought in reads them before its first call, so it can pass
 * instead of answering twice. Its context only goes up to the trigger.
 */
export async function repliesAfterTrigger(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId">,
  trigger: Pick<Message, "id" | "createdAt">,
  threadId: string | null,
): Promise<string | null> {
  const rows = await db
    .select({ body: messages.body, name: agents.name, handle: agents.handle })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
        eq(messages.authorType, "agent"),
        ne(messages.authorAgentId, run.agentId),
        // `createdAt` is cut to milliseconds while Postgres keeps microseconds: never the trigger itself.
        ne(messages.id, trigger.id),
        gt(messages.createdAt, trigger.createdAt),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(5);
  if (rows.length === 0) return null;
  return rows
    .map((m) => `[Meanwhile ${m.name} (@${m.handle}) replied here]: ${cutText(stripSentinel(m.body), 4000)}`)
    .join("\n\n");
}
