import type { RoutineTarget } from "@agenteschat/client";
import { useChannels } from "@agenteschat/client";
import { type CalItem, type RsvpStatus, shortDay } from "@agenteschat/client/lib/calendar";
import { formatTime } from "@agenteschat/client/lib/format";
import { appearanceStyle, Button, cx, Icon, Popover } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActorWho } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { DetailsLink } from "@/components/details-link";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";
import { RunResult } from "./RunsPopover";

/**
 * An agent's item takes the agent's colour: its deep end tints the block (`--cal-accent`), its light end is what the
 * dark theme writes in (`--cal-light`). A person's and a due date's come from the CSS.
 */
export function useAccent(item: CalItem): CSSProperties {
  const actors = useActors();
  if (item.source === "agent" || ((item.source === "routine" || item.source === "reminder") && item.agentId)) {
    const look = lookOf(actors.dir.agentById.get(item.agentId ?? ""));
    const vars = appearanceStyle(look) as Record<string, string> | undefined;
    return {
      "--cal-accent": vars?.["--av-bottom"] ?? "var(--agent)",
      "--cal-light": vars?.["--av-top"] ?? "var(--agent2)",
    } as CSSProperties;
  }
  return {};
}

/** "09:00–10:00"; a routine run or a reminder is a moment: "09:00". */
export const timeRange = (locale: string, it: CalItem) =>
  it.kind === "routine" || it.kind === "reminder"
    ? formatTime(locale, it.start.toISOString())
    : `${formatTime(locale, it.start.toISOString())}–${formatTime(locale, it.end.toISOString())}`;

/** How often a routine band runs: "a cada hora", "a cada 15 min", "6× por dia". */
export function useCadence() {
  const { t } = useTranslation();
  return (it: CalItem) => {
    const every = it.every;
    if (every && every % 60 === 0)
      return every === 60 ? t("calendar.every.hour") : t("calendar.every.hours", { count: every / 60 });
    if (every) return t("calendar.every.minutes", { count: every });
    const spanDays = Math.max(1, Math.round((it.end.getTime() - it.start.getTime()) / 86_400_000));
    return t("calendar.perDay", { count: Math.round((it.runs?.length ?? 0) / spanDays) });
  };
}

/** "seg, 12 out". */
export const dayLabel = shortDay;

/** A moment (a routine's run, a reminder) is over once its time came; anything else once it ended. */
const isOver = (item: CalItem, now: Date) =>
  (item.kind === "routine" && !item.runs) || item.kind === "reminder" ? item.start <= now : item.end <= now;

/**
 * One item on the calendar, the way Google Calendar draws one: a block tinted
 * in its owner's colour, their face opening its title, what's over lighter. A
 * click opens its details in a popover.
 */
