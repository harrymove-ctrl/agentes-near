import type { ReactNode } from "react";
import { cx } from "../cx";
import {
  PLAN_ALMOST,
  type PlanMeterText,
  type PlanMeterUsage,
  planLevel,
  planLine,
  planState,
  planWindows,
  renewals,
} from "../plan-state";
import { Meter } from "./Surfaces";

export {
  limitOffers,
  type OfferAccount,
  PLAN_ALMOST,
  PLAN_CRITICAL,
  PLAN_TONE,
  type PlanLevel,
  type PlanMeterText,
  type PlanMeterUsage,
  type PlanMeterWindow,
  type PlanState,
  planLevel,
  planLine,
  planState,
  planWindows,
} from "../plan-state";

const passed = (iso: string | undefined, now: number) => iso !== undefined && Date.parse(iso) <= now;

/**
 * A plan's usage like the provider shows it: a bar per window, tightest first,
 * with its percentage and when it resets; "almost" from 80%, "at the limit
 * until…" at 100%, and how old the numbers are. The bars are ink until a window
 * nears its limit (`data-level`, `planLevel`): amber from 80%, red from 90% and at
 * the limit, the words and the percentage always beside the color. `compact`
 * (lists, an agent's facts, Contas de IA): one line with the tightest windows
 * ("semana 40% · 5h 12%", after `label`), one bar for the fullest, every window
 * on hover, and only near the limit when it renews, then how old the numbers are
 * from 10 minutes ("atualizado há 51 min"; out of date past 6 hours); nothing
 * while no window is known, unless the plan already refused a request ("No limite"). `children` (an
 * account's agents) go between the bars and when they renew: each window's
 * renewal then moves under them, on one line, before how old the numbers are.
 */
export function PlanMeter({
  usage,
  text,
  compact = false,
  label,
  now = Date.now(),
  className,
  children,
}: {
  usage: PlanMeterUsage;
  text: PlanMeterText;
  compact?: boolean;
  /** Compact: what the line starts with (the account's name). */
  label?: string;
  now?: number;
  className?: string;
  children?: ReactNode;
}) {
  if (compact) {
    const shown = planLine(usage, text, now);
    if (!shown) return null;
    const line = [label, shown.line, shown.age].filter(Boolean).join(" · ");
    return (
      <div
        className={cx("ac-planmeter", "ac-planmeter--compact", className)}
        data-state={shown.state}
        data-stale={shown.stale || undefined}
        data-level={planLevel(shown.top?.used ?? 0, shown.state === "limited")}
        title={shown.title}
      >
        {line && <span className="ac-planmeter__line">{line}</span>}
        {shown.top && <Meter value={shown.top.used} max={100} label={text.window(shown.top)} marks={[PLAN_ALMOST]} />}
        {shown.alert && <span className="ac-planmeter__state">{shown.alert}</span>}
      </div>
    );
  }
  const rows = planWindows(usage, now);
  const { state, until, used } = planState(usage, now);
  const headline = state === "limited" ? text.limited(until) : state === "almost" ? text.almost : null;
  const renews = children ? renewals(rows, text, now) : null;
  return (
    <div className={cx("ac-planmeter", className)} data-state={state} data-level={planLevel(used, state === "limited")}>
      {headline && <p className="ac-planmeter__state">{headline}</p>}
      {rows.length > 0 && (
        <ul className="ac-planmeter__windows">
          {rows.map((w, i) => {
            const name = text.window(w);
            // A window that reset is empty again: its parts were the old window's.
            const fresh = !passed(w.resetsAt, now);
            return (
              <li key={`${w.kind}:${w.label ?? i}`} className="ac-planmeter__window" data-level={planLevel(w.used)}>
                <span className="ac-planmeter__name">{name}</span>
                <span className="ac-planmeter__pct">{w.used}%</span>
                <Meter
                  value={w.used}
                  max={100}
                  label={name}
                  marks={[PLAN_ALMOST]}
                  {...(w.part !== undefined && fresh ? { part: w.part } : {})}
                  {...(w.segments && fresh ? { segments: w.segments } : {})}
                />
                {w.note && fresh && <small className="ac-planmeter__note">{w.note}</small>}
                {w.resetsAt && fresh && !children && (
                  <small className="ac-planmeter__reset">{text.resets(w.resetsAt)}</small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {children}
      {children && renews && <small className="ac-planmeter__reset">{renews}</small>}
      <small className="ac-planmeter__at">{text.updated(usage.at)}</small>
    </div>
  );
}
