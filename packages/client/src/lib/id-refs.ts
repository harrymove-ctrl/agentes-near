/**
 * Internal ids written in a text (web and phone): an agent's "artifact 0193…", a task's or a run's id. Each is a part
 * of its own, so the text shows the pill of what it names (`useIdRef`: a file, a task, a message) instead of the id,
 * and the word that only names its kind ("artifact", "id:") goes with it. An id that names nothing the viewer sees
 * stays as written: a person's own (an order's, a row's) is theirs to read.
 */

import { internalIds } from "./markdown";

/** A piece of text: words, or an id with the words that name its kind (`text`, shown as is when nothing resolves). */
export type IdRefPart = { text: string; id?: undefined } | { text: string; id: string };

/**
 * A text split around its ids ("ver artifact 0193….” → "ver ", "artifact 0193…" (0193…), "."). One inside an address
 * written without its scheme (`exemplo.com/x/0193…`, `?id=0193…`) stays words.
 */
export function splitIdRefs(text: string): IdRefPart[] {
  const out: IdRefPart[] = [];
  let last = 0;
  for (const m of internalIds(text)) {
    if (m.at > last) out.push({ text: text.slice(last, m.at) });
    out.push({ text: m.text, id: m.id });
    last = m.at + m.text.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The id a `code` span holds when it holds only one (with its kind's word): agents write ids that way too. */
export function loneIdRef(code: string): string | null {
  const [only, ...more] = internalIds(code.trim());
  return only && more.length === 0 && only.text === code.trim() ? only.id : null;
}
