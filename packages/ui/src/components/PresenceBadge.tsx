import { useMemo } from "react";
import { cx } from "../cx";
import { type BadgePresence, type BadgeTone, badgeCells } from "../presence/badge";

export type { BadgePresence } from "../presence/badge";

export interface PresenceBadgeProps {
  presence: BadgePresence;
  /**
   * The pixel's side: `sm` 1 px (faces up to 36 px: the sidebar, lists, messages; 11 px with its ring), `lg` 1.5 px
   * (the profile cards' 56 px faces and larger).
   */
  size?: "sm" | "lg";
  /** The one-pixel ring in the surface's color (`--presence-ring`); off where the badge stands alone (a row's lead). */
  ring?: boolean;
  className?: string;
}

const TONES: readonly BadgeTone[] = ["ring", "base", "light", "deep", "mark"];
const CELL = { sm: 1, lg: 1.5 } as const;

/**
 * The presence badge (ADR 0084): the 9×9 pixel shape from `badgeCells` (the agents' body with its cut corner), in
 * their two-tone dither, with a white mark (busy: a bar, away: a clock, out of office: an arrow), an empty outline
 * for offline and a dotted one for hidden. One path per tone; the colors come from the stylesheet (`.ac-presence`),
 * so it follows the theme. Hidden from screen readers: words beside it say the presence.
 */
export function PresenceBadge({ presence, size = "sm", ring = true, className }: PresenceBadgeProps) {
  const { side, paths } = useMemo(() => {
    const { size: n, cells } = badgeCells(presence, ring);
    const d = new Map<BadgeTone, string>();
    for (const c of cells) d.set(c.tone, `${d.get(c.tone) ?? ""}M${c.x} ${c.y}h1v1h-1z`);
    return { side: n, paths: TONES.flatMap((tone) => (d.has(tone) ? [[tone, d.get(tone) ?? ""] as const] : [])) };
  }, [presence, ring]);
  const px = side * CELL[size];
  return (
    <svg
      className={cx("ac-presence", className)}
      data-presence={presence}
      viewBox={`0 0 ${side} ${side}`}
      width={px}
      height={px}
      aria-hidden="true"
      focusable="false"
    >
      {paths.map(([tone, d]) => (
        <path key={tone} className={`ac-presence__${tone}`} d={d} />
      ))}
    </svg>
  );
}
