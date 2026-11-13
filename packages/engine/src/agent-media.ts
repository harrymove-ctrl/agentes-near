import type { GifProvider, PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { getChannelCached } from "./context";
import { isAgentOnlyDm } from "./dms";
import { publishMessageCreated } from "./events";
import type { Judge, JudgeQuestion } from "./judge";
import {
  AGENT_GIF_CATEGORIES,
  AGENT_STICKER_MOODS,
  type AgentMediaLevel,
  GIF_CATEGORIES,
  type GifMedia,
  type GifRating,
  MEDIA_AFTER_KEY,
  type MediaSettings,
  type MessageMedia,
  mediaOf,
  mediaSettings,
  runMediaCount,
} from "./media";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { missionOfThread } from "./missions";
import { enqueue } from "./outbox";
import { routineBriefOf } from "./routine-brief";
import { standingRefusal } from "./standing";
import { isPersonalWorkspace } from "./workspace-mode";

/**
 * An agent's sticker or GIF after its own reply (ADR 0091 §4). The agent's prompt knows nothing of this step: once
 * a reply is posted, it decides whether a light visual reaction follows it. Code owns the policy (free checks
 * first, then cheap reads); Jev only answers typed questions, calibrated, and the workspace's level is the bar its
 * probability must clear. The reaction is a silent message of its own from the same agent (`meta.mediaAfter`): it
 * starts no run, routes to nobody and notifies nobody. When someone asks, the agent sends one itself with its
 * tools (`media-tools.ts`, ADR 0091 addendum 2026-10-31), and this step stays out of that run.
 */

const { agentRuns, agents, messages, users } = schema;

type AgentMood = (typeof AGENT_STICKER_MOODS)[number];
type AgentGif = (typeof AGENT_GIF_CATEGORIES)[number];
type ChannelFields = Pick<typeof schema.channels.$inferSelect, "kind" | "dmKey" | "archivedAt">;

/** The outbox job that judges one agent reply (payload `{ messageId }`), queued by `message.posted`. */
export const AGENT_MEDIA_JOB = "agents.media";
/** The judgment's name (usage records, fakes, logs). */
export const AGENT_MEDIA_JUDGMENT = "agent_media";

/**
 * How likely Jev must find a reaction natural and welcome before the agent sends one, by the workspace's level.
 * Tuned with `bun run eval:media` (precision first: a sticker after bad news costs more than a missed one).
 */
export const AGENT_MEDIA_THRESHOLDS: Readonly<Record<Exclude<AgentMediaLevel, "never">, number>> = {
  sometimes: 0.8,
  often: 0.6,
};

/** A longer reply is work content, not a moment for a reaction. */
export const MEDIA_REPLY_MAX_CHARS = 600;
/** None of the conversation's last this many messages may be an agent's sticker or GIF. */
export const MEDIA_QUIET_MESSAGES = 8;
/** An agent sends at most one sticker or GIF per channel in this long. */
export const MEDIA_AGENT_GAP_MS = 15 * 60_000;
/** Past this, the moment after the reply is gone (a backlog, a retry): nothing is sent. */
export const MEDIA_LATE_MS = 2 * 60_000;
/** Messages before the reply that Jev reads, each cut to `MEDIA_STATE_CLIP` characters. */
export const MEDIA_STATE_MESSAGES = 6;
const MEDIA_STATE_CLIP = 300;
/** "People send GIFs here": a person's GIF among the conversation's last 50 messages, within 7 days. */
export const MEDIA_PEOPLE_GIFS = { messages: 50, ms: 7 * 24 * 3600_000 } as const;
/** A GIF comes from the first results of its category's search: this many asked, one of the first five taken. */
export const MEDIA_GIF_SEARCH_LIMIT = 8;
export const MEDIA_GIF_PICK_FROM = 5;
/** A background step: Jev usually answers in well under a second, and a hung call never holds the job. */
export const MEDIA_JUDGE_TIMEOUT_MS = 5_000;
const GIF_SEARCH_TIMEOUT_MS = 4_000;
/** The messages table is partitioned by time (ADR 0009): conversation reads stay within the last week. */
const WEEK_MS = 7 * 24 * 3600_000;

/** Why no sticker or GIF followed a reply (logs and tests). */
export type AgentMediaSkip =
  /** Not an agent's reply in a run: a card, a notice, a server-written line, a hand-off, deleted. */
  | "not_reply"
  /** The reply is itself a GIF or a sticker. */
  | "media_reply"
  /** Its run already sent a GIF or a sticker with the agent's own tools (`send_gif`, `send_sticker`). */
  | "tool_media"
  /** Too long, or code, a table or a chart. */
  | "dense"
  /** It ends asking something: the person answers first. */
  | "question"
  /** Judged too long after the reply. */
  | "late"
  /** The workspace's level is `never`. */
  | "off"
  /** The agents' stickers are off and no GIF may go here. */
  | "nothing_to_send"
  /** The agent's own switch is off (or it was archived). */
  | "agent_off"
  /** Not the last word of a run that is over. */
  | "not_final"
  /** No person asked: a routine, a background run, another agent, a consultation, a notice. */
  | "not_person"
  /** A mission's or an issue's work. */
  | "work"
  /** Not a chat channel or a DM with a person (an agents-only DM, an archived place). */
  | "channel"
  /** Something newer was posted in the conversation. */
  | "newer"
  /** An agent's sticker or GIF among the conversation's last messages. */
  | "recent_media"
  /** This agent sent one in this channel a moment ago. */
  | "agent_gap"
  /** Another agent is about to answer in the conversation. */
  | "busy"
  /** The workspace or the agent is held (`standing.ts`). */
  | "standing"
  | "no_judge"
  /** Jev failed, took too long, or has no key (a calibrated request is never answered by another model). */
  | "judge_failed"
  /** Jev's probability is under the level's bar. */
  | "unfit"
  /** Jev named no mood we have (and no GIF went). */
  | "no_choice";

export type AgentMediaOutcome = { sent: MessageMedia; messageId: string } | { skipped: AgentMediaSkip };

export interface AgentMediaDeps {
  db: Database;
  pubsub: PubSub;
  /** The judge, asked calibrated: only Jev answers, so without its key nothing is sent. */
  judge?: Judge | null;
  /** GIF search (`Adapters.gifs`); absent: the agent's own stickers only. */
  gifs?: GifProvider | null;
  now?: () => Date;
  judgeTimeoutMs?: number;
}

// ── Free checks (the message and its channel, nothing read) ───────────────────

/**
 * Meta the server puts on cards, notices, server-written lines, routine, mission and issue work, stopped or cut
 * runs, and the step's own media: such a message is never a light reply in the agent's own words.
 */
const NOT_A_LIGHT_REPLY = [
  "talker",
  "notice",
  "noAi",
  "actionCard",
  "approvalId",
  "questionId",
  "secretRequestId",
  "issueWork",
  "issueWorkStart",
  "issueTaken",
  "missionLink",
  "missionSuggestion",
  "background",
  "routine",
  "viaRoutine",
  "joined",
  "agentDm",
  "consultation",
  "bodyCode",
  "artifacts",
  "brainUnavailable",
  "brainInterrupted",
  "canceled",
  "interrupted",
  MEDIA_AFTER_KEY,
] as const;

const CODE = /```|~~~/;
/** A Markdown table's rule line (`| --- | :-: |`). */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
/** Ends asking something (an emoji after the question mark still asks). */
const ASKS = /[?？](?:\s|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D})*$/u;

/** What a reply's text alone rules out: too long, code (a chart is a code block too), a table, a question. */
export function replyTextSkip(body: string): AgentMediaSkip | null {
  const text = body.trim();
  if (!text) return "not_reply";
  if (text.length > MEDIA_REPLY_MAX_CHARS || CODE.test(text) || TABLE_RULE.test(text)) return "dense";
  if (ASKS.test(text)) return "question";
  return null;
}

type ReplyFields = Pick<
  Message,
  "authorType" | "authorAgentId" | "agentRunId" | "body" | "meta" | "mentionedAgentIds" | "deletedAt"
>;

/**
 * What the message itself rules out: not an agent's reply in a run, a card or a notice, a GIF or a sticker itself
 * (the step's own, or one the agent sent with its tools), a hand-off, dense text.
 */
export function replySkip(message: ReplyFields): AgentMediaSkip | null {
  if (message.authorType !== "agent" || !message.authorAgentId || !message.agentRunId || message.deletedAt)
    return "not_reply";
  if (NOT_A_LIGHT_REPLY.some((key) => message.meta[key] != null && message.meta[key] !== false)) return "not_reply";
  if (message.meta.media != null) return "media_reply";
  // It hands something to another agent: the conversation goes on with that agent.
  if (message.mentionedAgentIds.length > 0) return "not_reply";
  return replyTextSkip(message.body);
}

/** Where a reaction may go: a chat channel or a DM with a person in it; never an agents-only DM. */
export function channelSkip(channel: ChannelFields | null | undefined): AgentMediaSkip | null {
  if (!channel || channel.archivedAt) return "channel";
  if (channel.kind === "channel") return null;
  if (channel.kind === "dm" && !isAgentOnlyDm(channel)) return null;
  return "channel";
}

/** Whether `message.posted` queues the judgment of this message: the free checks only. */
export function mediaCandidate(message: ReplyFields, channel: ChannelFields | null | undefined): boolean {
  return replySkip(message) === null && channelSkip(channel) === null;
}

/**
 * Queues the judgment of an agent's reply (`AGENT_MEDIA_JOB`) when the free checks pass: a job of its own, so a
 * slow or failing judgment never holds routing or anything else. Once per message.
 */
export async function enqueueAgentMedia(db: Executor, message: Message, channel: ChannelFields | null | undefined) {
  if (!mediaCandidate(message, channel)) return;
  await enqueue(db, {
    orgId: message.orgId,
    kind: AGENT_MEDIA_JOB,
    payload: { messageId: message.id },
    dedupeKey: `${AGENT_MEDIA_JOB}:${message.id}`,
    // A judgment retried much later is useless (`MEDIA_LATE_MS`): one retry for a database hiccup.
    maxAttempts: 2,
  });
}

// ── The judgment ──────────────────────────────────────────────────────────────

/** What Jev reads about the conversation (built from the database here, from labeled cases in `eval:media`). */
export interface AgentMediaInput {
  agent: { name: string; role: string };
  /** A team channel, or a direct conversation between a person and the agent. */
  where: "channel" | "dm";
  /** Up to `MEDIA_STATE_MESSAGES` messages before the reply, oldest first (`media`: a GIF or a sticker sent). */
  conversation: { from: string; kind: "person" | "agent"; text: string; media?: MessageMedia["kind"] }[];
  /** The agent's reply, as it wrote it. */
  reply: string;
  /** A personal workspace (ADR 0159): one person, maybe their family, and their agents; not a team. */
  personal?: boolean;
}

const clip = (text: string, max = MEDIA_STATE_CLIP) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The state of the judgment: the agent, the place, the conversation before the reply and the reply. Messages go
 * in as people wrote them; a GIF goes in as "a GIF", never with its title (outside text, ADR 0091 §6).
 */
export function agentMediaState(input: AgentMediaInput): Record<string, unknown> {
  return {
    agent: { name: input.agent.name, role: input.agent.role || null },
    where:
      input.where === "dm"
        ? "a direct conversation between one person and the agent"
        : input.personal
          ? "a group conversation where a person, maybe their family, and their AI agents talk"
          : "a team channel where people and AI agents talk",
    conversation: input.conversation.map((m) => ({
      from: m.from,
      kind: m.kind,
      text: clip(m.text),
      ...(m.media ? { sent: m.media === "gif" ? "a GIF" : "a sticker" } : {}),
    })),
    reply: input.reply.trim(),
  };
}

/** Is a light visual reaction right after this reply natural and welcome? The bar is the workspace's level. */
export const FITS_QUESTION: JudgeQuestion = {
  type: "noul",
  instructions:
    "`agent` is an AI teammate in a team chat. It just posted `reply` in `where`, after `conversation` (the messages before it, oldest first). Would a light visual reaction from `agent` right after its reply, one of its own animated stickers or a GIF, feel natural and welcome to the people there, the way a friendly teammate might add one?",
  criteria: {
    true: "Natural and welcome: a light, warm moment, such as a win or good news to celebrate, thanks, a friendly greeting or goodbye, or a plan everyone agreed on.",
    false:
      "Out of place: a problem, an error, a failure or bad news; a question or decision still waiting on someone; a serious, sensitive or personal subject; formal, dense or purely informational work content; a reply meant for a customer or a stranger; or any doubt.",
  },
};

/** The same in a personal workspace (ADR 0159): one of a person's own agents, not a teammate. */
export const FITS_QUESTION_PERSONAL: JudgeQuestion = {
  ...FITS_QUESTION,
  instructions:
    "`agent` is one of a person's own AI agents in their personal chat. It just posted `reply` in `where`, after `conversation` (the messages before it, oldest first). Would a light visual reaction from `agent` right after its reply, one of its own animated stickers or a GIF, feel natural and welcome to the people there, the way a friendly assistant might add one?",
};

const MOOD_INSTRUCTIONS = "Which of `agent`'s own animated stickers fits best right after `reply`?";
const GIF_INSTRUCTIONS = "Which kind of GIF fits best right after `reply`?";

/**
 * The stickers an agent may send on its own, for Jev. The order is fixed on purpose: Jev leans toward a choice's
 * first option, so the plainest one (a nod) comes first, where a lean costs least. `eval:media` measures the lean
 * by asking again with every list reversed.
 */
export const MOOD_CRITERIA = {
  deal: "A nod or a thumbs-up: agreed, done, sounds good, on it.",
  celebrate: "A celebration: a win, a launch, good news, something important finished.",
  love: "Warmth: thanks, kindness, a friendly hello or goodbye.",
  wow: "Amazement: a surprising result, something impressive.",
} as const satisfies Record<AgentMood, string>;

/** The GIF categories an agent may pick, plainest first for the same reason (`MOOD_CRITERIA`). */
export const GIF_CRITERIA = {
  ok: "OK, deal: agreed, done, sounds good.",
  thanks: "Thank you: gratitude for help or a kind word.",
  celebrate: "Celebration: a win, a launch, good news.",
  applause: "Applause: praise for someone's work or result.",
  wow: "Wow: amazement at a surprising or impressive result.",
  good_morning: "Good morning: the conversation starts the day with a greeting.",
  bye: "See you tomorrow: the conversation is wrapping up for the day.",
} as const satisfies Record<AgentGif, string>;

/**
 * The questions, exactly as production asks them: whether a reaction fits, which mood, and which GIF category
 * when a GIF may go. `reversed` (evals only) turns every option list around to measure the first-option lean.
 */
export function agentMediaQuestions(options: {
  gif: boolean;
  reversed?: boolean;
  /** A personal workspace (ADR 0159). */
  personal?: boolean;
}): Record<string, JudgeQuestion> {
  const ordered = (criteria: Record<string, string>) =>
    Object.fromEntries(options.reversed ? Object.entries(criteria).reverse() : Object.entries(criteria));
  const questions: Record<string, JudgeQuestion> = {
    fits: options.personal ? FITS_QUESTION_PERSONAL : FITS_QUESTION,
    mood: { type: "choice", instructions: MOOD_INSTRUCTIONS, criteria: ordered(MOOD_CRITERIA) },
  };
  if (options.gif) questions.gif = { type: "choice", instructions: GIF_INSTRUCTIONS, criteria: ordered(GIF_CRITERIA) };
  return questions;
}

export interface AgentMediaJudgment {
  /** Probability that a reaction right after the reply is natural and welcome. */
  fits: number;
  /** The sticker's mood; null when Jev named none of ours. */
  mood: AgentMood | null;
  /** The GIF's category (only when asked); null otherwise. */
  gif: AgentGif | null;
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

/** `promise`, or an error after `ms` (the GIF search and the judgment never hold their caller). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * One calibrated request to the judge. Throws when it fails, takes too long, or no calibrated judge can answer
 * (no Jev key): the caller sends nothing then.
 */
export async function judgeAgentMedia(
  judge: Judge,
  request: { orgId: string; agentId?: string | null; runId?: string; input: AgentMediaInput },
  options: { gif: boolean; reversed?: boolean; personal?: boolean; timeoutMs?: number },
): Promise<AgentMediaJudgment> {
  const answers = await withTimeout(
    judge.ask({
      orgId: request.orgId,
      agentId: request.agentId,
      runId: request.runId,
      kind: AGENT_MEDIA_JUDGMENT,
      // Code acts on the probability itself, so only a calibrated judge may answer.
      calibrated: true,
      state: agentMediaState(request.input),
      questions: agentMediaQuestions(options),
    }),
    options.timeoutMs ?? MEDIA_JUDGE_TIMEOUT_MS,
    "the agent media judgment",
  );
  const mood = answers.mood?.choice;
  const gif = answers.gif?.choice;
  return {
    fits: answers.fits?.noul ?? 0,
    mood: isOneOf(AGENT_STICKER_MOODS, mood) ? mood : null,
    gif: options.gif && isOneOf(AGENT_GIF_CATEGORIES, gif) ? gif : null,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The reply's conversation: its thread (the root included), or the channel's main timeline. */
const inConversation = (m: Pick<Message, "channelId" | "threadId">) =>
  and(
    eq(messages.channelId, m.channelId),
    m.threadId ? or(eq(messages.threadId, m.threadId), eq(messages.id, m.threadId)) : isNull(messages.threadId),
  );

/**
 * The run behind the reply: over, with this reply as its last word, started by a person's own message, and with no
 * GIF or sticker the agent already sent in it with its tools.
 */
async function runSkip(db: Executor, reply: Message): Promise<AgentMediaSkip | null> {
  const [run] = await db
    .select({
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      replyMessageId: agentRuns.replyMessageId,
      background: agentRuns.background,
      trigger: agentRuns.trigger,
      triggerMessageId: agentRuns.triggerMessageId,
      issueId: agentRuns.issueId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, reply.orgId), eq(agentRuns.id, reply.agentRunId as string)));
  if (!run || run.agentId !== reply.authorAgentId) return "not_reply";
  // Its final reply (`replyMessageId`, set as the run ends), not text posted on the way or a card.
  if (run.status !== "done" || run.replyMessageId !== reply.id) return "not_final";
  // A routine's background work: nobody asked for this reply.
  if (run.background) return "not_person";
  if (run.issueId) return "work";
  const trigger = await getMessage(db, reply.orgId, run.triggerMessageId);
  // A person's own message. Another agent's, a notice (a consultation's answer, a routine's report, an email
  // watch) or a routine's brief written as its creator is not a person asking now.
  if (trigger?.authorType !== "person" || !trigger.authorUserId) return "not_person";
  if (routineBriefOf(trigger.meta) || trigger.meta.background === true || trigger.meta.routine != null)
    return "not_person";
  if (trigger.meta.issueId != null) return "work";
  // A mission's thread is its work, moved by its own turns.
  if (reply.threadId && (await missionOfThread(db, reply.orgId, reply.threadId))) return "work";
  // It already sent one with its own tools (asked for it, or the moment invited it): that was its touch.
  const sent = await runMediaCount(db, {
    orgId: reply.orgId,
    id: reply.agentRunId as string,
    channelId: reply.channelId,
    createdAt: run.createdAt,
  });
  return sent > 0 ? "tool_media" : null;
}

/**
 * The conversation now, checked before the judgment and again under its lock right before posting: nothing
 * newer than the reply, no agent's sticker or GIF among its last messages, none from this agent in the channel
 * lately, and no other agent about to answer there.
 */
async function conversationSkip(db: Executor, reply: Message, at: Date): Promise<AgentMediaSkip | null> {
  const last = await db
    .select({
      id: messages.id,
      authorType: messages.authorType,
      media: sql<string | null>`${messages.meta}->'media'->>'kind'`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, reply.orgId),
        inConversation(reply),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(at.getTime() - WEEK_MS)),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MEDIA_QUIET_MESSAGES);
  // Still the conversation's last word, in the database's own order (its clock is finer than a `Date`).
  if (last[0]?.id !== reply.id) return "newer";
  if (last.some((m) => m.authorType === "agent" && m.media != null)) return "recent_media";
  const [mine] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, reply.orgId),
        eq(messages.channelId, reply.channelId),
        eq(messages.authorAgentId, reply.authorAgentId as string),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(at.getTime() - MEDIA_AGENT_GAP_MS)),
        sql`${messages.meta}->'media' is not null`,
      ),
    )
    .limit(1);
  if (mine) return "agent_gap";
  // Another agent about to answer here (brought in after this reply, or still at work): it speaks next.
  const [busy] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, reply.orgId),
        eq(agentRuns.channelId, reply.channelId),
        inArray(agentRuns.status, ["queued", "running"]),
        eq(agentRuns.background, false),
        reply.threadId
          ? eq(agentRuns.threadRootId, reply.threadId)
          : sql`${agentRuns.threadRootId} = ${agentRuns.triggerMessageId}`,
      ),
    )
    .limit(1);
  return busy ? "busy" : null;
}

/** Whether a GIF may go after this reply: the server's search now, the workspace's GIFs on, and people's GIFs here. */
const gifAllowed = (deps: AgentMediaDeps, settings: MediaSettings, reply: Message, at: Date) =>
  deps.gifs?.available() && settings.gifs ? peopleSendGifs(deps.db, reply, at) : Promise.resolve(false);

/** Whether people send GIFs in this conversation: a person's GIF among its last messages, lately. */
async function peopleSendGifs(db: Executor, reply: Message, at: Date): Promise<boolean> {
  const rows = await db
    .select({ authorType: messages.authorType, media: sql<string | null>`${messages.meta}->'media'->>'kind'` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, reply.orgId),
        inConversation(reply),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(at.getTime() - MEDIA_PEOPLE_GIFS.ms)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(MEDIA_PEOPLE_GIFS.messages);
  return rows.some((r) => r.authorType === "person" && r.media === "gif");
}

/**
 * The messages before the reply that Jev reads, oldest first, with who wrote them (notices are for agents). The
 * reply was just checked to be the conversation's last word: the rows after it in the database's order.
 */
async function conversationBefore(db: Executor, reply: Message, at: Date): Promise<AgentMediaInput["conversation"]> {
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      meta: messages.meta,
      authorType: messages.authorType,
      name: sql<string | null>`coalesce(${users.name}, ${agents.name})`,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.orgId, reply.orgId),
        inConversation(reply),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(at.getTime() - WEEK_MS)),
        sql`${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MEDIA_STATE_MESSAGES + 1);
  const own = rows.findIndex((r) => r.id === reply.id);
  const before = (own >= 0 ? rows.slice(own + 1) : rows).slice(0, MEDIA_STATE_MESSAGES);
  return before.reverse().map((r) => {
    const media = mediaOf(r.meta);
    return {
      from: r.name ?? (r.authorType === "person" ? "a person" : "an agent"),
      kind: r.authorType,
      text: r.body,
      ...(media ? { media: media.kind } : {}),
    };
  });
}

