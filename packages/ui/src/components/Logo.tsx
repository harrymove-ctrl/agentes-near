import { type CSSProperties, useId } from "react";
import { bodyPath, eyeShapes } from "../agent/engine.js";
import { cx } from "../cx";
import { ditherUrl } from "../sky/dither";

/** The domain in the expanded logo: a brand name, never translated. */
const TLD = ".chat";

/** The mark is the agent from the engine: body at (2, 2), side 28, and its eyes. */
const BODY = bodyPath(2, 2, 28);
const EYES = eyeShapes("round").map((e) => ({ x: 2 + e.x * 28, y: 2 + e.y * 28, w: e.w * 28, h: e.h * 28 }));

/**
 * The agent mark: the square with the cut corner in the sky's dither (solid
 * `agent` under it, and alone in the mono logo) and the engine's white eyes.
 */
export function LogoMark({ size, className, label }: { size?: number; className?: string; label?: string }) {
  const clip = `ac-logo-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 32 32"
      className={cx("ac-logo__mark", className)}
      style={size ? { width: size, height: size } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <clipPath id={clip}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <path className="ac-logo__body" d={BODY} />
      <image
        className="ac-logo__dither"
        href={ditherUrl("sky", 12)}
        x="2"
        y="2"
        width="28"
        height="28"
        preserveAspectRatio="none"
        clipPath={`url(#${clip})`}
      />
      <g className="ac-logo__eyes">
        {EYES.map((e) => (
          <rect key={e.x} x={e.x} y={e.y} width={e.w} height={e.h} rx={e.w / 2} />
        ))}
      </g>
    </svg>
  );
}

export interface LogoProps {
  /** `main` (app) or `expanded` (+ ".chat" in dot matrix, where the domain matters). */
  variant?: "main" | "expanded";
  /** One-color version. */
  mono?: boolean;
  /** Font size in px; the mark scales with it. Below 18px use `LogoMark` alone. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** "agentes" logo: mark + wordmark in Funnel Display light (".chat" in Doto). Accessible name "agentes" (or "agentes.chat" expanded). */
export function Logo({ variant = "main", mono, size = 24, className, style }: LogoProps) {
  const expanded = variant === "expanded";
  return (
    <span
      className={cx("ac-logo", mono && "ac-logo--mono", className)}
      style={{ fontSize: size, ...style }}
      role="img"
      aria-label={expanded ? "agentes.chat" : "agentes"}
    >
      <LogoMark />
      {expanded ? (
        <span className="ac-logo__word" aria-hidden="true">
          <span>agentes</span>
          <span className="ac-logo__chat">{TLD}</span>
        </span>
      ) : (
        <span aria-hidden="true">agentes</span>
      )}
    </span>
  );
}
