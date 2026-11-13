import { type ReactNode, useId, useState } from "react";
import { cx } from "../cx";
import {
  BUSINESS_DAYS,
  type RecurrenceFreq,
  type RecurrenceRule,
  ruleFor,
  WEEKDAYS,
  type Weekday,
  weekdayOfYmd,
  weekdayPosition,
} from "../recurrence";
import { Button } from "./Button";
import { DatePicker, type DatePickerProps } from "./DatePicker";
import { Input } from "./Field";
import { Segmented } from "./Segmented";
import { Select, type SelectOption } from "./Select";
import { TimeSelect } from "./TimeSelect";

export type RecurrenceMode = "once" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
type Unit = Exclude<RecurrenceFreq, "once">;

export interface RecurrenceLabels {
  frequency: string;
  modes: Record<RecurrenceMode, string>;
  /** "A cada". */
  every: string;
  /** "dias", "semanas"… (after the number). */
  units: Record<Unit, string>;
  /** Accessible name of the number field ("Intervalo"). */
  interval: string;
  /** "Unidade". */
  unit: string;
  businessDays: string;
  /** "Dias da semana". */
  weekdaysLabel: string;
  weekdays: Record<Weekday, { short: string; long: string }>;
  /** "No dia". */
  onDay: string;
  /** "Na". */
  onThe: string;
  /** "1ª", "2ª"…; `-1` = "última". */
  nth: (n: number) => string;
  lastBusinessDay: string;
  /** "Todo ano em 15 de outubro". */
  yearlyOn: string;
  times: string;
  addTime: string;
  removeTime: string;
  /** Hourly: "A partir de". */
  from: string;
  period: string;
  starts: string;
  ends: string;
  endsNever: string;
  endsOn: string;
  endsAfter: string;
  /** "vezes". */
  occurrences: string;
  timezone: string;
  /** "Próximas". */
  upcoming: string;
  date: DatePickerProps["labels"];
}

export interface RecurrencePickerProps {
  value: RecurrenceRule;
  onChange: (rule: RecurrenceRule) => void;
  labels: RecurrenceLabels;
  locale: string;
  /** The zone selector (the app's `TimezoneSelect`, with its names and suggestions). */
  renderTimezone?: (value: string, onChange: (zone: string) => void) => ReactNode;
  /** The live sentence ("A cada 2 semanas, seg e qua, às 09:00…"), from the app. */
  summary?: ReactNode;
  /** The next occurrences, already formatted. */
  upcoming?: string[];
  /** Leave out "Uma vez" (routines that must repeat). */
  hideOnce?: boolean;
  /** Times are set elsewhere (an event's start/end): no time list. */
  hideTimes?: boolean;
  /** No time zone select (the event has its own). */
  hideTimezone?: boolean;
  className?: string;
}

/** Which tab a rule opens in. */
export function modeOf(rule: RecurrenceRule): RecurrenceMode {
  if (rule.freq === "hourly") return "custom";
  if (rule.freq === "yearly" && rule.interval > 1) return "custom";
  return rule.freq;
}

type MonthlyKind = "day" | "nth" | "lastBusiness";
export function monthlyKindOf(rule: RecurrenceRule): MonthlyKind {
  if (rule.bySetPos && rule.byWeekday?.length) {
    return rule.byWeekday.length > 1 && rule.bySetPos === -1 ? "lastBusiness" : "nth";
  }
  return "day";
}

const clampInt = (raw: string, min: number, max: number) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

/**
 * Our recurrence picker (v2): Uma vez / Diária / Semanal / Mensal / Anual /
 * Personalizada, the days, the times, the period and the zone, with the live
 * sentence on top and the next occurrences. Controlled: the rule is the one
 * source of truth (a phrase field next to it fills the same rule).
 */
