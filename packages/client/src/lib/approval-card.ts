import type { Approval } from "../api/types";
import { approveAlwaysOffered } from "./approval-kind";
import { approvalOriginShort, approvalWhy } from "./approval-origin";

/**
 * The requests on one approval card, oldest first: the card's own (`first`) and every request of the agent
 * that joined it in that conversation (same `messageId`, server side `openApprovalCard`).
 */
export function approvalCardItems(list: readonly Approval[] | undefined, messageId: string, first?: Approval) {
  const byId = new Map<string, Approval>();
  // The first copy of an id wins: callers put the freshest list first.
  for (const a of [...(list ?? []), ...(first ? [first] : [])])
    if ((a.messageId === messageId || a === first) && !byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * What "Aprovar tudo" covers: the items still waiting that this person may decide, as listed now (the ids
 * sent, so one joining during the click is never approved unseen), and how many waiting ones they can't.
 */
export function approveAllScope(items: readonly Approval[], now = Date.now()) {
  const waiting = items.filter((a) => a.status === "pending" && new Date(a.expiresAt).getTime() > now);
  const ids = waiting.filter((a) => a.canDecide).map((a) => a.id);
  return { ids, waiting: waiting.length, blocked: waiting.length - ids.length };
}

/** A request past its deadline reads as expired, before the server's event says so. */
export const asOfNow = (a: Approval, now = Date.now()): Approval =>
  a.status === "pending" && Date.parse(a.expiresAt) <= now ? { ...a, status: "expired" } : a;

/** The card's shared deadline: the earliest of its waiting items (null: nothing waits). */
export function cardDeadline(items: readonly Approval[]): string | null {
  const pending = items.filter((a) => a.status === "pending").map((a) => a.expiresAt);
  return pending.length ? pending.reduce((a, b) => (a < b ? a : b)) : null;
}

/**
 * A list of approvals as their cards (Aprovações, the phone's list): requests sharing a card come together,
 * at the place of its newest one; one without a card stands alone.
 */
export function approvalCards(list: readonly Approval[]): Approval[][] {
  const cards = new Map<string, Approval[]>();
  for (const a of list) {
    const key = a.messageId ?? a.id;
    const card = cards.get(key);
    if (card) card.push(a);
    else cards.set(key, [a]);
  }
  return [...cards.values()].map((items) => items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

/**
 * What a request on a shared card says for itself: its why and where it came from, where they differ from the
 * card's lead request (one that joined from another turn or run keeps its own explanation).
 */
export function itemOwnWords(a: Approval, lead: Approval) {
  const why = approvalWhy(a);
  const origin = approvalOriginShort(a);
  return {
    why: why && why !== approvalWhy(lead) ? why : null,
    origin: origin && JSON.stringify(origin) !== JSON.stringify(approvalOriginShort(lead)) ? origin : null,
  };
}

/** "Aprovar sempre" on a shared card: once per kind, on the first request where it is offered. */
export function approveAlwaysOn(items: readonly Approval[]): Set<string> {
  const kinds = new Map<string, string>();
  for (const a of items) {
    const kind = JSON.stringify(a.approveAlways);
    if (approveAlwaysOffered(a) && !kinds.has(kind)) kinds.set(kind, a.id);
  }
  return new Set(kinds.values());
}

// The same "Aprovar sempre" kind too: a SQL write (none offered) never folds among reads, its SQL hidden.
const kindOf = (a: Approval) => JSON.stringify([a.agentId, a.tool, a.title, a.connectorAccount, a.approveAlways]);
const sameKind = (a: Approval, b: Approval) => kindOf(a) === kindOf(b);

/**
 * A key for each run of `approvalRuns` that stays the same while its requests are decided one by one (its first id
 * doesn't), so an unfolded run stays open: its kind, and which run of that kind on the card (a lone request is its id;
 * one decided out of a run doesn't shift the count).
 */
export function runKeys(runs: readonly Approval[][]): string[] {
  const seen = new Map<string, number>();
  return runs.map((run) => {
    const [first] = run;
    if (!first || run.length < 2) return first?.id ?? "";
    const kind = kindOf(first);
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    return `${kind}#${n}`;
  });
}

/**
 * A card's items as they are drawn: several waiting requests of one kind in a row (same agent, tool, action and
 * "Aprovar sempre" kind) come together as one run ("3 pedidos de Ada para Executar sql"), anything else stands alone. A run this person may decide
 * only one of stands apart again: "Aprovar todos" would cover just that one.
 */
export function approvalRuns(items: readonly Approval[]): Approval[][] {
  const runs: Approval[][] = [];
  for (const a of items) {
    const run = runs.at(-1);
    const head = run?.[0];
    if (run && head && a.status === "pending" && head.status === "pending" && sameKind(head, a)) run.push(a);
    else runs.push([a]);
  }
  return runs.flatMap((run) => (run.length > 1 && approveAllScope(run).ids.length === 1 ? run.map((a) => [a]) : [run]));
}

/**
 * The other requests "Aprovar sempre" on `a` approves with it: those on its card that this person may decide and that
 * the same rule covers. The rule is per connection, which the agent's tool name says, so the same server tool on
 * another account keeps asking, as does a write among SQL reads.
 */
export function approveAlwaysAlso(card: readonly Approval[], a: Approval): string[] {
  if (!a.approveAlways) return [];
  return card.filter((x) => x.id !== a.id && x.status === "pending" && x.canDecide && sameKind(x, a)).map((x) => x.id);
}
