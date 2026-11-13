import type { MessageConsultation, RunConsultation } from "../api/types";
import { noticeOf } from "./notices";

/**
 * The questions an agent asked other agents in one turn, and the work it handed them, drawn as one slim row right
 * before the reply of that turn: the two faces with ⇄ between them and how long it took, several consulted agents
 * folded into the same row (ADR 0034, ADR 0095). What they said opens only on a click. The answers also arrive as
 * `consult_reply` notices; the ones a reply close by already stands for fold away (`consultNoticeFolds`), and the
 * working line leaves out what such a row already says (`consultsForLine`).
 */

/**
 * Where one question is. `waiting`: the consulted agent waits on a person; `offline`: for its computer or its AI
 * provider to come back (still out, paused, on no one); `handedOn`: its part done, it waits on agents it handed
 * some to.
 */
export type ConsultLineState = "working" | "waiting" | "offline" | "handedOn" | "answered" | "failed" | "expired";

/** Reloads the list this often while a question is out (a consulted agent that stops waiting sends no event). */
export const CONSULT_GROUP_POLL_MS = 10_000;

/** An opened question reloads this often while it's out: its agents' DM sends the page no events. */
export const CONSULT_CONVERSATION_POLL_MS = 4_000;

export function consultLineState(
  c: Pick<RunConsultation, "status" | "answer" | "expiresAt" | "waiting">,
  now: number,
): ConsultLineState {
  if (c.status === "answered") return c.answer?.trim() ? "answered" : "failed";
  if (c.status === "failed") return "failed";
  if (c.status === "expired") return "expired";
  // Past its deadline the worker closes it within a minute: show it as it will be.
  if (Date.parse(c.expiresAt) < now) return "expired";
  if (c.waiting === "computer" || c.waiting === "outage") return "offline";
  if (c.waiting === "agents") return "handedOn";
  return c.waiting ? "waiting" : "working";
}

const isNote = (c: Pick<RunConsultation, "kind">) => c.kind === "note";

/** A question's words by its state, in the panel and on the phone's screen ("A Iris espera uma aprovação"). */
export function consultLineKey(state: ConsultLineState, c: Pick<RunConsultation, "waiting" | "kind">) {
  switch (state) {
    case "working":
      return "chat.consultGroup.working" as const;
    case "waiting":
      return c.waiting === "approval"
        ? ("chat.consultGroup.waitingApproval" as const)
        : ("chat.consultGroup.waitingInput" as const);
    case "offline":
      return c.waiting === "outage"
        ? ("chat.consultGroup.waitingProvider" as const)
        : ("chat.consultGroup.waitingComputer" as const);
    case "handedOn":
      return "chat.consultGroup.waitingAgents" as const;
    case "answered":
      return "chat.consultation.answered" as const;
    case "expired":
      return "chat.consultation.expired" as const;
    default:
      return isNote(c) ? ("chat.consultation.failedNote" as const) : ("chat.consultation.failed" as const);
  }
}

/** Over the asking agent's words: what it asked, or what it handed off ("Theo escreveu"). */
export const consultAskedKey = (c: Pick<RunConsultation, "kind">) =>
  isNote(c) ? ("chat.consultation.wrote" as const) : ("chat.consultation.asked" as const);

/** Where the opened conversation came from, in a channel or a DM. */
export const consultOriginKey = (c: Pick<RunConsultation, "kind">, inChannel: boolean) =>
  isNote(c)
    ? inChannel
      ? ("chat.consultPanel.originNote" as const)
      : ("chat.consultPanel.originNoteDm" as const)
    : inChannel
      ? ("chat.consultPanel.origin" as const)
      : ("chat.consultPanel.originDm" as const);

/**
 * Questions and hand-offs between the same two agents, either way, this close are one exchange: one asked before the
 * last one ended, or within this after it. An exchange draws one row and opens one conversation.
 */
export const EXCHANGE_GAP_MS = 5 * 60_000;

