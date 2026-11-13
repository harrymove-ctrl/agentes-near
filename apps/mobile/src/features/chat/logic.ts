import type {
  AgentQuestion,
  LiveConsult,
  LiveRun,
  Message,
  MessageCard,
  MessageConsultation,
  MessagePin,
  ReactionCount,
} from "@agenteschat/client";
import { agentProposalOf, costlyProposalOf, stretchCardOf } from "@agenteschat/client/lib/action-cards";
import { type ActivityEntry, barEntries, type barWords, markedPieces, markInk } from "@agenteschat/client/lib/activity";
import { splitChannelRefs } from "@agenteschat/client/lib/channel-refs";
import type { ChatStyle, ChatTextSize } from "@agenteschat/client/lib/chat-look";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import { loneIdRef, splitIdRefs } from "@agenteschat/client/lib/id-refs";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { detailsAt, MENTION, type TableAlign, tableAt } from "@agenteschat/client/lib/markdown";
import { messageMediaOf } from "@agenteschat/client/lib/media";
import {
  answeredNotices,
  isAgentOnlyNotice,
  isAnsweredNotice,
  isEventLine,
  isTalkerReply,
  type NoticeView,
  noticeOf,
  noticeView,
  settledNotices,
} from "@agenteschat/client/lib/notices";
import { replyOf } from "@agenteschat/client/lib/reply";
import { isRoutineCall, routineReplyOf } from "@agenteschat/client/lib/routines";
import { secretRequestOf } from "@agenteschat/client/lib/secret-requests";
import { usagePauseCardOf } from "@agenteschat/client/lib/usage-pause";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { type AgentColorName, gradientOf, mentionTone, mixHex } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { agentLook, previewOf } from "../shared/logic";
import { continuesReply } from "./media";

/**
 * The conversation screen's pure rules: which messages it shows and how they
 * group, what each message carries (cards from `meta`), the working line,
 * reactions, pins, the slash commands and a small Markdown reader.
 */

// ── Layout ───────────────────────────────────────────────────────────────────

/** A message row's side inset, its avatar column and the gap to the words (MessageRow, LiveRows, the queue's turn). */
export const MSG_INSET = 14;
export const MSG_AVATAR = 34;
export const MSG_GAP = 12;
/** Where a message's words start: event lines, receipts and what hangs under a message line up there. */
export const MSG_TEXT = MSG_INSET + MSG_AVATAR + MSG_GAP;
/** A `bubbles` row's own padding at its start (`lookRows.bubblesRow`). */
export const BUBBLES_INSET = 10;

/** How far a row's body stands in from the conversation's edges, at each end. */
export const ROW_BODY_INSET: Record<ChatStyle, { left: number; right: number }> = {
  left: { left: MSG_TEXT, right: 16 },
  comfortable: { left: MSG_TEXT, right: 16 },
  bubbles: { left: 48, right: 44 },
  compact: { left: 74, right: 12 },
};

interface InsetLook {
  style: ChatStyle;
  /** `RowLook.faces`: false in a DM whose sides say who spoke. */
  faces: boolean;
}

/** `ROW_BODY_INSET` in a look: a row with no face starts its body at its own padding. */
export function rowBodyInset({ style, faces }: InsetLook) {
  const inset = ROW_BODY_INSET[style];
  return faces ? inset : { ...inset, left: style === "bubbles" ? BUBBLES_INSET : MSG_INSET };
}

/**
 * Where a quiet row starts (an event pill, a receipt's line, a stopped task, the browser's card): on the messages'
 * words, or where the rows show no face, at their bodies' start, as the web's `--thread-indent`.
 */
export const quietInset = (look: InsetLook) => (look.faces ? MSG_TEXT : rowBodyInset(look).left);

/**
 * A message's words per Tamanho do texto (`textSize`, packages/client/src/lib/chat-look.ts), in points, both systems
 * alike. The system's own text size (Dynamic Type, Android's font scale) multiplies them, up to `CHAT_TEXT_MAX_SCALE`.
 * `md`, the default, is iOS's body (17 on 24), the size people read comfortably in a chat on the phone; the steps
 * around it go two points each way. Lines about 1.4 times the size.
 */
export const CHAT_TEXT: Record<ChatTextSize, { fontSize: number; lineHeight: number }> = {
  xs: { fontSize: 13, lineHeight: 18 },
  sm: { fontSize: 15, lineHeight: 21 },
  md: { fontSize: 17, lineHeight: 24 },
  lg: { fontSize: 19, lineHeight: 27 },
  xl: { fontSize: 21, lineHeight: 29 },
};
/**
 * How far the system's text size may grow a message's words and the name over them: every Android scale (up to 2) and
 * iOS's larger sizes up to its second accessibility one. Past it a row's column holds a word or two a line.
 */
