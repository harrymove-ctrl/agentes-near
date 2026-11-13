/**
 * The "@" picker's pure logic (same rules as the web's composer, `useMentionSearch` and `mentionQuery`):
 * the word being typed right before the caret, who matches (the channel's members first, then the rest of
 * the workspace), the part of the name or handle that matched, and the text after picking.
 */

import type { Agent } from "@agenteschat/client";
import { channelQuery, insertChannelRef } from "@agenteschat/client/lib/channel-refs";
import { mentionReaches } from "@agenteschat/client/lib/right-hand";

/** Lowercase, accent-free: "João" → "joao" (same length for composed text). */
export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** "@que" right before the caret (start of text or after a space or bracket); null when not typing one. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[\s(])@([\p{L}\p{N}_-]{0,32})$/u);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export interface MentionAgent {
  id: string;
  name: string;
  handle: string;
  role?: string | null;
  /** The server's `canTalk` (absent = yes): agents that don't answer me aren't offered. */
  canTalk?: boolean;
  builtin?: Agent["builtin"];
}

export interface MentionPerson {
  userId: string;
  name: string;
  handle: string;
  email?: string;
}

export interface MentionOption {
  key: string;
  type: "agent" | "person";
  id: string;
  name: string;
  handle: string;
  /** The agent's role ("Marketing"); null for people and agents without one. */
  role: string | null;
  /** In this conversation (always true when there is no member list, e.g. a DM). */
  inChannel: boolean;
  /** Where the query matched, to underline it: in the name or in the handle, `[start, end)`. */
  match: { in: "name" | "handle"; start: number; end: number } | null;
}

/** How many rows the picker shows (a phone's card above the keyboard). */
export const MENTION_LIMIT = 6;

const matchIn = (value: string, q: string) => {
  if (!q) return -1;
  const folded = fold(value);
  // Only underline when folding kept the length (composed text); the match itself still counts.
  return folded.length === value.length ? folded.indexOf(q) : -1;
};

/**
 * Who "@<query>" can mean: agents I can talk to and the other people of the workspace, filtered by name,
 * handle or e-mail; members of the conversation first, then names or handles that start with the query,
 * then the rest, by name. `members` = a channel's members (`type:id` keys), and the right hand is in every channel
 * (`mentionReaches`); null = everyone is in (a DM).
 */
export function mentionOptions(input: {
  query: string;
  agents: readonly MentionAgent[];
  people: readonly MentionPerson[];
  meId: string | null;
  members: ReadonlySet<string> | null;
  limit?: number;
}): MentionOption[] {
  const q = fold(input.query);
  const inChannel = (type: "agent" | "person", id: string) => !input.members || input.members.has(`${type}:${id}`);
  type Ranked = MentionOption & { rank: number };
  const rows: Ranked[] = [];
  const push = (
    type: "agent" | "person",
    id: string,
    name: string,
    handle: string,
    role: string | null,
    extra = "",
    reached = false,
  ) => {
    const hay = `${fold(name)} ${fold(handle)} ${fold(extra)}`;
    if (q && !hay.includes(q)) return;
    const n = matchIn(name, q);
    const h = matchIn(handle, q);
    const match =
      n >= 0
        ? { in: "name" as const, start: n, end: n + q.length }
        : h >= 0
          ? { in: "handle" as const, start: h, end: h + q.length }
          : null;
    const rank = fold(name).startsWith(q) || fold(handle).startsWith(q) ? 0 : 1;
    rows.push({
      key: `${type}:${id}`,
      type,
      id,
      name,
      handle,
      role,
      inChannel: reached || inChannel(type, id),
      match,
      rank,
    });
  };
  for (const a of input.agents)
    if (a.canTalk !== false) push("agent", a.id, a.name, a.handle, a.role || null, "", mentionReaches(a, "channel"));
  for (const p of input.people) if (p.userId !== input.meId) push("person", p.userId, p.name, p.handle, null, p.email);
  rows.sort((a, b) => Number(b.inChannel) - Number(a.inChannel) || a.rank - b.rank || a.name.localeCompare(b.name));
  return rows.slice(0, input.limit ?? MENTION_LIMIT).map(({ rank: _rank, ...o }) => o);
}

/** The text with "@handle " in place of the "@que" being typed, and where the caret goes. */
export function insertMention(
  text: string,
  token: { start: number; query: string },
  handle: string,
): { text: string; caret: number } {
  const end = token.start + 1 + token.query.length;
  const inserted = `@${handle} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(end).replace(/^ /, ""),
    caret: token.start + inserted.length,
  };
}

/** A label split around the matched part: [before, matched, after]. */
export function splitMatch(value: string, range: { start: number; end: number } | null): [string, string, string] {
  if (!range || range.start < 0 || range.end > value.length) return [value, "", ""];
  return [value.slice(0, range.start), value.slice(range.start, range.end), value.slice(range.end)];
}

/** The "#channel" or "@who" being typed right before the caret (`sigil: "#"` for a channel); null when neither. */
export function refQuery(text: string, caret: number): { start: number; query: string; sigil?: "#" } | null {
  const channel = channelQuery(text, caret);
  return channel ? { ...channel, sigil: "#" } : mentionQuery(text, caret);
}

/** The text after picking from either list: "#name " for a channel, "@handle " for someone. */
export function insertRef(
  text: string,
  token: { start: number; query: string; sigil?: "#" },
  value: string,
): { text: string; caret: number } {
  return token.sigil === "#" ? insertChannelRef(text, token, value) : insertMention(text, token, value);
}
