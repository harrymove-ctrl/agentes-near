import { useEffect, useRef } from "react";
import { cx } from "../cx";
import { drawSprite, redrawSkies, type SkyOptions, startSky } from "../sky/engine";
import { glowTones, pixelOf, spriteTone } from "../sky/tones";
import type { AgentColor } from "./AgentLook";

/**
 * The pixel sky on a canvas that fills its parent (give the parent
 * `position: relative` and `overflow: hidden`). The options are read on every
 * frame, so changing them (a color, how many agents work) needs no restart.
 * Decorative: a presentation canvas with nothing to read.
 */
export function PixelSky({ options, className }: { options: SkyOptions; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    const canvas = ref.current;
    return canvas ? startSky(canvas, () => opts.current) : undefined;
  }, []);
  // With reduced motion a sky only redraws when asked: new options are a reason.
  useEffect(() => redrawSkies());
  return <canvas ref={ref} className={cx("ac-sky", className)} />;
}

/** A dithered glow rising from the surface, with one pixel agent floating in it (empty states). */
export function SkyGlow({
  color = "sky",
  surface = "--bg",
  bare,
  className,
}: {
  color?: AgentColor;
  /** The token of the surface the glow sits on (it fades from it). */
  surface?: string;
  /** Only the light, for an agent drawn over it. */
  bare?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("ac-sky-glow", className)} aria-hidden="true">
      <PixelSky options={glowOptions(color, surface, bare)} />
    </span>
  );
}

const WHITE = pixelOf("#ffffff");

export function glowOptions(color: AgentColor, surface = "--bg", bare = false): SkyOptions {
  const body = pixelOf(spriteTone(color));
  return {
    pixel: 4,
    surface,
    seeThrough: bare,
    palette: (bg) => glowTones(color, bg),
    light: 0,
    base: (u, v, t) => {
      const dx = (u - 0.5) * 2.1;
      const dy = (v - 0.58) * 1.4;
      // Zero at the edges, so the glow meets the surface without a seam.
      const edge = Math.min(1, u * 5, (1 - u) * 5, v * 5, (1 - v) * 5);
      return edge * Math.exp(-(dx * dx + dy * dy) / 0.18) * (0.9 + 0.06 * Math.sin(t * 0.8));
    },
    after: bare
      ? undefined
      : (f) => {
          const k = 2;
          const y = Math.round(f.h * 0.5 - 9 + Math.sin(f.t * 1.6) * 2);
          drawSprite(f, Math.round(f.w / 2 - 9), y, k, body, WHITE, f.t % 4.2 > 4.04);
        },
  };
}
