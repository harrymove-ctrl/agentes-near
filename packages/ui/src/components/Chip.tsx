import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type ChipTone = "neutral" | "waiting" | "done";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** A state is said with an icon and a word, never a colored dot; a value ("Issue: ACME-177") goes without. */
  icon?: IconName;
  /** In place of the icon: e.g. a `PixelSpinner` in the working agent's color. */
  lead?: ReactNode;
  /** `waiting` (attention) only for what waits on a person. */
  tone?: ChipTone;
  children: ReactNode;
}

export function Chip({ icon, lead, tone = "neutral", className, children, ...rest }: ChipProps) {
  return (
    <span className={cx("ac-chip", tone !== "neutral" && `ac-chip--${tone}`, className)} {...rest}>
      {lead ?? (icon && <Icon name={icon} size={14} />)}
      <span className="ac-chip__text">{children}</span>
    </span>
  );
}

/** Small attention text with an icon (e.g. "pede aprovação"); no background. */
export function AttentionNote({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("ac-note-attention", className)} {...rest}>
      <Icon name="waiting" />
      {children}
    </span>
  );
}

/**
 * The one neutral count chip ("Missões 1", the sidebar's Threads, the
 * channel's "Threads 4", filter chips): a fixed-height pill, the number
 * centered on its box (line-height 1, tabular figures), never on the text
 * baseline. `strong`: the filled neutral look of a chosen chip.
 */
export function CountChip({
  className,
  size,
  strong,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { size?: "sm"; strong?: boolean }) {
  return (
    <span
      className={cx("ac-countchip", size === "sm" && "ac-countchip--sm", strong && "ac-countchip--strong", className)}
      {...rest}
    />
  );
}

/** Counter badge, e.g. pending approvals in the sidebar. */
export function CountBadge({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ac-count", className)} {...rest} />;
}
