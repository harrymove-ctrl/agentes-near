/**
 * Message text → tokens: fenced code blocks, inline code and @mentions.
 * Everything else is plain text (no HTML is ever interpreted). Mono only for
 * real code (design README).
 */
export type BodyToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "codeblock"; text: string }
  | { type: "mention"; handle: string };

/** Same rule as the backend (`parseMentionHandles`): emails are not mentions. */
const MENTION = /(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g;

function inline(text: string, out: BodyToken[]) {
  const parts = text.split(/(`[^`\n]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ type: "code", text: part.slice(1, -1) });
      continue;
    }
    let last = 0;
    for (const match of part.matchAll(MENTION)) {
      const prefix = match[1] ?? "";
      const start = (match.index ?? 0) + prefix.length;
      if (start > last) out.push({ type: "text", text: part.slice(last, start) });
      out.push({ type: "mention", handle: match[2] ?? "" });
      last = start + 1 + (match[2]?.length ?? 0);
    }
    if (last < part.length) out.push({ type: "text", text: part.slice(last) });
  }
}

export function tokenizeBody(body: string): BodyToken[] {
  const out: BodyToken[] = [];
  const blocks = body.split(/```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/g);
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) out.push({ type: "codeblock", text: chunk.replace(/\n$/, "") });
    else if (chunk) inline(chunk, out);
  });
  // Merge adjacent text tokens.
  return out.reduce<BodyToken[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (tok.type === "text" && prev?.type === "text") prev.text += tok.text;
    else acc.push({ ...tok });
    return acc;
  }, []);
}
