import { type CSSProperties, useLayoutEffect, useRef } from "react";
import { addLiveComputer, drawLiveComputer, type LiveComputer } from "../computer/live";
import {
  COMPUTER_ART,
  COMPUTER_GRID,
  COMPUTER_ROWS,
  type ComputerKind,
  type ComputerState,
  type PhoneKind,
  type PortraitKind,
} from "../computer/portrait.js";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";

export type { ComputerKind, ComputerState, PhoneKind, PortraitKind };

export interface ComputerPortraitProps {
  /** A computer, or a phone reached through one. */
  kind: PortraitKind;
  state: ComputerState;
  /** 48 (list rows, default), 96 (the computer page) or 144 (empty states): whole-number scales of the grid. */
  size?: 48 | 96 | 144;
  /** Accessible name. Without it the portrait is decorative (the text next to it names the computer). */
  label?: string;
  className?: string;
}

/**
 * A computer's portrait, from the one portrait
 * engine (computer/portrait.js): a Mac laptop, a Windows monitor or a Linux
 * tower, its screen lit, dimmed (paused) or dark
 * (offline). Pixels on a 48×48 grid scaled by whole numbers; it sits directly
 * on the surface, no tile, its box as wide as the drawing (`COMPUTER_ART`).
 * Below 48 px use `ComputerIcon`.
 */
export function ComputerPortrait({ kind, state, size = 48, label, className }: ComputerPortraitProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = useRef({ kind, state });
  look.current = { kind, state };
  const live = useRef<LiveComputer | null>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    live.current = { canvas: el, look: () => look.current };
    const stop = addLiveComputer(live.current);
    return () => {
      live.current = null;
      stop();
    };
  }, []);
  // The loop stands still with reduced motion: a new kind or state is drawn at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when what is drawn changes
  useLayoutEffect(() => {
    if (live.current) drawLiveComputer(live.current);
  }, [kind, state]);
  const cols = COMPUTER_ART[kind][1];
  return (
    <canvas
      ref={canvas}
      className={cx("ac-computer", className)}
      width={cols}
      height={COMPUTER_GRID}
      style={
        {
          width: (cols * size) / COMPUTER_GRID,
          height: size,
          imageRendering: "pixelated",
          // Where the drawing starts under the box's top (a face line puts the text there), and ends over its bottom.
          "--art-top": `${(COMPUTER_ROWS[kind][0] * size) / COMPUTER_GRID}px`,
          "--art-bottom": `${((COMPUTER_GRID - COMPUTER_ROWS[kind][0] - COMPUTER_ROWS[kind][1]) * size) / COMPUTER_GRID}px`,
        } as CSSProperties
      }
      data-kind={kind}
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

const ICONS: Record<ComputerKind, IconName> = {
  mac: "computerMac",
  windows: "computerWindows",
  linux: "computerLinux",
};

/** A computer's line icon for 14–20 px, next to text (pickers, chips): pixels don't read that small. */
export function ComputerIcon({
  kind,
  size = 16,
  label,
  className,
}: {
  kind: ComputerKind;
  size?: 14 | 16 | 18 | 20;
  label?: string;
  className?: string;
}) {
  return <Icon name={ICONS[kind]} size={size} label={label} className={className} />;
}