export const CHAT_TEXT_MAX_SCALE = 2;
export type ChatText = (typeof CHAT_TEXT)[ChatTextSize];
/** The name over the words: a step under them, on a line that holds it (16 on 22 at the default). */
export const chatNameOf = (text: ChatText) => ({
  fontSize: text.fontSize - 1,
  lineHeight: text.lineHeight - 2,
});
/** The time beside the name, on its line: two points under the words (15 at the default), never under 11. */
export const chatTimeOf = (text: ChatText) => ({
  fontSize: Math.max(11, text.fontSize - 2),
  lineHeight: text.lineHeight - 2,
});
/** Code, inline or in its card: the mono face runs wide, so two points under the words (15 on 23 at the default). */
export const chatCodeOf = (text: ChatText) => ({
  fontSize: text.fontSize - 2,
  lineHeight: text.lineHeight - 1,
});
/**
 * A table's cell: its own variant's size moved by as many points as the step moves the words, so the default table
 * keeps its size and a larger step grows it with the words around it.
 */
export const chatCellOf = (cell: { fontSize?: number; lineHeight?: number }, text: ChatText) => {
  const by = text.fontSize - CHAT_TEXT.md.fontSize;
  return {
    fontSize: (cell.fontSize ?? text.fontSize) + by,
    lineHeight: (cell.lineHeight ?? text.lineHeight) + Math.round(by * 1.4),
  };
};

/**
 * A row in the list, `gap` under what shows above it. Its plate (a mention, a press) reaches past its content, and it
 * gives that room back, so the next row counts from what shows too.
 */
export const rowFrame = (block: number, gap: number) => ({
  paddingVertical: block,
  marginTop: gap - block,
  marginBottom: -block,
});

// ── Timeline ─────────────────────────────────────────────────────────────────

const byTime = (a: Pick<Message, "createdAt" | "id">, b: Pick<Message, "createdAt" | "id">) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

/** Top-level messages plus loaded thread replies (agents answer inside the thread of the message that called them). */
export function mergeTimeline(topLevel: Message[], threads: (Message[] | undefined)[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of topLevel) seen.set(m.id, m);
  for (const list of threads) for (const m of list ?? []) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

export const GROUP_WINDOW_MS = 5 * 60_000;

/** Same author again within 5 minutes, nothing special in between: the row drops its name and avatar. */
export function groupsWith(prev: Pick<Message, "author" | "createdAt"> | null | undefined, m: Message) {
  if (!prev) return false;
  const gap = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return prev.author.type === m.author.type && prev.author.id === m.author.id && gap >= 0 && gap < GROUP_WINDOW_MS;
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export type ChatRow =
  | { kind: "day"; key: string; iso: string }
  | {
      kind: "message";
      key: string;
      message: Message;
      grouped: boolean;
      /** The next row groups under this one (with `grouped`, its place in the run: `runPosition`). */
      continued?: boolean;
      /** The message it groups under (what hangs under that one ends the run: `runAround`). */
      above?: Message;
    };

/** A row's key: an optimistic message keeps it when the server copy (same `clientId`) replaces it. */
export const messageKey = (m: Pick<Message, "id" | "clientId">) => (m.clientId ? `c:${m.clientId}` : m.id);

/** A message that stands on its own (cards, consultations): nothing groups under it and it never groups. */
export function standsAlone(m: Message) {
  const meta = m.meta ?? {};
  return Boolean(
    meta.approvalId ||
      meta.missionPlan ||
      meta.missionReview ||
      meta.missionDecision ||
      meta.missionSetup ||
      meta.missionStart ||
      meta.missionLink ||
      meta.threadStart ||
      meta.issueWork ||
      meta.issueTaken ||
      questionOf(meta) ||
      secretRequestOf(meta) ||
      consultationsOf(meta).length > 0 ||
      routineReplyOf(m) ||
      isEventLine(meta),
  );
}

/**
 * Day dividers and messages, oldest first (the list draws them newest at the bottom). What a routine
 * found, told by its agent, stands alone with its own header; the report it answers folds into it, and a
 * routine's call written as its creator is left out, like the web's `buildTimeline`. The sticker or GIF an agent
 * adds right after its own reply (ADR 0091) always groups under that reply, whatever the reply carries.
 */
export function buildRows(
  messages: Message[],
  hidden: (m: Message) => boolean = () => false,
  /** The agents at work in this conversation: an event over once they happened is left out (`settledNotices`). */
  working: ReadonlySet<string> = new Set(),
): ChatRow[] {
  const rows: ChatRow[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  const answered = answeredNotices(messages);
  const settled = settledNotices(messages, working);
  for (const m of [...messages].sort(byTime)) {
    if (
      hidden(m) ||
      settled.has(m.id) ||
      isRoutineCall(m) ||
      isAnsweredNotice(m, answered) ||
      isAgentOnlyNotice(m.meta)
    )
      continue;
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, iso: m.createdAt });
      lastDay = day;
      prev = null;
    }
    // A fast reply while its task works keeps its header ("enquanto trabalha"), and a reply to a message starts its
    // own block under its quote, as on the web.
    const grouped =
      !replyOf(m.meta) &&
      (continuesReply(prev, m) ||
        (!standsAlone(m) && !(prev && standsAlone(prev)) && !isTalkerReply(m.meta) && groupsWith(prev, m)));
    const last = rows.at(-1);
    const above = grouped && last?.kind === "message" ? last : undefined;
    if (above) above.continued = true;
    rows.push({ kind: "message", key: messageKey(m), message: m, grouped, ...(above && { above: above.message }) });
    prev = m;
  }
  return rows;
}

