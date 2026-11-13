import type { WikiPageSummary } from "@agenteschat/client";
import { prefixLines, wikiQuery, wrapSelection } from "@agenteschat/client/lib/wiki";
import { Button, Kbd, modKey, Segmented } from "@agenteschat/ui";
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/lib/markdown";
import { useWikiLinkRenderer } from "./WikiLinks";

type Mode = "write" | "preview" | "split";

/**
 * Our markdown editor: a textarea with a toolbar and shortcuts (⌘B, ⌘I,
 * ⌘K for a link, ⌘S saves), Escrever / Visualizar / Lado a lado, and `[[`
 * autocompletes page titles in glass.
 */
export function WikiEditor({
  value,
  onChange,
  onSave,
  pages,
  label,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  pages: WikiPageSummary[];
  label: string;
  /** Put the caret in the text when it opens. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [mode, setMode] = useState<Mode>("write");
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const selectAfter = useRef<[number, number] | null>(null);
  const wikiLink = useWikiLinkRenderer();

  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the editor opens
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const sel = selectAfter.current;
    if (el && sel) {
      el.setSelectionRange(sel[0], sel[1]);
      selectAfter.current = null;
    }
  });

  const q = token?.query.trim().toLowerCase() ?? "";
  const suggestions = token
    ? pages
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)))
        .slice(0, 8)
    : [];
  const open = suggestions.length > 0;
  const current = Math.min(active, Math.max(0, suggestions.length - 1));

  const apply = (r: { text: string; start: number; end: number }) => {
    selectAfter.current = [r.start, r.end];
    onChange(r.text);
    ref.current?.focus();
  };
  const sel = () => {
    const el = ref.current;
    return { start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length };
  };
  const tools = {
    bold: () => {
      const s = sel();
      apply(wrapSelection(value, s.start, s.end, "**", "**", t("wiki.editor.boldText")));
    },
    italic: () => {
      const s = sel();
      apply(wrapSelection(value, s.start, s.end, "_", "_", t("wiki.editor.italicText")));
    },
    heading: () => {
      const s = sel();
      apply(prefixLines(value, s.start, s.end, "## "));
    },
    list: () => {
      const s = sel();
      apply(prefixLines(value, s.start, s.end, "- "));
    },
    task: () => {
      const s = sel();
      apply(prefixLines(value, s.start, s.end, "- [ ] "));
    },
    link: () => {
      const s = sel();
      apply(wrapSelection(value, s.start, s.end, "[[", "]]", t("wiki.editor.linkText")));
    },
    code: () => {
      const s = sel();
      apply(wrapSelection(value, s.start, s.end, "`", "`", t("wiki.editor.codeSample")));
    },
  };

  const pick = (page: WikiPageSummary) => {
    if (!token) return;
    const caret = token.start + 2 + token.query.length;
    const rest = value.slice(caret).replace(/^\]\]/, "");
    const inserted = `[[${page.title}]]`;
    const next = value.slice(0, token.start) + inserted + rest;
    setToken(null);
    apply({ text: next, start: token.start + inserted.length, end: token.start + inserted.length });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const p = suggestions[current];
        if (p) pick(p);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setToken(null);
        return;
      }
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      onSave();
    } else if (k === "b") {
      e.preventDefault();
      tools.bold();
    } else if (k === "i") {
      e.preventDefault();
      tools.italic();
    } else if (k === "k" && !e.shiftKey) {
      // ⌘K in the editor is a link (the palette stays outside the text box).
      e.preventDefault();
      e.stopPropagation();
      tools.link();
    }
  };

  const toolbar: { key: keyof typeof tools; label: string; hint?: string }[] = [
    { key: "bold", label: t("wiki.editor.bold"), hint: `${modKey()} B` },
    { key: "italic", label: t("wiki.editor.italic"), hint: `${modKey()} I` },
    { key: "heading", label: t("wiki.editor.heading") },
    { key: "list", label: t("wiki.editor.list") },
    { key: "task", label: t("wiki.editor.task") },
    { key: "link", label: t("wiki.editor.link"), hint: `${modKey()} K` },
    { key: "code", label: t("wiki.editor.code") },
  ];

  return (
    <div className="wiki-editor" data-mode={mode}>
      <div className="wiki-editor__bar ac-glass">
        <div className="wiki-editor__tools" role="toolbar" aria-label={t("wiki.editor.toolbar")}>
          {toolbar.map((b) => (
            <Button
              key={b.key}
              size="sm"
              variant="ghost"
              title={b.hint ? `${b.label} (${b.hint})` : b.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={tools[b.key]}
            >
              {b.label}
            </Button>
          ))}
        </div>
        <Segmented
          size="sm"
          label={t("wiki.editor.mode")}
          value={mode}
          onValueChange={setMode}
          options={(["write", "split", "preview"] as const).map((m) => ({
            value: m,
            label: t(`wiki.editor.modes.${m}`),
          }))}
        />
      </div>
      <div className="wiki-editor__panes">
        {mode !== "preview" && (
          <div className="wiki-editor__write">
            <textarea
              ref={ref}
              className="wiki-editor__text"
              aria-label={label}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open ? `${listId}-${current}` : undefined}
              value={value}
              spellCheck
              onChange={(e) => {
                onChange(e.target.value);
                const next = wikiQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
                setToken(next);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            {open && (
              <div className="wiki-suggest ac-glass" role="listbox" id={listId} aria-label={t("wiki.editor.suggest")}>
                {suggestions.map((p, i) => (
                  <div
                    key={p.slug}
                    id={`${listId}-${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === current}
                    data-active={i === current || undefined}
                    className="ac-menu__item"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      pick(p);
                    }}
                    onKeyDown={() => {}}
                  >
                    <span className="ac-menu__label">
                      <span>{p.title}</span>
                      {p.folder && <span className="ac-menu__desc">{p.folder}</span>}
                    </span>
                    {i === current && <Kbd>↵</Kbd>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {mode !== "write" && (
          <section className="wiki-editor__preview" aria-label={t("wiki.editor.preview")}>
            <Markdown source={value} wikiLink={wikiLink} />
          </section>
        )}
      </div>
      <p className="small muted wiki-editor__hint">{t("wiki.editor.hint", { key: modKey() })}</p>
    </div>
  );
}
