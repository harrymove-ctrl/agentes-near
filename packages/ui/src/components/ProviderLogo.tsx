import { type CSSProperties, useId } from "react";
import { markOf, PROVIDER_MARKS } from "../brand/marks";
import { cx } from "../cx";

export interface ProviderLogoProps {
  /** A provider, plan, brain or mission executor id (`anthropic`, `zai`, `claude_code`…). */
  id: string;
  /**
   * `xs`: the bare mark beside text; `chip`: a 20 px tile, for `ProviderStack`; `sm`: a 30 px tile beside menu
   * options; `tile`: 48 px, for list rows.
   */
  size?: "xs" | "chip" | "sm" | "tile";
  /** Can't be used now (not installed, signed out, computer offline): dimmed, in its own colors. */
  off?: boolean;
  /** Accessible name. Without it the logo is decorative: the text next to it names the provider. */
  label?: string;
  className?: string;
}

/** An image mark's size in each tile: `components.css` gives a path mark's `svg` the same. */
const IMAGE_PX = { xs: 14, chip: 12, sm: 16, tile: 26 } as const;

/**
 * A provider's official mark (`brand/marks.ts`) on a tile tinted with its color; one-color marks follow the
 * theme, and an image mark sits on the neutral tile. An id without a mark shows its initial on a neutral tile.
 */
export function ProviderLogo({ id, size = "tile", off = false, label, className }: ProviderLogoProps) {
  const key = markOf(id);
  const mark = key ? PROVIDER_MARKS[key] : null;
  const color = mark && "path" in mark ? mark.color : undefined;
  const gradient = `ac-brand-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <span
      className={cx("ac-brand", `ac-brand--${size}`, !color && "ac-brand--mono", off && "ac-brand--off", className)}
      style={color ? ({ "--brand": color } as CSSProperties) : undefined}
      data-mark={key ?? undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {mark && "image" in mark ? (
        <img src={mark.image} alt="" width={IMAGE_PX[size]} height={IMAGE_PX[size]} />
      ) : mark ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {mark.gradient && (
            <defs>
              <linearGradient id={gradient} x1="0" y1="12" x2="24" y2="12" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={mark.gradient[0]} />
                <stop offset="1" stopColor={mark.gradient[1]} />
              </linearGradient>
            </defs>
          )}
          <path d={mark.path} fill={mark.gradient && `url(#${gradient})`} />
          {mark.parts?.map((part) => (
            <path
              key={part.path}
              d={part.path}
              className="ac-brand__part"
              style={{ "--part": part.color, "--part-dark": part.dark ?? part.color } as CSSProperties}
            />
          ))}
        </svg>
      ) : (
        <span className="ac-brand__initial">{id.trim().charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

export interface ProviderStackProps {
  /** Provider, plan or brain ids, drawn left to right, each over the one before. */
  ids: readonly string[];
  /** The group's accessible name ("Claude, ChatGPT, GLM and Kimi"). Without it the stack is decorative. */
  label?: string;
  className?: string;
}

/** Several makers at once, for a line that names more than one: their marks as 20 px tiles, overlapping. */
export function ProviderStack({ ids, label, className }: ProviderStackProps) {
  return (
    <span
      className={cx("ac-brand-stack", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {ids.map((id) => (
        <ProviderLogo key={id} id={id} size="chip" />
      ))}
    </span>
  );
}
