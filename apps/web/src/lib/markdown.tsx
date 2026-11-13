import { splitChannelRefs } from "@agenteschat/client/lib/channel-refs";
import { loneIdRef, splitIdRefs } from "@agenteschat/client/lib/id-refs";
import { linkPill } from "@agenteschat/client/lib/link-pills";
import {
  codeAndBoldParts,
  headingId,
  INLINE,
  MENTION,
  parseMarkdown,
  parseWikiToken,
  SAFE_URL,
} from "@agenteschat/client/lib/markdown";
import { parseFileLink, parseMessageLink } from "@agenteschat/client/lib/message-links";
import { type ReactNode, useMemo } from "react";
import { FileRef } from "@/chat/FileRef";
import { LinkPill } from "@/chat/LinkPill";
import { MessageRef } from "@/chat/MessageRef";
import { MermaidOrCode } from "@/components/artifacts/Mermaid";
import { ChartOrCode } from "@/components/ChartBlock";
import { CodeBlock } from "@/components/CodeBlock";
import { TableBox } from "@/components/TableBox";

/**
 * A small, safe Markdown renderer for chat messages and artifact documents
 * (the parser is shared: `@agenteschat/client/lib/markdown`). It builds React
 * elements only: raw HTML in the source is shown as text, never interpreted.
 * Links allow http(s) and mailto. In messages, line breaks are kept and
 * @mentions become our mention chips.
 */
export * from "@agenteschat/client/lib/markdown";

export type MentionRenderer = (handle: string, key: string) => ReactNode;
/** `#name` (lower case): a channel link, or the text as written (`#Name`) when it means no channel. */
export type ChannelRenderer = (name: string, text: string, key: string) => ReactNode;
/** `[[Título]]` or `[[Título|texto]]`: how a wiki link shows (a chip, a dashed missing link…). */
export type WikiLinkRenderer = (title: string, label: string, key: string) => ReactNode;
/** `![[foto.png]]`: how an embed shows (`block` alone on its line, else inside a sentence). */
export type EmbedRenderer = (target: string, key: string, block: boolean) => ReactNode;
/**
 * An internal id in the words (`splitIdRefs`) or alone in a `code` span (`loneIdRef`): the pill of what it names, or
 * `text` as written (`shown`, the code span, when it was one).
 */
export type IdRenderer = (id: string, text: string, key: string, shown?: ReactNode) => ReactNode;

/** Internal ids first (`idRef`), then `#channel` references, then @mentions. */
function withRefs(
  text: string,
  key: string,
  mention?: MentionRenderer,
  channel?: ChannelRenderer,
  idRef?: IdRenderer,
): ReactNode[] {
  const parts = idRef ? splitIdRefs(text) : [];
  if (idRef && parts.some((p) => p.id !== undefined)) {
    return parts.flatMap((part, i) =>
      part.id === undefined
        ? withRefs(part.text, `${key}-x${i}`, mention, channel)
        : [idRef(part.id, part.text, `${key}-id${i}`)],
    );
  }
  if (!channel) return withMentions(text, key, mention);
  return splitChannelRefs(text).flatMap((part, i) =>
    part.name === undefined
      ? withMentions(part.text, `${key}-c${i}`, mention)
      : [channel(part.name, part.text, `${key}-ch${i}`)],
  );
}

function withMentions(text: string, key: string, mention?: MentionRenderer): ReactNode[] {
  if (!mention) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    if (start > last) out.push(text.slice(last, start));
    out.push(mention(m[2] ?? "", `${key}-m${n++}`));
    last = start + 1 + (m[2]?.length ?? 0);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A link opens in a new tab; one to a message or a file here (`parseMessageLink`, `parseFileLink`) is its pill, opening
 * in the app. `bare`: an
 * address written as it is, shown as its service's pill when its shape is known (`linkPill`).
 */
function link(href: string, key: string, children: ReactNode, bare = false) {
  const message = parseMessageLink(href, [window.location.origin]);
  if (message) return <MessageRef key={key} link={message} />;
  const file = parseFileLink(href, [window.location.origin]);
  if (file) return <FileRef key={key} link={file} />;
  const pill = bare ? linkPill(href) : null;
  if (pill) return <LinkPill key={key} href={href} pill={pill} />;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="ac-link">
      {children}
    </a>
  );
}