// ── The GIF ───────────────────────────────────────────────────────────────────

/** Which of the first `n` results a reply gets: fixed by its id (FNV-1a), so a retry picks the same GIF. */
export function pickGifIndex(replyId: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < replyId.length; i++) {
    h ^= replyId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % Math.max(1, Math.floor(n));
}

/** A GIF of the category Jev picked (its English query, the workspace's rating), or null: none came back. */
async function gifFor(gifs: GifProvider, category: AgentGif, rating: GifRating, replyId: string) {
  const page = await withTimeout(
    gifs.search({ query: GIF_CATEGORIES[category], rating, lang: "en", limit: MEDIA_GIF_SEARCH_LIMIT, offset: 0 }),
    GIF_SEARCH_TIMEOUT_MS,
    "the GIF search",
  );
  const found = page.gifs.filter((g) => typeof g.id === "string" && g.id !== "");
  if (found.length === 0) return null;
  const gif = found[pickGifIndex(replyId, Math.min(MEDIA_GIF_PICK_FROM, found.length))];
  if (!gif) return null;
  const media: GifMedia = {
    kind: "gif",
    provider: "giphy",
    id: gif.id,
    title: gif.title,
    width: Math.max(1, Math.round(gif.width) || 1),
    height: Math.max(1, Math.round(gif.height) || 1),
  };
  return media;
}

