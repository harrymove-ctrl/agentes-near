import {
  type Message,
  type MessageReceipt,
  type ReceiptPhase,
  type ReceiptsState,
  receiptTicks,
  receiptView,
  type SteerPhase,
  type SteerState,
  steerWords,
} from "@agenteschat/client";
import { listNames } from "@agenteschat/client/lib/activity";
import { isEventLine } from "@agenteschat/client/lib/notices";
import type { TFunction } from "i18next";

/**
 * The agents' receipt of a person's message, the phone's way: on the latest one only (the web marks every message
 * with a check and a popover). Faces of the agents it is about, a small mark, and words: who saw it, a wait, a
 * failure, nobody or no AI, and while the author's own plan picks who answers. A receipt never takes a line of its
 * own: it is a mark beside the message (`markOf`): the clock, one tick or two (`receiptTicks`), its words its label,
 * except what asks something of you (send it again, connect an AI) and what nobody can act on (the AI provider being
 * down, the plan or budget to renew), which keep their line under the message, as on the web. "Nobody will answer" and "No one replied" (every agent it was for passed) are
 * two ticks whose sheet says it, with "Chamar um agente". Pure, so it is tested; the state itself is the shared `receipts.ts` (seeded from the lists, moved
 * by the channel's events).
 */

/** The small mark: the clock (nobody picked it up yet), one tick (an agent is on it), two (everyone acted), none. */
export type ReceiptMark = "clock" | "check" | "checks" | "none";

export interface ReceiptLine {
  /** The agents whose faces show (at most `FACES`), and how many more there are. */
  faces: string[];
  more: number;
  mark: ReceiptMark;
  /** The words, an i18n key and the agents it names (`names` / `count`); null: faces and the mark only. */
  words: { key: ReceiptWords; agents: string[] } | null;
  /** The words for a screen reader when the line shows none (`receipts.picked`, …). */
  label: { key: ReceiptWords; agents: string[] };
  /** What a tap on the line's own button does: send it again, or connect an AI. */
  action: "retry" | "connect" | null;
  /** A failure or no AI reads in the danger tone. */
  alert: boolean;
}

export type ReceiptWords =
  | "receipts.seenBy"
  | "receipts.picked"
  | "receipts.claimed"
  | "receipts.waiting"
  | "receipts.asking"
  | "receipts.outage"
  | "receipts.queued"
  | "receipts.away"
  | "receipts.plan"
  | "receipts.budget"
  | "receipts.line"
  | "receipts.handled"
  | "receipts.passed"
  | "receipts.canceled"
  | "receipts.failed"
  | "receipts.nobody"
  | "receipts.platformCap"
  | "receipts.mentionNeeded"
  | "receipts.picking"
  | "noAi.receipt"
  | "noAi.kept.receipt"
  | "noAi.kept.channel";

export const FACES = 3;

const faces = (ids: string[]) => ({ faces: ids.slice(0, FACES), more: Math.max(0, ids.length - FACES) });