// ── Automatic lines ──────────────────────────────────────────────────────────

/**
 * One quiet line instead of a voice (the web's `ChatNotices`): what reached an agent's conversation, as the shared
 * `noticeView` words it ("Rotina «X» entregou um relatório" while nobody answered it yet, "Infra respondeu"), with
 * what "Show" opens. A talker reply is never one: it shows as the agent's message (`noticeOf` leaves it out).
 */
export interface EventLineView extends NoticeView {
  kind: "notice";
  icon: "clock" | "agent" | "chat" | "check" | "bell" | "info";
}

const NOTICE_ICON: Record<string, EventLineView["icon"]> = {
  routine_handoff: "clock",
  consult_reply: "agent",
  agent_note: "chat",
  wait_result: "check",
  follow_up: "clock",
  wake_skipped: "info",
};

export function eventLineOf(
  m: Pick<Message, "body" | "meta">,
  names: { author: string; agentByHandle: (handle: string) => string | null },
  /** A follow-up's time for the reader ("18:30"), and the reader's locale for its day. */
  when: { time: (iso: string) => string; locale: string } = { time: (iso) => iso, locale: "pt-BR" },
): EventLineView | null {
  const view = noticeView(m, names, when);
  const kind = noticeOf(m.meta)?.kind ?? "";
  return view ? { ...view, kind: "notice", icon: NOTICE_ICON[kind] ?? "bell" } : null;
}

// ── What a message carries ───────────────────────────────────────────────────

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export const approvalIdOf = (meta: Message["meta"]) => str(meta?.approvalId) || null;

const STATUSES = new Set(["answered", "expired", "failed"]);

/** `meta.consulted`: the agents it asked before answering (bad entries left out). */
export function consultationsOf(meta: Message["meta"]): MessageConsultation[] {
  const list = meta?.consulted;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v): MessageConsultation[] => {
    const o = obj(v);
    if (!o || !str(o.agentId)) return [];
    const raw = str(o.status);
    const status = (STATUSES.has(raw) ? raw : "failed") as MessageConsultation["status"];
    const answer = status === "answered" && str(o.answer).trim() ? str(o.answer) : null;
    return [
      {
        agentId: str(o.agentId),
        consultationId: str(o.consultationId) || `${str(o.agentId)}:${status}`,
        status: status === "answered" && !answer ? "failed" : status,
        question: str(o.question),
        answer,
      },
    ];
  });
}

/** `meta.missionReview` / `missionDecision` / `missionDelivery`: the card's id and mission. */
export function missionCardRef(
  meta: Message["meta"],
  key: "missionDecision" | "missionReview" | "missionDelivery",
): { id: string; missionId: string } | null {
  const p = obj(meta?.[key]);
  return p && str(p.id) && str(p.missionId) ? { id: str(p.id), missionId: str(p.missionId) } : null;
}

/** `meta.missionPlan`: the plan card (Começar / Mudar algo). */
export function missionPlanOf(meta: Message["meta"]): { missionId: string; title: string; goal: string } | null {
  const p = obj(meta?.missionPlan);
  return p && str(p.missionId) ? { missionId: str(p.missionId), title: str(p.title), goal: str(p.goal) } : null;
}

/** `meta.missionLink`: the mission an agent's reply proposed, whose thread lives elsewhere. */
export function missionLinkOf(meta: Message["meta"]): { missionId: string; threadId: string } | null {
  const p = obj(meta?.missionLink);
  return p && str(p.missionId) && str(p.threadId) ? { missionId: str(p.missionId), threadId: str(p.threadId) } : null;
}

/** `meta.work`: how many tools the run used (its saved tool block shows only when it used some). */
export function workStepsOf(meta: Message["meta"]): number | null {
  const w = obj(meta?.work);
  return w && typeof w.steps === "number" && w.steps > 0 ? w.steps : null;
}

/** `meta.artifacts`: the files on a message. */
export function artifactsOf(
  meta: Message["meta"],
): { id: string; version?: number; title: string; deleted: boolean }[] {
  const list = meta?.artifacts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r) => {
    const o = obj(r);
    if (!o || !str(o.id)) return [];
    return [
      {
        id: str(o.id),
        ...(typeof o.version === "number" ? { version: o.version } : {}),
        title: str(o.title),
        deleted: o.deleted === true,
      },
    ];
  });
}

