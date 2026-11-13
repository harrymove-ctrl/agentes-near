import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { Icon, type IconName } from "../icons/Icon";
import { Button } from "./Button";
import { CountChip } from "./Chip";
import { SearchField } from "./Toolbar";

export interface FilterOption {
  value: string;
  label: string;
  /** An avatar or icon before the label (people and agents get their living avatars). */
  leading?: ReactNode;
  /** Consecutive options with the same group get a heading ("Pessoas", "Agentes"). */
  group?: string;
  /** How many there are of it (Tipo: 3 Documentos), at the row's end before the check. */
  count?: number;
}

export interface FilterChipProps {
  /** The filter's name: "Tipo", "Canal", "Pessoa". */
  label: string;
  icon: IconName;
  options: FilterOption[];
  /** Selected values (empty = no filter). */
  value: string[];
  onChange: (value: string[]) => void;
  /** Several values at once (channels, people). */
  multiple?: boolean;
  /** How a single selected value reads on the chip ("Tipo: Documentos" by default; "#general"). */
  valueText?: (option: FilterOption) => string;
  /** Several selected: "3 canais". */
  countText?: (count: number) => string;
  /** Accessible name of the × ("Limpar Tipo"). */
  clearLabel: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  noResults?: string;
  className?: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Search shows up past this many options. */
export const FILTER_SEARCH_AFTER = 8;

/**
 * A filter as a dropdown chip (v2): a compact control of the ruler (32, r10) with the filter's icon, its
 * name and a chevron. With a value it reads it ("Tipo: Documentos",
 * "#general", "3 canais"), turns raised with the ink ring and gets a × to
 * clear. The glass menu has a search past 8 options, a check on what's
 * selected and multi-select where it fits.
 */
export function FilterChip({
  label,
  icon,
  options,
  value,
  onChange,
  multiple,
  valueText = (o) => `${label}: ${o.label}`,
  countText = (n) => `${label}: ${n}`,
  clearLabel,
  searchLabel,
  searchPlaceholder,
  noResults,
  className,
}: FilterChipProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.filter((o) => value.includes(o.value));
  const active = selected.length > 0;
  const text = !active
    ? label
    : selected.length === 1 && selected[0]
      ? valueText(selected[0])
      : countText(selected.length);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q ? options.filter((o) => fold(o.label).includes(q)) : options;
  }, [options, query]);
  const toggle = (o: FilterOption) => {
    if (multiple) {
      onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]);
      return;
    }
    onChange(value.includes(o.value) ? [] : [o.value]);
    setOpen(false);
  };
  // ↑/↓ between the options.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    e.preventDefault();
  };
  let lastGroup: string | undefined;
  return (
    <span className={cx("ac-filter", active && "ac-filter--active", className)}>
      <RPopover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQuery("");
        }}
      >
        <RPopover.Trigger asChild>
          <button type="button" className="ac-filter__trigger" aria-haspopup="listbox" aria-expanded={open}>
            <Icon name={icon} size={14} />
            <span className="ac-filter__text">{text}</span>
            <svg className="ac-filter__chev" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
        </RPopover.Trigger>
        <RPopover.Portal>
          <RPopover.Content
            className="ac-menu ac-filter__menu"
            align="start"
            sideOffset={6}
            collisionPadding={EDGE_ROOM}
          >
            {options.length > FILTER_SEARCH_AFTER && (
              <div className="ac-tz__searchrow">
                <SearchField
                  size="sm"
                  aria-label={searchLabel ?? label}
                  placeholder={searchPlaceholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      listRef.current?.querySelector<HTMLElement>("[role=option]")?.focus();
                      e.preventDefault();
                    }
                  }}
                />
              </div>
            )}
            <div
              className="ac-filter__list"
              role="listbox"
              id={listId}
              aria-label={label}
              aria-multiselectable={multiple || undefined}
              ref={listRef}
              onKeyDown={onKey}
              tabIndex={-1}
            >
              {shown.length === 0 && noResults && <p className="ac-tz__empty">{noResults}</p>}
              {shown.map((o) => {
                const heading = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                const on = value.includes(o.value);
                return (
                  <div key={o.value} className="ac-filter__item">
                    {heading && (
                      <div className="ac-menu__heading" aria-hidden="true">
                        {heading}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      className="ac-filter__option"
                      onClick={() => toggle(o)}
                    >
                      {o.leading}
                      <span className="ac-filter__label">{o.label}</span>
                      {o.count !== undefined && <CountChip>{o.count}</CountChip>}
                      <span className="ac-tz__check" aria-hidden="true">
                        {on && (
                          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                            <path d="m5.5 10.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
                          </svg>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
      {active && (
        <button type="button" className="ac-filter__clear" aria-label={clearLabel} onClick={() => onChange([])}>
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  );
}

/**
 * A row of filters: the ones in use first, then the rest, and "Limpar
 * filtros" when any is set.
 */
export function FilterBar({
  label,
  filters,
  onClear,
  clearText,
  children,
  className,
}: {
  label: string;
  /** Each filter and whether it has a value. */
  filters: { key: string; active: boolean; node: ReactNode }[];
  onClear: () => void;
  clearText: string;
  /** Before the filters (a search field). */
  children?: ReactNode;
  className?: string;
}) {
  const ordered = [...filters.filter((f) => f.active), ...filters.filter((f) => !f.active)];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of filters
    <div className={cx("ac-filterbar", className)} role="group" aria-label={label}>
      {children}
      {ordered.map((f) => (
        <span key={f.key} className="ac-filterbar__item">
          {f.node}
        </span>
      ))}
      {filters.some((f) => f.active) && (
        <Button size="sm" variant="ghost" onClick={onClear} className="ac-filterbar__clear">
          {clearText}
        </Button>
      )}
    </div>
  );
}
