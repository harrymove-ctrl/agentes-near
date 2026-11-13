import type { Message } from "../api/types";
import { parseMarkdown, plainLines } from "./markdown";

/**
 * A long message from one agent to another in a conversation (ADR 0034): the apps show its first paragraph and
 * "Ler tudo · mais N linhas", which opens the whole message in its thread (the panel beside the chat on the web,
 * the thread's screen on the phone). Messages to people stay whole, and so does everything inside a thread view.
 */

/** About how many characters fit on one line of a message: the web's column and the phone's. */
export const TALK_LINE_CHARS = { web: 96, phone: 40 } as const;

/** Below this many lines (as drawn) a message stays whole. */
const FOLD_MIN_LINES = 12;
/** What the fold hides must be worth a click. */
const FOLD_MIN_MORE = 4;
/** A first paragraph longer than this is cut at a word, with "…". */
const LEAD_MAX_CHARS = 360;

const OPENING_MENTION = /^\s*@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/;

/**
 * An agent's message to another agent: it answers another agent's message (`meta.toAgent`, set by the server on
 * every message of a run that agent's message started; `meta.joined` before it), or it opens by mentioning another
 * agent ("@Iris, …"). `agentOf` reads a handle as an agent's id.
 */
export function talksToAgent(
  m: Pick<Message, "author" | "body" | "meta">,
  agentOf: (handle: string) => string | undefined,
): boolean {
  if (m.author.type !== "agent") return false;
  const self = m.author.id;
  const to = m.meta?.toAgent;
  if (typeof to === "string" && to !== self) return true;
  if (m.meta?.joined === true) return true;
  const handle = m.body.match(OPENING_MENTION)?.[1];
  const id = handle ? agentOf(handle.toLowerCase()) : undefined;
  return Boolean(id && id !== self);
}

export interface TalkFold {
  /** The first paragraph, as Markdown (its mentions and marks kept); plain text when the message opens otherwise. */
  lead: string;
  /** About how many more lines the whole message has. */
  more: number;
}

/** About how many lines `text` takes at `perLine` characters a line. */
const linesOf = (text: string, perLine: number) =>
  text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.trim().length / perLine)), 0);

/** Cut at the last word before `max`, with "…". */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = head.lastIndexOf(" ");
  return `${(at > max * 0.6 ? head.slice(0, at) : head).trimEnd()}…`;
}

/**
 * A long text folded to its first paragraph, or null when it is short enough to read whole. `perLine` is how
 * many characters a line holds where it is drawn (`TALK_LINE_CHARS`): the same message folds sooner on a phone.
 */
export function foldTalk(source: string, perLine: number): TalkFold | null {
  const blocks = parseMarkdown(source, { breaks: true });
  const sizes = blocks.map((b) => {
    switch (b.type) {
      case "paragraph":
      case "heading":
        return linesOf(b.text, perLine);
      case "quote":
        return linesOf(b.lines.join("\n"), perLine);
      case "list":
        return b.items.reduce((n, item) => n + linesOf(item, perLine - 2), 0);
      case "code":
        return b.text.split("\n").length + 1;
      case "table":
        return b.rows.length + 2;
      case "embed":
        return 8;
      default:
        return 1;
    }
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  const [first] = blocks;
  if (!first || total < FOLD_MIN_LINES) return null;
  // A paragraph first: it, as written. Anything else first (a heading, a list, code): its first line of prose.
  const lead = first.type === "paragraph" ? first.text : (plainLines(source)[0] ?? "");
  if (!lead.trim()) return null;
  const shown = cut(lead.trim(), LEAD_MAX_CHARS);
  const more = total - linesOf(shown, perLine);
  return more < FOLD_MIN_MORE ? null : { lead: shown, more };
}