/** `meta.question`: an agent's question (`ask_user`), with its choices and, once answered, the answer. */
export function questionOf(meta: Message["meta"]): AgentQuestion | null {
  const q = obj(meta?.question);
  if (!q || !str(q.id) || !str(q.text) || !str(q.agentId)) return null;
  const choices = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === "string" && !!c) : [];
  return {
    id: str(q.id),
    agentId: str(q.agentId),
    channelId: str(q.channelId),
    threadId: str(q.threadId) || null,
    messageId: str(q.messageId) || null,
    text: str(q.text),
    choices: choices.length > 0 ? choices : null,
    status: q.status === "answered" ? "answered" : "open",
    answer: str(q.answer) || null,
    answeredByUserId: str(q.answeredByUserId) || null,
    ...(str(q.requestedForUserId) ? { requestedForUserId: str(q.requestedForUserId) } : {}),
    ...(q.withdrawn === true ? { withdrawn: true as const } : {}),
    ...(q.dismissed === true ? { dismissed: true as const } : {}),
  };
}

/** A message the person never needs to read as text (the card says it all; a question's card repeats it). */
export const hidesBody = (m: Message) =>
  Boolean(
    approvalIdOf(m.meta) ||
      secretRequestOf(m.meta) ||
      agentProposalOf(m.meta) ||
      stretchCardOf(m.meta) ||
      costlyProposalOf(m.meta) ||
      usagePauseCardOf(m.meta) ||
      m.meta?.missionStart ||
      m.meta?.threadStart ||
      m.meta?.issueWork ||
      m.meta?.browserHandoff ||
      m.meta?.missionSetup ||
      voiceOf(m.meta) ||
      questionOf(m.meta)?.text.trim() === m.body.trim(),
  );

// ── Live work ────────────────────────────────────────────────────────────────

/**
 * Who shows in the working line, as on the web's bar (`barEntries`): agents
 * asking another agent, then agents at work, one entry per agent even when it
 * has two runs (a provisional "thinking" row and the real run, or two tasks at
 * once), then the people typing.
 */
export function workingEntries(
  runs: LiveRun[],
  consults: LiveConsult[],
  agentName: (id: string) => string,
  typing: string[] = [],
  personName: (id: string) => string | undefined = () => undefined,
): ActivityEntry[] {
  return barEntries(runs, typing, agentName, personName, consults);
}

/**
 * Still working (thinking, queued, running a tool or writing): what "Parar" stops, right away, also while
 * the words arrive. A guessed "pensando…" has no run to stop yet.
 */
export const stoppableInLine = (runs: LiveRun[]) =>
  runs.filter((r) => !r.provisional && (r.status === "thinking" || r.status === "queued" || r.status === "running"));

/**
 * What the line above the composer stops with its own "Parar" (the working line, or the requests' line while it
 * takes its place): the runs I may stop of the one agent at work here. With several, the line can't say whose (the
 * box's own stop stops them all).
 */
export function lineStops(entries: ActivityEntry[], runs: LiveRun[], canStop: (run: LiveRun) => boolean): LiveRun[] {
  const agents = entries.filter((e) => e.type === "agent");
  const solo = agents.length === 1 ? agents[0] : undefined;
  return solo ? stoppableInLine(runs).filter((r) => r.agentId === solo.id && canStop(r)) : [];
}

/**
 * The one agent the working line speaks for: its run, for its step, its time and its stop. None with several agents
 * (a question it asks keeps its phrase in the line).
 */
export function awayRun(entries: ActivityEntry[], runs: LiveRun[]): LiveRun | undefined {
  const agents = entries.filter((e) => e.type === "agent");
  const solo = agents.length === 1 ? agents[0] : undefined;
  return solo ? runs.find((r) => r.agentId === solo.id) : undefined;
}

/**
 * Who may press "Parar" (the web's `useStopRun`): admins, the agent's owner,
 * or the person whose message started the run. The server checks it again.
 */
export function mayStopRun(
  run: Pick<LiveRun, "agentId" | "threadId" | "triggerMessageId">,
  who: { meId: string | null; manageAgents: boolean; agentOwnerId: string | null | undefined; messages: Message[] },
): boolean {
  if (who.manageAgents) return true;
  if (!who.meId) return false;
  if (who.agentOwnerId === who.meId) return true;
  const rootId = run.triggerMessageId ?? run.threadId;
  const root = who.messages.find((m) => m.id === rootId);
  return root?.author.type === "person" && root.author.id === who.meId;
}

/** Names in a sentence: in ink, or with the agent's face (shared with the web's `WorkingLine`). */
export const markName = markInk;

/** A marked sentence split into plain and bold (name) pieces; a faced name carries its agent's id. */
export const markedParts = markedPieces;

/** How wide the working line's pieces that can end in "…" drew their text (`onTextLayout`). */
export interface LineDrawn {
  agents?: number;
  typers?: number;
}

