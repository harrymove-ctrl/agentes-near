import type { TFunction } from "i18next";
import type { SearchFilterInput, SearchHas, SearchSort } from "../api/types";

export type { SearchHas, SearchSort };

import { norm } from "./tool-review";

/**
 * Search filters (ADR 0123): what the search box understands besides words (`from:@ana in:#geral has:file
 * before:2026-10-01`), the chips they become, and what the search API is asked. English operator words work in
 * every language; the person's language adds its own (`de:`, `em:`…).
 */

export type SearchOp = "from" | "mentions" | "in" | "has" | "before" | "after" | "during" | "pinned" | "author";
export const SEARCH_OPS: readonly SearchOp[] = [
  "from",
  "in",
  "has",
  "mentions",
  "before",
  "after",
  "during",
  "author",
  "pinned",
];
export const SEARCH_HAS: readonly SearchHas[] = ["link", "file", "image", "card"];
export const SEARCH_SORTS: readonly SearchSort[] = ["newest", "oldest", "relevance"];
export type AuthorType = "person" | "agent";

/** Someone a filter can name: a person (user id) or an agent. */
export interface SearchActor {
  type: AuthorType;
  id: string;
  name: string;
  handle?: string | null;
}
/** A channel or a DM (`name` = the other person's name). */
export interface SearchPlace {
  id: string;
  name: string;
  dm?: boolean;
}
export interface SearchDirectory {
  actors: readonly SearchActor[];
  places: readonly SearchPlace[];
}

export type SearchChip =
  | { op: "from" | "mentions"; actor: SearchActor }
  | { op: "in"; place: SearchPlace }
  | { op: "has"; value: SearchHas }
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  | { op: "before" | "after" | "during"; value: string }
  | { op: "pinned" }
  | { op: "author"; value: AuthorType };

/** The words of one language: each operator, each `has:` and `author:` value. */
export interface SearchWords {
  ops: Record<SearchOp, string>;
  has: Record<SearchHas, string>;
  author: Record<AuthorType, string>;
}

export const ENGLISH_SEARCH_WORDS: SearchWords = {
  ops: {
    from: "from",
    mentions: "mentions",
    in: "in",
    has: "has",
    before: "before",
    after: "after",
    during: "during",
    pinned: "pinned",
    author: "author",
  },
  has: { link: "link", file: "file", image: "image", card: "card" },
  author: { person: "person", agent: "agent" },
};

const PERIOD = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** The local-time span of `2026`, `2026-10` or `2026-10-05`: [start, end). Null for anything else. */
export function periodOf(value: string): { start: Date; end: Date } | null {
  const m = PERIOD.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) - 1 : null;
  const d = m[3] ? Number(m[3]) : null;
  if (mo !== null && (mo < 0 || mo > 11)) return null;
  const start = new Date(y, mo ?? 0, d ?? 1);
  if (d !== null && start.getDate() !== d) return null;
  const end = d !== null ? new Date(y, mo ?? 0, d + 1) : mo !== null ? new Date(y, mo + 1, 1) : new Date(y + 1, 0, 1);
  return { start, end };
}

/** The word typed for `value` in `table` (English or the person's language), or null. */
function lookup<K extends string>(value: string, tables: Record<K, string>[]): K | null {
  const v = norm(value);
  for (const table of tables) {
    for (const [key, word] of Object.entries(table) as [K, string][]) if (norm(word) === v) return key;
  }
  return null;
}

