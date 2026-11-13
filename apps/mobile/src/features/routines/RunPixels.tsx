import { type AgentColorName, mixHex } from "@agenteschat/ui/agent/engine";
import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFrameTime, useLivePaused } from "@/agent/live";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { CellCanvas } from "../browser/TrailPixels";
import { RUN_SLOTS } from "./logic";
import {
  LANE_BASE,
  LANE_ROWS,
  laneCells,
  laneWidth,
  RUN_CELL,
  type RunPixel,
  type RunTones,
  SPRITE,
  STRIP_ROWS,
  spriteCells,
  spritePose,
  spriteX,
  stripCells,
  stripWidth,
} from "./run-pixels";

/** A routine's runs in pixels (./run-pixels.ts, the web's drawings) on Skia canvases. */

/** The pixels' tones from the theme (the dots as the agent's month draws them). */
export function useRunTones(): RunTones {
  const { colors } = useTheme();
  return useMemo(
    () => ({
      raised: colors.raised,
      danger: colors.danger,
      warn: colors.warn,
      dot: mixHex(colors.raised, colors.faint, 0.45),
    }),
    [colors.raised, colors.danger, colors.warn, colors.faint],
  );
}

/**
 * The last runs as a strip of pixel columns, oldest left; a run at work flickers in the newest slot. `label` says
 * them: a screen reader hears the strip as one image. `dim`: a paused or finished routine's.
 */
export const RunStrip = memo(function RunStrip({
  runs,
  color,
  label,
  running = false,
  dim = false,
}: {
  /** Newest first (`runPixels`). */
  runs: readonly RunPixel[];
  color: AgentColorName;
  label: string;
  running?: boolean;
  dim?: boolean;
}) {
  const tones = useRunTones();
  const reduced = useReducedMotion();
  // A run at work is redrawn about 12 times a second, as on the web.
  const frame = Math.floor(useFrameTime(running && !reduced, 0) * 12);
  const key = runs.map((r) => `${r.status}:${r.weight ?? 1}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the runs
  const cells = useMemo(
    () => stripCells(runs, color, tones, { slots: RUN_SLOTS, running, t: frame / 12 }),
    [key, color, tones, running, frame],
  );
  const w = stripWidth(RUN_SLOTS) * RUN_CELL;
  const h = STRIP_ROWS * RUN_CELL;
  return (
    <View
      style={[{ width: w, height: h }, dim ? styles.dim : null]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <CellCanvas runs={cells} width={w} height={h} cx={RUN_CELL} />
    </View>
  );
});

/**
 * One routine's lane on the horizon, `width` points wide: the dotted line, its past runs, its coming ones, and
 * the agent itself on its next run (or at "now" while it runs). Decorative: the lane's words are its button's.
 */
export const LaneTrack = memo(function LaneTrack({
  width,
  from,
  to,
  now,
  past,
  future,
  look,
  running,
}: {
  width: number;
  /** The window and "now", in milliseconds. */
  from: number;
  to: number;
  now: number;
  past: readonly RunPixel[];
  future: readonly string[];
  look: { color: AgentColorName; eyes: string };
  running: boolean;
}) {
  const tones = useRunTones();
  const w = laneWidth(width);
  const cx = width / w;
  const key = `${past.map((p) => `${p.status}:${p.at}:${p.weight ?? 1}`).join(",")}|${future.join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the runs
  const cells = useMemo(
    () => laneCells(w, new Date(from), new Date(to), past, future, look.color, tones, running),
    [w, from, to, key, look.color, tones, running],
  );
  const x = spriteX(w, new Date(from), new Date(to), new Date(now), future, running);
  const height = LANE_ROWS * RUN_CELL;
  return (
    <View style={{ width, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <CellCanvas runs={cells} width={width} height={height} cx={cx} cy={RUN_CELL} />
      {x === null ? null : <LaneSprite x={x} cx={cx} look={look} running={running} />}
    </View>
  );
});

/** The agent on its lane: it blinks and hops now and then (still with reduced motion). */
function LaneSprite({
  x,
  cx,
  look,
  running,
}: {
  x: number;
  cx: number;
  look: { color: AgentColorName; eyes: string };
  running: boolean;
}) {
  const reduced = useReducedMotion();
  const t = useTicker(!reduced, 125);
  const { hop, blink } = spritePose(t, look, running, reduced);
  const cells = useMemo(
    () => spriteCells(look.color, look.eyes, running, blink),
    [look.color, look.eyes, running, blink],
  );
  return (
    <View style={[styles.sprite, { left: (x - 4) * cx, top: (LANE_BASE - 8 - hop) * RUN_CELL }]}>
      <CellCanvas runs={cells} width={SPRITE * cx} height={SPRITE * RUN_CELL} cx={cx} cy={RUN_CELL} />
    </View>
  );
}

/**
 * Seconds, ticking every `ms` while `active` on a screen that is showing: the sprites hop and blink at a few frames
 * a second (the shared clock's 25 would redraw every lane that often for a blink).
 */
function useTicker(active: boolean, ms: number): number {
  const paused = useLivePaused();
  const on = active && !paused;
  const [t, setT] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setT(Date.now() / 1000), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return on ? t : 0;
}

const styles = StyleSheet.create({
  dim: { opacity: 0.5 },
  sprite: { position: "absolute" },
});
