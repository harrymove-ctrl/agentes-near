/**
 * The React pieces of the chat's charts (a clean stroke over a fine dither in the agent's tones),
 * shared by the chat's chart card (`apps/web/src/components/ChartBlock.tsx`) and the widgets (ADR 0135). The cells
 * themselves come from `../sky/chart`, DOM-free, as the phone draws them.
 */
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentColorName } from "../agent/engine.js";
import { cx } from "../cx";
import { useDarkTheme } from "../hooks/useDarkTheme";
import { areaCells, CHART_CELL, chartAreaTones, chartInk, linePoints, lineTops, smoothPath } from "../sky/chart";
import { parseColor } from "../sky/math";

/** Paints cells (one canvas pixel each, drawn at `CHART_CELL` points) in the color `tone(value)` gives. */
export function paintCells(
  canvas: HTMLCanvasElement | null,
  cols: number,
  rows: number,
  cells: ArrayLike<number>,
  tone: (value: number) => string | null,
) {
  if (!canvas || cols < 1 || rows < 1) return;
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(cols, rows);
  const cache = new Map<number, [number, number, number] | null>();
  for (let i = 0; i < cols * rows; i++) {
    const v = cells[i] ?? -1;
    if (!cache.has(v)) {
      const c = tone(v);
      cache.set(v, c ? parseColor(c) : null);
    }
    const rgb = cache.get(v);
    if (!rgb) continue;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** An element's width, kept up to date. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Tops missing at either end (NaN) take the nearest column's, so an edge-to-edge area has no gap at its sides. */
export function fillEnds(tops: number[]) {
  const first = tops.findIndex((v) => !Number.isNaN(v));
  if (first < 0) return;
  for (let i = 0; i < first; i++) tops[i] = tops[first] as number;
  for (let i = first + 1; i < tops.length; i++) if (Number.isNaN(tops[i] as number)) tops[i] = tops[i - 1] as number;
}

/**
 * The dither under a line (`points`, in a box `width` × `height` points), in an agent's tones: the near tone along
 * the curve, the far one fading down. `bleed` (edge to edge) fills the side columns the curve's samples round past
 * and fades over twice the height, so the dither still reaches the bottom edge. The one painter of a line's area, for
 * the chat's chart and the widgets alike.
 */
export function paintLineArea(
  canvas: HTMLCanvasElement | null,
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
  color: AgentColorName,
  dark: boolean,
  bleed = false,
) {
  if (width < 10) return;
  const cols = Math.round(width / CHART_CELL);
  const rows = Math.round(height / CHART_CELL);
  const tops = lineTops(points, cols);
  if (bleed) fillEnds(tops);
  const [near, far] = chartAreaTones(color, dark);
  const cells = areaCells(cols, bleed ? rows * 2 : rows, tops);
  paintCells(canvas, cols, rows, cells, (v) => (v === 1 ? near : v === 2 ? far : null));
}

/**
 * A line over its dither area, in an agent's tones, as wide as its box: no axes, no tips. `bleed` runs it edge to
 * edge (a sparkline), `dot` marks the last point with a square, as a widget's line ends.
 */
export function DitherLine({
  values,
  color,
  height,
  bleed = false,
  dot = false,
  className,
}: {
  values: readonly number[];
  /** An agent color, as `AgentAvatar` takes it. */
  color: string;
  height: number;
  bleed?: boolean;
  dot?: boolean;
  className?: string;
}) {
  const dark = useDarkTheme();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const area = useRef<HTMLCanvasElement>(null);
  const tone = color as AgentColorName;
  const points = useMemo(() => {
    if (width < 10 || values.length < 2) return [];
    const pad = bleed ? 3 : 6;
    const flat = linePoints(values, width, height, pad);
    if (!bleed) return flat;
    return flat.map(([, y], i): [number, number] => [(i * width) / Math.max(1, values.length - 1), y]);
  }, [values, width, height, bleed]);
  const ink = chartInk(tone, dark);

  useLayoutEffect(() => {
    if (points.length < 2) return;
    paintLineArea(area.current, points, width, height, tone, dark, bleed);
  }, [points, width, height, tone, dark, bleed]);

  const last = points[points.length - 1];
  return (
    <div className={cx("ac-dline", className)} ref={box} style={{ height }} aria-hidden="true">
      <canvas ref={area} className="ac-dline__area" />
      {width > 10 && points.length > 1 && (
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
          <path d={smoothPath(points)} fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round" />
          {dot && last && (
            // Kept whole inside the box: edge to edge, the last point sits on the right edge.
            <rect
              x={Math.max(0, Math.min(width - 6, Math.round(last[0]) - 3))}
              y={Math.max(0, Math.min(height - 6, Math.round(last[1]) - 3))}
              width={6}
              height={6}
              fill={ink}
            />
          )}
        </svg>
      )}
    </div>
  );
}
