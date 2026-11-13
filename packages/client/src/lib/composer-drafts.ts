/**
 * What a person typed in a conversation's composer and didn't send, kept on this device so switching
 * conversations or reloading doesn't lose it. One book per person (JSON, by conversation key); the app stores it
 * where it likes (`localStorage` on the web). A blank text removes its entry, old entries go after `DRAFT_TTL_MS`,
 * and the book keeps the `MAX_DRAFTS` most recent ones.
 */
export interface ComposerDraft {
  text: string;
  /** When it was last typed (ms). */
  at: number;
}

export type DraftBook = Record<string, ComposerDraft>;

export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DRAFTS = 100;

/** The conversation a composer writes to: a thread's own, else its channel's (a DM is a channel). */
export const draftKeyOf = (channelId: string, threadId?: string | null) =>
  threadId ? `thread:${threadId}` : `channel:${channelId}`;

/** The book saved as `raw` (nothing, broken or anything else: empty), without expired entries. */
export function readDraftBook(raw: string | null, now: number): DraftBook {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const book: DraftBook = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || typeof at !== "number" || !text.trim()) continue;
    if (now - at > DRAFT_TTL_MS) continue;
    book[key] = { text, at };
  }
  return book;
}

/** The book with `key`'s text set (or removed when blank), trimmed to the most recent `MAX_DRAFTS`. */
export function withDraft(book: DraftBook, key: string, text: string, now: number): DraftBook {
  const next: DraftBook = { ...book };
  if (text.trim()) next[key] = { text, at: now };
  else delete next[key];
  const keys = Object.keys(next);
  if (keys.length <= MAX_DRAFTS) return next;
  const kept = keys.sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0)).slice(0, MAX_DRAFTS);
  return Object.fromEntries(kept.map((k) => [k, next[k] as ComposerDraft]));
}