export function RecurrencePicker({
  value: rule,
  onChange,
  labels,
  locale,
  renderTimezone,
  summary,
  upcoming,
  hideOnce,
  hideTimes,
  hideTimezone,
  className,
}: RecurrencePickerProps) {
  const id = useId();
  const [mode, setMode] = useState<RecurrenceMode>(() => modeOf(rule));
  // A rule from outside (the phrase) may need another tab.
  const [seen, setSeen] = useState(rule);
  if (seen !== rule) {
    setSeen(rule);
    const next = modeOf(rule);
    if (next !== mode && !(mode === "custom" && rule.freq !== "once")) setMode(next);
  }
  const set = (patch: Partial<RecurrenceRule>) => onChange({ ...rule, ...patch });
  const pickMode = (m: RecurrenceMode) => {
    setMode(m);
    if (m === "custom") {
      onChange(rule.freq === "once" ? ruleFor("daily", rule) : rule);
      return;
    }
    if (m !== rule.freq) onChange(ruleFor(m, rule));
  };
  const modes = (["once", "daily", "weekly", "monthly", "yearly", "custom"] as const).filter(
    (m) => !(hideOnce && m === "once"),
  );
  const intervalField = (unit: Unit) => (
    <span className="ac-recur__every">
      <span>{labels.every}</span>
      <Input
        className="ac-recur__n"
        inputMode="numeric"
        aria-label={labels.interval}
        value={String(rule.interval)}
        onChange={(e) => set({ interval: clampInt(e.target.value, 1, 99) })}
      />
      <span>{labels.units[unit]}</span>
    </span>
  );
  const weekdayChips = (
    <fieldset className="ac-recur__days">
      <legend className="ac-visually-hidden">{labels.weekdaysLabel}</legend>
      {WEEKDAYS.map((wd) => {
        const on = (rule.byWeekday ?? []).includes(wd);
        return (
          <button
            key={wd}
            type="button"
            className="ac-recur__day"
            aria-pressed={on}
            aria-label={labels.weekdays[wd].long}
            title={labels.weekdays[wd].long}
            onClick={() => {
              const list = on ? (rule.byWeekday ?? []).filter((x) => x !== wd) : [...(rule.byWeekday ?? []), wd];
              // Never empty: the last day stays.
              if (list.length === 0) return;
              set({ byWeekday: WEEKDAYS.filter((x) => list.includes(x)) });
            }}
          >
            {labels.weekdays[wd].short}
          </button>
        );
      })}
    </fieldset>
  );
  const monthly = monthlyKindOf(rule);
  const pos = weekdayPosition(rule.start);
  const nthOptions: SelectOption[] = [1, 2, 3, 4, -1].map((n) => ({ value: String(n), label: labels.nth(n) }));
  const weekdayOptions: SelectOption[] = WEEKDAYS.map((wd) => ({ value: wd, label: labels.weekdays[wd].long }));
  const dayOptions: SelectOption[] = Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
  const ends = rule.count ? "after" : rule.until ? "on" : "never";
  const unit: Unit = rule.freq === "once" ? "daily" : rule.freq;
  return (
    <div className={cx("ac-recur", className)}>
      {summary && (
        <p className="ac-recur__summary" aria-live="polite">
          {summary}
        </p>
      )}
      <Segmented
        label={labels.frequency}
        size="sm"
        value={mode}
        onValueChange={pickMode}
        options={modes.map((m) => ({ value: m, label: labels.modes[m] }))}
        className="ac-recur__modes"
      />
      {mode === "custom" && (
        <div className="ac-recur__row">
          {intervalField(unit)}
          <Select
            aria-label={labels.unit}
            value={unit}
            onValueChange={(u) => onChange({ ...ruleFor(u as Unit, rule), interval: rule.interval })}
            options={(["hourly", "daily", "weekly", "monthly", "yearly"] as const).map((u) => ({
              value: u,
              label: labels.units[u],
            }))}
          />
        </div>
      )}
      {mode === "daily" && (
        <div className="ac-recur__row">
          <Segmented
            label={labels.modes.daily}
            size="sm"
            value={rule.byWeekday?.length ? "business" : "every"}
            onValueChange={(v) =>
              set(v === "business" ? { byWeekday: BUSINESS_DAYS, interval: 1 } : { byWeekday: undefined })
            }
            options={[
              { value: "every", label: `${labels.every} N ${labels.units.daily}` },
              { value: "business", label: labels.businessDays },
            ]}
          />
          {!rule.byWeekday?.length && intervalField("daily")}
        </div>
      )}
      {(mode === "weekly" || (mode === "custom" && unit === "weekly")) && (
        <div className="ac-recur__row">
          {weekdayChips}
          {mode === "weekly" && intervalField("weekly")}
        </div>
      )}
      {(mode === "monthly" || (mode === "custom" && unit === "monthly")) && (
        <div className="ac-recur__stack">
          <Segmented
            label={labels.modes.monthly}
            size="sm"
            value={monthly}
            onValueChange={(k) =>
              set(
                k === "day"
                  ? { byMonthDay: [Number(rule.start.slice(8, 10)) || 1], byWeekday: undefined, bySetPos: undefined }
                  : k === "nth"
                    ? {
                        byMonthDay: undefined,
                        byWeekday: [pos.weekday],
                        bySetPos: pos.last && pos.nth > 4 ? -1 : pos.nth,
                      }
                    : { byMonthDay: undefined, byWeekday: BUSINESS_DAYS, bySetPos: -1 },
              )
            }
            options={[
              { value: "day", label: labels.onDay },
              { value: "nth", label: labels.onThe },
              { value: "lastBusiness", label: labels.lastBusinessDay },
            ]}
          />
          <div className="ac-recur__row">
            {monthly === "day" && (
              <Select
                aria-label={labels.onDay}
                value={String(rule.byMonthDay?.[0] ?? 1)}
                onValueChange={(v) => set({ byMonthDay: [Number(v)] })}
                options={dayOptions}
              />
            )}
            {monthly === "nth" && (
              <>
                <Select
                  aria-label={labels.onThe}
                  value={String(rule.bySetPos ?? 1)}
                  onValueChange={(v) => set({ bySetPos: Number(v) })}
                  options={nthOptions}
                />
                <Select
                  aria-label={labels.weekdaysLabel}
                  value={rule.byWeekday?.[0] ?? weekdayOfYmd(rule.start)}
                  onValueChange={(v) => set({ byWeekday: [v as Weekday] })}
                  options={weekdayOptions}
                />
              </>
            )}
            {mode === "monthly" && intervalField("monthly")}
          </div>
        </div>
      )}
      {mode === "yearly" && <p className="ac-recur__note">{labels.yearlyOn}</p>}
      {!hideTimes && (
        <div className="ac-recur__group">
          <span className="ac-recur__label" id={`${id}-times`}>
            {rule.freq === "hourly" ? labels.from : labels.times}
          </span>
          <div className="ac-recur__times">
            {rule.times.map((hm, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two times may be equal while editing
              <span key={`${i}-${hm}`} className="ac-recur__time">
                <TimeSelect
                  value={hm}
                  aria-label={`${labels.times} ${i + 1}`}
                  onChange={(v) => set({ times: rule.times.map((x, j) => (j === i ? v : x)) })}
                />
                {rule.times.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="close"
                    aria-label={`${labels.removeTime} ${hm}`}
                    onClick={() => set({ times: rule.times.filter((_, j) => j !== i) })}
                  />
                )}
              </span>
            ))}
            {rule.freq !== "hourly" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => set({ times: [...rule.times, rule.times.at(-1) ?? "09:00"] })}
              >
                {labels.addTime}
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="ac-recur__group">
        <span className="ac-recur__label">{labels.period}</span>
        {/* Two columns, labels above, every control 40px; the end's extra control sits below it. */}
        <div className="ac-recur__period">
          <div className="ac-recur__cell">
            <span className="ac-recur__sublabel" id={`${id}-starts`}>
              {labels.starts}
            </span>
            <DatePicker
              value={rule.start}
              onChange={(v) => set({ start: v })}
              locale={locale}
              labels={labels.date}
              aria-label={labels.starts}
            />
          </div>
          {rule.freq !== "once" && (
            <div className="ac-recur__cell">
              <span className="ac-recur__sublabel">{labels.ends}</span>
              <Segmented
                label={labels.ends}
                value={ends}
                className="ac-recur__ends"
                onValueChange={(v) =>
                  set(
                    v === "never"
                      ? { until: null, count: null }
                      : v === "on"
                        ? { until: rule.until ?? rule.start, count: null }
                        : { until: null, count: rule.count ?? 10 },
                  )
                }
                options={[
                  { value: "never", label: labels.endsNever },
                  { value: "on", label: labels.endsOn },
                  { value: "after", label: labels.endsAfter },
                ]}
              />
              {ends === "on" && (
                <DatePicker
                  value={rule.until ?? rule.start}
                  onChange={(v) => set({ until: v })}
                  locale={locale}
                  labels={labels.date}
                  min={rule.start}
                  aria-label={labels.endsOn}
                />
              )}
              {ends === "after" && (
                <span className="ac-recur__inline">
                  <Input
                    className="ac-recur__n"
                    inputMode="numeric"
                    aria-label={`${labels.endsAfter} (${labels.occurrences})`}
                    value={String(rule.count ?? 10)}
                    onChange={(e) => set({ count: clampInt(e.target.value, 1, 999) })}
                  />
                  <span>{labels.occurrences}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {!hideTimezone && renderTimezone && (
        <div className="ac-recur__group">
          <span className="ac-recur__label" aria-hidden="true">
            {labels.timezone}
          </span>
          {renderTimezone(rule.timezone, (v) => set({ timezone: v }))}
        </div>
      )}
      {upcoming && upcoming.length > 0 && (
        <div className="ac-recur__upcoming">
          <span className="ac-recur__label">{labels.upcoming}</span>
          <ol>
            {upcoming.map((u) => (
              <li key={u} className="tabular">
                {u}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
