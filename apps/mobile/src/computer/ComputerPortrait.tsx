import { useMachines } from "@agenteschat/client";
import { computerKind } from "@agenteschat/client/lib/machines";
import { COMPUTER_GRID } from "@agenteschat/ui/computer/portrait";
import { Canvas, createPicture, PaintStyle, Picture, Skia, type SkPaint } from "@shopify/react-native-skia";
import { memo, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { frameClock } from "@/agent/clock";
import { useLivePaused } from "@/agent/live";
import { Icon } from "@/ui/Icon";
import { useTheme } from "@/ui/theme";
import {
  type CellRun,
  type ComputerKind,
  type ComputerState,
  cellsToSvg,
  type PortraitKind,
  portraitFrame,
} from "./cells";

/** The design's pace (~11 frames a second): screens shimmer, agents bob, drive lights blink. */
const FPS = 11;
/** The still frame (reduced motion, off screen): eyes open, nothing mid-blink. */
const STILL_T = 2;

const paints = new Map<string, SkPaint>();
/** Pixel-crisp: no antialias, so neighboring cells never seam. */
function cellPaint(color: string): SkPaint {
  let p = paints.get(color);
  if (!p) {
    p = Skia.Paint();
    p.setAntiAlias(false);
    p.setStyle(PaintStyle.Fill);
    p.setColor(Skia.Color(color));
    paints.set(color, p);
  }
  return p;
}

/** The shared clock's time at the portraits' pace while `active`; otherwise the still frame. */
function usePortraitTime(active: boolean): number {
  const paused = useLivePaused();
  const running = active && !paused;
  const [t, setT] = useState(STILL_T);
  useEffect(() => {
    if (!running) return;
    // Same value between steps: React skips the render.
    return frameClock.subscribe((now) => setT(Math.floor(now * FPS) / FPS));
  }, [running]);
  return running ? t : STILL_T;
}

export interface ComputerPortraitProps {
  /** A computer, or a phone it reaches (`android`, `iphone`). */
  kind: PortraitKind;
  state: ComputerState;
  /** 48 (rows, default) or 96 points: whole-number scales of the 48 grid. */
  size?: 48 | 96;
  /** false: one still frame. Default true. */
  live?: boolean;
  /** For screen readers; without it the portrait is decorative (the text next to it names the computer). */
  label?: string;
}

function ComputerPortraitView({ kind, state, size = 48, live = true, label }: ComputerPortraitProps) {
  const { scheme, reducedMotion } = useTheme();
  const t = usePortraitTime(live && !reducedMotion);
  const picture = useMemo(() => {
    const runs: CellRun[] = portraitFrame(kind, state, scheme === "dark", t);
    const k = size / COMPUTER_GRID;
    return createPicture(
      (canvas) => {
        canvas.scale(k, k);
        for (const run of runs) {
          const path = Skia.Path.MakeFromSVGString(cellsToSvg(run.cells));
          if (path) canvas.drawPath(path, cellPaint(run.color));
        }
      },
      { width: size, height: size },
    );
  }, [kind, state, scheme, t, size]);
  return (
    <View
      accessible={Boolean(label)}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={{ width: size, height: size }}
    >
      <Canvas style={{ width: size, height: size }}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

/**
 * A computer's portrait, drawn by the shared engine
 * (`@agenteschat/ui/computer/portrait`) on a Skia canvas, the way agents are: a Mac laptop, a Windows
 * monitor or a Linux tower, its screen lit, dimmed (paused) or dark (offline). It
 * sits directly on the surface, no tile. Living portraits share the app's clock; with reduced motion,
 * `live={false}` or an off-screen screen they hold a still frame. Below 48 points use `ComputerIcon`.
 */
export const ComputerPortrait = memo(ComputerPortraitView);

const ICONS = {
  mac: "computerMac",
  windows: "computerWindows",
  linux: "computerLinux",
} as const;

/** A computer's line icon next to text (chips, small rows): pixels don't read that small. */
export function ComputerIcon({ kind, size = 16, color }: { kind: ComputerKind; size?: number; color?: string }) {
  return <Icon name={ICONS[kind]} size={size} color={color} />;
}

/**
 * Which portrait a machine gets, from the org's computers (the lists that name a machine carry only its
 * id, name and whether it's online). Linux, the server, until the list arrives.
 */
export function useComputerKind(orgId: string, machineId: string | null | undefined): ComputerKind {
  const machines = useMachines(orgId, Boolean(machineId));
  const os = machineId ? machines.data?.find((m) => m.id === machineId)?.os : undefined;
  return computerKind(os);
}
