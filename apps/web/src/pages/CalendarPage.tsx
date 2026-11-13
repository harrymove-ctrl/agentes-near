import type { CalendarEvent, CalendarRange, SeriesScope } from "@agenteschat/client";
import { useCalendar, useCalendarAction, useReminderAction, useRoutines } from "@agenteschat/client";
import {
  addDays,
  addMinutes,
  type CalendarView,
  type CalItem,
  collapseRoutines,
  type ItemSource,
  isBarItem,
  myRsvp,
  onDay,
  rangeLabel,
  sameDay,
  slotText,
  startOfDay,
  stepFocus,
  toItems,
  upcomingItems,
  viewDays,
  viewRange,
} from "@agenteschat/client/lib/calendar";
import { errorText } from "@agenteschat/client/lib/errors";
import { dateOnly, formatTime, joinNames, toYmd } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { runPixelStatus, runPixels } from "@agenteschat/client/lib/routine-view";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import {
  ApprovalCard,
  Button,
  FilterToggle,
  Icon,
  type IconName,
  Kbd,
  ListRow,
  offsetMinutes,
  PageHeader,
  Popover,
  Segmented,
  Toolbar,
  useDelayed,
} from "@agenteschat/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { actorKey, useActors } from "@/components/actors";
import { AgendaView } from "@/components/calendar/AgendaView";
import { dayLabel, ItemDetails } from "@/components/calendar/EventChip";
import { EventDialog, type EventDraft, type EventSave } from "@/components/calendar/EventDialog";
import { MiniMonth } from "@/components/calendar/MiniMonth";
import { MonthView } from "@/components/calendar/MonthView";
import { Owners } from "@/components/calendar/Owners";
import { SeriesPrompt } from "@/components/calendar/SeriesPrompt";
import { TimeGrid } from "@/components/calendar/TimeGrid";
import { ErrorState, LoadingList } from "@/components/Loading";
import { PHONE_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { matchesNow } from "@/hooks/useMatchMedia";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./calendar.css";

export { mondayOf } from "@agenteschat/client/lib/calendar";

const VIEWS: CalendarView[] = ["day", "week", "month", "agenda"];
/** A linked event's day goes with it when its details close. */
const WITH_OPEN = ["day"];
const SOURCES: { source: ItemSource; icon: IconName }[] = [
  { source: "person", icon: "person" },
  { source: "agent", icon: "agent" },
  { source: "routine", icon: "routines" },
  { source: "reminder", icon: "bell" },
  { source: "deadline", icon: "issues" },
];
type Filters = Record<ItemSource, boolean>;
const ALL_SOURCES: Filters = { person: true, agent: true, routine: true, reminder: true, deadline: true };

/** A pending edit or delete of a recurring event: which occurrences? */
interface SeriesAsk {
  action: "edit" | "delete";
  run: (scope: SeriesScope) => void;
}

const isSeries = (e: CalendarEvent | undefined) => Boolean(e?.rule && e.rule.freq !== "once");
const seriesOf = (e: CalendarEvent, scope: SeriesScope) => ({ scope, occurrenceStart: e.occurrenceStart ?? e.start });
/** Nobody's typing and nothing modal is open: single-key shortcuts apply. */
const shortcutsFree = (e: KeyboardEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return false;
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return false;
  return !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
};

/**
 * Calendário (v2): Dia / Semana / Mês / Agenda, a collapsible side panel
 * (mini month, Agentes e pessoas, Próximos, filters by source), drag to create
 * and to move, recurring events with "Só este / Este e os próximos / Todos".
 * Keys: ←/→ move the day, N creates, T goes to today.
 */
export function CalendarPage({ today: todayProp, day }: { today?: Date; day?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useCalendarAction(org.id);
  const reminders = useReminderAction(org.id);
  const [today] = useState(() => todayProp ?? new Date());
  const [now, setNow] = useState(() => new Date());
  // A phone's width holds one day's column, not a week of seven unreadable ones.
  const [view, setView] = useState<CalendarView>(() => (matchesNow(PHONE_QUERY) ? "day" : "week"));
  // A link to an event (an invitation's email) says its day, so the view starts on its week.
  const [linked, setLinked] = useOpenParam("open", WITH_OPEN);
  const [focus, setFocus] = useState(() => startOfDay(day ? dateOnly(day) : today));
  const [businessOnly, setBusinessOnly] = useState(false);
  // Beside a week only from 1440: under it the panel would leave the week columns too narrow for a name.
  const [panel, setPanel] = useState(() => typeof window === "undefined" || window.innerWidth >= 1440);
  const [filters, setFilters] = useState<Filters>(ALL_SOURCES);
  // Whose items are hidden (Agentes e pessoas), by `actorKey`.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ draft: EventDraft | null; event: CalendarEvent | null } | null>(null);
  const [ask, setAsk] = useState<SeriesAsk | null>(null);

  // The current-time line moves every minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const days = viewDays(view, focus, businessOnly);
  const { from, to } = viewRange(view, focus);
  const range = useCalendar(org.id, from.toISOString(), to.toISOString());
  const soon = useCalendar(org.id, startOfDay(now).toISOString(), addDays(startOfDay(now), 14).toISOString());
  // The calendar can be read in another zone: items are shown at that zone's wall-clock time.
  const [viewZone, setViewZone] = useState(() => browserTimezone() ?? "UTC");
  const toView = (d: Date) => new Date(d.getTime() + (offsetMinutes(viewZone, d) + d.getTimezoneOffset()) * 60_000);
  const fromView = (d: Date) => new Date(d.getTime() - (offsetMinutes(viewZone, d) + d.getTimezoneOffset()) * 60_000);
  const shiftItems = (list: CalItem[]) =>
    list.map((it) => (it.allDay ? it : { ...it, start: toView(it.start), end: toView(it.end) }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: toView only depends on the zone
  const all = useMemo(() => shiftItems(toItems(range.data)), [range.data, viewZone]);
  // A routine that runs often is one band, not a chip per run; its lane shows how the recent runs went.
  const routines = useRoutines(org.id);
  const routineById = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r])), [routines.data]);
  const sourced = collapseRoutines(
    all.filter((it) => filters[it.source]),
    days,
  );
  const ownerShown = (it: CalItem) => !it.owner || !hidden.has(actorKey(it.owner));
  const items = sourced.filter(ownerShown).map((it) => {
    const r = it.routineId ? routineById.get(it.routineId) : undefined;
    if (!r) return it;
    if (!it.runs) {
      // A single run: how it went when it already ran (a run within 5 minutes of it), and the routine's last result.
      const recent = runPixels(r.recentRuns);
      const own = recent.find((x) => Math.abs(toView(new Date(x.at)).getTime() - it.start.getTime()) < 5 * 60_000);
      const last = r.lastRun ? (runPixelStatus(r.lastRun.status) ?? undefined) : undefined;
      return { ...it, result: own?.status, lastResult: recent[0]?.status ?? last };
    }
    const pastRuns = runPixels(r.recentRuns).map((x) => ({
      at: toView(new Date(x.at)),
      status: x.status,
      weight: x.weight,
    }));
    return { ...it, pastRuns, running: r.state === "running" };
  });
  const counts = Object.fromEntries(
    SOURCES.map(({ source }) => [source, all.filter((it) => it.source === source).length]),
  );
  const events = useMemo(() => eventsByKey(range.data), [range.data]);
  const upcoming = upcomingItems(
    shiftItems(toItems(soon.data)).filter((it) => filters[it.source] && ownerShown(it)),
    now,
  );
  // Once the linked event has loaded, its details open; closing them drops the link.
  const shownLink = useRef<string | null>(null);
  useEffect(() => {
    const item = linked && shownLink.current !== linked ? items.find((it) => it.eventId === linked) : undefined;
    if (!item || !linked) return;
    shownLink.current = linked;
    setFocus(startOfDay(item.start));
    setOpenKey(item.key);
  });
  const onOpenKey = (key: string | null) => {
    setOpenKey(key);
    if (!key && linked) setLinked(null);
  };
  const placeholders = useDelayed(range.isLoading);
  const busy = useMemo(() => new Set(all.map((it) => toYmd(it.start))), [all]);
  const proposal = range.data?.proposals[0];

  const newAt = (day: Date) => {
    const start = addMinutes(startOfDay(day), 9 * 60);
    setDialog({ draft: { start, end: addMinutes(start, 30) }, event: null });
  };
  // Keyboard: ←/→ (↑/↓ by week), N, T.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutsFree(e)) return;
      const k = e.key;
      if (k === "n" || k === "N") {
        e.preventDefault();
        if (posts) newAt(focus);
      } else if (k === "t" || k === "T") {
        e.preventDefault();
        setFocus(startOfDay(today));
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        setFocus((f) => addDays(f, k === "ArrowLeft" ? -1 : 1));
      } else if ((k === "ArrowUp" || k === "ArrowDown") && view !== "day") {
        e.preventDefault();
        setFocus((f) => addDays(f, k === "ArrowUp" ? -7 : 7));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = ({ input, patch }: EventSave) => {
    const editing = dialog?.event;
    const done = (msg: string) => () => {
      toast.show(msg);
      setDialog(null);
    };
    if (!editing) {
      action.mutate(
        { type: "create", input: { ...input, recurrence: "none" } },
        { onSuccess: done(t("calendar.form.created")) },
      );
      return;
    }
    if (Object.keys(patch).length === 0) {
      setDialog(null);
      return;
    }
    const id = editing.id;
    if (isSeries(editing)) {
      setAsk({
        action: "edit",
        run: (scope) =>
          action.mutate(
            { type: "update", id, patch, series: seriesOf(editing, scope) },
            { onSuccess: done(t("calendar.saved")) },
          ),
      });
      return;
    }
    action.mutate({ type: "update", id, patch }, { onSuccess: done(t("calendar.saved")) });
  };
  const move = (item: CalItem, r: { start: Date; end: Date }) => {
    const e = events.get(item.key);
    if (!e) return;
    const patch = { start: fromView(r.start).toISOString(), end: fromView(r.end).toISOString() };
    const run = (scope?: SeriesScope) =>
      action.mutate(
        { type: "update", id: e.id, patch, ...(scope ? { series: seriesOf(e, scope) } : {}) },
        { onSuccess: () => toast.show(t("calendar.moved")) },
      );
    if (isSeries(e)) setAsk({ action: "edit", run });
    else run();
  };
  const remove = (item: CalItem) => {
    const e = events.get(item.key);
    if (!e) return;
    setOpenKey(null);
    const run = (scope?: SeriesScope) =>
      action.mutate(
        { type: "remove", id: e.id, ...(scope ? { series: seriesOf(e, scope) } : {}) },
        { onSuccess: () => toast.show(t("calendar.deleted")) },
      );
    if (isSeries(e)) setAsk({ action: "delete", run });
    else run();
  };
  const cancelReminder = (id: string) => {
    setOpenKey(null);
    reminders.mutate(
      { type: "cancel", id },
      {
        onSuccess: () => toast.show(t("calendar.reminderCancelled")),
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  };
  const respond = (item: CalItem, status: "accepted" | "declined") => {
    const e = events.get(item.key);
    if (!e) return;
    action.mutate(
      { type: "respond", id: e.id, status },
      { onError: (error) => toast.show(errorText(t, error, i18n.language), "error") },
    );
  };
  const rsvpOf = (item: CalItem) => {
    const e = item.kind === "event" ? events.get(item.key) : undefined;
    const status = myRsvp(e, me.user.id);
    if (!e || !status) return undefined;
    const answers = new Map(e.rsvp.filter((r) => r.type === "person").map((r) => [r.id, r.status]));
    return { status, answers, onRespond: (next: "accepted" | "declined") => respond(item, next) };
  };
  const details = (item: CalItem) => (
    <ItemDetails
      item={item}
      rsvp={rsvpOf(item)}
      onEdit={
        item.kind === "event"
          ? () => {
              setOpenKey(null);
              setDialog({ draft: null, event: events.get(item.key) ?? null });
            }
          : undefined
      }
      onDelete={item.kind === "event" ? () => remove(item) : undefined}
      onCancel={item.reminderId && item.canCancel ? () => cancelReminder(item.reminderId as string) : undefined}
    />
  );
  const inGrid = items.filter((it) => days.some((d) => onDay(it, d)));
  const posts = can(org, "post");
  const filtersOff = Object.values(filters).includes(false) || hidden.size > 0;
  const clearFilters = () => {
    setFilters(ALL_SOURCES);
    setHidden(new Set());
  };
  const owners = (
    <Owners
      items={sourced.filter((it) => days.some((d) => onDay(it, d)))}
      hidden={hidden}
      onToggle={(key) =>
        setHidden((h) => {
          const next = new Set(h);
          if (!next.delete(key)) next.add(key);
          return next;
        })
      }
    />
  );
  // The last range stays on screen while the next one loads: its items say nothing about these days.
  const agendaWaits = range.isLoading || range.isPlaceholderData;
  const agendaEmpty = view === "agenda" && range.isSuccess && !agendaWaits && inGrid.length === 0 && !filtersOff;
  const filterChips = (
    <Toolbar size="sm" label={t("calendar.filters")}>
      {SOURCES.map(({ source, icon }) => (
        <FilterToggle
          key={source}
          icon={icon}
          pressed={filters[source]}
          count={counts[source] ?? 0}
          onPressedChange={() => setFilters((f) => ({ ...f, [source]: !f[source] }))}
        >
          {t(`calendar.filter.${source}`)}
        </FilterToggle>
      ))}
    </Toolbar>
  );

  return (
    <div className="cal-page" data-panel={panel || undefined}>
      <PageHeader
        className="cal-page__header"
        title={t("calendar.title")}
        meta={rangeLabel(i18n.language, view, days, focus)}
        metaLive
        actions={
          <>
            <Button
              variant="ghost"
              iconOnly
              icon="sidebar"
              aria-label={panel ? t("calendar.hidePanel") : t("calendar.showPanel")}
              aria-expanded={panel}
              onClick={() => setPanel((p) => !p)}
            />
            {/* Creating an event is posting. An empty agenda holds this button: one way in, in the middle of the page. */}
            {posts && !agendaEmpty && (
              <Button variant="primary" icon="plus" className="cal-page__new" onClick={() => newAt(focus)}>
                {t("calendar.new")}
                <Kbd aria-hidden="true">N</Kbd>
              </Button>
            )}
          </>
        }
      >
        <div className="cal-page__tools">
          {/* biome-ignore lint/a11y/useSemanticElements: prev / today / next as one compact group */}
          <div className="cal-nav" role="group" aria-label={t("calendar.nav")}>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronLeft"
              aria-label={t(`calendar.prev.${view}`)}
              onClick={() => setFocus((f) => stepFocus(view, f, -1))}
            />
            <Button size="sm" variant="ghost" onClick={() => setFocus(startOfDay(today))}>
              {t("calendar.today")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="chevronRight"
              aria-label={t(`calendar.next.${view}`)}
              onClick={() => setFocus((f) => stepFocus(view, f, 1))}
            />
          </div>
          <Segmented
            label={t("calendar.view")}
            size="sm"
            value={view}
            onValueChange={setView}
            options={VIEWS.map((v) => ({ value: v, label: t(`calendar.views.${v}`) }))}
          />
          {view === "week" && (
            <FilterToggle pressed={businessOnly} onPressedChange={setBusinessOnly}>
              {t("calendar.businessDays")}
            </FilterToggle>
          )}
        </div>
        {!panel && (
          <Popover
            label={t("calendar.filters")}
            side="bottom"
            align="end"
            trigger={
              <Button size="sm" variant="ghost" icon="filter">
                {t("calendar.filters")}
              </Button>
            }
          >
            <div className="cal-filters">
              {filterChips}
              {owners}
            </div>
          </Popover>
        )}
      </PageHeader>
      <div className="cal-page__body">
        <div className="cal-page__main">
          {range.isError && !range.data && <ErrorState error={range.error} onRetry={() => void range.refetch()} />}
          {(view === "day" || view === "week") && (
            <TimeGrid
              days={days}
              items={items}
              today={today}
              now={toView(now)}
              loading={placeholders}
              focusDay={focus}
              openKey={openKey}
              onOpenKey={onOpenKey}
              details={details}
              onCreate={(r) => {
                if (posts) setDialog({ draft: { start: fromView(r.start), end: fromView(r.end) }, event: null });
              }}
              onMove={move}
              onFocusDay={setFocus}
              emptyHint={posts && range.isSuccess && inGrid.length === 0 ? t("calendar.emptyHint") : null}
            />
          )}
          {view === "month" && (
            <MonthView
              days={days}
              month={focus.getMonth()}
              items={items}
              today={today}
              now={toView(now)}
              focusDay={focus}
              openKey={openKey}
              onOpenKey={onOpenKey}
              details={details}
              onFocusDay={setFocus}
            />
          )}
          {view === "agenda" && agendaWaits && <LoadingList count={4} avatar={false} />}
          {view === "agenda" && range.data && !agendaWaits && (
            <AgendaView
              days={days}
              items={items}
              today={today}
              now={toView(now)}
              openKey={openKey}
              onOpenKey={onOpenKey}
              details={details}
              onNew={posts ? () => newAt(focus) : undefined}
              onClearFilters={filtersOff ? clearFilters : undefined}
            />
          )}
        </div>
        {panel && (
          <aside className="cal-side" aria-label={t("calendar.panel")}>
            {proposal && <Proposal proposal={proposal} />}
            <MiniMonth
              focus={focus}
              today={today}
              busy={busy}
              onPick={(d) => {
                setFocus(d);
                if (view === "agenda") setView("day");
              }}
            />
            {owners}
            <section className="cal-side__section" aria-label={t("calendar.upcoming")}>
              <h2 className="cal-side__title">{t("calendar.upcoming")}</h2>
              {upcoming.length === 0 ? (
                <p className="small muted">{t("calendar.upcomingEmpty")}</p>
              ) : (
                <ol className="cal-upcoming">
                  {upcoming.map((it) => {
                    const day = sameDay(it.start, now) ? t("calendar.today") : dayLabel(i18n.language, it.start);
                    return (
                      <li key={it.key}>
                        <ListRow
                          lead={
                            it.owner ? (
                              <ActorAvatar actor={it.owner} size="xs" name={actors.name(it.owner)} />
                            ) : (
                              <Icon name="calendar" size={16} aria-hidden="true" />
                            )
                          }
                          title={it.title}
                          meta={
                            it.allDay || isBarItem(it)
                              ? day
                              : t("calendar.upcomingMeta", {
                                  day,
                                  time: formatTime(i18n.language, it.start.toISOString()),
                                })
                          }
                          onClick={() => {
                            setFocus(startOfDay(it.start));
                            if (view === "agenda" || view === "month") setView("week");
                          }}
                        />
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
            <section className="cal-side__section" aria-label={t("calendar.filters")}>
              <h2 className="cal-side__title">{t("calendar.filters")}</h2>
              {filterChips}
            </section>
            <section className="cal-side__section" aria-label={t("calendar.viewZone")}>
              <h2 className="cal-side__title">{t("calendar.viewZone")}</h2>
              <ZoneSelect value={viewZone} onChange={setViewZone} aria-label={t("calendar.viewZone")} />
            </section>
          </aside>
        )}
      </div>
      {dialog && (
        <EventDialog
          open
          draft={dialog.draft}
          event={dialog.event}
          onClose={() => setDialog(null)}
          onSave={save}
          saving={action.isPending}
        />
      )}
      <SeriesPrompt
        open={Boolean(ask)}
        action={ask?.action ?? "edit"}
        onCancel={() => setAsk(null)}
        onPick={(scope) => {
          ask?.run(scope);
          setAsk(null);
        }}
      />
    </div>
  );
}

/** Range events by the key their items use (an occurrence: series id + its start). */
function eventsByKey(range: CalendarRange | undefined) {
  const map = new Map<string, CalendarEvent>();
  for (const e of range?.events ?? [])
    map.set(e.occurrenceStart ? `${e.seriesId ?? e.id}@${e.occurrenceStart}` : e.id, e);
  return map;
}

function Proposal({ proposal }: { proposal: CalendarRange["proposals"][number] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useCalendarAction(org.id);
  const agent = { type: "agent" as const, id: proposal.agentId };
  const when = slotText(i18n.language, proposal.start, proposal.end);
  const people = joinNames(proposal.participants.map(actors.name), t);
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("calendar.proposal")}
      avatar={actors.avatar(agent)}
      who={<Trans i18nKey="calendar.proposes" values={{ name: actors.name(agent) }} components={[<b key="b" />]} />}
      title={proposal.title}
      detail={[t("calendar.proposalDetail", { when, people }), proposal.note].filter(Boolean).join(" · ")}
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={action.isPending}
            loading={action.isPending && action.variables?.type === "confirm"}
            onClick={() =>
              action.mutate(
                { type: "confirm", id: proposal.id },
                { onSuccess: () => toast.show(t("calendar.confirmed")) },
              )
            }
          >
            {t("calendar.confirm")}
          </Button>
          <Button
            size="sm"
            disabled={action.isPending}
            loading={action.isPending && action.variables?.type === "dismiss"}
            onClick={() => action.mutate({ type: "dismiss", id: proposal.id })}
          >
            {t("calendar.otherTime")}
          </Button>
        </>
      }
    />
  );
}
