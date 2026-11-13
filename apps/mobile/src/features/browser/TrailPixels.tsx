import type { BrowserTrailKind } from "@agenteschat/client";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { Canvas, createPicture, PaintStyle, Picture, Skia, type SkPaint } from "@shopify/react-native-skia";
import { memo, useMemo, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { useTheme } from "@/ui/theme";
import { cellsToSvg } from "../../computer/cells";
import {
  type CellRun,
  MARK_W,
  markCells,
  pageCells,
  pageGrid,
  SKY_CELL,
  STRIP_ROWS,
  skyEdgeCells,
  stripCells,
  stripWidth,
  TRAIL_CELL,
} from "./trail-pixels";

/**
 * The card's pixels after a run (./trail-pixels.ts, the web's drawings) on Skia canvases. Decorative: the
 * card's words say what they show, so screen readers skip them.
 */

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

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };

/** Cell runs drawn at `cx` × `cy` points per cell, in a `width` × `height` box (also the agent's month). */
export function CellCanvas({
  runs,
  width,
  height,
  cx,
  cy = cx,
}: {
  runs: CellRun[];
  width: number;
  height: number;
  cx: number;
  cy?: number;
}) {
  const picture = useMemo(
    () =>
      createPicture(
        (canvas) => {
          canvas.scale(cx, cy);
          for (const run of runs) {
            const path = Skia.Path.MakeFromSVGString(cellsToSvg(run.cells));
            if (path) canvas.drawPath(path, cellPaint(run.color));
          }
        },
        { width, height },
      ),
    [runs, width, height, cx, cy],
  );
  return (
    <Canvas style={{ width, height }}>
      <Picture picture={picture} />
    </Canvas>
  );
}

function useTones() {
  const { colors, scheme } = useTheme();
  return { raised: colors.raised, danger: colors.danger, dark: scheme === "dark" };
}

/** The steps as pixel columns, oldest left (the card's summary line). */
export const TrailStrip = memo(function TrailStrip({
  kinds,
  color,
}: {
  kinds: BrowserTrailKind[];
  color: AgentColorName;
}) {
  const { raised, danger } = useTones();
  const key = kinds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the kinds
  const runs = useMemo(() => stripCells(kinds, color, { raised, danger }), [key, color, raised, danger]);
  const w = stripWidth(kinds.length) * TRAIL_CELL;
  const h = STRIP_ROWS * TRAIL_CELL;
  return (
    <View style={{ width: w, height: h }} {...hidden}>
      <CellCanvas runs={runs} width={w} height={h} cx={TRAIL_CELL} />
    </View>
  );
});

/** One step's column, marking its line in the list. */
export const TrailMark = memo(function TrailMark({ kind, color }: { kind: BrowserTrailKind; color: AgentColorName }) {
  const { raised, danger } = useTones();
  const runs = useMemo(() => markCells(kind, color, { raised, danger }), [kind, color, raised, danger]);
  const w = MARK_W * TRAIL_CELL;
  const h = STRIP_ROWS * TRAIL_CELL;
  return (
    <View style={{ width: w, height: h }} {...hidden}>
      <CellCanvas runs={runs} width={w} height={h} cx={TRAIL_CELL} />
    </View>
  );
});

/** The thin edge of the agent's sky on top of the card: still and greyed, as on the web. */
export function TrailSky({ color }: { color: AgentColorName }) {
  const { raised, dark } = useTones();
  const [width, setWidth] = useState(0);
  const runs = useMemo(() => (width ? skyEdgeCells(width, color, raised, dark) : []), [width, color, raised, dark]);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  return (
    <View style={{ height: 2 * SKY_CELL }} onLayout={onLayout} {...hidden}>
      {width ? <CellCanvas runs={runs} width={width} height={2 * SKY_CELL} cx={SKY_CELL} /> : null}
    </View>
  );
}

/** The drawn page in the thumbnail: the shape of a page, never the real one. */
export const TrailPage = memo(function TrailPage({
  color,
  width,
  height,
}: {
  color: AgentColorName;
  width: number;
  height: number;
}) {
  const { dark } = useTones();
  const { w, h } = pageGrid(width, height);
  const runs = useMemo(() => pageCells(w, h, color, dark), [w, h, color, dark]);
  return (
    <View style={{ width, height }} {...hidden}>
      <CellCanvas runs={runs} width={width} height={height} cx={width / w} cy={height / h} />
    </View>
  );
});