export function renderInline(
  text: string,
  key = "i",
  mention?: MentionRenderer,
  wiki?: WikiLinkRenderer,
  embed?: EmbedRenderer,
  channel?: ChannelRenderer,
  /** Bare addresses as pills. Off in a link's words. */
  pills = true,
  idRef?: IdRenderer,
): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  const inner = (t: string, k: string) => renderInline(t, k, mention, wiki, embed, channel, pills, idRef);
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push(...withRefs(rest, `${key}-t${n}`, mention, channel, idRef));
      break;
    }
    const tok = m[0];
    // The text before this token keeps the key it had as the trailing text, so its words stay on screen as they are;
    // the text after takes the next one. Two pieces with one key leave the old words behind in the DOM.
    const textKey = `${key}-t${n}`;
    const k = `${key}-${n++}`;
    // `![[…]]` inside a sentence: the "!" belongs to the embed.
    const isEmbed = Boolean(m[6] && embed && m.index > 0 && rest[m.index - 1] === "!");
    const before = rest.slice(0, isEmbed ? m.index - 1 : m.index);
    if (before) out.push(...withRefs(before, textKey, mention, channel, idRef));
    if (isEmbed && embed) {
      out.push(embed(parseWikiToken(tok).title, k, false));
      rest = rest.slice(m.index + tok.length);
      continue;
    }
    if (m[1]) {
      const code = (
        <code key={k} className="ac-inlinecode">
          {tok.slice(1, -1)}
        </code>
      );
      const id = idRef ? loneIdRef(tok.slice(1, -1)) : null;
      out.push(id && idRef ? idRef(id, tok.slice(1, -1), k, code) : code);
    } else if (m[2]) out.push(<strong key={k}>{inner(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inner(tok.slice(1, -1), k)}</em>);
    else if (m[7]) out.push(<del key={k}>{inner(tok.slice(2, -2), k)}</del>);
    else if (m[4]) {
      const parts = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = parts?.[2] ?? "";
      const label = parts?.[1] ?? "";
      const own = renderInline(label, k, mention, wiki, undefined, undefined, false);
      out.push(SAFE_URL.test(href) ? link(href, k, own, pills && label === href) : tok);
    } else if (m[6]) {
      const { title, label } = parseWikiToken(tok);
      out.push(
        wiki ? (
          wiki(title, label, k)
        ) : (
          <span key={k} className="wiki-link">
            {label}
          </span>
        ),
      );
    } else out.push(link(tok, k, tok, pills));
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

/**
 * An agent's own words on a card (its reason, a question, a summary, a value it wrote) as formatted text: code between
 * backticks, bold, links, never address pills. A node passes through as it is.
 */
export function inlineWords(words: ReactNode, key = "w"): ReactNode {
  return typeof words === "string"
    ? renderInline(words, key, undefined, undefined, undefined, undefined, false)
    : words;
}

/** Code between backticks and **bold**, nothing else: words inside a control (an option, a button), where no link can go. */
export function codeAndBold(text: string, key = "cb"): ReactNode[] {
  return codeAndBoldParts(text).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.mark === "code")
      return (
        <code key={k} className="ac-inlinecode">
          {part.text}
        </code>
      );
    if (part.mark === "bold") return <b key={k}>{part.text}</b>;
    return part.text;
  });
}

export interface MarkdownProps {
  source: string;
  /**
   * `document` (artifacts): real headings, wrapped in `.md`.
   * `message` (chat): line breaks kept, headings as bold lines, no wrapper.
   */
  variant?: "document" | "message";
  mention?: MentionRenderer;
  /** `#channel` references (chat); without it they stay text. */
  channel?: ChannelRenderer;
  wikiLink?: WikiLinkRenderer;
  /** Obsidian embeds (`![[file]]`); without it they show as a plain link. */
  embed?: EmbedRenderer;
  /** Internal ids in the words (what agents write: chat, tasks, the wiki); without it they stay text. */
  idRef?: IdRenderer;
  /** Skip a leading `# Title` equal to this (the page shows the title itself). */
  title?: string;
  /** The first lines of a page (a link's hover card): its ```mermaid blocks stay code, the cut may have split one. */
  excerpt?: boolean;
  /** Added to the wrapper. */
  className?: string;
  /** The blocks without a wrapper of their own: a `<details>`'s body, inside its parent's. */
  bare?: boolean;
}

const TASK = /^\[( |x|X)\]\s+(.*)$/;
const CALLOUT = /^\[!([\w-]+)\][+-]?\s*(.*)$/i;
/** Obsidian's callout kinds, in our three looks. */
const calloutKind = (kind: string) =>
  /^(warning|caution|attention|danger|error|bug|failure|fail|missing|important)$/.test(kind)
    ? "warning"
    : /^(tip|hint|success|check|done)$/.test(kind)
      ? "tip"
      : "note";

