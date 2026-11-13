import type { CSSProperties } from "react";
import { cx } from "../cx";
import { Icon, type IconName, iconNames } from "../icons/Icon";
import { ditherUrl } from "../sky/dither";
import type { AgentColor } from "./AgentLook";

/** Dither cells and icon size for a mark `size` px wide. */
const fit = (size: number) =>
  size <= 20
    ? { cells: 8, icon: 12 }
    : size <= 28
      ? { cells: 10, icon: 16 }
      : size <= 40
        ? { cells: 14, icon: 20 }
        : { cells: 18, icon: Math.round(size * 0.47) };

/**
 * A workspace role's mark (ADR 0085): the role's color in the agents' dither in a full circle (never a people tile
 * or an agent's cut corner), its icon in white on top. Decorative: the role's name is always beside it.
 */
export function RoleMark({
  color,
  icon,
  size = 26,
  className,
}: {
  /** One of the agents' colors (roles never use sky). */
  color: string;
  icon: string;
  size?: number;
  className?: string;
}) {
  const { cells, icon: px } = fit(size);
  const name = (iconNames as readonly string[]).includes(icon) ? (icon as IconName) : "shield";
  const style = { width: size, height: size, backgroundImage: `url("${ditherUrl(color as AgentColor, cells)}")` };
  return (
    <span className={cx("ac-rolemark", className)} style={style as CSSProperties} aria-hidden="true">
      {px <= 20 ? (
        <Icon name={name} size={px as 14 | 16 | 18 | 20} />
      ) : (
        <Icon name={name} size={20} style={{ width: px, height: px }} />
      )}
    </span>
  );
}
