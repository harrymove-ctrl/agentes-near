import type { Actor, CalendarEvent, CalendarEventPatch } from "@agenteschat/client";
import { toYmd } from "@agenteschat/client/lib/format";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import {
  Button,
  DatePicker,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  RecurrencePicker,
  type RecurrenceRule,
  Switch,
  Textarea,
  TimeSelect,
  weekdayOfYmd,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { PeoplePicker, type PickKey } from "@/components/MemberPicker";
import { useOrg } from "@/components/org-context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useEdited } from "@/hooks/useEdited";
import { fromApiRule, recurrenceLabels, ruleSentence, toApiRule, upcomingLabels } from "@/lib/recurrence";

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at = (ymd: string, time: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
};

export interface EventDraft {
  start: Date;
  end: Date;
  allDay?: boolean;
}

export interface EventSave {
  /** New event: everything; editing: only what changed. */
  input: CalendarEventPatch & { title: string; start: string; end: string; participants: Actor[] };
  patch: CalendarEventPatch;
}

/**
 * "Novo evento" / "Editar evento": title, all day, start and end (dates and
 * times, several days allowed), the recurrence picker, participants (people
 * and agents), location or link, description.
 */
export function EventDialog({
  open,
  draft,
  event,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  /** A new event's slot (from a drag or N). */
  draft: EventDraft | null;
  /** The event being edited (an occurrence of a series keeps its own times). */
  event: CalendarEvent | null;
  onClose: () => void;
  onSave: (save: EventSave) => void;
  saving: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const actors = useActors();
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "America/Sao_Paulo";
  const start0 = event ? new Date(event.start) : (draft?.start ?? new Date());
  const end0 = event ? new Date(event.end) : (draft?.end ?? new Date(start0.getTime() + 30 * 60_000));
  const [title, setTitle] = useState(event?.title ?? "");
  const [allDay, setAllDay] = useState(event?.allDay ?? draft?.allDay ?? false);
  // All-day events carry their days (`startDate`/`endDate`, the end inclusive).
  const [startDay, setStartDay] = useState(event?.allDay && event.startDate ? event.startDate : toYmd(start0));
  const [startTime, setStartTime] = useState(hm(start0));
  const [endDay, setEndDay] = useState(
    event?.allDay && event.endDate
      ? event.endDate
      : toYmd(event?.allDay ? new Date(end0.getTime() - 86_400_000) : end0),
  );
  const [endTime, setEndTime] = useState(hm(end0));
  const [location, setLocation] = useState(event?.location ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [picked, setPicked] = useState<Set<PickKey>>(
    () =>
      new Set(
        (event?.participants ?? [])
          .filter((p) => !(p.type === "person" && p.id === me.user.id))
          .map((p) => `${p.type}:${p.id}` as PickKey),
      ),
  );
  const zone = event?.timezone || myZone;
  const [rule, setRule] = useState<RecurrenceRule>(() =>
    event?.rule
      ? fromApiRule(event.rule, toYmd(start0))
      : { freq: "once", interval: 1, times: [hm(start0)], timezone: zone, start: toYmd(start0) },
  );
  // The rule follows the event's first day and time.
  const syncedRule: RecurrenceRule = {
    ...rule,
    start: startDay,
    times: [allDay ? "00:00" : startTime],
    ...(rule.freq === "weekly" && !rule.byWeekday?.length ? { byWeekday: [weekdayOfYmd(startDay)] } : {}),
  };
  const unsaved = useEdited(open, [
    title,
    location,
    description,
    [...picked],
    rule,
    allDay,
    startDay,
    startTime,
    endDay,
    endTime,
  ]);
  const start = at(startDay, allDay ? "00:00" : startTime);
  const end = allDay ? at(endDay, "00:00") : at(endDay, endTime);
  const timeOk = allDay ? end >= start : end > start;
  const participants: Actor[] = [
    { type: "person", id: me.user.id },
    ...[...picked].map((k) => {
      const [type, id] = k.split(":");
      return { type: type as Actor["type"], id: id ?? "" };
    }),
  ];
  const submit = () => {
    if (!title.trim() || !timeOk) return;
    const endAt = allDay ? new Date(end.getTime() + 86_400_000) : end;
    const input = {
      title: title.trim(),
      start: start.toISOString(),
      end: endAt.toISOString(),
      allDay,
      timezone: syncedRule.timezone,
      participants,
      rule: syncedRule.freq === "once" ? null : toApiRule(syncedRule),
      ...(allDay ? { startDate: startDay, endDate: endDay } : {}),
      location: location.trim() || null,
      description: description.trim(),
    };
    const patch: CalendarEventPatch = {};
    if (event) {
      if (input.title !== event.title) patch.title = input.title;
      if (input.start !== new Date(event.start).toISOString()) patch.start = input.start;
      if (input.end !== new Date(event.end).toISOString()) patch.end = input.end;
      if (input.allDay !== event.allDay) patch.allDay = input.allDay;
      if (allDay && (startDay !== event.startDate || endDay !== event.endDate)) {
        patch.startDate = startDay;
        patch.endDate = endDay;
      }
      if (input.location !== (event.location ?? null)) patch.location = input.location;
      if (input.description !== (event.description ?? "")) patch.description = input.description;
      const before = event.rule ? JSON.stringify(toApiRule(fromApiRule(event.rule, toYmd(start0)))) : "null";
      if (JSON.stringify(input.rule) !== before) patch.rule = input.rule;
      const keys = (list: Actor[]) =>
        list
          .map((p) => `${p.type}:${p.id}`)
          .sort()
          .join(",");
      if (keys(participants) !== keys(event.participants)) patch.participants = participants;
    }
    onSave({ input, patch });
  };
  const dateLabels = {
    previousMonth: t("common.previousMonth"),
    nextMonth: t("common.nextMonth"),
    choose: t("common.chooseDate"),
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={event ? t("calendar.form.editTitle") : t("calendar.new")}
      closeLabel={t("common.close")}
      unsaved={unsaved}
      width={600}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={saving}>
          <DialogBody>
            <Field label={t("calendar.form.title")} id="ev-title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("calendar.form.titlePlaceholder")}
              />
            </Field>
            <label className="cal-form__switch" htmlFor="ev-allday">
              <Switch id="ev-allday" checked={allDay} onCheckedChange={setAllDay} />
              <span>{t("calendar.form.allDay")}</span>
            </label>
            <div className="cal-form__when">
              <Field label={t("calendar.form.startDate")} id="ev-sd">
                <DatePicker
                  value={startDay}
                  onChange={(v) => {
                    // The end keeps the same length.
                    const shift = at(v, "00:00").getTime() - at(startDay, "00:00").getTime();
                    setStartDay(v);
                    setEndDay(toYmd(new Date(at(endDay, "00:00").getTime() + shift)));
                  }}
                  locale={i18n.language}
                  labels={dateLabels}
                />
              </Field>
              {!allDay && (
                <Field label={t("calendar.form.startTime")} id="ev-st">
                  <TimeSelect value={startTime} onChange={setStartTime} />
                </Field>
              )}
              <Field label={t("calendar.form.endDate")} id="ev-ed">
                <DatePicker
                  value={endDay}
                  onChange={setEndDay}
                  locale={i18n.language}
                  labels={dateLabels}
                  min={startDay}
                />
              </Field>
              {!allDay && (
                <Field
                  label={t("calendar.form.endTime")}
                  id="ev-et"
                  error={timeOk ? undefined : t("calendar.form.timeInvalid")}
                >
                  <TimeSelect value={endTime} onChange={setEndTime} />
                </Field>
              )}
            </div>
            <div className="cal-form__repeat">
              <span className="ac-field__label">{t("calendar.form.repeat")}</span>
              <RecurrencePicker
                value={syncedRule}
                onChange={setRule}
                labels={recurrenceLabels(t, i18n.language, syncedRule)}
                locale={i18n.language}
                renderTimezone={(value, change) => (
                  <ZoneSelect value={value} onChange={change} aria-label={t("recurrence.timezone")} />
                )}
                summary={syncedRule.freq === "once" ? undefined : ruleSentence(t, i18n.language, syncedRule)}
                upcoming={syncedRule.freq === "once" ? undefined : upcomingLabels(i18n.language, syncedRule)}
                hideTimes
              />
            </div>
            <PeoplePicker
              label={t("calendar.form.participants")}
              searchLabel={t("calendar.form.participantsSearch")}
              hint={t("calendar.form.participantsHelp")}
              emptyText={() => t("calendar.form.participantsEmpty")}
              selected={picked}
              onChange={setPicked}
            />
            <Field label={t("calendar.form.location")} id="ev-loc">
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t("calendar.form.locationPlaceholder")}
              />
            </Field>
            <Field label={t("calendar.form.description")} id="ev-desc">
              <Textarea
                rows={3}
                maxLength={10_000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("calendar.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || !timeOk || saving} loading={saving}>
            {event ? t("calendar.form.save") : t("calendar.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