/** A piece only narrows: kept to what it drew, it can't draw wider, and a narrower room cuts it again. */
export const narrowDrawn = (drawn: LineDrawn, part: keyof LineDrawn, width: number): LineDrawn =>
  (drawn[part] ?? Number.POSITIVE_INFINITY) <= width ? drawn : { ...drawn, [part]: width };

/** Narrower than this, the agents' words cut short are a sliver ("A", "Th…"). */
export const AGENT_WORDS_MIN = 40;

/**
 * The widths the working line's pieces keep (whole points) while someone types: iOS keeps a cut text's whole box,
 * a gap before what follows, so each keeps to what it drew and the next piece comes right after its "…".
 * `agents: null` drops the agents' words, their " · " with them, when they'd be a sliver: who types keeps the room,
 * as on the web. Alone, the agents' words keep the line as it is (nothing follows them).
 */
export function lineFit(drawn: LineDrawn, someoneTypes: boolean): { agents?: number | null; typers?: number } {
  if (!someoneTypes) return {};
  const whole = (width?: number) => (width === undefined ? undefined : Math.ceil(width));
  const sliver = drawn.agents !== undefined && drawn.agents < AGENT_WORDS_MIN;
  return { agents: sliver ? null : whole(drawn.agents), typers: whole(drawn.typers) };
}

/** The working line's words in the pieces that give way in turn (`barWords`). */
export type LineWords = ReturnType<typeof barWords>;

/** How long the working line's phrase takes to turn (the web's `.ac-turn`). */
export const PHRASE_FADE_MS = 420;

/**
 * The working line's phrase as it turns, as on the web (TurnText): the one shown and the one leaving, the only two
 * drawn. `n` counts the turns: the phrase shown is the `n`th, the one leaving the one before it.
 */
export interface PhraseTurn {
  now: LineWords;
  was: LineWords | null;
  n: number;
  /** When the phrase shown came. */
  since: number;
}

/**
 * The phrase once the line's words are `words`, at `at`: new words turn it, the phrase shown leaving as they come in.
 * A phrase stays a whole crossfade first, so it has come all the way in before it leaves (it never flashes back to
 * full on its way out) and the one before it has gone; until then `wait` says how long, and the newest words come
 * when it ends (any in between never show).
 */
export function turnPhrase(shown: PhraseTurn, words: LineWords, at: number): { shown: PhraseTurn; wait: number } {
  if (words.join("") === shown.now.join("")) return { shown, wait: 0 };
  const wait = shown.since + PHRASE_FADE_MS - at;
  if (wait > 0) return { shown, wait };
  return { shown: { now: words, was: shown.now, n: shown.n + 1, since: at }, wait: 0 };
}

/**
 * The phrase still leaving at `at`: none under Reduce Motion, and none once its crossfade is over. A phrase that left
 * while Reduce Motion was on, or long ago, must not mount again when Reduce Motion is turned off: it would start whole,
 * over the phrase shown.
 */
export const leavingWords = (shown: PhraseTurn, reduced: boolean, at: number): LineWords | null =>
  !reduced && shown.was && at - shown.since < PHRASE_FADE_MS ? shown.was : null;

// ── Reactions ────────────────────────────────────────────────────────────────

/** The quick row in the long-press sheet. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙌", "👀"] as const;

/** `+1` / `-1` are stored by name (feedback to the agent); the pills show the emoji. */
const NAMED: Record<string, string> = { "+1": "👍", "-1": "👎" };
export const reactionEmoji = (reaction: string) => NAMED[reaction] ?? reaction;

/** What to send for an emoji: 👍 and 👎 go by name. */
export const reactionName = (emoji: string) => Object.entries(NAMED).find(([, e]) => e === emoji)?.[0] ?? emoji;

export interface ReactionPill {
  reaction: string;
  emoji: string;
  /** People who reacted (the count on the pill). */
  people: number;
  /** Agents who reacted (their faces on the pill). */
  agentIds: string[];
  mine: boolean;
}

/** People's pills show a count (mine outlined); an agent's reaction shows its face. */
export function reactionPills(reactions: ReactionCount[] | undefined, meId: string | null): ReactionPill[] {
  return (reactions ?? [])
    .map((r) => ({
      reaction: r.reaction,
      emoji: reactionEmoji(r.reaction),
      people: r.userIds.length,
      agentIds: r.agentIds ?? [],
      mine: meId ? r.userIds.includes(meId) : false,
    }))
    .filter((p) => p.people > 0 || p.agentIds.length > 0);
}

/** My bubble: a tint of the deep end of the color on the page (stronger on a dark page), or the color a step darker. */
export function bubbleFill(color: AgentColorName, tone: "light" | "strong", page: string, dark: boolean) {
  const deep = gradientOf(color)[1];
  return tone === "strong" ? mixHex(deep, "#000000", 0.18) : mixHex(page, deep, dark ? 0.3 : 0.2);
}