export function Markdown({
  source,
  variant = "document",
  mention,
  channel,
  wikiLink,
  embed,
  idRef,
  title,
  excerpt,
  className,
  bare,
}: MarkdownProps) {
  const message = variant === "message";
  const inline = (text: string, k: string) =>
    renderInline(text, k, mention, wikiLink, embed, channel, undefined, idRef);
  // Parsed once per source (a streaming row re-renders every reveal frame); never mutated.
  const all = useMemo(() => parseMarkdown(source, { breaks: message, details: true }), [source, message]);
  const [first] = all;
  const parsed =
    title && first?.type === "heading" && first.level === 1 && first.text.trim() === title.trim() ? all.slice(1) : all;
  const blocks = parsed.map((b, i) => {
    const k = `b${i}`;
    switch (b.type) {
      case "heading": {
        if (message) {
          // Opens a section (more air above), still a bold line rather than a document heading.
          return (
            <p key={k} className="md__h">
              <strong>{inline(b.text, k)}</strong>
            </p>
          );
        }
        const H = `h${Math.min(6, b.level + 1)}` as "h2";
        return (
          <H key={k} id={`h-${headingId(b.text)}`}>
            {inline(b.text, k)}
          </H>
        );
      }
      case "paragraph":
        return <p key={k}>{inline(b.text, k)}</p>;
      case "code": {
        const lang = b.lang.toLowerCase();
        if (lang === "chart") return <ChartOrCode key={k} text={b.text} />;
        if (lang === "mermaid" && !excerpt) return <MermaidOrCode key={k} text={b.text} />;
        return <CodeBlock key={k} lang={b.lang} text={b.text} />;
      }
      case "list": {
        const L = b.ordered ? "ol" : "ul";
        return (
          <L key={k}>
            {b.items.map((item, j) => {
              // "- [ ] tarefa" / "- [x] feita": a task with our own (read-only) box.
              const task = item.match(TASK);
              if (task) {
                const done = task[1] !== " ";
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  <li key={j} className="md__task" data-done={done || undefined}>
                    <span className="md__task-box" role="img" aria-label={done ? "✓" : "○"} />
                    <span>{inline(task[2] ?? "", `${k}-${j}`)}</span>
                  </li>
                );
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              return <li key={j}>{inline(item, `${k}-${j}`)}</li>;
            })}
          </L>
        );
      }
      case "quote": {
        // "> [!note] Título" + lines → a callout (neutral card with an icon), as in Obsidian.
        const callout = (b.lines[0] ?? "").match(CALLOUT);
        if (callout && !message) {
          const kind = calloutKind((callout[1] ?? "note").toLowerCase());
          const rest = b.lines.slice(1).join(" ").trim();
          return (
            <aside key={k} className="md__callout" data-kind={kind}>
              {callout[2] ? <b className="md__callout-title">{inline(callout[2], `${k}t`)}</b> : null}
              {rest ? <span className="md__callout-body">{inline(rest, `${k}b`)}</span> : null}
            </aside>
          );
        }
        return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
      }
      case "embed":
        return embed ? embed(b.target, k, true) : <p key={k}>{inline(`[[${b.target}]]`, k)}</p>;
      case "rule":
        return <hr key={k} />;
      case "details":
        // Closed until the reader opens it (ADR 0147): what only some want to read.
        return (
          <details key={k} className="md__details">
            <summary>{b.summary ? inline(b.summary, `${k}s`) : "…"}</summary>
            <Markdown
              source={b.body}
              variant={variant}
              mention={mention}
              channel={channel}
              wikiLink={wikiLink}
              embed={embed}
              idRef={idRef}
              excerpt={excerpt}
              bare
            />
          </details>
        );
      case "table":
        return (
          <TableBox key={k}>
            <table>
              <thead>
                <tr>
                  {b.header.map((h, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static table
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {inline(h, `${k}-h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static table
                  <tr key={j}>
                    {r.map((c, x) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static table
                      <td key={x} style={{ textAlign: b.align[x] }}>
                        {inline(c, `${k}-${j}-${x}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableBox>
        );
    }
    return null;
  });
  if (bare) return <>{blocks}</>;
  const extra = className ? ` ${className}` : "";
  return message ? (
    <div className={`md md--message${extra}`}>{blocks}</div>
  ) : (
    <div className={`md${extra}`}>{blocks}</div>
  );
}
