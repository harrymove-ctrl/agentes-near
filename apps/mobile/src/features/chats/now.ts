import type { AppNotification } from "@agenteschat/client";
import type { WorkItem } from "../agents/logic";
import { type AppHref, chatHref, notificationHref } from "../links/logic";
import type { ConversationRow } from "./logic";
import type { WaitingItem, WaitingKind } from "./waiting";

/**
 * What changed, said on Conversas: the greeting's second line ("Theo terminou
 * “Corrige o login” · 2 trabalhando", each part opens where it happened) and what an agent's row says (it
 * waits on your ok, or what it is doing). Pure: built from what the app already loads (who is working, what
 * waits on you, the conversations and the inbox).
 */

// ── An agent's row ──────────────────────────────────────────────────────────

/** What an agent's DM row says instead of its last message: it waits on you, or what it is doing. */
export type AgentRowState =
  | { kind: "waiting"; wait: WaitingKind; title: string }
  | { kind: "working"; work: WorkItem }
  | { kind: "computer"; computer: string }
  | null;

/**
 * Waiting on you wins (amber, the only waiting color), then waiting for its offline computer, then what it is on: the item in this conversation
 * first, else its first item anywhere (missions come first in `workingNow`).
 */
export function agentRowState(
  agentId: string,
  channelId: string,
  work: readonly WorkItem[],
  waiting: readonly Pick<WaitingItem, "agentId" | "kind" | "title">[],
  /** Agents waiting for an offline computer (`waitingComputerByAgent`): "Esperando o MacBook Air", never working. */
  offline: ReadonlyMap<string, { name: string }> = new Map(),
): AgentRowState {
  const wait = waiting.find((w) => w.agentId === agentId);
  if (wait) return { kind: "waiting", wait: wait.kind, title: wait.title };
  const computer = offline.get(agentId);
  if (computer) return { kind: "computer", computer: computer.name };
  const mine = work.filter((w) => w.agentId === agentId);
  const here = mine.find((w) => w.channelId === channelId) ?? mine[0];
  return here ? { kind: "working", work: here } : null;
}

// ── What finished ───────────────────────────────────────────────────────────

/** Something an agent finished: a run seen working that ended with its answer, a mission, a routine. */
export interface FinishedItem {
  key: string;
  agentId: string;
  kind: "run" | "mission" | "routine" | "work";
  /** What it was (the run's label, the mission's or routine's name); null when unknown. */
  what: string | null;
  /** When it finished (its answer's time, the inbox item's). */
  at: string;
  /** Where tapping it opens; null: the agent's profile. */
  href: AppHref | null;
}

/** How long something finished stays news on the greeting. */
export const FINISHED_FRESH_MS = 3 * 60 * 60_000;

/** Items that were in progress and no longer are (they finished, failed or were stopped). */
export function endedWork(prev: readonly WorkItem[], next: readonly WorkItem[]): WorkItem[] {
  const still = new Set(next.map((w) => w.key));
  return prev.filter((w) => !still.has(w.key));
}

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);

/**
 * The ended items that really finished: the agent spoke last in that conversation, after the work started
 * (a failed or stopped run leaves no answer). A DM or channel already read (no unread) is no news.
 */
export function confirmFinished(ended: readonly WorkItem[], rows: readonly ConversationRow[]): FinishedItem[] {
  const out: FinishedItem[] = [];
  for (const w of ended) {
    const row = rows.find((r) =>
      w.threadId && w.threadId !== w.channelId
        ? (r.kind === "thread" || r.kind === "mission") && r.threadId === w.threadId
        : (r.kind === "dm" || r.kind === "channel") && r.channelId === w.channelId,
    );
    if (!row?.last || !row.at) continue;
    const author = row.last.author;
    if (author?.type !== "agent" || author.id !== w.agentId) continue;
    // It said its computer is away: it waits for it, it didn't finish.
    if (row.last.meta?.bodyCode === "brain_unavailable") continue;
    if (!(time(row.at) >= time(w.since))) continue;
    if ((row.kind === "dm" || row.kind === "channel") && row.unread === 0) continue;
    out.push({
      key: w.key,
      agentId: w.agentId,
      kind: w.kind,
      what: w.what,
      at: row.at,
      href: chatHref(w.channelId, w.threadId),
    });
  }
  return out;
}

/** Missions and routines that finished, from the inbox: unread ones, by an agent. */
export function finishedFromInbox(
  items: readonly Pick<AppNotification, "id" | "kind" | "actors" | "source" | "readAt" | "updatedAt">[],
): FinishedItem[] {
  const out: FinishedItem[] = [];
  for (const n of items) {
    if (n.kind !== "mission_finished" && n.kind !== "routine_finished") continue;
    if (n.readAt !== null) continue;
    const agent = n.actors.find((a) => a.type === "agent");
    if (!agent) continue;
    out.push({
      key: `n:${n.id}`,
      agentId: agent.id,
      kind: n.kind === "mission_finished" ? "mission" : "routine",
      what: n.source.label?.trim() || null,
      at: n.updatedAt,
      href: notificationHref(n),
    });
  }
  return out;
}

/** The newest finished item still fresh and not dismissed (tapped), or null. */
export function latestFinished(
  items: readonly FinishedItem[],
  dismissed: ReadonlySet<string>,
  now = Date.now(),
  freshMs = FINISHED_FRESH_MS,
): FinishedItem | null {
  let best: FinishedItem | null = null;
  for (const f of items) {
    if (dismissed.has(f.key)) continue;
    const at = time(f.at);
    if (!(now - at <= freshMs)) continue;
    if (!best || at > time(best.at)) best = f;
  }
  return best;
}

/** Adds newly finished items to what is kept (by key, newest first, at most `max`). */
export function keepFinished(kept: readonly FinishedItem[], add: readonly FinishedItem[], max = 20): FinishedItem[] {
  const byKey = new Map(kept.map((f) => [f.key, f]));
  for (const f of add) byKey.set(f.key, f);
  return [...byKey.values()].sort((a, b) => time(b.at) - time(a.at)).slice(0, max);
}

// ── The greeting's second line ──────────────────────────────────────────────

/**
 * What the line says: what finished (when something did) and how many work now. With something finished,
 * the working part is short ("2 trabalhando"); alone, it says it whole ("2 agentes trabalhando agora").
 */
export type GreetingLine =
  | { kind: "finished"; finished: FinishedItem; working: number }
  | { kind: "working"; working: number }
  | { kind: "idle" };

export function greetingLine(finished: FinishedItem | null, working: number): GreetingLine {
  if (finished) return { kind: "finished", finished, working };
  return working > 0 ? { kind: "working", working } : { kind: "idle" };
}

/** The i18n key of "Theo terminou …" by kind, and with or without what it was. */
export function finishedKey(f: Pick<FinishedItem, "kind" | "what">) {
  if (!f.what) return "mobile.homeNow.finished.plain" as const;
  return `mobile.homeNow.finished.${f.kind}` as const;
}