/**
 * A name's color in the bubbles: the deep end on a light page, the bright end on a dark one, each a step toward the
 * ink because amber, teal and an agent's own lighter colors are under AA on the bubble.
 */
export const nameInk = (color: AgentColorName, dark: boolean) => {
  const [top, deep] = gradientOf(color);
  return dark ? mixHex(top, "#ffffff", 0.15) : mixHex(deep, "#000000", 0.35);
};

/** What my row shows under its bubble (`MessageRow`'s foot, files and cards): it ends a run's look (`runAround`). */
export const hangsUnder = (
  m: Message,
  thread: boolean,
  reactions: ReactionCount[] | undefined,
  meId: string | null,
): boolean =>
  Boolean(m.local) ||
  thread ||
  Boolean(m.meta?.missionStart) ||
  reactionPills(reactions ?? m.reactions, meId).length > 0 ||
  artifactsOf(m.meta).length > 0 ||
  Boolean(messageMediaOf(m.meta)) ||
  Boolean(issueWorkOf(m.meta));

// ── Pins ─────────────────────────────────────────────────────────────────────

/** "Fixadas": one entry per message, the latest pin first (the server's order, kept even if events raced). */
export function orderPins(pins: MessagePin[]): MessagePin[] {
  const latest = new Map<string, MessagePin>();
  for (const p of pins) {
    const had = latest.get(p.messageId);
    if (!had || had.pinnedAt < p.pinnedAt) latest.set(p.messageId, p);
  }
  return [...latest.values()].sort((a, b) =>
    a.pinnedAt === b.pinnedAt
      ? b.message.createdAt.localeCompare(a.message.createdAt)
      : b.pinnedAt.localeCompare(a.pinnedAt),
  );
}

/**
 * Tapping a pin: go to it here when it lives in this timeline (this thread, or the main one), else open where it
 * lives (its thread, or the conversation's main timeline from a thread) at it.
 */
export function pinTarget(
  pin: Pick<MessagePin, "messageId" | "threadId">,
  threadId: string | null,
): { kind: "here"; messageId: string } | { kind: "open"; threadId: string | null; messageId: string } {
  const here = threadId ? pin.threadId === threadId || pin.messageId === threadId : !pin.threadId;
  return here
    ? { kind: "here", messageId: pin.messageId }
    : { kind: "open", threadId: pin.threadId, messageId: pin.messageId };
}

// ── Composer ─────────────────────────────────────────────────────────────────

/** Slash commands (English identifiers in every language). */
export const SLASH_COMMANDS = ["mission", "summary", "remind", "plan", "pause", "resume", "stop"] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export function parseSlash(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const command = m[1] as SlashCommand;
  if (!SLASH_COMMANDS.includes(command)) return null;
  return { command, arg: (m[2] ?? "").trim() };
}

/** The title of a new thread from the message it starts at: its first words. */
export function threadTitleFrom(body: string, words = 6) {
  const text = previewOf(body);
  const cut = text.split(" ").slice(0, words).join(" ");
  return cut.replace(/[.,:;!?]+$/, "");
}

/** Faces of a thread link: distinct people and agents who wrote, up to `max`. */
export function threadFaces<T extends { type: string; id: string | null }>(participants: T[], max = 2): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of participants) {
    if (!p.id) continue;
    const k = `${p.type}:${p.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length === max) break;
  }
  return out;
}

// ── Markdown (what agents write) ─────────────────────────────────────────────

export type Inline =
  | { kind: "text" | "bold" | "italic" | "code" | "mention"; text: string }
  | { kind: "link"; text: string; href: string }
  /** An internal id (`splitIdRefs`, `code` when alone in a code span): the pill of what it names, or its text as written. */
  | { kind: "id"; text: string; id: string; code?: true }
  /** `#name` (`name` lower case): a channel link when it means a channel the viewer sees, else its text. */
  | { kind: "channel"; text: string; name: string };
export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "bullet"; inline: Inline[]; ordinal: string | null }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][]; align: TableAlign[] }
  /** Closed until tapped (the shared `detailsAt`, ADR 0147): `body` is Markdown of its own. */
  | { kind: "details"; summary: Inline[]; body: string };

/** Widest a table's column gets at the default text size: a longer cell wraps inside it, at its words. */
export const TABLE_COL_MAX = 280;
export const TABLE_COL_MIN = 56;
/** Points per letter of a column's first guess, until its cells have been measured as drawn. */
const TABLE_GUESS_PER_CHAR = 8.6;
/** A cell's horizontal padding (both sides), in the guess. */
const TABLE_CELL_PAD = 24;

const cellChars = (cell: Inline[]) => cell.reduce((n, s) => n + s.text.length, 0);

/**
 * Each column's width in a chat table: as wide as its widest cell as drawn (`drawn`, measured on a copy that never
 * wraps), a guess by letters until then, between the min and the max. The max grows with the person's text size
 * (up to twice), so a larger text still fits a few words per line. A point more than measured: rounding never wraps
 * a short cell that fits.
 */