export function EventChip({
  item,
  variant,
  style,
  now,
  day,
  measure,
  open,
  onOpenChange,
  details,
  onPointerDown,
  resizeHandle,
}: {
  item: CalItem;
  /**
   * `block` a meeting in the hour grid (its title, then its time where there's room), `run` a moment there (a
   * routine's run, a reminder) on one line, `bar` all day or several days, `line` a row in the month and the agenda.
   */
  variant: "block" | "run" | "bar" | "line";
  style?: CSSProperties;
  now?: Date;
  /** A frequent routine's row for one day (month, agenda): its first run then, and how many. */
  day?: { at: Date; count: number };
  /** The key its drawn height is measured by (`TimeGrid`). */
  measure?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ReactNode;
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  resizeHandle?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const accent = useAccent(item);
  const band = Boolean(item.runs);
  const bar = item.allDay && !band;
  const at = (d: Date) => formatTime(i18n.language, d.toISOString());
  const time = day ? at(day.at) : bar ? t("calendar.allDay") : timeRange(i18n.language, item);
  const title =
    item.kind === "deadline" ? t("calendar.deadline", { number: item.issueNumber, title: item.title }) : item.title;
  const label = bar
    ? t("calendar.allDayAria", { title })
    : item.kind === "routine"
      ? t("calendar.runAria", { name: item.title, time })
      : t("calendar.eventAria", { title: item.title, time });
  const owner = item.owner;
  const ownerName = owner ? actors.name(owner) : "";
  // A task nobody has: its kind's glyph stands in for a face where a column has room only for that (the CSS shows it).
  const face = owner ? (
    <ActorWho actor={owner} name={ownerName} faceOnly />
  ) : (
    <Icon name="issues" size={14} inline className="cal-chip__glyph" />
  );
  // Who it is, after the time, where the column has room for it (the CSS shows it).
  const who = owner && <span className="cal-chip__who">{` · ${ownerName}`}</span>;
  const repeat = item.kind === "event" && item.recurring && (
    <>
      {" "}
      <Icon name="repeat" size={14} inline className="cal-chip__repeat" />
    </>
  );
  const range = (
    <span className="cal-chip__time tabular">
      {variant === "block" && item.kind === "event" ? (
        <>
          {at(item.start)}
          <span className="cal-chip__end">{`–${at(item.end)}`}</span>
        </>
      ) : (
        time
      )}
      {day && day.count > 1 && ` ${t("calendar.runTimes", { count: day.count })}`}
      {variant !== "line" && who}
    </span>
  );
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={title}
      side="right"
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className={cx("cal-chip", `cal-chip--${variant}`)}
          data-source={item.source}
          data-kind={item.kind}
          data-recurring={item.recurring || undefined}
          data-allday={(variant === "line" && bar) || undefined}
          data-past={(now && isOver(item, now)) || undefined}
          data-measure={measure}
          style={{ ...accent, ...style }}
          aria-label={label}
          aria-pressed={open}
          title={owner ? t("calendar.runHint", { name: title, agent: ownerName, time }) : label}
          onPointerDown={onPointerDown}
        >
          {variant === "line" ? (
            // A row: the face, the time, the name, wrapping under the face. A day's bar: the face and the name.
            <>
              {face}
              {!bar && <>{range} </>}
              <span className="cal-chip__title">{title}</span>
              {repeat}
            </>
          ) : (
            <>
              <span className="cal-chip__title">
                {face}
                <span className="cal-chip__name">{title}</span>
                {repeat}
              </span>
              {variant === "block" && <span className="cal-chip__when">{range}</span>}
              {variant === "run" && <> {range}</>}
            </>
          )}
          {resizeHandle}
        </button>
      }
    >
      {details}
    </Popover>
  );
}

