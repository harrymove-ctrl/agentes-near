import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { matchesWords } from "../search";
import { useFieldControl } from "./Field";
import { ChosenValue, type SelectOption } from "./Select";
import { SearchField } from "./Toolbar";

export interface SearchSelectLabels {
  /** Accessible name of the search field ("Buscar modelos"). */
  search: string;
  searchPlaceholder: string;
  noResults: string;
  /** Accessible name of the list ("Modelos"). */
  list: string;
}

export interface SearchSelectProps<V extends string = string, O extends SelectOption<V> = SelectOption<V>> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  /** Consecutive options with the same `group` get a heading. A function is read only while the list is open. */
  options: O[] | (() => O[]);
  labels: SearchSelectLabels;
  /** A group's heading; default: the group as given. */
  groupLabel?: (group: string) => string;
  /** Whether an option is among what was typed; default: every word in its label, value or group. */
  matches?: (option: O, query: string) => boolean;
  /** A row before its check; default: its leading mark, label and description, as `Select` draws them. */
  renderOption?: (option: O) => ReactNode;
  /** What the trigger shows; default: the chosen option's face or logo and its label, as `Select`'s, else `placeholder`. */
  renderValue?: (option: O | undefined) => ReactNode;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

const defaultMatches = (o: SelectOption, query: string) =>
  matchesWords(`${o.label} ${o.value} ${o.group ?? ""}`, query);

const defaultRow = (o: SelectOption) => (
  <>
    {o.leading && (
      <span className="ac-menu__leading" aria-hidden="true">
        {o.leading}
      </span>
    )}
    <span className="ac-menu__label">
      <span>{o.label}</span>
      {o.description && <span className="ac-menu__desc">{o.description}</span>}
    </span>
  </>
);

/** Runs of consecutive options by `group`. */
function groupsOf<O extends SelectOption>(options: O[]) {
  const out: [string | undefined, O[]][] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else out.push([o.group, [o]]);
  }
  return out;
}

/**
 * One choice from a long list: our trigger, then a glass dropdown with a search over the options, in their groups,
 * the chosen one checked. Combobox semantics, arrows / Home / End / Page keys / Enter / Esc, `aria-activedescendant`.
 * A disabled option shows, but can't be picked.
 */
export function SearchSelect<V extends string = string, O extends SelectOption<V> = SelectOption<V>>({
  value,
  onValueChange,
  options,
  labels,
  groupLabel = (group) => group,
  matches = defaultMatches,
  renderOption,
  renderValue,
  placeholder,
  id,
  disabled,
  className,
  ...rest
}: SearchSelectProps<V, O>) {
  const wiring = useFieldControl({ id });
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const all = useMemo(() => (Array.isArray(options) ? options : open ? options() : []), [options, open]);
  const groups = useMemo(
    () => groupsOf(query.trim() ? all.filter((o) => matches(o, query)) : all),
    [all, query, matches],
  );
  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
  const optionId = (i: number) => `${listId}-o${i}`;
  const chosen = Array.isArray(options) ? options.find((o) => o.value === value) : undefined;

  // Opening starts on the chosen option; typing goes back to the first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        all.findIndex((o) => o.value === value),
      ),
    );
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const pick = (o: O | undefined) => {
    if (!o || o.disabled) return;
    onValueChange(o.value);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = flat.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "PageDown") setActive((a) => Math.min(last, a + 10));
    else if (e.key === "PageUp") setActive((a) => Math.max(0, a - 10));
    else if (e.key === "Enter") pick(flat[active]);
    else return;
    e.preventDefault();
  };

  let index = -1;
  return (
    <div className={cx("ac-select", className)}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild disabled={disabled}>
          <button
            type="button"
            className="ac-select__trigger"
            id={wiring.id}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={rest["aria-label"]}
            aria-describedby={wiring["aria-describedby"]}
            aria-invalid={wiring["aria-invalid"]}
            onKeyDown={(e) => {
              // The keys that open `Select`'s list open this one too.
              if (open || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return;
              e.preventDefault();
              setOpen(true);
            }}
          >
            <span className="ac-select__value">
              {renderValue ? (
                renderValue(chosen)
              ) : chosen ? (
                <span>
                  <ChosenValue option={chosen} />
                </span>
              ) : (
                placeholder
              )}
            </span>
            <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
        </RPopover.Trigger>
        <RPopover.Portal>
          <RPopover.Content className="ac-menu ac-tz__menu" align="start" sideOffset={4} collisionPadding={EDGE_ROOM}>
            <div className="ac-tz__searchrow">
              <SearchField
                size="sm"
                role="combobox"
                aria-label={labels.search}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat.length ? optionId(active) : undefined}
                placeholder={labels.searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </div>
            <div className="ac-tz__list" role="listbox" id={listId} aria-label={labels.list}>
              {flat.length === 0 && <p className="ac-tz__empty">{labels.noResults}</p>}
              {groups.map(([group, list], g) => {
                const rows = list.map((o) => {
                  index += 1;
                  const i = index;
                  return (
                    // biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys
                    <div
                      key={o.value}
                      id={optionId(i)}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled || undefined}
                      data-active={i === active || undefined}
                      className={cx("ac-tz__option", !renderOption && "ac-search__option")}
                      onPointerMove={() => setActive(i)}
                      onClick={() => pick(o)}
                    >
                      {renderOption ? renderOption(o) : defaultRow(o)}
                      <span className="ac-tz__check" aria-hidden="true">
                        {o.value === value && (
                          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                            <path d="m5.5 10.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" />
                          </svg>
                        )}
                      </span>
                    </div>
                  );
                });
                return group ? (
                  // biome-ignore lint/a11y/useSemanticElements: a listbox group
                  <div key={group} role="group" aria-label={groupLabel(group)}>
                    <div className="ac-menu__heading" aria-hidden="true">
                      {groupLabel(group)}
                    </div>
                    {rows}
                  </div>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ungrouped runs have nothing else to tell them apart
                  <div key={`~${g}`}>{rows}</div>
                );
              })}
            </div>
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
    </div>
  );
}