export function tableColumnWidths(
  header: Inline[][],
  rows: Inline[][][],
  drawn: Readonly<Record<number, number>>,
  fontScale = 1,
): number[] {
  const scale = Math.min(2, Math.max(1, fontScale));
  const max = TABLE_COL_MAX * scale;
  return header.map((h, col) => {
    const guess =
      Math.max(cellChars(h), ...rows.map((r) => cellChars(r[col] ?? []))) * TABLE_GUESS_PER_CHAR * scale +
      TABLE_CELL_PAD;
    const natural = drawn[col] ?? guess;
    return Math.min(max, Math.max(TABLE_COL_MIN, Math.ceil(natural) + 1));
  });
}

/** Which sides of a table scrolled sideways hide columns (`x`: the scroll, `frame`: the box, `total`: the table). */
export function tableHidden(x: number, frame: number, total: number): { left: boolean; right: boolean } {
  return { left: x > 1, right: frame > 0 && x + frame < total - 1 };
}

/** A mentioned agent's chip in its own tone (`mentionTone`); none for a person or an unknown handle. */
export function mentionTint(
  handle: string,
  agents: readonly { handle: string; previousHandles?: string[]; appearance?: unknown }[],
  scheme: "light" | "dark",
) {
  const agent = agentsByAnyHandle(agents).get(handle.toLowerCase());
  if (!agent) return undefined;
  const tone = mentionTone(agentLook(agent).color, scheme === "dark");
  return { color: tone.ink, backgroundColor: tone.background };
}

/** Internal ids, then `#channel` references, then @mentions in the words between them. */
function mentions(text: string, out: Inline[], kind: "text" | "bold" | "italic") {
  for (const piece of splitIdRefs(text)) {
    if (piece.id !== undefined) {
      out.push({ kind: "id", text: piece.text, id: piece.id });
      continue;
    }
    for (const part of splitChannelRefs(piece.text)) {
      if (part.name === undefined) atMentions(part.text, out, kind);
      else out.push({ kind: "channel", text: part.text, name: part.name });
    }
  }
}

function atMentions(text: string, out: Inline[], kind: "text" | "bold" | "italic") {
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    if (start > last) out.push({ kind, text: text.slice(last, start) });
    out.push({ kind: "mention", text: `@${match[2] ?? ""}` });
    last = start + 1 + (match[2]?.length ?? 0);
  }
  if (last < text.length) out.push({ kind, text: text.slice(last) });
}

