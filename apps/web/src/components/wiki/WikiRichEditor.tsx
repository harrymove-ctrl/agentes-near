import type { WikiPageSummary } from "@agenteschat/client";
import { Button, Icon, type IconName, Kbd, Menu, MenuItem, modKey, useLocked } from "@agenteschat/ui";
import {
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { markdownFromRich, pastedHtml, pastedText, richFromMarkdown, wikiLinkHtml } from "@/lib/wiki-rich";

/** What the editor hands its page: the text as Markdown now (saving reads it), and the caret. */
export interface WikiRichEditorHandle {
  markdown: () => string;
  focus: () => void;
}

type Kind = "p" | "h2" | "h3" | "ul" | "ol" | "task" | "table" | "call" | "code" | "quote";
type Command = Kind | "bold" | "italic" | "strike" | "link" | "rule";

/** The blocks of the "/" menu and of the toolbar's selector: what each is called and does. */
/** A block's name in `wiki.rich.blocks`. */
type BlockKey =
  | "paragraph"
  | "heading"
  | "subheading"
  | "list"
  | "numbered"
  | "task"
  | "table"
  | "callout"
  | "code"
  | "quote"
  | "rule"
  | "link";

const BLOCKS: { cmd: Command; icon: IconName; key: BlockKey }[] = [
  { cmd: "p", icon: "document", key: "paragraph" },
  { cmd: "h2", icon: "page", key: "heading" },
  { cmd: "h3", icon: "page", key: "subheading" },
  { cmd: "ul", icon: "bulletList", key: "list" },
  { cmd: "ol", icon: "numberedList", key: "numbered" },
  { cmd: "task", icon: "checks", key: "task" },
  { cmd: "table", icon: "table", key: "table" },
  { cmd: "call", icon: "quote", key: "callout" },
  { cmd: "code", icon: "codeBlock", key: "code" },
  { cmd: "rule", icon: "dash", key: "rule" },
  { cmd: "link", icon: "link", key: "link" },
];

/** Each kind's name in `wiki.rich.blocks`. */
const KIND_KEY: Record<Kind, BlockKey> = {
  p: "paragraph",
  h2: "heading",
  h3: "subheading",
  ul: "list",
  ol: "numbered",
  task: "task",
  table: "table",
  call: "callout",
  code: "code",
  quote: "quote",
};

/** The kind of block the caret is in, for the selector and the pressed buttons. */
function kindAt(node: Node | null, root: HTMLElement): Kind {
  let el: Element | null = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  while (el && el !== root) {
    switch (el.tagName) {
      case "H1":
      case "H2":
        return "h2";
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "h3";
      case "LI":
        return el.classList.contains("md__task") ? "task" : el.parentElement?.tagName === "OL" ? "ol" : "ul";
      case "TD":
      case "TH":
        return "table";
      case "ASIDE":
        return "call";
      case "PRE":
        return "code";
      case "BLOCKQUOTE":
        return "quote";
    }
    el = el.parentElement;
  }
  return "p";
}

/** `[[que` or `/que` right before the caret, in the text node it sits in. */
function tokenAt(trigger: "[[" | "/"): { node: Text; start: number; end: number; query: string } | null {
  const sel = getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return null;
  const before = (node.textContent ?? "").slice(0, range.startOffset);
  const at = before.lastIndexOf(trigger);
  if (at < 0) return null;
  // "/" opens the blocks only at the start of a line or after a space (never inside a date or a path).
  if (trigger === "/" && at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + trigger.length);
  if (/[[\]\n]/.test(query) || query.length > 40 || (trigger === "/" && /\s/.test(query))) return null;
  return { node: node as Text, start: at, end: range.startOffset, query };
}

const exec = (command: string, value?: string) => {
  if (typeof document.execCommand === "function") document.execCommand(command, false, value);
};

/**
 * The wiki's visual editor: the page as it reads, editable in place, saved as Markdown (`@/lib/wiki-rich`). The
 * toolbar stays on top while the page scrolls (its selector names the block the caret is in; marks light up when
 * on); `[[` links a page, `/` lists the blocks, ⌘K links, ⌘S saves. Selected text can go to an agent ("Pedir a um
 * agente"); inside a table, rows and columns are one click away. Pastes come in as the page draws them.
 */
export const WikiRichEditor = forwardRef<
  WikiRichEditorHandle,
  {
    /** The Markdown it opens with (give the editor a new `key` to open another). */
    value: string;
    /** The page's title: a first `# Title` equal to it stays out of the text (the page shows it above). */
    title?: string;
    onChange: (markdown: string) => void;
    onSave: () => void;
    pages: WikiPageSummary[];
    label: string;
    autoFocus?: boolean;
    /** "Pedir a um agente" with the selected text (empty: the whole page). */
    onAsk?: (quote: string) => void;
  }
>(function WikiRichEditor({ value, title, onChange, onSave, pages, label, autoFocus = false, onAsk }, ref) {
  const { t } = useTranslation();
  const locked = useLocked();
  const box = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const doc = useRef<{ original: string; sources: string[]; snapshots: Map<number, string>; lead: string } | null>(
    null,
  );
  const lastRange = useRef<Range | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const [kind, setKind] = useState<Kind>("p");
  const [marks, setMarks] = useState({ bold: false, italic: false, strike: false });
  const [menu, setMenu] = useState<{ kind: "link" | "block"; query: string; x: number; y: number } | null>(null);
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState<{ x: number; y: number } | null>(null);
  const [tableAt, setTableAt] = useState<{ left: number; top: number } | null>(null);

  const read = useCallback(
    () => (box.current ? markdownFromRich(box.current, doc.current ?? undefined) : value),
    [value],
  );
  useImperativeHandle(ref, () => ({ markdown: read, focus: () => box.current?.focus() }), [read]);

  // The page goes in once; afterwards the browser owns the text (React never re-renders it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the editor opens
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const rich = richFromMarkdown(value, { title });
    el.innerHTML = rich.html;
    const snapshots = new Map<number, string>();
    for (const c of Array.from(el.children) as HTMLElement[])
      if (c.dataset.b !== undefined) snapshots.set(Number(c.dataset.b), c.outerHTML);
    doc.current = { original: value, sources: rich.sources, snapshots, lead: rich.lead };
    if (autoFocus) el.focus();
  }, []);

  const emit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(read()), 250);
  }, [onChange, read]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const inside = (node: Node | null) => Boolean(node && box.current?.contains(node));

  // Where the caret is: the selector, the marks, the agent button over a selection, the table's buttons.
  useEffect(() => {
    const onSel = () => {
      const sel = getSelection();
      const root = box.current;
      if (!sel?.rangeCount || !root || !inside(sel.anchorNode)) {
        setSelection(null);
        return;
      }
      lastRange.current = sel.getRangeAt(0).cloneRange();
      setKind(kindAt(sel.anchorNode, root));
      const state = (c: string) => typeof document.queryCommandState === "function" && document.queryCommandState(c);
      setMarks({ bold: state("bold"), italic: state("italic"), strike: state("strikeThrough") });
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setSelection(!sel.isCollapsed && onAsk && r.width > 0 ? { x: r.left + r.width / 2, y: r.top } : null);
      const anchor = sel.anchorNode;
      const table = (anchor?.nodeType === 1 ? (anchor as Element) : anchor?.parentElement)?.closest(".md__table");
      const wrap = wrapRef.current;
      if (table && wrap) {
        const tr = table.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        setTableAt({ left: tr.left - wr.left, top: tr.bottom - wr.top + 6 });
      } else setTableAt(null);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  });

  /** Puts the caret back where it was (a toolbar click or a menu took the focus), then runs the command. */
  const restore = () => {
    const el = box.current;
    if (!el) return;
    el.focus();
    const sel = getSelection();
    if (lastRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(lastRange.current);
    }
  };

  const insert = (html: string) => exec("insertHTML", html);
  const currentLi = () => {
    const n = getSelection()?.anchorNode ?? null;
    return (n?.nodeType === 1 ? (n as Element) : n?.parentElement)?.closest("li") ?? null;
  };

  const run = (cmd: Command) => {
    restore();
    const selected = getSelection()?.toString() ?? "";
    switch (cmd) {
      case "bold":
        exec("bold");
        break;
      case "italic":
        exec("italic");
        break;
      case "strike":
        exec("strikeThrough");
        break;
      case "p":
      case "h2":
      case "h3":
        exec("formatBlock", `<${cmd}>`);
        break;
      case "quote":
        exec("formatBlock", "<blockquote>");
        break;
      case "ul":
        exec("insertUnorderedList");
        break;
      case "ol":
        exec("insertOrderedList");
        break;
      case "task": {
        if (!currentLi()) exec("insertUnorderedList");
        const li = currentLi();
        if (li && !li.classList.contains("md__task")) {
          li.classList.add("md__task");
          const tick = document.createElement("span");
          tick.className = "md__task-box";
          tick.contentEditable = "false";
          li.prepend(tick);
        } else if (li) {
          li.classList.remove("md__task");
          li.removeAttribute("data-done");
          li.querySelector(".md__task-box")?.remove();
        }
        break;
      }
      case "table": {
        const head = Array.from({ length: 3 }, () => `<th>${t("wiki.rich.column")}</th>`).join("");
        const row = `<tr>${"<td><br></td>".repeat(3)}</tr>`;
        insert(
          `<div class="md__table"><table><thead><tr>${head}</tr></thead><tbody>${row}${row}</tbody></table></div><p><br></p>`,
        );
        break;
      }
      case "call": {
        const text = selected.trim() || t("wiki.rich.calloutText");
        insert(
          `<aside class="md__callout" data-kind="note" data-callout="note"><span class="md__callout-body">${text.replace(/</g, "&lt;")}</span></aside><p><br></p>`,
        );
        break;
      }
      case "code":
        insert(`<pre><code>${(selected || t("wiki.rich.codeText")).replace(/</g, "&lt;")}</code></pre><p><br></p>`);
        break;
      case "rule":
        insert("<hr><p><br></p>");
        break;
      case "link":
        exec("insertText", "[[");
        openMenu("link");
        break;
    }
    emit();
  };

  const openMenu = (kindOf: "link" | "block", query = "") => {
    const r = getSelection()?.rangeCount ? getSelection()?.getRangeAt(0).getBoundingClientRect() : undefined;
    const fallback = box.current?.getBoundingClientRect();
    setMenu({ kind: kindOf, query, x: r?.left || fallback?.left || 0, y: (r?.bottom || fallback?.top || 0) + 6 });
    setActive(0);
  };

  const q = menu?.query.trim().toLowerCase() ?? "";
  const linkOptions =
    menu?.kind === "link"
      ? pages
          .filter((p) => !q || p.title.toLowerCase().includes(q))
          .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)))
          .slice(0, 8)
      : [];
  const blockOptions =
    menu?.kind === "block"
      ? BLOCKS.filter((b) =>
          t(`wiki.rich.blocks.${b.key}`)
            .toLowerCase()
            .split(/\s+/)
            .some((w) => !q || w.startsWith(q)),
        )
      : [];
  const count = menu?.kind === "link" ? linkOptions.length : blockOptions.length;
  const current = Math.min(active, Math.max(0, count - 1));

  /** Takes out the `[[que` or `/que` typed, then links the page or runs the block. */
  const pick = (i: number) => {
    if (!menu) return;
    const token = tokenAt(menu.kind === "link" ? "[[" : "/");
    if (token) {
      const range = document.createRange();
      range.setStart(token.node, token.start);
      range.setEnd(token.node, token.end);
      range.deleteContents();
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      lastRange.current = range.cloneRange();
    }
    setMenu(null);
    if (menu.kind === "link") {
      const page = linkOptions[i];
      if (page) insert(`${wikiLinkHtml(page.title, page.title)}&nbsp;`);
      emit();
    } else {
      const b = blockOptions[i];
      if (b) run(b.cmd);
    }
  };

  const onInput = () => {
    emit();
    const link = tokenAt("[[");
    const slash = link ? null : tokenAt("/");
    if (link) openMenu("link", link.query);
    else if (slash) openMenu("block", slash.query);
    else setMenu(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (menu && count > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(current);
        return;
      }
    }
    if (menu && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      onChange(read());
      onSave();
    } else if (k === "k" && !e.shiftKey) {
      // ⌘K in the text links a page (the palette stays outside the text).
      e.preventDefault();
      e.stopPropagation();
      run("link");
    }
  };

  /** A task's box: checks and unchecks it. */
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const tick = (e.target as Element).closest(".md__task-box");
    if (!tick) return;
    const li = tick.closest("li");
    if (!li) return;
    li.toggleAttribute("data-done");
    emit();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    const sel = getSelection();
    // A web address over selected words makes them a link.
    if (!html && sel && !sel.isCollapsed && /^https?:\/\/\S+$/.test(text.trim())) {
      exec("createLink", text.trim());
      emit();
      return;
    }
    if (!html && !text.includes("\n")) exec("insertText", text);
    else {
      const rich = html ? pastedHtml(html) : pastedText(text);
      // One paragraph goes into the line as words, without splitting it.
      const one = rich.match(/^<p>([\s\S]*)<\/p>$/);
      insert(one && !one[1]?.includes("<p") ? (one[1] ?? "") : rich);
    }
    emit();
  };

  const addRow = () => {
    const table = (lastRange.current?.startContainer.parentElement ?? null)?.closest(".md__table table");
    const body = (table as HTMLTableElement | null)?.tBodies[0];
    const last = body?.rows[body.rows.length - 1] ?? (table as HTMLTableElement | null)?.rows[0];
    if (!body || !last) return;
    const row = document.createElement("tr");
    for (let i = 0; i < last.cells.length; i++) {
      const td = document.createElement("td");
      td.append(document.createElement("br"));
      row.append(td);
    }
    body.append(row);
    emit();
  };
  const addColumn = () => {
    const table = (lastRange.current?.startContainer.parentElement ?? null)?.closest(
      ".md__table table",
    ) as HTMLTableElement | null;
    if (!table) return;
    for (const row of Array.from(table.rows)) {
      const head = row.parentElement?.tagName === "THEAD";
      const c = document.createElement(head ? "th" : "td");
      if (head) c.textContent = t("wiki.rich.column");
      else c.append(document.createElement("br"));
      row.append(c);
    }
    emit();
  };

  const keep = (e: MouseEvent) => e.preventDefault();
  const tool = (cmd: Command, icon: IconName, name: string, pressed?: boolean, hint?: string) => (
    <Button
      key={cmd}
      size="sm"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={name}
      title={hint ? `${name} (${hint})` : name}
      aria-pressed={pressed}
      onMouseDown={keep}
      onClick={() => run(cmd)}
    />
  );
  const blockName = t(`wiki.rich.blocks.${KIND_KEY[kind]}`);

  return (
    <div className="wiki-rich-wrap" ref={wrapRef}>
      <div className="wiki-editor__bar ac-glass wiki-bar" role="toolbar" aria-label={t("wiki.editor.toolbar")}>
        <Menu
          label={t("wiki.rich.blockLabel")}
          trigger={
            <button type="button" className="ac-select__trigger wiki-bar__block" onMouseDown={keep}>
              <span className="ac-select__value">{blockName}</span>
              <Icon name="chevronDown" size={16} className="ac-select__chev" />
            </button>
          }
          onClosed={() => box.current?.focus()}
        >
          {BLOCKS.filter((b) => ["p", "h2", "h3", "ul", "ol", "task", "call", "code"].includes(b.cmd)).map((b) => (
            <MenuItem key={b.cmd} icon={b.icon} onSelect={() => run(b.cmd)}>
              {t(`wiki.rich.blocks.${b.key}`)}
            </MenuItem>
          ))}
        </Menu>
        <span className="wiki-bar__sep" aria-hidden="true" />
        {tool("bold", "bold", t("wiki.editor.bold"), marks.bold, `${modKey()} B`)}
        {tool("italic", "italic", t("wiki.editor.italic"), marks.italic, `${modKey()} I`)}
        {tool("strike", "strike", t("wiki.rich.strike"), marks.strike)}
        <span className="wiki-bar__sep" aria-hidden="true" />
        {tool("ul", "bulletList", t("wiki.editor.list"), kind === "ul")}
        {tool("ol", "numberedList", t("wiki.rich.blocks.numbered"), kind === "ol")}
        {tool("task", "checks", t("wiki.editor.task"), kind === "task")}
        <span className="wiki-bar__sep" aria-hidden="true" />
        {tool("link", "link", t("wiki.rich.linkPage"), false, `${modKey()} K`)}
        {tool("table", "table", t("wiki.rich.blocks.table"), kind === "table")}
        {tool("call", "quote", t("wiki.rich.blocks.callout"), kind === "call")}
        {tool("code", "codeBlock", t("wiki.editor.code"), kind === "code")}
        {onAsk && (
          <span className="wiki-bar__end">
            <Button
              size="sm"
              variant="ghost"
              icon="agent"
              onMouseDown={keep}
              onClick={() => onAsk(getSelection()?.toString().trim() ?? "")}
            >
              {t("wiki.ask.button")}
            </Button>
          </span>
        )}
      </div>
      <div className="wiki-page__body wiki-prose">
        {/* biome-ignore lint/a11y/useSemanticElements: rich text (headings, lists, tables, links) can't live in a textarea */}
        <div
          ref={box}
          className="md wiki-rich"
          contentEditable={!locked}
          suppressContentEditableWarning
          tabIndex={0}
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          aria-controls={menu ? listId : undefined}
          spellCheck
          data-placeholder={t("wiki.rich.placeholder")}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPaste={onPaste}
          onFocus={() => {
            // Enter makes paragraphs and marks are tags, the same in every browser.
            exec("defaultParagraphSeparator", "p");
            exec("styleWithCSS", "false");
          }}
          onBlur={() => onChange(read())}
        />
      </div>
      {tableAt && (
        <div className="wiki-rich__table-acts" style={{ left: tableAt.left, top: tableAt.top }}>
          <Button size="sm" icon="plus" onMouseDown={keep} onClick={addRow}>
            {t("wiki.rich.addRow")}
          </Button>
          <Button size="sm" icon="plus" onMouseDown={keep} onClick={addColumn}>
            {t("wiki.rich.addColumn")}
          </Button>
        </div>
      )}
      {selection && onAsk && !menu && (
        <div className="wiki-rich__float ac-glass" style={{ left: selection.x, top: selection.y }}>
          <Button
            size="sm"
            variant="ghost"
            icon="agent"
            onMouseDown={keep}
            onClick={() => onAsk(getSelection()?.toString().trim() ?? "")}
          >
            {t("wiki.ask.button")}
          </Button>
        </div>
      )}
      {menu && count > 0 && (
        <div
          className="wiki-suggest wiki-suggest--float ac-glass"
          role="listbox"
          id={listId}
          aria-label={menu.kind === "link" ? t("wiki.editor.suggest") : t("wiki.rich.blockLabel")}
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kind === "link"
            ? linkOptions.map((p, i) => (
                <div
                  key={p.slug}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  data-active={i === current || undefined}
                  className="ac-menu__item"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                  onKeyDown={() => {}}
                >
                  <span className="ac-menu__label">
                    <span>{p.title}</span>
                    {p.folder && <span className="ac-menu__desc">{p.folder}</span>}
                  </span>
                  {i === current && <Kbd>↵</Kbd>}
                </div>
              ))
            : blockOptions.map((b, i) => (
                <div
                  key={b.cmd}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  data-active={i === current || undefined}
                  className="ac-menu__item"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                  onKeyDown={() => {}}
                >
                  <span className="ac-menu__leading" aria-hidden="true">
                    <Icon name={b.icon} size={16} />
                  </span>
                  <span className="ac-menu__label">
                    <span>{t(`wiki.rich.blocks.${b.key}`)}</span>
                  </span>
                  {i === current && <Kbd>↵</Kbd>}
                </div>
              ))}
        </div>
      )}
    </div>
  );
});
