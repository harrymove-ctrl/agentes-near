import {
  dedupe,
  parseSearch,
  SEARCH_HAS,
  SEARCH_OPS,
  type SearchChip,
  type SearchDirectory,
  type SearchOp,
  type SearchWords,
  searchChipKey,
  searchChipLabel,
  suggestActors,
  suggestPlaces,
  typingOperator,
} from "@agenteschat/client/lib/search-filters";
import { cx, Icon, type IconName, Token } from "@agenteschat/ui";
import { type KeyboardEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import "./search.css";

interface Option {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  group?: string;
  className?: string;
  pick: () => void;
}

/** The ones the empty box offers first; the rest under "Mais filtros". */
const MAIN_OPS: SearchOp[] = ["from", "in", "has", "mentions"];
const DATE_OPS = new Set<SearchOp>(["before", "after", "during"]);
/** The compact menu's mark for each main filter. */
const OP_ICONS: Partial<Record<SearchOp, IconName>> = { from: "person", in: "channel", has: "attach" };

/** A recent search as its chips (the operator in bold, a face or a #) and its words. */
function RecentSearch({ text, directory, words }: { text: string; directory: SearchDirectory; words: SearchWords }) {
  const { t, i18n } = useTranslation();
  const parsed = parseSearch(text, directory, words);
  return (
    <span className="search-menu__chips">
      {parsed.chips.map((c) => {
        const label = searchChipLabel(t, i18n.language, c);
        const at = label.indexOf(": ");
        const value = at < 0 ? label : label.slice(at + 2).replace(/^#/, "");
        return (
          <span key={searchChipKey(c)} className="ac-token ac-token--sm search-menu__chip">
            <span className="ac-token__label">
              {at >= 0 && <b>{label.slice(0, at + 1)}</b>}
              {(c.op === "from" || c.op === "mentions") && (
                <ActorAvatar actor={c.actor} name={c.actor.name} size="xs" />
              )}
              {c.op === "in" && !c.place.dm && <Icon name="channel" size={14} />}
              {value}
            </span>
          </span>
        );
      })}
      {parsed.text && <span className="search-menu__text">{parsed.text}</span>}
    </span>
  );
}

/**
 * The search box with filters (ADR 0123): chips inside the field, the options and recent searches while it is
 * empty, and a picker for the operator being typed (`from:` people and agents with their faces, `in:` channels and
 * DMs, `has:` kinds, dates). Space or Enter turns typed operators into chips; Backspace on an empty box removes
 * the last chip.
 */
export function SearchBox({
  chips,
  onChipsChange,
  text,
  onTextChange,
  onSubmit,
  directory,
  words,
  recent,
  onPickRecent,
  onClearRecent,
  compact,
  placeholder,
  autoFocus = true,
  inputRef,
  onClear,
  className,
  ops = SEARCH_OPS,
}: {
  chips: SearchChip[];
  onChipsChange: (chips: SearchChip[]) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** Enter with nothing picked: the search is worth remembering. */
  onSubmit: () => void;
  directory: SearchDirectory;
  words: SearchWords;
  recent: string[];
  onPickRecent: (search: string) => void;
  onClearRecent: () => void;
  /**
   * The channel header's mini menu: each main filter with its mark and an example, the rest folded under "Mais
   * filtros", recent searches as their chips.
   */
  compact?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** A ✕ in the field while it holds something. */
  onClear?: () => void;
  className?: string;
  /** The operators it offers and turns into chips while typed (a DM's: no who or where). */
  ops?: readonly SearchOp[];
}) {
  const { t, i18n } = useTranslation();
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  const [more, setMore] = useState(false);
  const listId = useId();
  const [open, setOpen] = useState(false);
  // -1: nothing highlighted yet (an operator being typed still highlights its first option).
  const [active, setActive] = useState(-1);

  const addChip = (chip: SearchChip, rest: string) => {
    onChipsChange(dedupe([...chips, chip]));
    onTextChange(rest);
    setActive(-1);
    input.current?.focus();
  };
  const typed = typingOperator(text, words);
  const typing = typed && ops.includes(typed.op) ? typed : null;
  // What the box holds before the operator being typed.
  const before = typing ? text.slice(0, typing.start).trimEnd() : text;
  const withSpace = (s: string) => (s ? `${s} ` : "");
  const insertOp = (op: SearchOp) => {
    onTextChange(`${withSpace(text.trimEnd())}${words.ops[op]}:`);
    setActive(-1);
    input.current?.focus();
  };

  const options: Option[] = [];
  if (typing) {
    const op = typing.op;
    if (op === "from" || op === "mentions") {
      // Agents, then people, each under its name.
      const found = suggestActors(typing.value, directory.actors).sort(
        (a, b) => Number(b.type === "agent") - Number(a.type === "agent"),
      );
      for (const a of found) {
        options.push({
          key: `${a.type}:${a.id}`,
          label: (
            <span className="search-from__who">
              <span className="search-from__name">{a.name}</span>
              {a.handle && <span className="search-from__handle">{a.handle}</span>}
            </span>
          ),
          leading: <ActorAvatar actor={a} name={a.name} size="sm" />,
          group: t(`searchPage.authorLabel.${a.type}`),
          className: "search-from__item",
          pick: () => addChip({ op, actor: a }, withSpace(before)),
        });
      }
    } else if (op === "in") {
      for (const p of suggestPlaces(typing.value, directory.places)) {
        options.push({
          key: p.id,
          label: p.dm ? t("searchPage.dm", { name: p.name }) : `#${p.name}`,
          leading: <Icon name={p.dm ? "message" : "channel"} size={16} />,
          pick: () => addChip({ op, place: p }, withSpace(before)),
        });
      }
    } else if (op === "has") {
      for (const h of SEARCH_HAS) {
        options.push({
          key: h,
          label: t(`searchPage.hasLabel.${h}`),
          description: `${words.ops.has}:${words.has[h]}`,
          pick: () => addChip({ op, value: h }, withSpace(before)),
        });
      }
    } else if (op === "author") {
      for (const a of ["person", "agent"] as const) {
        options.push({
          key: a,
          label: t(`searchPage.authorLabel.${a}`),
          description: `${words.ops.author}:${words.author[a]}`,
          pick: () => addChip({ op, value: a }, withSpace(before)),
        });
      }
    } else if (op === "pinned") {
      options.push({
        key: "pinned",
        label: t("searchPage.pinnedChip"),
        leading: <Icon name="pin" size={16} />,
        pick: () => addChip({ op }, withSpace(before)),
      });
    }
  } else if (!text.trim() && compact) {
    for (const op of ops) {
      const main = MAIN_OPS.includes(op);
      if (!main && !more) continue;
      const icon = OP_ICONS[op];
      options.push({
        key: op,
        label: t(`searchPage.option.${op}`),
        description: (
          <>
            <b>{words.ops[op]}:</b> {main ? t(`searchPage.optionHint.${op as "from"}`) : null}
          </>
        ),
        leading: (
          <span className="search-menu__icon">
            {icon ? <Icon name={icon} /> : <span className="search-menu__at">@</span>}
          </span>
        ),
        group: main ? t("searchPage.panel.filters") : t("searchPage.moreFilters"),
        className: "search-menu__filter",
        pick: () => insertOp(op),
      });
    }
    if (!more) {
      options.push({
        key: "more",
        label: t("searchPage.moreFilters"),
        description: t("searchPage.moreFiltersHint"),
        leading: (
          <span className="search-menu__icon">
            <Icon name="filter" />
          </span>
        ),
        group: t("searchPage.panel.filters"),
        className: "search-menu__filter",
        pick: () => {
          setMore(true);
          input.current?.focus();
        },
      });
    }
    for (const r of recent) {
      options.push({
        key: `recent:${r}`,
        label: <RecentSearch text={r} directory={directory} words={words} />,
        leading: <Icon name="search" size={16} />,
        group: t("searchPage.recent"),
        className: "search-menu__recent",
        pick: () => onPickRecent(r),
      });
    }
  } else if (!text.trim()) {
    for (const op of ops) {
      options.push({
        key: op,
        label: `${words.ops[op]}:`,
        description: t(`searchPage.option.${op}`),
        group: MAIN_OPS.includes(op) ? t("searchPage.options") : t("searchPage.moreFilters"),
        pick: () => insertOp(op),
      });
    }
    for (const r of recent) {
      options.push({
        key: `recent:${r}`,
        label: r,
        leading: <Icon name="clock" size={16} />,
        group: t("searchPage.recent"),
        pick: () => onPickRecent(r),
      });
    }
  }
  const shown = open && (options.length > 0 || typing !== null);
  const current = Math.min(typing ? Math.max(active, 0) : active, options.length - 1);

  const commit = (value: string) => {
    // Complete operators become chips once a space follows them.
    if (!/\s$/.test(value)) return onTextChange(value);
    const parsed = parseSearch(value, directory, words);
    if (parsed.chips.length === 0) return onTextChange(value);
    onChipsChange(dedupe([...chips, ...parsed.chips]));
    onTextChange(withSpace(parsed.text));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && shown && options.length) {
      e.preventDefault();
      setActive((current + 1) % options.length);
    } else if (e.key === "ArrowUp" && shown && options.length) {
      e.preventDefault();
      setActive(current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = shown && current >= 0 ? options[current] : undefined;
      if (option) return option.pick();
      const parsed = parseSearch(text, directory, words);
      if (parsed.chips.length) {
        onChipsChange(dedupe([...chips, ...parsed.chips]));
        onTextChange(parsed.text);
      }
      setOpen(false);
      onSubmit();
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Backspace" && !text && chips.length) {
      onChipsChange(chips.slice(0, -1));
    }
  };

  let lastGroup: string | undefined;
  return (
    <search
      className={cx("search-box", compact && "search-box--compact", className)}
      // Closes when the focus leaves the box and its menu (the date field inside the menu keeps it open).
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the field's padding focuses its input. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys. */}
      <div className="search-box__field" onClick={() => input.current?.focus()}>
        <Icon name="search" size={16} className="search-box__icon" />
        {chips.map((c) => {
          const label = searchChipLabel(t, i18n.language, c);
          return (
            <Token
              key={searchChipKey(c)}
              size="sm"
              removeLabel={t("searchPage.removeFilter", { filter: label })}
              onRemove={() => onChipsChange(chips.filter((x) => searchChipKey(x) !== searchChipKey(c)))}
            >
              {label}
            </Token>
          );
        })}
        <input
          ref={input}
          className="search-box__input"
          type="search"
          role="combobox"
          data-esc-free=""
          aria-label={t("searchPage.label")}
          aria-expanded={Boolean(shown)}
          aria-controls={listId}
          aria-activedescendant={shown && current >= 0 ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the search page and the phone's search sheet are for typing.
          autoFocus={autoFocus}
          placeholder={chips.length ? "" : (placeholder ?? t("searchPage.placeholder"))}
          value={text}
          onChange={(e) => {
            commit(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {onClear && (chips.length > 0 || text) && (
          <button
            type="button"
            className="search-box__x"
            aria-label={t("searchPage.header.clear")}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
              setMore(false);
              input.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {shown && (
        <div
          className={cx("ac-menu search-box__menu", compact && "search-menu")}
          role="listbox"
          id={listId}
          aria-label={t("searchPage.options")}
        >
          {typing && DATE_OPS.has(typing.op) && (
            <label className="search-box__date">
              <span className="small muted">{t("searchPage.pickDate")}</span>
              <input
                type="date"
                onChange={(e) => {
                  if (e.target.value) addChip({ op: typing.op as "before", value: e.target.value }, withSpace(before));
                }}
              />
            </label>
          )}
          {typing && !DATE_OPS.has(typing.op) && options.length === 0 && (
            <p className="search-box__none small muted">
              {typing.op === "in" ? t("searchPage.noPlace") : t("searchPage.noMatch")}
            </p>
          )}
          {options.map((o, i) => {
            const heading = o.group && o.group !== lastGroup;
            lastGroup = o.group;
            return (
              <div key={o.key} role="presentation">
                {heading && (
                  <div className="ac-menu__heading search-box__heading" role="presentation">
                    <span>{o.group}</span>
                    {o.group === t("searchPage.recent") &&
                      (compact ? (
                        <button
                          type="button"
                          className="search-box__clear search-menu__trash"
                          aria-label={t("searchPage.clearRecentAll")}
                          title={t("searchPage.clearRecentAll")}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={onClearRecent}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="search-box__clear"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={onClearRecent}
                        >
                          {t("searchPage.clearRecent")}
                        </button>
                      ))}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  data-active={i === current || undefined}
                  className={cx("ac-menu__item ac-suggest__item", o.className)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={o.pick}
                  onKeyDown={() => {}}
                >
                  {o.leading && (
                    <span className="ac-menu__leading" aria-hidden="true">
                      {o.leading}
                    </span>
                  )}
                  <span className="ac-menu__label">
                    <span>{o.label}</span>
                    {o.description && <span className="ac-menu__desc">{o.description}</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </search>
  );
}