type Exchangeable = Pick<
  RunConsultation,
  "id" | "runId" | "agentId" | "consultedAgentId" | "status" | "createdAt" | "answeredAt"
>;

/** Each question's exchange, by question id: the exchange's first question. */
function exchangeRoots(list: readonly Exchangeable[]): Map<string, Exchangeable> {
  const out = new Map<string, Exchangeable>();
  const current = new Map<string, { root: Exchangeable; end: number }>();
  for (const c of [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    const pair = [c.agentId, c.consultedAgentId].sort().join(" ");
    const at = Date.parse(c.createdAt);
    const end = c.answeredAt ? Date.parse(c.answeredAt) : c.status === "open" ? Number.POSITIVE_INFINITY : at;
    const open = current.get(pair);
    if (open && at <= open.end + EXCHANGE_GAP_MS) {
      open.end = Math.max(open.end, end);
      out.set(c.id, open.root);
    } else {
      current.set(pair, { root: c, end });
      out.set(c.id, c);
    }
  }
  return out;
}

/**
 * The conversation's questions as their rows draw them: each under the run of its exchange's first question, so the
 * reply of that run shows one row for the whole exchange (its time from the first ask to the last answer) and the
 * other runs' replies show none.
 */
export function asExchanges<T extends Exchangeable>(list: readonly T[]): T[] {
  const roots = exchangeRoots(list);
  return list.map((c) => {
    const runId = roots.get(c.id)?.runId ?? c.runId;
    return runId === c.runId ? c : { ...c, runId };
  });
}

/** The questions of `id`'s exchange, oldest first: the conversation its row opens. */
export function exchangeIds(list: readonly Exchangeable[], id: string): string[] {
  const roots = exchangeRoots(list);
  const root = roots.get(id);
  if (!root) return [id];
  return list
    .filter((c) => roots.get(c.id) === root)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((c) => c.id);
}

/** The conversation's questions by the run that asked them, each run's oldest first. */
export function groupsByRun(list: readonly RunConsultation[]): Map<string, RunConsultation[]> {
  const out = new Map<string, RunConsultation[]>();
  for (const c of list) {
    const group = out.get(c.runId);
    if (group) group.push(c);
    else out.set(c.runId, [c]);
  }
  for (const group of out.values()) group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out;
}

export interface ConsultGroupSummary {
  total: number;
  /** Answered, failed or expired. */
  closed: number;
  answered: number;
  /** Some question is still out: the row counts what came back. */
  open: boolean;
  /** Some consulted agent waits on a person (one waiting for its computer doesn't count). */
  waiting: boolean;
}

export function consultGroupSummary(
  group: readonly Pick<RunConsultation, "status" | "answer" | "expiresAt" | "waiting">[],
  now: number,
): ConsultGroupSummary {
  let closed = 0;
  let answered = 0;
  let waiting = false;
  for (const c of group) {
    const s = consultLineState(c, now);
    if (s === "answered") answered++;
    if (s === "answered" || s === "failed" || s === "expired") closed++;
    if (s === "waiting") waiting = true;
  }
  return { total: group.length, closed, answered, open: closed < group.length, waiting };
}

/**
 * One question as the pair row reads it: the run's list has it whole; a reply's `meta.consulted` entry or an
 * answer's notice is closed and carries no times (`pairItemOf`).
 */
export type ConsultPairItem = Pick<
  RunConsultation,
  "id" | "kind" | "consultedAgentId" | "status" | "waiting" | "question" | "answer" | "expiresAt"
> & { agentId?: string; createdAt: string | null; answeredAt: string | null };

export const pairItemOf = (c: MessageConsultation): ConsultPairItem => ({
  id: c.consultationId,
  kind: c.kind,
  consultedAgentId: c.agentId,
  status: c.status,
  waiting: null,
  question: c.question,
  answer: c.answer,
  expiresAt: "",
  createdAt: null,
  answeredAt: null,
});

/** The short word after the names while one question is out ("perguntando 42 s"). */
function pairOpenKey(state: ConsultLineState, c: ConsultPairItem) {
  switch (state) {
    case "waiting":
      return c.waiting === "approval"
        ? ("chat.consultPair.waitingApproval" as const)
        : ("chat.consultPair.waitingInput" as const);
    case "offline":
      return c.waiting === "outage"
        ? ("chat.consultPair.waitingProvider" as const)
        : ("chat.consultPair.waitingComputer" as const);
    case "handedOn":
      return "chat.consultPair.handedOn" as const;
    default:
      return isNote(c) ? ("chat.consultPair.working" as const) : ("chat.consultPair.asking" as const);
  }
}

export interface ConsultPair {
  /** The consulted agents, each once, in the order asked; `off`: it didn't answer (its face dims). */
  faces: { agentId: string; off: boolean }[];
  /** The question a click opens: the first still out, else the first. */
  opens: string;
  /** What the slot after the names says, if anything: "perguntando", "1 de 3", "não respondeu". */
  word: {
    key:
      | ReturnType<typeof pairOpenKey>
      | "chat.consultGroup.progress"
      | "chat.consultPair.noAnswer"
      | "chat.consultPair.notFinished"
      | "chat.consultPair.someAnswered";
    values?: { done: number; total: number };
  } | null;
  /** `live`: some question is still out (accent, the clock ticks); `bad`: some went unanswered. */
  tone: "live" | "bad" | null;
  /** How long it took, or has been out while live; null without times (a reply's `meta.consulted`). */
  seconds: number | null;
}

/**
 * The pair row of a run's questions: "Theo ⇄ Atlas · 2 min", "Theo ⇄ Atlas e mais 2 · 1 de 3 42 s". `askerId`: the
 * row's asker; in an exchange the other agent may have asked it too, and its face is still the other agent's.
 */
export function consultPair(group: readonly ConsultPairItem[], now: number, askerId?: string): ConsultPair | null {
  const first = group[0];
  if (!first) return null;
  const states = group.map((c) => consultLineState(c, now));
  const closed = (s: ConsultLineState) => s === "answered" || s === "failed" || s === "expired";
  const other = (c: ConsultPairItem) =>
    askerId && c.agentId && c.consultedAgentId === askerId ? c.agentId : c.consultedAgentId;
  const off = new Map<string, boolean>();
  group.forEach((c, i) => {
    off.set(other(c), states[i] === "failed" || states[i] === "expired");
  });
  const faces = [...off].map(([agentId, o]) => ({ agentId, off: o }));
  const summary = consultGroupSummary(group, now);
  const starts = group.map((c) => (c.createdAt ? Date.parse(c.createdAt) : Number.NaN));
  const start = Math.min(...starts);
  const out = group.findIndex((_, i) => !closed(states[i] ?? "answered"));
  const opens = group[out]?.id ?? first.id;
  if (summary.open) {
    const state = states[0] ?? "working";
    return {
      faces,
      opens,
      word:
        group.length === 1
          ? { key: pairOpenKey(state, first) }
          : { key: "chat.consultGroup.progress", values: { done: summary.closed, total: summary.total } },
      tone: "live",
      seconds: Number.isNaN(start) ? null : Math.max(1, Math.round((now - start) / 1000)),
    };
  }
  const ends = group.map((c) => (c.answeredAt ? Date.parse(c.answeredAt) : Number.NaN));
  const end = Math.max(...ends);
  const seconds = Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(1, Math.round((end - start) / 1000));
  if (summary.answered === summary.total) return { faces, opens, word: null, tone: null, seconds };
  return {
    faces,
    opens,
    word:
      group.length === 1
        ? { key: isNote(first) ? "chat.consultPair.notFinished" : "chat.consultPair.noAnswer" }
        : { key: "chat.consultPair.someAnswered", values: { done: summary.answered, total: summary.total } },
    tone: "bad",
    seconds: null,
  };
}

/**
 * The questions a reply in view shows: those of runs with a message (or a live row) loaded here. A notice
 * whose asking reply isn't loaded (further up, not paged in yet) keeps its own row, so no answer goes unseen.
 */
export function shownConsultations(
  list: readonly RunConsultation[],
  runsInView: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(list.flatMap((c) => (runsInView.has(c.runId) ? [c.id] : [])));
}

/** A `consult_reply` notice whose question a reply here already shows with its answer: not drawn again. */
export function foldsNotice(meta: Record<string, unknown> | undefined, shown: ReadonlySet<string>): boolean {
  const notice = noticeOf(meta);
  if (notice?.kind !== "consult_reply") return false;
  const id = notice.refs.consultationId;
  return Boolean(id && shown.has(id));
}

/**
 * How many rows away the reply that asked may sit and still stand in for the rest: an answer's notice that close
 * to it folds away, and with it among the last rows the working line doesn't repeat its questions. About what a
 * phone shows above the box: farther up, a person reading the newest messages doesn't see the row.
 */
export const CONSULT_NEAR_ROWS = 3;

/** A row of the conversation as drawn, in order: a message (a notice too). */
export interface ConsultRow {
  id: string;
  agentRunId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * How an answer's `consult_reply` notice draws: not at all (the reply that asked is close and shows the answer),
 * one line leading to that reply when it is farther up ("Atlas respondeu à pergunta da Ada · Ver": the answer
 * arriving still leaves a sign where the person reads), or its own row when that reply isn't here.
 */
export type ConsultNoticeFold =
  | { fold: "hide" }
  | { fold: "card" }
  | {
      fold: "line";
      consultation: RunConsultation;
      /** The asking run's message nearest the notice: "Ver" goes there and opens the row. */
      messageId: string;
    };

const NO_RUNS: ReadonlySet<string> = new Set();

/**
 * Where each asking run sits among the rows people see. A notice whose answer a reply here shows takes no row
 * (hidden, or one line): answers to several questions in a row don't push their reply away.
 */
/**
 * Which of a run's messages draws its row: the web draws it on the run's last message, the phone on its first
 * (its rows don't know their neighbours, `firstOfRun`). Distances and "Ver" go to that one message.
 */
export type ConsultAnchor = "first" | "last";

function consultLayout(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string>,
  anchor: ConsultAnchor,
) {
  const byId = new Map(list.map((c) => [c.id, c] as const));
  const shown = shownConsultations(list, new Set([...live, ...rows.flatMap((r) => r.agentRunId ?? [])]));
  /** Each run's rows: its place among the rows people see, and the message. */
  const places = new Map<string, { at: number; id: string }[]>();
  /** Answers' notices, each between the rows `at - 1` and `at`; `consultation` null: it draws its own row. */
  const notices: { id: string; at: number; consultation: RunConsultation | null }[] = [];
  let count = 0;
  for (const row of rows) {
    const notice = noticeOf(row.meta);
    if (notice?.kind === "consult_reply") {
      const consultation = byId.get(notice.refs.consultationId ?? "") ?? null;
      const folds = consultation !== null && foldsNotice(row.meta, shown);
      notices.push({ id: row.id, at: count, consultation: folds ? consultation : null });
      if (folds) continue;
    }
    if (row.agentRunId) {
      const own = places.get(row.agentRunId);
      if (own) own.push({ at: count, id: row.id });
      else places.set(row.agentRunId, [{ at: count, id: row.id }]);
    }
    count++;
  }
  // Only the message that draws the row counts: a run that posted several shows its questions on one of them.
  for (const [runId, own] of places) {
    const one = anchor === "first" ? own[0] : own.at(-1);
    if (one) places.set(runId, [one]);
  }
  return { count, places, notices };
}

/**
 * How each answer's notice draws here (every `consult_reply` row, by message id). `rows`: the conversation's
 * messages in order; `live`: the runs drawn as live rows under them (at the end, where the newest answers land:
 * their notices fold); `anchor`: the run's message that draws its row. Close is `CONSULT_NEAR_ROWS` rows at most,
 * on either side.
 */
export function consultNoticeFolds(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string> = NO_RUNS,
  anchor: ConsultAnchor = "last",
): Map<string, ConsultNoticeFold> {
  const out = new Map<string, ConsultNoticeFold>();
  const { places, notices } = consultLayout(rows, list, live, anchor);
  for (const n of notices) {
    const c = n.consultation;
    if (!c) {
      out.set(n.id, { fold: "card" });
      continue;
    }
    if (live.has(c.runId)) {
      out.set(n.id, { fold: "hide" });
      continue;
    }
    let near: { distance: number; id: string } | null = null;
    for (const p of places.get(c.runId) ?? []) {
      const distance = p.at < n.at ? n.at - p.at : p.at - n.at + 1;
      if (!near || distance < near.distance) near = { distance, id: p.id };
    }
    if (!near) out.set(n.id, { fold: "card" });
    else if (near.distance <= CONSULT_NEAR_ROWS) out.set(n.id, { fold: "hide" });
    else out.set(n.id, { fold: "line", consultation: c, messageId: near.id });
  }
  return out;
}

/**
 * The asking runs whose row shows their questions near the end of the conversation, right above the working
 * line: a reply among the last `CONSULT_NEAR_ROWS` rows, or a live row.
 */
export function consultBlocksNearEnd(
  rows: readonly ConsultRow[],
  list: readonly RunConsultation[],
  live: ReadonlySet<string> = NO_RUNS,
  anchor: ConsultAnchor = "last",
): Set<string> {
  const asked = new Set(list.map((c) => c.runId));
  const out = new Set([...live].filter((runId) => asked.has(runId)));
  const { count, places } = consultLayout(rows, list, live, anchor);
  for (const [runId, own] of places) {
    const last = own.at(-1);
    if (asked.has(runId) && last && count - last.at <= CONSULT_NEAR_ROWS) out.add(runId);
  }
  return out;
}

/**
 * The live questions the working line still says ("Dev está perguntando ao Infra… 0:41"): not those of a run whose
 * row, near the end, shows every question with where it is and its clock. The asker's own work stays on the
 * line. With the reply farther up or not loaded, the line is the only sign that a question is out.
 */
export function consultsForLine<T extends { runId: string }>(live: T[], blocks: ReadonlySet<string>): T[] {
  return blocks.size === 0 ? live : live.filter((c) => !blocks.has(c.runId));
}

/** A stored card's id that opens the two agents' conversation: not the stand-in `consultationsOf` makes for none. */
export const openableConsultation = (id: string | null | undefined) => (id && !id.includes(":") ? id : null);

/** Seconds since the question went out (while open) or until it closed. */
export function consultSeconds(c: RunConsultation, now: number): number {
  const end = c.answeredAt ? Date.parse(c.answeredAt) : now;
  return Math.max(0, Math.round((end - Date.parse(c.createdAt)) / 1000));
}

/**
 * The reply that shows its run's questions when a run posted several (the phone's rows don't know their
 * neighbours): the run's first message, which stays first as later ones arrive.
 */
export function firstOfRun(
  messages: readonly { id: string; agentRunId?: string | null; createdAt: string }[],
  runId: string,
): string | null {
  let first: { id: string; createdAt: string } | null = null;
  for (const m of messages)
    if (m.agentRunId === runId && (!first || Date.parse(m.createdAt) < Date.parse(first.createdAt))) first = m;
  return first?.id ?? null;
}

/**
 * Where "Ver" on an answer's line goes on the phone: the message that draws the asking run's row (its first,
 * `firstOfRun`), not the run's message nearest the notice when the run posted several; that one if none of the
 * run's messages is among `messages`.
 */
export function consultLineTarget(
  messages: readonly { id: string; agentRunId?: string | null; createdAt: string }[],
  fold: Extract<ConsultNoticeFold, { fold: "line" }>,
): string {
  return firstOfRun(messages, fold.consultation.runId) ?? fold.messageId;
}
