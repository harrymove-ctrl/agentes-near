import { type MessageMedia, mediaOf } from "./media";

/** `meta.voice` of a message (ADR 0100): all the apps need to draw and play it. */
export interface MessageVoice {
  clipId: string;
  durationMs: number;
  peaks: number[];
  /** When the recording stops playing (ISO); absent: it stays. */
  expiresAt?: string;
  /** `body` is our placeholder, not what was said: never offered as the message's words. */
  noWords?: true;
}

/** A message's voice recording, if it is one. */
export function voiceOf(meta: Record<string, unknown> | null | undefined): MessageVoice | null {
  const v = meta?.voice as Partial<MessageVoice> | undefined;
  return v && typeof v.clipId === "string" && typeof v.durationMs === "number"
    ? {
        clipId: v.clipId,
        durationMs: v.durationMs,
        peaks: Array.isArray(v.peaks) ? v.peaks : [],
        ...(typeof v.expiresAt === "string" ? { expiresAt: v.expiresAt } : {}),
        ...(v.noWords === true ? { noWords: true as const } : {}),
      }
    : null;
}

/**
 * A message's text for what lists it (previews, notifications, quotes, snippets): none for a voice message (ADR 0100).
 * A notice's body is written for the agent, in English: only what people may read of it (a routine's report, a fast
 * reply, another agent's own answer), else nothing, as the chat's `noticeView` does. What happened on GitHub lists as
 * its line with who wrote it (the apps word it by `previewMeta`): the words alone, under the agent's name, would read
 * as the agent's.
 */
export const readableBody = (body: string, meta: Record<string, unknown> | null | undefined) => {
  if (voiceOf(meta)) return "";
  const notice = meta?.notice as { kind?: unknown; refs?: { answer?: unknown } } | undefined;
  if (!notice || typeof notice !== "object") return body;
  if (notice.kind === "routine_handoff" || notice.kind === "talker_reply" || notice.kind === "github_event")
    return body;
  return notice.kind === "consult_reply" && typeof notice.refs?.answer === "string" ? notice.refs.answer : "";
};

/** What a GitHub event's line says (`chat.notice.github.*`): the refs the apps word it by. */
const GITHUB_LINE_REFS = ["event", "item", "state", "who", "number", "repo", "agent", "asker", "answerFor"] as const;

/** One line of at most `max` chars (a preview's text). */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * What a last-message preview needs to show a server-written body in the reader's language (the same
 * `meta` keys the chat reads: `bodyCode`/`bodyParams`, a cut-off run's notes, memory lines, why an
 * agent has no AI, a GIF or a sticker), or null for a plain message. Long texts are cut: a preview is one line.
 */
export interface PreviewMeta {
  bodyCode?: string;
  bodyParams?: Record<string, unknown>;
  interrupted?: { text: string };
  brainInterrupted?: { brain?: string; text: string; tools?: string[] };
  memoryUpdates?: { action: string; text: string }[];
  noAi?: { reason: string; own?: string; why?: string };
  /** What a computer brain's wait is on, and a usage wait's state: the chat's words depend on them. */
  brainUnavailable?: Record<string, unknown>;
  usageWait?: Record<string, unknown>;
  /** A GIF or a sticker (ADR 0091), as `meta.media`: a message of only that has no text to preview. */
  media?: MessageMedia;
  /** A voice message (ADR 0100): its length, never its words. */
  voice?: { durationMs: number };
}

/**
 * A message of only a GIF or a sticker (ADR 0091): which, so a preview with no text says it in the reader's
 * language ("GIF", "Figurinha"); null for a message with text or without media.
 */
export function previewMediaKind(
  body: string | null | undefined,
  meta: Record<string, unknown> | null | undefined,
): MessageMedia["kind"] | "voice" | null {
  if (voiceOf(meta)) return "voice";
  return (body ?? "").trim() === "" ? (mediaOf(meta)?.kind ?? null) : null;
}

export function previewMeta(meta: Record<string, unknown> | null | undefined): PreviewMeta | null {
  if (!meta) return null;
  const out: PreviewMeta = {};
  if (typeof meta.bodyCode === "string") out.bodyCode = meta.bodyCode;
  const media = mediaOf(meta);
  if (media) out.media = media;
  const voice = voiceOf(meta);
  if (voice) out.voice = { durationMs: voice.durationMs };
  if (meta.bodyParams && typeof meta.bodyParams === "object") {
    out.bodyParams = meta.bodyParams as Record<string, unknown>;
  }
  const noAi = meta.noAi as { reason?: unknown; own?: unknown; why?: unknown } | undefined;
  if (out.bodyCode === "no_ai" && typeof noAi?.reason === "string") {
    out.noAi = {
      reason: noAi.reason,
      ...(typeof noAi.own === "string" ? { own: noAi.own } : {}),
      ...(typeof noAi.why === "string" ? { why: noAi.why } : {}),
    };
  }
  if (out.bodyCode && meta.brainUnavailable && typeof meta.brainUnavailable === "object") {
    out.brainUnavailable = meta.brainUnavailable as Record<string, unknown>;
  }
  if (out.bodyCode && meta.usageWait && typeof meta.usageWait === "object") {
    out.usageWait = meta.usageWait as Record<string, unknown>;
  }
  const cut = (v: unknown) => (typeof v === "string" ? oneLine(v) : null);
  const interrupted = meta.interrupted as { text?: unknown } | undefined;
  const iText = interrupted && typeof interrupted === "object" ? cut(interrupted.text) : null;
  if (iText !== null) out.interrupted = { text: iText };
  const b = meta.brainInterrupted as { brain?: unknown; text?: unknown; tools?: unknown } | undefined;
  const bText = b && typeof b === "object" ? cut(b.text) : null;
  if (b && bText !== null) {
    out.brainInterrupted = {
      text: bText,
      ...(typeof b.brain === "string" ? { brain: b.brain } : {}),
      ...(Array.isArray(b.tools) ? { tools: b.tools.filter((x): x is string => typeof x === "string") } : {}),
    };
  }
  if (out.bodyCode === "memory" && Array.isArray(meta.memoryUpdates)) {
    out.memoryUpdates = (meta.memoryUpdates as { action?: unknown; text?: unknown }[])
      .flatMap((u) =>
        u && typeof u.action === "string" && typeof u.text === "string"
          ? [{ action: u.action, text: oneLine(u.text) }]
          : [],
      )
      .slice(0, 3);
  }
  // A server-written body, so a push never quotes it as the agent's words (`pushQuote`).
  const notice = meta.notice as { kind?: unknown; text?: unknown; refs?: Record<string, unknown> } | undefined;
  if (notice?.kind === "github_event") {
    const said = cut(notice.text);
    out.bodyCode = "github_event";
    out.bodyParams = {
      ...Object.fromEntries(
        GITHUB_LINE_REFS.flatMap((k) => (typeof notice.refs?.[k] === "string" ? [[k, notice.refs[k]]] : [])),
      ),
      ...(said ? { said } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}