/** `@ana`, `Ana Lima`, `#geral`: the one person, agent or place it names (handle, then the whole name). */
function findActor(value: string, actors: readonly SearchActor[]) {
  const v = norm(value.replace(/^@/, ""));
  return actors.find((a) => a.handle && norm(a.handle) === v) ?? actors.find((a) => norm(a.name) === v) ?? null;
}
function findPlace(value: string, places: readonly SearchPlace[]) {
  const v = norm(value.replace(/^[#@]/, ""));
  return places.find((p) => norm(p.name) === v) ?? null;
}

/** Splits on spaces, keeping `"two words"` (also after `op:`) together. */
function tokens(input: string): string[] {
  return input.match(/(?:[^\s"]+:)?"[^"]*"?|\S+/g) ?? [];
}
const unquote = (s: string) => s.replace(/^"|"$/g, "");

/** The chip `op:value` makes, or null when the value names nothing known. */
function chipFor(op: SearchOp, raw: string, dir: SearchDirectory, words: SearchWords[]): SearchChip | null {
  const value = unquote(raw).trim();
  switch (op) {
    case "from":
    case "mentions": {
      const actor = findActor(value, dir.actors);
      return actor ? { op, actor } : null;
    }
    case "in": {
      const place = findPlace(value, dir.places);
      return place ? { op, place } : null;
    }
    case "has": {
      const has = lookup(
        value,
        words.map((w) => w.has),
      );
      return has ? { op, value: has } : null;
    }
    case "author": {
      const author = lookup(
        value,
        words.map((w) => w.author),
      );
      return author ? { op, value: author } : null;
    }
    case "before":
    case "after":
    case "during":
      return periodOf(value) ? { op, value } : null;
    case "pinned":
      return { op };
  }
}

/** The operator `word` names, in English or the person's language. */
// Chinese, Japanese and Korean IMEs type the full-width colon by default; same length, so offsets hold.
const asciiColon = (s: string) => s.replace(/\uFF1A/g, ":");

const opOf = (word: string, words: SearchWords[]) =>
  lookup(
    word,
    words.map((w) => w.ops),
  );

/**
 * What a typed search holds: the chips its operators make and the words left. An operator whose value names
 * nothing known (`from:nobody`) stays in the words, as typed. `pinned:` takes any value (`pinned:true`).
 */
export function parseSearch(
  input: string,
  dir: SearchDirectory,
  local?: SearchWords,
): { chips: SearchChip[]; text: string } {
  const words = local ? [ENGLISH_SEARCH_WORDS, local] : [ENGLISH_SEARCH_WORDS];
  const chips: SearchChip[] = [];
  const text: string[] = [];
  for (const token of tokens(input)) {
    const t = asciiColon(token);
    const at = t.indexOf(":");
    const op = at > 0 ? opOf(t.slice(0, at), words) : null;
    const chip = op ? chipFor(op, t.slice(at + 1), dir, words) : null;
    if (chip) chips.push(chip);
    else text.push(token);
  }
  return { chips: dedupe(chips), text: text.join(" ") };
}

/** What makes two chips the same filter. */
export const searchChipKey = (c: SearchChip) => {
  switch (c.op) {
    case "from":
    case "mentions":
      return `${c.op}:${c.actor.type}:${c.actor.id}`;
    case "in":
      return `in:${c.place.id}`;
    case "pinned":
      return "pinned";
    default:
      // One date per operator, one author type: the last typed wins.
      return c.op === "has" ? `has:${c.value}` : c.op;
  }
};

/** Who and where: a DM's search offers neither, the DM is both. */
const WHO_OR_WHERE = new Set<SearchOp>(["from", "mentions", "in", "author"]);
export const DM_SEARCH_OPS: readonly SearchOp[] = SEARCH_OPS.filter((op) => !WHO_OR_WHERE.has(op));

/** Whether a chip may stand in a search held to one DM: its own `in:` chip, and no other who or where. */
export const chipFitsDm = (c: SearchChip, placeId: string) =>
  c.op === "in" ? c.place.id === placeId : !WHO_OR_WHERE.has(c.op);

/** A search held to one DM: its `in:` chip first, then the chips that fit it. */
export const inDmOnly = (chips: readonly SearchChip[], place: SearchPlace): SearchChip[] => [
  { op: "in", place },
  ...chips.filter((c) => c.op !== "in" && chipFitsDm(c, place.id)),
];

/** Each chip once; for a date operator and `author:` the last one wins. */
export function dedupe(chips: SearchChip[]): SearchChip[] {
  const byKey = new Map<string, SearchChip>();
  for (const c of chips) {
    byKey.delete(searchChipKey(c));
    byKey.set(searchChipKey(c), c);
  }
  return [...byKey.values()];
}

const quoted = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);

/** A search written back as text with English operators (a recent search, re-read by `parseSearch`). */
export function formatSearch(chips: readonly SearchChip[], text: string): string {
  const parts = chips.map((c) => {
    switch (c.op) {
      case "from":
      case "mentions":
        return `${c.op}:${c.actor.handle ? `@${c.actor.handle}` : quoted(c.actor.name)}`;
      case "in":
        return `in:${quoted(c.place.name)}`;
      case "pinned":
        return "pinned:true";
      default:
        return `${c.op}:${c.value}`;
    }
  });
  return [...parts, text.trim()].filter(Boolean).join(" ");
}

/** The sort shown when the person picked none: by relevance with words, newest first without. */
export const searchSortFor = (sort: SearchSort | null, text: string): SearchSort =>
  sort ?? (text.trim() ? "relevance" : "newest");

/** What the search API is asked for these chips (ADR 0123). */
export function searchFilterInput(chips: readonly SearchChip[], sort?: SearchSort): SearchFilterInput {
  const out: SearchFilterInput = {};
  const push = (key: "in" | "fromUsers" | "fromAgents" | "mentionsUsers" | "mentionsAgents", id: string) => {
    out[key] = [...(out[key] ?? []), id];
  };
  for (const c of chips) {
    switch (c.op) {
      case "from":
        push(c.actor.type === "agent" ? "fromAgents" : "fromUsers", c.actor.id);
        break;
      case "mentions":
        push(c.actor.type === "agent" ? "mentionsAgents" : "mentionsUsers", c.actor.id);
        break;
      case "in":
        push("in", c.place.id);
        break;
      case "has":
        out.has = [...(out.has ?? []), c.value];
        break;
      case "author":
        out.author = c.value;
        break;
      case "pinned":
        out.pinned = true;
        break;
      case "before": {
        const p = periodOf(c.value);
        if (p) out.before = p.start.toISOString();
        break;
      }
      case "after": {
        const p = periodOf(c.value);
        if (p) out.after = p.end.toISOString();
        break;
      }
      case "during": {
        const p = periodOf(c.value);
        if (p) {
          out.after = p.start.toISOString();
          out.before = p.end.toISOString();
        }
        break;
      }
    }
  }
  if (sort) out.sort = sort;
  return out;
}

/**
 * The operator being typed at the end of the box (`from:an`, `in:`), for its picker; null when the last word isn't
 * one. `value` is what follows the colon so far.
 */
export function typingOperator(
  input: string,
  local?: SearchWords,
): { op: SearchOp; value: string; start: number } | null {
  const m = /(?:^|\s)([^\s:"]+):("?[^\s"]*)$/.exec(asciiColon(input));
  if (!m?.[1]) return null;
  const op = opOf(m[1], local ? [ENGLISH_SEARCH_WORDS, local] : [ENGLISH_SEARCH_WORDS]);
  if (!op) return null;
  return { op, value: unquote(m[2] ?? ""), start: input.length - m[1].length - 1 - (m[2] ?? "").length };
}

/** People and agents (handle or name) or places whose name starts a word with `value`, at most `max`. */
export function suggestActors(value: string, actors: readonly SearchActor[], max = 8) {
  const v = norm(value.replace(/^@/, ""));
  return actors
    .filter((a) => !v || [a.handle ?? "", ...a.name.split(/\s+/)].some((w) => norm(w).startsWith(v)))
    .slice(0, max);
}
export function suggestPlaces(value: string, places: readonly SearchPlace[], max = 8) {
  const v = norm(value.replace(/^[#@]/, ""));
  return places.filter((p) => !v || p.name.split(/[\s-]+/).some((w) => norm(w).startsWith(v))).slice(0, max);
}

/** Recent searches: the newest first, each once, at most `max`. */
export function rememberSearch(recent: readonly string[], search: string, max = 8): string[] {
  const s = search.trim();
  if (!s) return [...recent];
  return [s, ...recent.filter((r) => r !== s)].slice(0, max);
}

/** Whether there is anything to search: words or a chip. */
export const hasSearch = (chips: readonly SearchChip[], text: string) => chips.length > 0 || text.trim().length > 0;

/** Message hits grouped by their channel, groups in the order their first hit came. */
export function groupByChannel<H extends { channelIds: string[] }>(hits: readonly H[]): [string, H[]][] {
  const groups = new Map<string, H[]>();
  for (const h of hits) {
    const id = h.channelIds[0] ?? "";
    groups.set(id, [...(groups.get(id) ?? []), h]);
  }
  return [...groups];
}

/** Message hits by where they were said: a thread's replies under the thread, the rest under their channel. */
export function groupHitsByPlace<
  H extends { channelIds: string[]; messageId?: string | null; threadId?: string | null; threadTitle?: string | null },
>(hits: readonly H[]): { key: string; channelId: string; thread: { id: string; title: string } | null; hits: H[] }[] {
  const groups = new Map<
    string,
    { key: string; channelId: string; thread: { id: string; title: string } | null; hits: H[] }
  >();
  for (const h of hits) {
    const channelId = h.channelIds[0] ?? "";
    const threadId = h.threadId && h.threadId !== h.messageId ? h.threadId : null;
    const key = threadId ? `thread:${threadId}` : channelId;
    const group = groups.get(key) ?? {
      key,
      channelId,
      thread: threadId ? { id: threadId, title: h.threadTitle ?? "" } : null,
      hits: [],
    };
    group.hits.push(h);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The words of a search, unquoted, for `markTerms`. */
export const searchTerms = (text: string) =>
  text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter(Boolean);

/**
 * `text` cut where it holds one of `terms` (any case, any accents), the found parts `mark`ed: "o Convite" with
 * ["convite"] → [{ text: "o " }, { text: "Convite", mark: true }].
 */
export function markTerms(text: string, terms: readonly string[]): { text: string; mark?: boolean }[] {
  // The folded text, and where each of its units came from in `text` (folding can change a character's length).
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const f = norm(ch);
    for (let k = 0; k < f.length; k++) from.push(i);
    folded += f;
    i += ch.length;
  }
  from.push(text.length);
  const ranges: [number, number][] = [];
  for (const term of terms.map(norm).filter(Boolean)) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      ranges.push([from[at] ?? 0, from[at + term.length] ?? text.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out: { text: string; mark?: boolean }[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) out.push({ text: text.slice(pos, start) });
    out.push({ text: text.slice(start, end), mark: true });
    pos = end;
  }
  if (pos < text.length || out.length === 0) out.push({ text: text.slice(pos) });
  return out;
}

/** This language's search words (the box reads them besides English's). */
export function searchWords(t: TFunction): SearchWords {
  return {
    ops: Object.fromEntries(SEARCH_OPS.map((op) => [op, t(`searchPage.words.ops.${op}`)])) as Record<SearchOp, string>,
    has: Object.fromEntries(SEARCH_HAS.map((h) => [h, t(`searchPage.words.has.${h}`)])) as Record<SearchHas, string>,
    author: { person: t("searchPage.words.author.person"), agent: t("searchPage.words.author.agent") },
  };
}

/** A date chip's value as people read it: a day, a month or a year in the person's locale. */
function periodLabel(value: string, locale: string) {
  const p = periodOf(value);
  if (!p) return value;
  const parts = value.split("-").length;
  const options: Intl.DateTimeFormatOptions =
    parts === 3 ? { dateStyle: "medium" } : parts === 2 ? { month: "long", year: "numeric" } : { year: "numeric" };
  return new Intl.DateTimeFormat(locale, options).format(p.start);
}

/** A chip as people read it: "from: Lia", "in: #geral", "has: File", "Pinned". */
export function searchChipLabel(t: TFunction, locale: string, c: SearchChip): string {
  const op = (word: string) => `${t(`searchPage.words.ops.${c.op}`)}: ${word}`;
  switch (c.op) {
    case "from":
    case "mentions":
      return op(c.actor.name);
    case "in":
      return op(c.place.dm ? c.place.name : `#${c.place.name}`);
    case "has":
      return op(t(`searchPage.hasLabel.${c.value}`));
    case "author":
      return op(t(`searchPage.authorLabel.${c.value}`));
    case "pinned":
      return t("searchPage.pinnedChip");
    default:
      return op(periodLabel(c.value, locale));
  }
}
