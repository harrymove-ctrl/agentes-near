import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

/**
 * `warn`: the icon in the attention color and the words in ink (a date that is close or past); `warn-icon`: only the
 * icon (high priority); `ok`: the icon in green (everything done); `bold`: the words heavier (unread); `label`: the
 * line's one pill (a label nobody presses).
 */
export type LineFactTone = "warn" | "warn-icon" | "ok" | "bold" | "label";

export interface LineFact {
  key: string;
  /** An icon name, or a node in its place (a maker's logo). */
  icon?: IconName | ReactNode;
  text: ReactNode;
  tone?: LineFactTone;
  /** What the fact means when its icon says it (a hover title: "7 de 8 critérios feitos"). */
  title?: string;
}

/**
 * One quiet line of facts under a title (a task card's number, label, date, criteria, pull request, messages): each an
 * icon and its words, no plates. The line wraps between facts, never inside one; only a label alone wider than the
 * line wraps its own words.
 */
export function FactLine({ facts, className, ...rest }: { facts: LineFact[] } & HTMLAttributes<HTMLSpanElement>) {
  if (facts.length === 0) return null;
  return (
    <span className={cx("ac-factline", className)} {...rest}>
      {facts.map((f) => (
        <span key={f.key} className="ac-factline__fact" data-tone={f.tone} title={f.title}>
          {typeof f.icon === "string" ? <Icon name={f.icon as IconName} size={14} /> : f.icon}
          {f.text}
        </span>
      ))}
    </span>
  );
}