/** What the popover says about an item, with its actions. */
export function ItemDetails({
  item,
  onEdit,
  onDelete,
  onCancel,
  rsvp,
}: {
  item: CalItem;
  onEdit?: () => void;
  onDelete?: () => void;
  /** A reminder this person may cancel. */
  onCancel?: () => void;
  /** An event this person is invited to: their answer, and Vou or Não vou to give or change it. */
  rsvp?: { status: RsvpStatus; answers: Map<string, RsvpStatus>; onRespond: (status: "accepted" | "declined") => void };
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const cadence = useCadence();
  const channels = useChannels(org.id);
  const target = (tg: RoutineTarget) => {
    if (tg.type === "channel") return `#${channels.data?.find((c) => c.id === tg.channelId)?.name ?? ""}`;
    if (tg.type === "conversation") {
      const c = channels.data?.find((x) => x.id === tg.channelId);
      return c ? `#${c.name}` : t("routines.inConversation");
    }
    return t(tg.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
  const owner = item.owner;
  const role = owner?.type === "agent" ? actors.dir.agentById.get(owner.id)?.role : undefined;
  // A run: how it went, or how the routine's last run went while this one is ahead.
  const result = item.kind === "routine" && !item.runs ? (item.result ?? item.lastResult) : undefined;
  return (
    <section className="cal-details" aria-label={item.title}>
      {/* Whose it is, first: the agent of a routine or a reminder, who made an event, who has a task. */}
      {owner && (
        <p className="cal-details__owner">
          <ActorWho actor={owner} name={actors.name(owner)} />
          {role && ` · ${role}`}
        </p>
      )}
      <span className="cal-details__title">
        {item.kind === "deadline"
          ? t("calendar.deadline", { number: item.issueNumber, title: item.title })
          : item.title}
      </span>
      <span className="small muted">
        {dayLabel(i18n.language, item.start)}
        {item.runs
          ? `${item.end.getTime() - item.start.getTime() > 86_400_000 ? ` – ${dayLabel(i18n.language, new Date(item.end.getTime() - 1))}` : ""} · ${cadence(item)}`
          : item.allDay
            ? ` · ${t("calendar.allDay")}`
            : ` · ${timeRange(i18n.language, item)}`}
        {item.kind === "event" && item.recurring && (
          <>
            {" · "}
            <Icon name="repeat" size={14} inline /> {t("calendar.recurring")}
          </>
        )}
      </span>
      {item.runs && <span className="small">{t("calendar.runs", { count: item.runs.length })}</span>}
      {item.kind === "routine" && item.target && (
        <span className="small">{t("calendar.routineDetail", { target: target(item.target) })}</span>
      )}
      {result && (
        <span className="cal-details__result">
          <RunResult status={result} last={!item.result} />
        </span>
      )}
      {item.kind === "reminder" && item.target && (
        <>
          <span className="small">{t("calendar.reminderPosted", { target: target(item.target) })}</span>
          {item.setBy && (
            <span className="small">
              {t("calendar.reminderBy", { name: actors.name({ type: "person", id: item.setBy }) })}
            </span>
          )}
        </>
      )}
      {item.kind === "deadline" && <span className="small">{t("calendar.deadlineDetail")}</span>}
      {item.location && (
        <span className="small ac-iconline cal-details__row">
          <Icon name="link" size={14} aria-hidden="true" />
          {/^https?:\/\//.test(item.location) ? (
            <a className="ac-link" href={item.location} target="_blank" rel="noreferrer">
              {item.location}
            </a>
          ) : (
            item.location
          )}
        </span>
      )}
      {item.description && <span className="small">{item.description}</span>}
      {/* A routine's one person is its agent, the line on top. */}
      {item.kind !== "routine" && item.people.length > 0 && (
        <ul className="cal-details__people">
          {item.people.map((p) => {
            const answer = p.type === "person" ? rsvp?.answers.get(p.id) : undefined;
            return (
              <li key={`${p.type}:${p.id}`} className="actor-label">
                {actors.avatar(p)}
                <span>{actors.name(p)}</span>
                {answer && answer !== "needs_action" && (
                  <span className="small muted">{t(`calendar.rsvp.${answer}`)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rsvp && <span className="small">{t(`calendar.rsvp.mine.${rsvp.status}`)}</span>}
      <div className="cal-details__actions">
        {item.kind === "deadline" && item.issueNumber !== undefined && (
          <Link
            to="/org/$orgId/issues/$number"
            params={{ orgId: org.id, number: String(item.issueNumber) }}
            className="ac-link small"
          >
            {t("calendar.openIssue")}
          </Link>
        )}
        {item.kind === "routine" &&
          (item.routineId ? (
            <DetailsLink item={{ kind: "routine", id: item.routineId }} className="ac-link small">
              {t("calendar.openRoutine")}
            </DetailsLink>
          ) : (
            <Link to="/org/$orgId/routines" params={{ orgId: org.id }} className="ac-link small">
              {t("calendar.openRoutines")}
            </Link>
          ))}
        {onCancel && (
          <Button size="sm" variant="ghost" icon="trash" onClick={onCancel}>
            {t("calendar.cancelReminder")}
          </Button>
        )}
        {onDelete && (
          <Button size="sm" variant="ghost" icon="trash" onClick={onDelete}>
            {t("calendar.delete")}
          </Button>
        )}
        {rsvp && rsvp.status !== "accepted" && (
          <Button size="sm" icon="check" onClick={() => rsvp.onRespond("accepted")}>
            {t("calendar.rsvp.accept")}
          </Button>
        )}
        {rsvp && rsvp.status !== "declined" && (
          <Button size="sm" variant="ghost" icon="close" onClick={() => rsvp.onRespond("declined")}>
            {t("calendar.rsvp.decline")}
          </Button>
        )}
        {onEdit && (
          <Button size="sm" variant="primary" icon="edit" onClick={onEdit}>
            {t("calendar.edit")}
          </Button>
        )}
      </div>
    </section>
  );
}
