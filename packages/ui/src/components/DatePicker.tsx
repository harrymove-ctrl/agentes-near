import { appLocale, localeInfo } from "@agenteschat/i18n/locale";
import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { Icon } from "../icons/Icon";
import { Button } from "./Button";
import { useFieldControl } from "./Field";

/** `YYYY-MM-DD` ↔ local dates (a day, no time zone). */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function parseYmd(value: string | null | undefined): Date | null {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
};
const sameDay = (a: Date | null, b: Date | null) => Boolean(a && b && ymd(a) === ymd(b));

/** Hard bound for the grid: 6 weeks × 7 days. */
const GRID_CELLS = 42;

/** The 6×7 days shown for `month`, weeks starting on `weekStart` (0 Sunday, 1 Monday). */
export function monthGrid(month: Date, weekStart: 0 | 1 = 1): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 7 - weekStart) % 7));
  return Array.from({ length: GRID_CELLS }, (_, i) => addDays(start, i));
}

export interface DatePickerProps {
  /** `YYYY-MM-DD` or null. */
  value: string | null;
  onChange: (value: string) => void;
  locale: string;
  /** Accessible names: "Mês anterior", "Próximo mês", "Escolher data"; `clear` names the clear action ("Tirar o prazo"). */
  labels: { previousMonth: string; nextMonth: string; choose: string; clear?: string };
  placeholder?: string;
  /** 40px (default) or 34px, the same heights as Select's `md` and `sm`. */
  size?: "md" | "sm";
  /** With a date set, the grid ends with a clear action (`labels.clear`) that calls this. */
  onClear?: () => void;
  min?: string;
  max?: string;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  /** The chosen day without its weekday, and its year only when it isn't this one ("10 de nov."): a compact trigger. */
  short?: boolean;
  /** Under the month, at the start of the clear action's row: a way on from the date ("Ver no calendário"). */
  footer?: ReactNode;
}

/**
 * Our date picker: a trigger like our inputs and a small month grid in a
 * popover (Radix Popover). Keyboard: arrows move by day and week, Home/End
 * to the week's edges, PageUp/PageDown by month, Enter or Space picks, Esc
 * closes. Never the native date input.
 */
export function DatePicker({
  value,
  onChange,
  locale,
  labels,
  placeholder,
  size = "md",
  onClear,
  min,
  max,
  id,
  disabled,
  className,
  short = false,
  footer,
  ...rest
}: DatePickerProps) {
  const wiring = useFieldControl({ id });
  // One formatter per locale, not one per day cell per render.
  const fullDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "full" }), [locale]);
  const selected = parseYmd(value);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<Date>(() => selected ?? new Date());
  const grid = useRef<HTMLTableElement>(null);
  const minD = parseYmd(min);
  const maxD = parseYmd(max);
  const outOfRange = (d: Date) => Boolean((minD && d < minD) || (maxD && d > maxD));

  // Focus follows the roving day while the grid is open.
  // Focus follows the roving day while the grid is open. Keyed on the day's
  // string, not the Date object, and only moves focus when it isn't there
  // already: no focus/re-render ping-pong.
  const focusKey = ymd(focus);
  useEffect(() => {
    if (!open) return;
    const el = grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusKey}"]`);
    if (el && document.activeElement !== el) el.focus();
  }, [open, focusKey]);

  const label = selected
    ? new Intl.DateTimeFormat(
        locale,
        short
          ? {
              day: "numeric",
              month: "short",
              ...(selected.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
            }
          : { weekday: "short", day: "numeric", month: "short", year: "numeric" },
      ).format(selected)
    : (placeholder ?? "");
  const monthTitle = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(focus);
  // The week starts where the reader's language starts it (CLDR: Sunday in the US, Brazil, Japan…; else Monday).
  const weekStart = localeInfo(appLocale([locale], true) ?? "en").weekStart;
  const weekdays = monthGrid(focus, weekStart)
    .slice(0, 7)
    .map((d) => ({
      short: new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(d),
      long: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d),
    }));
  const days = monthGrid(focus, weekStart);
  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));

  const pick = (d: Date) => {
    if (outOfRange(d)) return;
    onChange(ymd(d));
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      Home: () => addDays(focus, -((focus.getDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() + 6) % 7)),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setFocus(move());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(focus);
    }
  };

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) setFocus(selected ?? new Date());
        setOpen(o);
      }}
    >
      <RPopover.Trigger asChild>
        <button
          type="button"
          className={cx("ac-select__trigger ac-date__trigger", size === "sm" && "ac-date__trigger--sm", className)}
          id={wiring.id}
          disabled={disabled}
          aria-label={rest["aria-label"]}
          aria-describedby={wiring["aria-describedby"]}
          aria-invalid={wiring["aria-invalid"]}
          aria-haspopup="dialog"
        >
          <span className={cx("ac-select__value", !selected && "ac-date__placeholder")}>{label}</span>
          <Icon name="calendar" size={18} className="ac-select__chev" />
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className="ac-menu ac-date"
          align="start"
          sideOffset={4}
          collisionPadding={EDGE_ROOM}
          role="dialog"
          aria-label={labels.choose}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="ac-date__head">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronLeft"
              aria-label={labels.previousMonth}
              onClick={() => setFocus((f) => addMonths(f, -1))}
            />
            <span className="ac-date__title" aria-live="polite">
              {monthTitle}
            </span>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronRight"
              aria-label={labels.nextMonth}
              onClick={() => setFocus((f) => addMonths(f, 1))}
            />
          </div>
          <table ref={grid} aria-label={monthTitle} className="ac-date__grid">
            <thead>
              <tr>
                {weekdays.map((w) => (
                  <th key={w.long} scope="col" abbr={w.long} className="ac-date__wd">
                    {w.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={ymd(week[0] as Date)}>
                  {week.map((d) => {
                    const isSelected = sameDay(d, selected);
                    return (
                      <td key={ymd(d)}>
                        <button
                          type="button"
                          className="ac-date__day"
                          data-day={ymd(d)}
                          data-outside={d.getMonth() !== focus.getMonth() || undefined}
                          data-today={sameDay(d, new Date()) || undefined}
                          tabIndex={sameDay(d, focus) ? 0 : -1}
                          disabled={outOfRange(d)}
                          aria-label={fullDate.format(d)}
                          aria-pressed={isSelected}
                          onKeyDown={onKey}
                          onClick={() => pick(d)}
                        >
                          {d.getDate()}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {(footer || (onClear && selected && labels.clear)) && (
            <div className="ac-date__foot">
              {footer && <span className="ac-date__extra">{footer}</span>}
              {onClear && selected && labels.clear && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    onClear();
                    setOpen(false);
                  }}
                >
                  {labels.clear}
                </Button>
              )}
            </div>
          )}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