/** Only these open from a message; anything else stays plain text. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
/** A bare address ends before trailing punctuation, and before a ")" it did not open. */
function trimUrl(url: string) {
  let end = url.length;
  const count = (ch: string) => url.slice(0, end).split(ch).length - 1;
  while (end > 0) {
    const ch = url[end - 1] ?? "";
    if (/[.,;:!?'"]/.test(ch) || (ch === ")" && count("(") < count(")"))) end--;
    else break;
  }
  return url.slice(0, end);
}

/** Words under a mark, with their bare addresses still links (`**https://…**`), as on the web. */
function marked(text: string, out: Inline[], kind: "bold" | "italic") {
  const parts = text.split(/(\bhttps?:\/\/[^\s<>`]+)/);
  for (const [i, part] of parts.entries()) {
    const url = i % 2 ? trimUrl(part) : "";
    if (url) out.push({ kind: "link", text: url, href: url });
    mentions(part.slice(url.length), out, kind);
  }
}

/** Inline marks: `code`, [links](https://…) and bare https:// addresses, **bold**, *italic* / _italic_, @mentions. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /(`[^`\n]+`)|(!?\[([^\]]*)\]\(([^)\s]*)\))|(\bhttps?:\/\/[^\s<>`]+)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    let tok = m[0];
    if (m[5]) tok = trimUrl(tok);
    if (at > last) mentions(text.slice(last, at), out, "text");
    if (m[1]) {
      const id = loneIdRef(tok.slice(1, -1));
      out.push(id ? { kind: "id", text: tok.slice(1, -1), id, code: true } : { kind: "code", text: tok.slice(1, -1) });
    } else if (m[2]) {
      // An image shows its words; a link to anything but the web or e-mail is just its words.
      const label = m[3] ?? "";
      const href = m[4] ?? "";
      if (!tok.startsWith("!") && SAFE_HREF.test(href)) out.push({ kind: "link", text: label || href, href });
      else mentions(label, out, "text");
    } else if (m[5]) out.push({ kind: "link", text: tok, href: tok });
    else if (m[6]) marked(tok.slice(2, -2), out, "bold");
    else marked(tok.slice(1, -1), out, "italic");
    last = at + tok.length;
  }
  if (last < text.length) mentions(text.slice(last), out, "text");
  return out.reduce<Inline[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === tok.kind && (tok.kind === "text" || tok.kind === "bold" || tok.kind === "italic"))
      prev.text += tok.text;
    else if (tok.text) acc.push({ ...tok });
    return acc;
  }, []);
}

/**
 * Blocks: collapsed `<details>` (outside fenced code), then in the text around them fenced code (with its language),
 * tables (the web's rule: `tableAt` from the shared parser, so a table right under a sentence is still a table),
 * headings, lists, quotes and paragraphs (lines of a paragraph keep their breaks).
 */
export function parseBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const out: Block[] = [];
  let from = 0;
  let fence = false;
  for (let n = 0; n < lines.length; n++) {
    if (/^\s*```/.test(lines[n] ?? "")) fence = !fence;
    const found = fence ? null : detailsAt(lines, n);
    if (!found) continue;
    out.push(...plainBlocks(lines.slice(from, n).join("\n")));
    out.push({ kind: "details", summary: parseInline(found.details.summary), body: found.details.body });
    from = found.next;
    n = found.next - 1;
  }
  if (from === 0) return plainBlocks(body);
  out.push(...plainBlocks(lines.slice(from).join("\n")));
  return out;
}

function plainBlocks(body: string): Block[] {
  const out: Block[] = [];
  const parts = body.split(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i] ?? "";
    // The last part may hold a block without its closing fence: it runs to the end of the text, as code.
    const last = i + 3 >= parts.length;
    const open = last ? /```([a-zA-Z0-9_+-]*)\n([\s\S]*)$/.exec(text) : null;
    if (open) {
      textBlocks(text.slice(0, open.index), out);
      const code = (open[2] ?? "").replace(/`{1,2}$/, "").replace(/\n$/, "");
      out.push({ kind: "code", lang: open[1] ?? "", text: code });
    } else textBlocks(last ? text.replace(/```[a-zA-Z0-9_+-]*$/, "") : text, out); // a fence still opening
    if (i + 2 < parts.length)
      out.push({ kind: "code", lang: parts[i + 1] ?? "", text: (parts[i + 2] ?? "").replace(/\n$/, "") });
  }
  return out;
}

function textBlocks(chunk: string, out: Block[]) {
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  const lines = chunk.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const table = tableAt(lines, n);
    if (table) {
      flush();
      const cells = (row: string[]) => row.map((c) => parseInline(c));
      out.push({
        kind: "table",
        header: cells(table.table.header),
        rows: table.table.rows.map(cells),
        align: table.table.align,
      });
      n = table.next - 1;
      continue;
    }
    const line = (lines[n] ?? "").trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", inline: parseInline(heading[1] ?? "") });
    } else if (bullet) {
      flush();
      out.push({ kind: "bullet", inline: parseInline(bullet[2] ?? ""), ordinal: bullet[1] ?? null });
    } else if (quote) {
      flush();
      out.push({ kind: "quote", inline: parseInline(quote[1] ?? "") });
    } else para.push(line);
  }
  flush();
}

/**
 * The day of the topmost row in view that has one (a day line, a message), for the floating date while the list
 * scrolls; null with none, and while the list's first row is in view: above it is the conversation's start (its
 * greeting, the setup card, the pins), which has no day for a date to float over. `prev` comes back unchanged while
 * the day is the same, so the screen's state only changes when the day does (a new timestamp per row reaching the top
 * would re-render the whole chat during a fling).
 */
export function dayInView(
  rows: readonly { index: number; item: { kind: string; iso?: string; message?: Pick<Message, "createdAt"> } }[],
  prev: string | null = null,
): string | null {
  if (rows.some((r) => r.index === 0)) return null;
  const top = [...rows]
    .sort((a, b) => a.index - b.index)
    .find(({ item }) => (item.kind === "day" && item.iso) || (item.kind === "message" && item.message));
  const next = top ? (top.item.kind === "day" ? (top.item.iso ?? null) : (top.item.message?.createdAt ?? null)) : null;
  return prev && next && dayKey(prev) === dayKey(next) ? prev : next;
}

/**
 * What seeing the end of a conversation marks read. A thread view marks only its thread: the channel's own timeline
 * isn't on screen, and reading the channel would clear its unread and mentions unseen.
 */
export const readMark = (channelId: string, threadId: string | null | undefined) =>
  threadId ? ({ kind: "thread", id: threadId } as const) : ({ kind: "channel", id: channelId } as const);

/**
 * A message link's pill before its message icon (the web's `MessageRef`): "#general ›", "@Ana ›" in a DM,
 * "#general › Thread ›" for a thread's reply.
 */
export const messageRefWords = (t: TFunction, card: MessageCard) =>
  `${card.kind === "dm" ? `@${card.name}` : `#${card.name}`}${card.threadId ? ` › ${t("messageRefs.thread")}` : ""} › `;

/** Two taps this close on a message are its double tap (the thumbs up), on its words or on a receipt under them. */
export const DOUBLE_TAP_MS = 300;
