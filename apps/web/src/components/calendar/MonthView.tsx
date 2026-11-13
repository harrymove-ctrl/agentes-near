import { type CalItem, type DayEntry, dayEntries, sameDay } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { Popover } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dayLabel, EventChip } from "./EventChip";

/** Rows shown per day before "+N mais". */
const PER_DAY = 3;

/**
 * Mês: 6 weeks; each day lists its first items as rows (all day first, then
 * by time: the owner's face, the time, the name) and "+N mais" opens the rest
 * in a popover. A routine's runs are rows like the rest.
 */
export function MonthView({
  days,
  month,
  items,
  today,
  now,
  focusDay,
  openKey,
  onOpenKey,
  details,
  onFocusDay,
}: {
  days: Date[];
  month: number;
  items: CalItem[];
  today: Date;
  now: Date;
  focusDay: Date;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  details: (item: CalItem) => ReactNode;
  onFocusDay: (d: Date) => void;
}) {
  const { t, i18n } = useTranslation();
  const weekdays = days.slice(0, 7);
  const row = (e: DayEntry) => (
    <EventChip
      key={e.key}
      item={e.item}
      variant="line"
      now={now}
      day={e.day}
      open={openKey === e.key}
      onOpenChange={(o) => onOpenKey(o ? e.key : null)}
      details={details(e.item)}
    />
  );
  return (
    <section className="cal-month" aria-label={t("calendar.grid")}>
      <div className="cal-month__head">
        {weekdays.map((d) => (
          <span key={toYmd(d)} className="small muted">
            {new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\.$/, "")}
          </span>
        ))}
      </div>
      <div className="cal-month__grid">
        {days.map((d) => {
          const list = dayEntries(items, d);
          const rest = list.length - PER_DAY;
          return (
            <div
              key={toYmd(d)}
              className="cal-month__cell"
              data-day={toYmd(d)}
              data-other={d.getMonth() !== month || undefined}
              data-today={sameDay(d, today) || undefined}
            >
              <button
                type="button"
                className="cal-month__num tabular"
                aria-current={sameDay(d, today) ? "date" : undefined}
                aria-pressed={sameDay(d, focusDay)}
                aria-label={dayLabel(i18n.language, d)}
                onClick={() => onFocusDay(d)}
              >
                {d.getDate()}
              </button>
              {list.slice(0, rest > 0 ? PER_DAY : list.length).map(row)}
              {rest > 0 && (
                <Popover
                  label={dayLabel(i18n.language, d)}
                  side="bottom"
                  className="cal-more"
                  trigger={
                    <button type="button" className="cal-month__more" aria-label={t("calendar.more", { count: rest })}>
                      <span className="cal-more-words">{t("calendar.more", { count: rest })}</span>
                      {/* Where the day is a column of faces, the count alone. */}
                      <span className="cal-more-count">+{rest}</span>
                    </button>
                  }
                >
                  <p className="cal-more__title">{dayLabel(i18n.language, d)}</p>
                  <div className="cal-more__list">{list.map(row)}</div>
                </Popover>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
