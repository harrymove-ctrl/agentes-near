import { type CalItem, dayEntries, sameDay } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { Button, EmptyState } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { dayLabel, EventChip } from "./EventChip";

/**
 * Agenda: the next 30 days as a list, only the days with something. Each day's
 * rows are the month's (the owner's face, the time, the name), a routine's
 * runs among them.
 */
export function AgendaView({
  days,
  items,
  today,
  now,
  openKey,
  onOpenKey,
  details,
  onNew,
  onClearFilters,
}: {
  days: Date[];
  items: CalItem[];
  today: Date;
  now: Date;
  openKey: string | null;
  onOpenKey: (key: string | null) => void;
  details: (item: CalItem) => ReactNode;
  /** Absent for who can't post: creating an event is posting. */
  onNew?: (() => void) | undefined;
  /** With a source filtered out: nothing here says little about the days, the way out is the filter. */
  onClearFilters?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const look = useRightHandLook();
  const groups = days.map((d) => ({ d, list: dayEntries(items, d) })).filter((g) => g.list.length > 0);
  if (groups.length === 0 && onClearFilters)
    return (
      <EmptyState size="panel" actions={<Button onClick={onClearFilters}>{t("filters.clearAll")}</Button>}>
        {t("calendar.noResults")}
      </EmptyState>
    );
  if (groups.length === 0)
    return (
      <EmptyState
        size="page"
        agent={look}
        title={t("calendar.agendaEmptyTitle")}
        actions={
          onNew && (
            <Button variant="primary" icon="plus" onClick={onNew}>
              {t("calendar.new")}
            </Button>
          )
        }
      >
        {t("calendar.agendaEmpty")}
      </EmptyState>
    );
  return (
    <div className="cal-agenda">
      {groups.map((g) => (
        <section key={toYmd(g.d)} className="cal-agenda__day" aria-label={dayLabel(i18n.language, g.d)}>
          <h2 className="cal-agenda__date" data-today={sameDay(g.d, today) || undefined}>
            <span className="cal-agenda__num tabular">{g.d.getDate()}</span>
            <span className="small muted">{dayLabel(i18n.language, g.d)}</span>
          </h2>
          <div className="cal-agenda__list">
            {g.list.map((e) => (
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
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
