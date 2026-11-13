/**
 * The `#channel` reference rules shared by the server (`parseChannelNames`), the apps' renderer
 * (`@agenteschat/client/lib/channel-refs`) and both composers, so what one suggests the others recognise.
 */

/**
 * `#name` after a space or punctuation, never `a#b`, `&#39;` or `##`. It holds a letter, so `PR #123` or `#42` stays
 * an issue number even where a channel is named with digits only.
 */
export const CHANNEL_REF = /(^|[^\w#&/])#(?=[\w-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})(?![\w-])/g;

/** "#que" right before the caret (start of text or after a space or bracket); null when not typing one. */
export function channelQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[\s(])#([a-zA-Z0-9_-]{0,80})$/);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The text with "#name " in place of the "#que" being typed, and where the caret goes. */
export function insertChannelRef(
  text: string,
  token: { start: number; query: string },
  name: string,
): { text: string; caret: number } {
  const end = token.start + 1 + token.query.length;
  const inserted = `#${name} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(end).replace(/^ /, ""),
    caret: token.start + inserted.length,
  };
}
