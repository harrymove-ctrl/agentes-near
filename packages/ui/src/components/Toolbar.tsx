import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import { CountChip } from "./Chip";

/**
 * List screens use Toolbar + SearchField + FilterChip / FilterToggle (and
 * Segmented for views); don't style search inputs or filter rows per screen.
 * One shape for all of them, from the control ruler (tokens.css --control-*):
 * a Toolbar's row is compact (32, r10; 40 on touch), a SearchField on its own
 * is a default field (40, r12; `sm` 32 in dialogs and panels), the same field
 * background and hairline as FilterChip, filled neutral when pressed or set.
 */

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** 36px (default) or 32px (dialogs, panels, side lists). */
  size?: "md" | "sm";
  /** Shows a × while there is text; it calls this (and keeps the focus in the field). */
  onClear?: () => void;
  /** The ×'s accessible name ("Limpar busca"); required with `onClear`. */
  clearLabel?: string;
  /** A key hint at the end while empty and not focused (a Kbd "/"). */
  shortcut?: ReactNode;
}

/** The search box of every list: a field of the ruler with the search icon and, with text, a ×. Role `searchbox`. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { size = "md", onClear, clearLabel, shortcut, className, value, ...rest },
  ref,
) {
  const filled = typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;
  return (
    <span className={cx("ac-searchfield", size === "sm" && "ac-searchfield--sm", className)}>
      <Icon name="search" size={16} className="ac-searchfield__icon" />
      <input ref={ref} type="search" autoComplete="off" className="ac-searchfield__input" value={value} {...rest} />
      {shortcut && !filled && <span className="ac-searchfield__hint">{shortcut}</span>}
      {onClear && filled && (
        <button
          type="button"
          className="ac-searchfield__clear"
          aria-label={clearLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClear}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  );
});

export interface FilterToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  icon?: IconName;
  /** A count after the label ("Todas 6"). */
  count?: number;
  children: ReactNode;
}

/** An on/off filter ("Precisa de você", "Abertas 6"): the FilterChip shape; pressed = filled neutral. */
export function FilterToggle({
  pressed,
  onPressedChange,
  icon,
  count,
  children,
  className,
  ...rest
}: FilterToggleProps) {
  return (
    <button
      type="button"
      className={cx("ac-filtertoggle", className)}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      {...rest}
    >
      {icon && <Icon name={icon} size={14} />}
      <span className="ac-filtertoggle__text">{children}</span>
      {count !== undefined && <CountChip aria-hidden="true">{count}</CountChip>}
    </button>
  );
}

/**
 * Whether a toolbar holds its parts on one row: each at its own width, the search at its floor (its `min-width`), and
 * the gaps between them. Measured in the one-row layout. scripts/geometry/rules.js mirrors it for captured screens.
 */
export function fitsOneRow(bar: HTMLElement) {
  const parts = [...bar.children].filter((p) => getComputedStyle(p).display !== "none");
  let need = (Number.parseFloat(getComputedStyle(bar).columnGap) || 0) * Math.max(0, parts.length - 1);
  for (const p of parts)
    need += p.classList.contains("ac-toolbar__search")
      ? Number.parseFloat(getComputedStyle(p).minWidth) || 0
      : p.getBoundingClientRect().width;
  return need <= bar.clientWidth + 0.5;
}

/**
 * Stacked, whether the search at its floor (its `min-width`) and the actions share the top row. When they can't, the
 * search takes that row alone and the actions lead the filters' row (`data-stack="split"`): the search never shrinks
 * under its floor. scripts/geometry/rules.js mirrors it for captured screens.
 */
export function topRowFits(bar: HTMLElement) {
  const search = bar.querySelector(":scope > .ac-toolbar__search");
  const actions = bar.querySelector(":scope > .ac-toolbar__actions");
  if (!search || !actions) return true;
  const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
  const floor = Number.parseFloat(getComputedStyle(search).minWidth) || 0;
  return floor + gap + actions.getBoundingClientRect().width <= bar.clientWidth + 0.5;
}

/**
 * The bar above a list: the search on the left, the filters (FilterBar, FilterChip, FilterToggle, a Segmented) and
 * `actions` at the end, on one row from 761px, the search giving way first. When they can't fit even so, it takes
 * the phone's two rows (`data-stack`): the search and the actions, then the filters in one row that scrolls sideways.
 */
export function Toolbar({
  search,
  children,
  actions,
  size = "md",
  className,
  label,
}: {
  search?: ReactNode;
  /** The filters. */
  children?: ReactNode;
  /** At the end (a view switch, Novo…). */
  actions?: ReactNode;
  size?: "md" | "sm";
  className?: string;
  /** Names the filters' group for screen readers. */
  label?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const searched = Boolean(search);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!searched || !el || typeof ResizeObserver === "undefined") return;
    const watched = new WeakSet<Element>();
    // Measured with one row each time the toolbar or a part changes width (the window, a filter that got a value),
    // watching the parts that came since (filters that appeared once their data loaded).
    const measure = () => {
      for (const part of [el, ...el.querySelectorAll(":scope > *, :scope > * > *")]) {
        if (watched.has(part)) continue;
        watched.add(part);
        watch.observe(part);
      }
      el.removeAttribute("data-stack");
      if (!fitsOneRow(el)) el.setAttribute("data-stack", topRowFits(el) ? "" : "split");
    };
    const watch = new ResizeObserver(measure);
    measure();
    return () => {
      watch.disconnect();
      el.removeAttribute("data-stack");
    };
  }, [searched]);
  return (
    <div ref={bar} className={cx("ac-toolbar", size === "sm" && "ac-toolbar--sm", className)}>
      {search && <div className="ac-toolbar__search">{search}</div>}
      {children &&
        (label ? (
          // biome-ignore lint/a11y/useSemanticElements: a group of filters
          <div className="ac-toolbar__filters" role="group" aria-label={label}>
            {children}
          </div>
        ) : (
          <div className="ac-toolbar__filters">{children}</div>
        ))}
      {actions && <div className="ac-toolbar__actions">{actions}</div>}
    </div>
  );
}