/** What the line under a person's message shows, or null when there is nothing to say yet. */
export function receiptLine(receipt: MessageReceipt | undefined): ReceiptLine | null {
  const view = receiptView(receipt);
  const status = view.status;
  const mark = receiptTicks(receipt);
  if (view.picking) {
    const words = { key: "receipts.picking" as const, agents: [] };
    return { faces: [], more: 0, mark, words, label: words, action: null, alert: false };
  }
  if (view.seen.length === 0 && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;
  if (status === null) {
    const words = { key: "receipts.seenBy" as const, agents: view.seen };
    return { ...faces(view.seen), mark, words, label: words, action: null, alert: false };
  }
  switch (status.kind) {
    case "picked":
    case "claimed":
    case "line":
    case "handled":
    case "passed":
    case "canceled": {
      const label = { key: `receipts.${status.kind}` as const, agents: status.agents };
      return { ...faces(status.agents), mark, words: null, label, action: null, alert: false };
    }
    case "waiting":
    case "asking": {
      const words = { key: `receipts.${status.kind}` as const, agents: status.agents };
      return { ...faces(status.agents), mark, words, label: words, action: null, alert: false };
    }
    case "outage":
    case "queued":
    case "away":
    case "plan":
    case "budget": {
      const words = { key: `receipts.${status.kind}` as const, agents: status.agents };
      return { ...faces(status.agents), mark: "none", words, label: words, action: null, alert: false };
    }
    case "failed": {
      const words = { key: "receipts.failed" as const, agents: status.agents };
      return { ...faces(status.agents), mark: "none", words, label: words, action: "retry", alert: true };
    }
    case "nobody": {
      const key = status.mentionNeeded ? ("receipts.mentionNeeded" as const) : ("receipts.nobody" as const);
      const words = { key, agents: [] };
      return { faces: [], more: 0, mark, words: null, label: words, action: null, alert: false };
    }
    case "platform_cap": {
      const words = { key: "receipts.platformCap" as const, agents: [] };
      return { faces: [], more: 0, mark: "none", words, label: words, action: null, alert: false };
    }
    case "no_ai": {
      const words = { key: "noAi.receipt" as const, agents: [] };
      return { ...faces(status.agents), mark: "none", words, label: words, action: "connect", alert: true };
    }
  }
}

/**
 * The same line on a billing hold: the message is kept, with no alert and nothing to connect yet. With a face it has
 * its agent's card above; with none (a channel message nobody mentioned) the words are all it gets.
 */
export function keptLine(line: ReceiptLine | null): ReceiptLine | null {
  if (line?.words?.key !== "noAi.receipt") return line;
  const words = {
    key: line.faces.length > 0 ? ("noAi.kept.receipt" as const) : ("noAi.kept.channel" as const),
    agents: [],
  };
  return { ...line, words, label: words, action: null, alert: false };
}

/** What keeps its line of words under the message: a receipt with no small mark of its own asks something of you. */
export const keepsLine = (line: ReceiptLine) => line.mark === "none";

/**
 * The line under the message, for what keeps one. It gives way to the steer mark ("Theo leu", "lê na próxima
 * pausa"), which says more about a message that went into a task at work; only what asks for a tap (send again,
 * connect an AI) still shows.
 */
export const receiptShows = (line: ReceiptLine | null, steered: boolean): line is ReceiptLine =>
  line !== null && keepsLine(line) && (!steered || line.action !== null);

/** The mark a person's message carries beside its text, in room its row already has. */
export type ReceiptMarkView =
  /** My message sent into a task at work: the agent's face once it read it, else the phase's small mark. */
  | { kind: "steer"; agentId: string; state: SteerPhase; words: ReturnType<typeof steerWords> }
  /** My latest message in a DM between people, once they read it: their face. */
  | { kind: "seen"; personId: string }
  /** The latest person's message's agents' receipt when it asks nothing of you: the first agent's face and the mark. */
  | { kind: "agents"; agentId: string | null; mark: ReceiptMark; label: ReceiptLine["label"] };

/** The one mark of a person's message, or null: what became of it in a task at work, "Visto", the agents' receipt. */
export function markOf(
  steer: SteerState | null,
  seenBy: string | null | undefined,
  receipt: MessageReceipt | undefined,
): ReceiptMarkView | null {
  if (steer) return { kind: "steer", agentId: steer.agentId, state: steer.state, words: steerWords(steer, receipt) };
  if (seenBy) return { kind: "seen", personId: seenBy };
  const line = receiptLine(receipt);
  if (!line || keepsLine(line)) return null;
  return { kind: "agents", agentId: line.faces[0] ?? null, mark: line.mark, label: line.label };
}

/** The mark's words: its accessibility label, and what a tap on it says. */
export function markLabel(
  t: TFunction,
  view: ReceiptMarkView,
  names: { agent: (id: string) => string; person: (id: string) => string },
): string {
  if (view.kind === "steer") return t(`mobile.chat.steer.${view.words}`, { name: names.agent(view.agentId) });
  if (view.kind === "seen") return t("receipts.seenBy", { names: names.person(view.personId) });
  const agents = view.label.agents;
  return t(view.label.key, { count: agents.length, names: listNames(t, agents.map(names.agent)) });
}

/**
 * Where someone else's receipt mark goes: the end of the name line of the turn its message ends. A grouped row has
 * no name line, and its text runs to the edge.
 */
export function turnHeadId(
  rows: readonly { kind: string; message?: Message; grouped?: boolean }[],
  messageId: string,
): string | null {
  let at = rows.findIndex((r) => r.kind === "message" && r.message?.id === messageId);
  if (at < 0) return null;
  while (at > 0 && rows[at]?.grouped && rows[at - 1]?.kind === "message") at--;
  return rows[at]?.message?.id ?? null;
}

/**
 * The message the line goes under: the latest on screen that the server has, a person's or an agent's that mentions
 * agents (whom it handed work to, and who it only mentioned: ADR 0089). An agent's never takes it from the latest
 * person's message while that one's line asks something of you (`keepsLine`: send it again, connect an AI).
 */
export function receiptMessageId(messages: readonly Message[], receipts: ReceiptsState = {}): string | null {
  let byAgent: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.local || isEventLine(m.meta)) continue;
    if (m.author.type === "person") {
      if (!byAgent) return m.id;
      const line = receiptLine(receipts[m.id]);
      return line && keepsLine(line) ? m.id : byAgent;
    }
    if (!byAgent && m.author.type === "agent" && m.mentionedAgentIds.length > 0) byAgent = m.id;
  }
  return byAgent;
}

/** Each agent's line in the sheet: its phase, "only mentioned" for one the message just names, "reacted" for one
 * whose reaction was its answer (in any phase). */
export type ReceiptRowPhase = ReceiptPhase | "referenced" | "reacted";

export function receiptRows(
  receipt: MessageReceipt | undefined,
  reactedBy: readonly string[] = [],
): { agentId: string; phase: ReceiptRowPhase }[] {
  const view = receiptView(receipt);
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);
  return view.seen.map((agentId) => {
    const phase = phases.get(agentId) ?? "seen";
    // A reaction was its answer, whatever its run's state says.
    if (reactedBy.includes(agentId)) return { agentId, phase: "reacted" };
    if (phase === "seen" && view.referenced.includes(agentId)) return { agentId, phase: "referenced" };
    return { agentId, phase };
  });
}

/** The i18n key of an agent's phase in the sheet. */
export const phaseKey = (phase: ReceiptRowPhase, held = false) =>
  phase === "no_ai" ? (held ? "noAi.kept.receipt" : "noAi.chip") : `receipts.status.${phase}`;
