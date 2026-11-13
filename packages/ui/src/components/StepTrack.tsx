import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type StepTrackState = "done" | "now" | "after" | "failed";

export interface StepTrackStep {
  key: string;
  /** An icon name, or a node in its place (an app's logo). */
  icon: IconName | ReactNode;
  /** Short, one line: "Read the PR", "Ran the tests". */
  label: string;
  /** The whole line, on hover. */
  title?: string;
  time?: string;
  /** `done` before it, `now` the step that waits on a person, `after` what followed a decision, `failed`. */
  state?: StepTrackState;
}

/**
 * A run's steps as one horizontal track: a node per step joined by a line, a short label and the time under it.
 * Past `max` steps, the middle ones fold into one "+N" node so the track keeps one row.
 */
export function StepTrack({
  steps,
  max = 8,
  more,
  className,
  ...rest
}: {
  steps: StepTrackStep[];
  max?: number;
  /** The folded node's label ("+4 steps"). */
  more?: (count: number) => string;
} & HTMLAttributes<HTMLOListElement>) {
  const folded = steps.length > max;
  const head = folded ? steps.slice(0, 2) : steps;
  const tail = folded ? steps.slice(steps.length - (max - 3)) : [];
  const hidden = steps.length - head.length - tail.length;
  const node = (s: StepTrackStep) => (
    <li key={s.key} className={cx("ac-track__step", s.state && `is-${s.state}`)} title={s.title ?? s.label}>
      <span className="ac-track__node" aria-hidden="true">
        {typeof s.icon === "string" ? <Icon name={s.icon as IconName} size={14} /> : s.icon}
      </span>
      <span className="ac-track__label">{s.label}</span>
      {s.time && <span className="ac-track__time">{s.time}</span>}
    </li>
  );
  const shown = head.length + tail.length + (folded ? 1 : 0);
  return (
    <ol className={cx("ac-track", className)} style={{ "--n": shown } as CSSProperties} {...rest}>
      {head.map(node)}
      {folded && (
        <li className="ac-track__step is-more">
          <span className="ac-track__node" aria-hidden="true">
            +{hidden}
          </span>
          <span className="ac-track__label">{more ? more(hidden) : `+${hidden}`}</span>
        </li>
      )}
      {tail.map(node)}
    </ol>
  );
}
