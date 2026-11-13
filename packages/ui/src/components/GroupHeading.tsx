import type { ReactNode } from "react";
import { cx } from "../cx";

/**
 * A list group's heading ("Hoje", "Decididos há pouco"): one line on the list's outer edge, 8 over its rows, an aside
 * (a link, a select, a note) at its end, or under the title from its edge when they don't share the line
 * (`.ac-actline`). Groups stand 24 apart in `.ac-groups`.
 */
export function GroupHeading({
  title,
  count,
  note,
  aside,
  level = 2,
  id,
  className,
}: {
  title: ReactNode;
  count?: ReactNode;
  /** A few quiet words after the count, on the title's line ("ninguém mais vê"). */
  note?: ReactNode;
  aside?: ReactNode;
  level?: 2 | 3 | 4;
  id?: string;
  className?: string;
}) {
  const H = (["h2", "h3", "h4"] as const)[level - 2] ?? "h2";
  return (
    <div className={cx("ac-grouphead", aside ? "ac-actline" : undefined, className)}>
      <H className="ac-grouphead__title" id={id}>
        {title}
        {count !== undefined && <span className="ac-grouphead__count">{count}</span>}
        {note && <span className="ac-grouphead__note">{note}</span>}
      </H>
      {aside && <span className="ac-grouphead__aside">{aside}</span>}
    </div>
  );
}
