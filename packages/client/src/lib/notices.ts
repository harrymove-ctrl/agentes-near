import type { ConsultationStatus, MessageConsultation } from "../api/types";
import { daysBetween, formatShortDate } from "./format";
import { reachOf } from "./reach";
import { routineReplyOf } from "./routines";

type Meta = Record<string, unknown> | undefined;

/** What reached the agent's conversation (packages/engine/src/notices.ts; a test keeps the two lists equal). */
export const NOTICE_KINDS = [
  "routine_handoff",
  "consult_reply",
  "agent_note",
  "wait_result",
  "talker_reply",
  "proposal_result",
  "poll_result",
  "follow_up",
  "wake_skipped",
  "work_check_in",
  "run_stopped",
  "github_event",
  "work_follow_up",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * An event an agent's conversation got (`meta.notice`): its routine's report,
 * another agent's answer or note, the late result of a wait. The agent reads
 * it as an event, never as a person's words; people see one compact line,
 * the text on demand. `from` is written for the agent ("@infra"), so the app
 * prefers its own words.
 */
export interface MessageNotice {
  kind: NoticeKind | (string & {});
  text: string;
  from: string | null;
  refs: Record<string, string>;
}

/**
 * Notices only for the agent they are for (packages/engine/src/notices.ts): another agent's note, the late result of a
 * wait, what a person decided on its proposal (its card already says it). People never see them: what matters to
 * them, the agent says in its reply.
 */
export const AGENT_ONLY_NOTICES: ReadonlySet<string> = new Set<NoticeKind>([
  "agent_note",
  "wait_result",
  "proposal_result",
  "poll_result",
  "work_check_in",
  "work_follow_up",
]);

/** A message that is a notice only its agent reads: left out of the conversation. */
export const isAgentOnlyNotice = (meta: Meta) => {
  const kind = (meta?.notice as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && AGENT_ONLY_NOTICES.has(kind);
};

/** The notice card of a message, or null (none, or a fast reply that shows as a normal message). */
export function noticeOf(meta: Meta): MessageNotice | null {
  const n = meta?.notice as { kind?: unknown; text?: unknown; from?: unknown; refs?: unknown } | undefined;
  if (!n || typeof n !== "object" || typeof n.kind !== "string" || typeof n.text !== "string") return null;
  if (n.kind === "talker_reply" || isTalkerReply(meta)) return null;
  const refs: Record<string, string> = {};
  if (n.refs && typeof n.refs === "object") {
    for (const [k, v] of Object.entries(n.refs)) if (typeof v === "string") refs[k] = v;
  }
  return { kind: n.kind, text: n.text, from: typeof n.from === "string" && n.from ? n.from : null, refs };
}

/**
 * A short reply the agent gave while its task kept working (`meta.talker`, or a `talker_reply`
 * notice): shown as its normal message, with a quiet "enquanto trabalha".
 */
export function isTalkerReply(meta: Meta): boolean {
  const talker = meta?.talker as { runId?: unknown } | undefined;
  if (talker && typeof talker === "object") return true;
  return (meta?.notice as { kind?: unknown } | undefined)?.kind === "talker_reply";
}

/** A fast reply given while its task waited (its computer, a person), not while it worked: "enquanto espera". */
export const talkerWaited = (meta: Meta) => (meta?.talker as { waiting?: unknown } | undefined)?.waiting === true;

/** The routine a report came from: the notice's refs, or the «name» in `from`. */
export function noticeRoutineName(notice: MessageNotice): string | null {
  if (notice.refs.routineName) return notice.refs.routineName;
  return notice.from?.match(/«([^»]+)»/)?.[1] ?? null;
}

/** "@infra" in `from` (or `refs.agentHandle`): the other agent's handle, to show its name. */
export function noticeAgentHandle(notice: MessageNotice): string | null {
  const handle = notice.refs.agentHandle ?? notice.from?.match(/^@([\w.-]+)$/)?.[1];
  return handle ? handle.replace(/^@/, "") : null;
}

/** `wake_skipped`: the handles an agent's mention couldn't wake (ADR 0097), for the line's names. */
export const skippedHandles = (notice: MessageNotice) => (notice.refs.agentHandles ?? "").split(",").filter(Boolean);

/** An automatic line in the conversation (a notice): nothing groups with it. */
export const isEventLine = (meta: Meta) => noticeOf(meta) !== null;

/**
 * An agent's follow-up (`follow_up`), as its line reads: the one it set ("Ari volta às 18:30 para «ver o CI»",
 * `pending` while it can still be canceled), the same once it came ("Ari voltou às 18:30…") or once canceled,
 * with its day when that isn't today ("…em 31 out às 09:00…"), and at its time the one that woke it ("Ari voltou
 * para «ver o CI»"). `about` is the agent's words, quoted in the app's sentence. `key`/`values` are the shared
 * i18n; `when.time` formats a time for the reader, in `when.locale`.
 */
export function followUpLine(
  notice: MessageNotice,
  name: string,
  when: { time: (iso: string) => string; locale: string },
  now = new Date(),
) {
  if (notice.kind !== "follow_up") return null;
  const { at = "", about = "", state, wake } = notice.refs;
  const otherDay = Boolean(at) && daysBetween(at, now) !== 0;
  const values = { name, about, time: at ? when.time(at) : "", day: otherDay ? formatShortDate(when.locale, at) : "" };
  if (wake) return { key: "chat.notice.followUpWake" as const, values, pending: false };
  if (state === "canceled")
    return {
      key: otherDay ? ("chat.notice.followUpCanceledOn" as const) : ("chat.notice.followUpCanceled" as const),
      values,
      pending: false,
    };
  if (state === "done")
    return {
      key: otherDay ? ("chat.notice.followUpDoneOn" as const) : ("chat.notice.followUpDone" as const),
      values,
      pending: false,
    };
  return {
    key: otherDay ? ("chat.notice.followUpOn" as const) : ("chat.notice.followUp" as const),
    values,
    pending: state === "pending",
  };
}

/**
 * What a person reads of a notice, on the web and the phone alike: its line (`key`/`values`) and what "Ver" opens
 * (`detail`). `notice.text` and a notice message's body are written for the agent, in English: never shown. The
 * detail is the app's own words built from the refs (`words`), or what the notice carried that people wrote or asked
 * for (`content`: a routine's report, another agent's own answer, what someone wrote on GitHub); null when the line
 * says it all.
 */
export interface NoticeView {
  key: string;
  values: Record<string, string>;
  detail: { words: { key: string; values: Record<string, string> } } | { content: string } | null;
  /** A follow-up still to come: it can be canceled. */
  pending: boolean;
  /** Someone the agent doesn't answer wrote it on GitHub: a person here may ask the agent to answer ("Pedir resposta"). */
  answer: boolean;
}

/** A GitHub event's line (packages/engine/src/git/github-events.ts), by what happened and to which kind of item. */
export function githubLineKey(r: Record<string, string>) {
  const issue = r.item === "issue";
  const discussion = r.item === "discussion";
  switch (r.event) {
    case "comment":
      return issue
        ? "chat.notice.github.commentIssue"
        : discussion
          ? "chat.notice.github.commentDiscussion"
          : "chat.notice.github.comment";
    case "opened":
      return "chat.notice.github.opened";
    case "review":
      return r.state === "approved"
        ? "chat.notice.github.approved"
        : r.state === "changes_requested"
          ? "chat.notice.github.changes"
          : "chat.notice.github.reviewed";
    case "review_requested":
      return "chat.notice.github.reviewRequested";
    case "merged":
      return "chat.notice.github.merged";
    case "closed":
      return issue ? "chat.notice.github.closedIssue" : "chat.notice.github.closed";
    default:
      return "chat.notice.other";
  }
}

export function noticeView(
  m: { body: string; meta?: Meta | null },
  names: { author: string; agentByHandle: (handle: string) => string | null },
  when: { time: (iso: string) => string; locale: string },
  now = new Date(),
): NoticeView | null {
  const notice = noticeOf(m.meta ?? undefined);
  if (!notice) return null;
  const line = (key: string, values: Record<string, string> = {}, detail: NoticeView["detail"] = null) => ({
    key,
    values,
    detail,
    pending: false,
    answer: false,
  });
  const kind = notice.kind as NoticeKind;
  switch (kind) {
    case "routine_handoff": {
      const routine = noticeRoutineName(notice);
      // The report is what the routine found for people: the same words the agent's reply unfolds.
      const report = m.body.trim() || notice.text.trim();
      const detail = report ? { content: report } : null;
      return routine
        ? line("chat.notice.routineHandoff", { routine }, detail)
        : line("chat.notice.routineHandoffAnon", {}, detail);
    }
    case "consult_reply": {
      const handle = noticeAgentHandle(notice);
      // `from` is written for the agent ("@infra"): the app says the agent's name, without the @.
      const from = handle ? (names.agentByHandle(handle) ?? handle) : null;
      const answer = notice.refs.answer?.trim();
      const detail = answer ? { content: answer } : null;
      return from
        ? line("chat.notice.consultReply", { from }, detail)
        : line("chat.notice.consultReplyAnon", {}, detail);
    }
    case "follow_up": {
      const followUp = followUpLine(notice, names.author, when, now);
      return followUp ? { ...line(followUp.key, followUp.values), pending: followUp.pending } : null;
    }
    case "wake_skipped": {
      const agents = skippedHandles(notice)
        .map((h) => names.agentByHandle(h) ?? h)
        .join(", ");
      if (!agents) return line("chat.notice.wakeSkippedAnon", { name: names.author });
      const values = { name: names.author, agents };
      // No app words name this cause (the agent has no AI connected): the line says who wasn't reached and stops.
      if (notice.refs.reason === "no_ai") return line("chat.notice.wakeSkipped", values);
      const why =
        notice.refs.reason === "callable" ? "chat.notice.wakeSkippedCallable" : "chat.notice.wakeSkippedAudience";
      return line("chat.notice.wakeSkipped", values, { words: { key: why, values } });
    }
    // Only their agent reads these (`AGENT_ONLY_NOTICES`), a fast reply is the agent's own message, a stopped task
    // has its own pill: a person never gets a line of them here. Their words, if they ever show, are the app's.
    case "agent_note": {
      const handle = noticeAgentHandle(notice);
      const from = handle ? (names.agentByHandle(handle) ?? handle) : null;
      return from ? line("chat.notice.agentNote", { from }) : line("chat.notice.agentNoteAnon");
    }
    case "wait_result":
      return line("chat.notice.waitResult", { name: names.author });
    // What happened on GitHub: "Ver" opens what they wrote there and the link. Once someone asked the agent to answer
    // a stranger, the new notice says who asked.
    case "github_event": {
      const r = notice.refs;
      const values = {
        who: r.who ?? r.login ?? "",
        number: r.number ?? "",
        repo: r.repo ?? "",
        name: names.author,
        asker: r.asker ?? "",
      };
      const said = [notice.text.trim(), r.url ?? ""].filter(Boolean).join("\n\n");
      const detail = said ? { content: said } : null;
      if (r.answerFor) return line("chat.notice.github.asked", values, detail);
      return { ...line(githubLineKey(r), values, detail), answer: r.outside === "1" && !r.answeredBy };
    }
    case "proposal_result":
    case "poll_result":
    case "work_check_in":
    case "work_follow_up":
    case "talker_reply":
    case "run_stopped":
      return line("chat.notice.other", { name: names.author });
    default:
      kind satisfies never;
      return line("chat.notice.other", { name: names.author });
  }
}

/**
 * Notices that only matter while they happen, left out of the conversation once over (the agent's message says the
 * rest): a follow-up that came (its line now past, and the notice that woke the agent once its turn is over: the
 * agent said something after it there, or something else came after it while the agent isn't at work, `working`
 * holding the agents at work here), and an @mention that couldn't wake an agent when the message that named it is
 * here with its own line about it (`meta.reach`). A follow-up still to come or canceled stays.
 */
export function settledNotices(
  messages: readonly {
    id: string;
    threadId: string | null;
    author: { type: string; id: string | null };
    createdAt: string;
    meta?: Meta | null;
  }[],
  working: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  const byId = new Map(messages.map((m) => [m.id, m]));
  // The latest message that isn't a notice, by place, and by place and agent.
  const latest = new Map<string, string>();
  for (const m of messages) {
    if (noticeOf(m.meta ?? undefined)) continue;
    const place = m.threadId ?? "";
    for (const key of [place, `${place}|${m.author.type === "agent" ? m.author.id : ""}`])
      if ((latest.get(key) ?? "") < m.createdAt) latest.set(key, m.createdAt);
  }
  for (const m of messages) {
    const notice = noticeOf(m.meta ?? undefined);
    if (!notice) continue;
    if (notice.kind === "follow_up") {
      if (notice.refs.state === "done") out.add(m.id);
      else if (notice.refs.wake && m.author.id) {
        const place = m.threadId ?? "";
        const said = (latest.get(`${place}|${m.author.id}`) ?? "") > m.createdAt;
        const after = (latest.get(place) ?? "") > m.createdAt;
        if (said || (after && !working.has(m.author.id))) out.add(m.id);
      }
    } else if (notice.kind === "wake_skipped") {
      const named = byId.get(notice.refs.messageId ?? "");
      const told = new Set(reachOf(named?.meta).map((e) => e.handle.toLowerCase()));
      const handles = skippedHandles(notice);
      if (handles.length > 0 && handles.every((h) => told.has(h.toLowerCase()))) out.add(m.id);
    }
  }
  return out;
}

const CONSULTATION_STATUSES: ReadonlySet<string> = new Set<ConsultationStatus>(["answered", "expired", "failed"]);

/**
 * Another agent's answer that carries its consultation (`consult_reply` refs: who asked whom, the question and
 * the answer apart, and `kind` `note` for work handed off): the app shows it as the consultation card, not the
 * text written for the asking agent. Null for older notices without them.
 */
export function consultationOfNotice(meta: Meta): { askerId: string; consultation: MessageConsultation } | null {
  const notice = noticeOf(meta);
  const r = notice?.kind === "consult_reply" ? notice.refs : null;
  if (!r?.askerAgentId || !r.agentId || !r.question || !r.status || !CONSULTATION_STATUSES.has(r.status)) return null;
  return {
    askerId: r.askerAgentId,
    consultation: {
      agentId: r.agentId,
      consultationId: r.consultationId ?? "",
      ...(r.kind === "note" ? { kind: "note" as const } : {}),
      status: r.status as ConsultationStatus,
      question: r.question,
      answer: r.answer ?? null,
    },
  };
}

type Said = { id: string; author: { type: string }; body: string; meta?: Record<string, unknown> };

/**
 * The routine reports the agent already told people about (ADR 0053 §7): the `noticeId` of every agent
 * message that answers one. Such a `routine_handoff` notice folds into that message (hidden in the
 * timeline); a report nobody answered still shows as its compact line.
 */
export function answeredNotices(messages: readonly Said[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    const noticeId = routineReplyOf(m)?.noticeId;
    if (noticeId) out.add(noticeId);
  }
  return out;
}

/** A routine report answered by an agent's message in `answered`: left out of the timeline. */
export const isAnsweredNotice = (m: Pick<Said, "id" | "meta">, answered: ReadonlySet<string>) =>
  answered.has(m.id) && noticeOf(m.meta)?.kind === "routine_handoff";

/** The report a routine's message answers (its notice's text), when that notice is loaded here. */
export function routineReportText(messages: readonly Said[], noticeId: string | null): string | null {
  if (!noticeId) return null;
  const found = messages.find((m) => m.id === noticeId);
  const notice = found ? noticeOf(found.meta) : null;
  if (!found || !notice) return null;
  return found.body.trim() || notice.text.trim() || null;
}

/**
 * A person stopped one of the agent's tasks (ADR 0128): the line "Você parou esta tarefa · Dev foi avisado", with the
 * reason when one was said. `runId` lets who stopped it add a reason later ("Dizer por quê").
 */
export interface StoppedNotice {
  runId: string;
  byUserId: string;
  byName: string;
  label: string;
  was: "working" | "waiting" | "queued";
  reason: string | null;
}

export function stoppedNoticeOf(meta: Meta): StoppedNotice | null {
  const n = meta?.notice as { kind?: unknown; refs?: Record<string, unknown> } | undefined;
  if (n?.kind !== "run_stopped" || !n.refs) return null;
  const r = n.refs;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (!s(r.runId)) return null;
  const was = r.was === "working" || r.was === "queued" ? r.was : "waiting";
  return {
    runId: s(r.runId),
    byUserId: s(r.byUserId),
    byName: s(r.byName),
    label: s(r.label),
    was,
    reason: s(r.reason) || null,
  };
}
