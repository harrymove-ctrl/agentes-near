import type { CSSProperties } from "react";
import { cx } from "../cx";

/** One source's piece of a day: `value` is 0–100 of the column's height, its color in `--part`. */
export interface UsageDayPart {
  key: string;
  value: number;
  style?: CSSProperties;
}

export interface UsageDay {
  key: string;
  parts: UsageDayPart[];
  /** A day still to come: a dotted stub. */
  ahead?: boolean;
  title?: string;
}

/** A month day by day: a column per day, stacked by source. Decorative: the caller gives the words in `label`. */
export function UsageDays({ days, label, className }: { days: UsageDay[]; label: string; className?: string }) {
  return (
    <div
      className={cx("ac-usage-days", className)}
      role="img"
      aria-label={label}
      style={{ "--days": days.length } as CSSProperties}
    >
      {days.map((d) =>
        d.ahead ? (
          <span key={d.key} className="ac-usage-days__day ac-usage-days__day--ahead" />
        ) : (
          <span key={d.key} className="ac-usage-days__day" title={d.title}>
            {d.parts
              .filter((p) => p.value > 0)
              .map((p) => (
                <i key={p.key} style={{ ...p.style, height: `${Math.min(100, p.value)}%` }} />
              ))}
          </span>
        ),
      )}
    </div>
  );
}

/** A legend swatch in a source's color (`--part`). */
export function UsageSwatch({ style }: { style?: CSSProperties }) {
  return <i className="ac-usage-swatch" style={style} aria-hidden="true" />;
}
