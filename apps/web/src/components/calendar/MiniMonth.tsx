import { sameDay } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { Button, monthGrid } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** The small month in the side panel: pick a day; dots-free, today in a filled pill. */
export function MiniMonth({
  focus,
  today,
  busy,
  onPick,
}: {
  focus: Date;
  today: Date;
  /** Days with something on them (bold). */
  busy: Set<string>;
  onPick: (d: Date) => void;
}) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(() => new Date(focus.getFullYear(), focus.getMonth(), 1));
  const [seen, setSeen] = useState(focus);
  // Follow the main calendar when it moves to another month.
  if (!sameDay(seen, focus)) {
    setSeen(focus);
    if (focus.getMonth() !== month.getMonth() || focus.getFullYear() !== month.getFullYear())
      setMonth(new Date(focus.getFullYear(), focus.getMonth(), 1));
  }
  const days = monthGrid(month);
  const title = new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(month);
  return (
    <section className="cal-mini" aria-label={t("calendar.miniMonth")}>
      <div className="cal-mini__head">
        <span className="cal-mini__title">{title}</span>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="chevronLeft"
          aria-label={t("common.previousMonth")}
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="chevronRight"
          aria-label={t("common.nextMonth")}
          onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        />
      </div>
      <div className="cal-mini__grid">
        {days.slice(0, 7).map((d) => (
          <span key={`h${toYmd(d)}`} className="cal-mini__dow" aria-hidden="true">
            {new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(d)}
          </span>
        ))}
        {days.map((d) => (
          <button
            key={toYmd(d)}
            type="button"
            className="cal-mini__day tabular"
            data-other={d.getMonth() !== month.getMonth() || undefined}
            data-today={sameDay(d, today) || undefined}
            data-busy={busy.has(toYmd(d)) || undefined}
            aria-pressed={sameDay(d, focus)}
            aria-label={new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" }).format(d)}
            onClick={() => onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </section>
  );
}
