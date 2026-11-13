import { cellPaths } from "@agenteschat/ui/sky/chart";
import { Group, Path, Skia } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { ditherCells, WIDGET_CELL } from "./logic";

/**
 * A shape filled with the widgets' dither (ADR 0135): square cells on the 4×4 Bayer threshold in the agent's light
 * tone, clipped to the shape, and the shape's clean outline in its deep tone. Drawn inside a Skia `Canvas`, at
 * (`x`, `y`); `shape` and `outline` are SVG path data in the box's own coordinates (`outline` defaults to `shape`).
 */
export function DitherShape({
  x = 0,
  y = 0,
  width,
  height,
  shape,
  outline,
  fill,
  stroke,
  strokeWidth = 1.5,
  density = 0.55,
  cell = WIDGET_CELL,
}: {
  x?: number;
  y?: number;
  width: number;
  height: number;
  shape: string;
  outline?: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  density?: number;
  cell?: number;
}) {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const dots = useMemo(() => {
    const d = cellPaths(ditherCells(cols, rows, density), cols, rows, cell, true).get(1);
    return d ? Skia.Path.MakeFromSVGString(d) : null;
  }, [cols, rows, density, cell]);
  const clip = useMemo(() => Skia.Path.MakeFromSVGString(shape), [shape]);
  const line = useMemo(() => (outline ? Skia.Path.MakeFromSVGString(outline) : clip), [outline, clip]);
  if (width <= 0 || height <= 0) return null;
  return (
    <Group transform={[{ translateX: x }, { translateY: y }]}>
      {dots && clip ? (
        <Group clip={clip}>
          <Path path={dots} color={fill} />
        </Group>
      ) : null}
      {line && stroke ? (
        <Path path={line} color={stroke} style="stroke" strokeWidth={strokeWidth} strokeJoin="round" />
      ) : null}
    </Group>
  );
}