/** A GIF where one may go and Jev picked a category (a search that finds nothing falls back), else the sticker. */
async function chooseMedia(
  deps: AgentMediaDeps,
  reply: Message,
  settings: MediaSettings,
  judged: AgentMediaJudgment,
  gifEligible: boolean,
): Promise<MessageMedia | null> {
  if (gifEligible && judged.gif && deps.gifs?.available()) {
    const gif = await gifFor(deps.gifs, judged.gif, settings.gifRating, reply.id).catch(() => null);
    if (gif) return gif;
  }
  if (!settings.agentStickers || !judged.mood) return null;
  return { kind: "sticker", agentId: reply.authorAgentId as string, mood: judged.mood };
}

// ── The step ──────────────────────────────────────────────────────────────────

/**
 * Decides whether an agent's reply gets a sticker or a GIF after it, and posts it. The free checks and cheap
 * reads come first, each ending it: the reply's own kind and text (`replySkip`), its moment (`MEDIA_LATE_MS`);
 * the workspace's level is not `never`; stickers on or a GIF possible here; the agent's switch; the final reply
 * of a run a person started, which sent none with the agent's tools (`runSkip`); a chat channel or a person's DM
 * (`channelSkip`); the conversation (`conversationSkip`). Then one calibrated judgment, a GIF or the sticker, and
 * the conversation checked again under a lock right before posting. Never throws for the judgment or the GIF
 * search: nothing is sent then.
 */
