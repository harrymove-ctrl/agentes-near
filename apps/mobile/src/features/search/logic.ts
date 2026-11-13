import type { Agent, Channel, DirectMessage, SearchHit, SearchKind } from "@agenteschat/client";
import {
  DM_SEARCH_OPS,
  dedupe,
  inDmOnly,
  parseSearch,
  SEARCH_OPS,
  type SearchChip,
  type SearchDirectory,
  type SearchOp,
  type SearchPlace,
  type SearchWords,
} from "@agenteschat/client/lib/search-filters";
import { type AppHref, chatHref } from "../links/logic";

/**
 * Busca (the search bar of Conversas): actions, agents and conversations match the words here; the team's
 * outside actions (ADR 0064), messages and files come from the search API (`GET …/search`, kinds
 * `action`, `message` and `file`). Results are grouped (Conversas, Ações do time, Mensagens, Arquivos)
 * with a chip per group.
 */

export type SearchAction = "newConversation" | "newTask" | "newAgent";
export const SEARCH_ACTIONS: SearchAction[] = ["newConversation", "newTask", "newAgent"];

/** What the search API is asked for. */
export const SEARCH_KINDS: SearchKind[] = ["action", "message", "file"];

/** The chips over the results. */
export type SearchFilter = "all" | "chats" | "team" | "messages" | "files";
export const SEARCH_FILTERS: SearchFilter[] = ["all", "chats", "team", "messages", "files"];

/** Lowercase, no accents: "Ação" matches "acao". */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const n = fold(q);
  return !n || fields.some((f) => f && fold(f).includes(n));
};

export interface SearchResults {
  actions: SearchAction[];
  agents: Agent[];
  channels: Channel[];
  dms: DirectMessage[];
  /** What agents already did outside (emails, PRs…), where it happened. */
  team: SearchHit[];
  messages: SearchHit[];
  files: SearchHit[];
}

/** What to show for `q`, given the action labels in the person's language. */
export function searchResults(
  q: string,
  input: {
    actionLabels: Record<SearchAction, string>;
    agents: Agent[];
    channels: Channel[];
    dms: DirectMessage[];
    hits: SearchHit[];
  },
): SearchResults {
  const words = Boolean(fold(q));
  return {
    actions: SEARCH_ACTIONS.filter((a) => matches(q, input.actionLabels[a])),
    agents: input.agents.filter((a) => matches(q, a.name, a.role, a.handle)).slice(0, 8),
    channels: input.channels.filter((c) => matches(q, c.name, c.topic)).slice(0, 8),
    dms: input.dms.filter((d) => matches(q, d.with.name, d.with.handle)).slice(0, 8),
    // Only hits that open in the app; with no words, nothing.
    team: words ? input.hits.filter((h) => h.kind === "action" && h.channelIds.length > 0).slice(0, 20) : [],
    messages: words ? input.hits.filter((h) => h.kind === "message" && h.channelIds.length > 0).slice(0, 20) : [],
    files: words ? input.hits.filter((h) => h.kind === "file").slice(0, 20) : [],
  };
}

/** How many results each chip has ("Tudo" counts every group but the actions). */
export function searchCounts(r: SearchResults): Record<SearchFilter, number> {
  const chats = r.agents.length + r.channels.length + r.dms.length;
  return {
    all: chats + r.team.length + r.messages.length + r.files.length,
    chats,
    team: r.team.length,
    messages: r.messages.length,
    files: r.files.length,
  };
}

/** The results a chip keeps (actions only under "Tudo"). */
export function filterResults(r: SearchResults, filter: SearchFilter): SearchResults {
  const none: SearchResults = { actions: [], agents: [], channels: [], dms: [], team: [], messages: [], files: [] };
  switch (filter) {
    case "all":
      return r;
    case "chats":
      return { ...none, agents: r.agents, channels: r.channels, dms: r.dms };
    case "team":
      return { ...none, team: r.team };
    case "messages":
      return { ...none, messages: r.messages };
    case "files":
      return { ...none, files: r.files };
  }
}

export const isEmpty = (r: SearchResults) =>
  r.actions.length +
    r.agents.length +
    r.channels.length +
    r.dms.length +
    r.team.length +
    r.messages.length +
    r.files.length ===
  0;

/**
 * What the box holds after `value` is typed: a space after a complete operator makes it a chip, unless one of them
 * isn't offered here (`ops`), then it all stays as typed.
 */
export function typeSearch(
  value: string,
  chips: readonly SearchChip[],
  dir: SearchDirectory,
  words: SearchWords,
  ops: readonly SearchOp[] = SEARCH_OPS,
): { chips: SearchChip[]; q: string } {
  if (!/\s$/.test(value)) return { chips: [...chips], q: value };
  const parsed = parseSearch(value, dir, words);
  if (parsed.chips.length === 0 || parsed.chips.some((c) => !ops.includes(c.op)))
    return { chips: [...chips], q: value };
  return { chips: dedupe([...chips, ...parsed.chips]), q: parsed.text ? `${parsed.text} ` : "" };
}

/**
 * The search inside one conversation, as the web's header search: a channel starts in itself (an `in:` chip the
 * person may remove) with every operator; a DM holds to itself (no chip to remove, no who or where).
 * `searched` is what the API is asked, `shown` the chips on the box (and in a recent search).
 */
export function conversationScope(place: SearchPlace, chips: readonly SearchChip[]) {
  const searched = place.dm ? inDmOnly(chips, place) : [...chips];
  return {
    searched,
    shown: place.dm ? searched.slice(1) : searched,
    ops: place.dm ? DM_SEARCH_OPS : SEARCH_OPS,
  };
}

/** Nothing asked beyond the conversation itself: the options and recent searches show, not results. */
export const idleIn = (place: SearchPlace, searched: readonly SearchChip[], text: string) =>
  !text.trim() && searched.every((c) => c.op === "in" && c.place.id === place.id);

type HitPlace = Pick<SearchHit, "channelIds" | "messageId" | "threadId">;
/** A thread's root says its own id as its thread: it stands on the timeline. */
const threadOf = (hit: HitPlace) => (hit.threadId && hit.threadId !== hit.messageId ? hit.threadId : null);

/** Where a message hit opens: its conversation at it, a reply in its thread. */
export const hitHref = (hit: HitPlace): AppHref => chatHref(hit.channelIds[0] ?? "", threadOf(hit), hit.messageId);

/**
 * Where a message hit goes from the conversation `channelId`: one on its own timeline is gone to in place (lit for a
 * moment); a thread's reply opens the thread at it, another conversation's opens there.
 */
export function hitTarget(
  hit: HitPlace,
  channelId: string,
): { kind: "here"; messageId: string } | { kind: "open"; href: AppHref } {
  if (hit.channelIds[0] === channelId && !threadOf(hit) && hit.messageId)
    return { kind: "here", messageId: hit.messageId };
  return { kind: "open", href: hitHref(hit) };
}
