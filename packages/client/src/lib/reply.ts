import type { ArtifactRef, Message, ReplyRef } from "../api/types";
import { artifactRefs } from "./artifacts";
import { plainLine } from "./markdown";
import { mediaKindOf, messageMediaOf } from "./media";
import { voiceOf } from "./voice";

/** Same rule as the server (`replyExcerpt`): one line of plain words, ~200 characters. */
export function quoteExcerpt(body: string, max = 200): string {
  const line = plainLine(body);
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `meta.replyTo` when it is well formed. */
export function replyOf(meta: Record<string, unknown> | undefined): ReplyRef | null {
  const r = meta?.replyTo;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.messageId !== "string" || typeof o.excerpt !== "string") return null;
  const author = o.author as ReplyRef["author"] | undefined;
  // A quoted GIF or sticker (ADR 0091): its kind, however the server wrote it ("gif", { kind }, `mediaKind`).
  const media = mediaKindOf(o.media) ?? mediaKindOf(o.mediaKind);
  return {
    messageId: o.messageId,
    threadId: typeof o.threadId === "string" ? o.threadId : null,
    author:
      author && (author.type === "person" || author.type === "agent")
        ? { type: author.type, id: typeof author.id === "string" ? author.id : null }
        : { type: "person", id: null },
    authorName: typeof o.authorName === "string" ? o.authorName : "",
    excerpt: o.excerpt,
    ...(media ? { media } : {}),
    ...(o.deleted === true ? { deleted: true } : {}),
  };
}

/** The optimistic `meta` of a message being sent (the server writes the real one). */
export function localMeta(quote: Message | null, authorName: string, files: ArtifactRef[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (quote) {
    // Quoting a GIF or a sticker: the quote names it until the server's copy comes (ADR 0091).
    const voice = voiceOf(quote.meta);
    const media = voice ? ("voice" as const) : messageMediaOf(quote.meta)?.kind;
    meta.replyTo = {
      messageId: quote.id,
      threadId: quote.threadId,
      author: quote.author,
      authorName,
      // A quote of a voice message names it: its words never travel.
      excerpt: voice ? "" : quoteExcerpt(quote.body || (artifactRefs(quote.meta)[0]?.title ?? "")),
      ...(media ? { media } : {}),
    } satisfies ReplyRef;
  }
  if (files.length > 0) meta.artifacts = files;
  return meta;
}