export async function maybeSendAgentMedia(
  deps: AgentMediaDeps,
  input: { orgId: string; messageId: string },
): Promise<AgentMediaOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const skip = (reason: AgentMediaSkip): AgentMediaOutcome => ({ skipped: reason });

  const reply = await getMessage(db, input.orgId, input.messageId);
  if (!reply) return skip("not_reply");
  const free = replySkip(reply);
  if (free) return skip(free);
  if (now().getTime() - reply.createdAt.getTime() > MEDIA_LATE_MS) return skip("late");
  const agentId = reply.authorAgentId as string;
  const runId = reply.agentRunId as string;

  const settings = await mediaSettings(db, reply.orgId);
  const level = settings.agentMedia;
  if (level === "never") return skip("off");
  // Read once, and only when needed.
  let gifCheck: Promise<boolean> | null = null;
  const gifPossible = () => {
    gifCheck ??= gifAllowed(deps, settings, reply, now());
    return gifCheck;
  };
  if (!settings.agentStickers && !(await gifPossible())) return skip("nothing_to_send");

  const [agent] = await db
    .select({ name: agents.name, role: agents.role, mediaReplies: agents.mediaReplies, archivedAt: agents.archivedAt })
    .from(agents)
    .where(and(eq(agents.orgId, reply.orgId), eq(agents.id, agentId)));
  if (!agent || agent.archivedAt || !agent.mediaReplies) return skip("agent_off");

  const notAsked = await runSkip(db, reply);
  if (notAsked) return skip(notAsked);

  const channel = await getChannelCached(db, reply.orgId, reply.channelId);
  const place = channelSkip(channel);
  if (place || !channel) return skip(place ?? "channel");

  const moved = await conversationSkip(db, reply, now());
  if (moved) return skip(moved);

  const gif = await gifPossible();
  if (await standingRefusal(db, reply.orgId, agentId)) return skip("standing");
  if (!deps.judge) return skip("no_judge");

  const personal = await isPersonalWorkspace(db, reply.orgId);
  const asked: AgentMediaInput = {
    agent: { name: agent.name, role: agent.role },
    where: channel.kind === "dm" ? "dm" : "channel",
    conversation: await conversationBefore(db, reply, now()),
    reply: reply.body,
    personal,
  };
  let judged: AgentMediaJudgment;
  try {
    judged = await judgeAgentMedia(
      deps.judge,
      { orgId: reply.orgId, agentId, runId, input: asked },
      { gif, personal, timeoutMs: deps.judgeTimeoutMs },
    );
  } catch {
    // An error, a timeout, or no Jev key (a calibrated request has no fallback): nothing, quietly.
    return skip("judge_failed");
  }
  if (judged.fits < AGENT_MEDIA_THRESHOLDS[level]) return skip("unfit");

  const media = await chooseMedia(deps, reply, settings, judged, gif);
  if (!media) return skip("no_choice");

  const lockKey = `agent-media:${reply.channelId}:${reply.threadId ?? ""}`;
  const posted = await db.transaction(async (tx) => {
    // One reaction per conversation at a time: two replies judged together can't both add one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    // Someone may have written while Jev answered: the moment is theirs then.
    const meanwhile = await conversationSkip(tx, reply, now());
    if (meanwhile) return meanwhile;
    return insertMessage(tx, {
      orgId: reply.orgId,
      channelId: reply.channelId,
      threadId: reply.threadId,
      // The same agent, run and hop as the reply: it reads as part of that answer.
      author: { type: "agent", agentId, runId, hop: reply.hop },
      body: "",
      meta: { media, [MEDIA_AFTER_KEY]: reply.id },
    });
  });
  if (typeof posted === "string") return skip(posted);
  await publishMessageCreated(deps.pubsub, messageView(posted));
  return { sent: media, messageId: posted.id };
}
