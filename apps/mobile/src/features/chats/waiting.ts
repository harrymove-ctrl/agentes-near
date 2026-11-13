import type { AppNotification, Approval, Mission } from "@agenteschat/client";
import { type AppHref, chatHref, notificationHref } from "../links/logic";
import { minutesLeft } from "../shared/logic";
import { missionWaitingItems } from "./logic";

/**
 * "Esperando você": what waits on you as items in one order (requests, the one
 * closest to expiring first, then missions, then agents' questions), the dark strip that shows the first one, and
 * the card it opens into (which says how many more wait). Pure: the strip turns this into text.
 */

export type WaitingKind = "approval" | "question" | "mission";

export interface WaitingItem {
  key: string;
  kind: WaitingKind;
  /** Who asks (an agent), null when unknown. */
  agentId: string | null;
  /** What it is about: the request's action, the mission, the question. */
  title: string;
  createdAt: string | null;
  /** Only requests expire. */
  expiresAt: string | null;
  /** How much it adds to the count (a mission counts each item waiting in it). */
  weight: number;
  /** Where "Revisar" opens: the request, the conversation of the question, the mission's thread. */
  href: AppHref | null;
  /** Its thread and mission (the Threads tab shows only those from threads and missions). */
  threadId: string | null;
  missionId: string | null;
}

export function waitingItems(input: {
  approvals: Pick<Approval, "id" | "agentId" | "title" | "createdAt" | "expiresAt" | "threadId" | "missionId">[];
  missions: Pick<Mission, "id" | "agentId" | "title" | "channelId" | "threadId" | "pending">[];
  questions: Pick<AppNotification, "id" | "kind" | "actors" | "latest" | "source" | "createdAt">[];
}): WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const a of input.approvals)
    items.push({
      key: `a:${a.id}`,
      kind: "approval",
      agentId: a.agentId,
      title: a.title,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      weight: 1,
      href: `/approval/${a.id}`,
      threadId: a.threadId || null,
      missionId: a.missionId ?? null,
    });
  for (const m of input.missions)
    items.push({
      key: `m:${m.id}`,
      kind: "mission",
      agentId: m.agentId,
      title: m.title,
      createdAt: null,
      expiresAt: null,
      weight: Math.max(1, missionWaitingItems(m)),
      href: chatHref(m.channelId, m.threadId),
      threadId: m.threadId,
      missionId: m.id,
    });
  for (const q of input.questions) {
    const actor = q.actors[0];
    items.push({
      key: `q:${q.id}`,
      kind: "question",
      agentId: actor?.type === "agent" ? actor.id : null,
      title: q.latest.text ?? q.latest.title ?? "",
      createdAt: q.createdAt,
      expiresAt: null,
      weight: 1,
      href: notificationHref(q),
      threadId: q.source.threadId ?? null,
      missionId: q.source.missionId ?? null,
    });
  }
  return items;
}

/** The count on the strip: requests, mission items and questions. */
export const waitingCount = (items: Pick<WaitingItem, "weight">[]) => items.reduce((n, i) => n + i.weight, 0);

/** The Threads tab's own: what waits in a mission or in one of its threads. */
export const waitingInThreads = (items: WaitingItem[], threadIds: ReadonlySet<string>) =>
  items.filter((i) => i.kind === "mission" || i.missionId || (i.threadId !== null && threadIds.has(i.threadId)));

/** How many faces the card's "e mais N" row shows. */
const MORE_FACES = 3;

/**
 * The strip's shape: the first item, the count, how many more wait besides it ("e mais N" on the open card), and
 * the agents of the next ones (distinct, at most three).
 */
export function waitingStack(items: WaitingItem[]) {
  const first = items[0] ?? null;
  const count = waitingCount(items);
  const rest = first ? Math.max(0, count - first.weight) : 0;
  const faces: string[] = [];
  for (const i of items.slice(1)) {
    if (i.agentId && !faces.includes(i.agentId)) faces.push(i.agentId);
    if (faces.length === MORE_FACES) break;
  }
  return { first, count, rest, stacked: rest > 0, faces };
}

/** Minutes until a request expires ("· expira em 46 min"); null when it has no deadline. */
export const waitingMinutes = (i: Pick<WaitingItem, "expiresAt">, now = Date.now()) =>
  i.expiresAt ? minutesLeft(i.expiresAt, now) : null;

/** The i18n keys of an item's verb ("precisa do seu ok") and its chip ("Aprovar", "Pergunta", "Missão"). */
export const waitingVerbKey = (kind: WaitingKind) => `mobile.chats.wait.verb.${kind}` as const;
export const waitingChipKey = (kind: WaitingKind) => `mobile.chats.wait.chip.${kind}` as const;
export const WAITING_ICON = { approval: "shield", question: "help", mission: "target" } as const;
