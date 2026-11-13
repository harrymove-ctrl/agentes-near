import {
  ClipOp,
  PaintStyle,
  type SkCanvas,
  Skia,
  type SkPaint,
  type SkPath,
  StrokeCap,
  StrokeJoin,
} from "@shopify/react-native-skia";
import type { CompiledOp, PathCmd } from "./recorder";
import { rectsToSvg } from "./recorder";

/**
 * Replays the engine's recorded drawing (./recorder.ts) on a Skia canvas: the adapter from the engine's
 * `Ctx2D` subset to React Native Skia. Paints are cached per color and style (they are reused every frame).
 */

const paints = new Map<string, SkPaint>();

function fillPaint(color: string): SkPaint {
  const key = `f:${color}`;
  let p = paints.get(key);
  if (!p) {
    p = Skia.Paint();
    p.setAntiAlias(true);
    p.setStyle(PaintStyle.Fill);
    p.setColor(Skia.Color(color));
    paints.set(key, p);
  }
  return p;
}

const CAPS: Record<CanvasLineCap, StrokeCap> = {
  butt: StrokeCap.Butt,
  round: StrokeCap.Round,
  square: StrokeCap.Square,
};
const JOINS: Record<CanvasLineJoin, StrokeJoin> = {
  miter: StrokeJoin.Miter,
  round: StrokeJoin.Round,
  bevel: StrokeJoin.Bevel,
};

function strokePaint(color: string, width: number, cap: CanvasLineCap, join: CanvasLineJoin): SkPaint {
  const key = `s:${color}:${width.toFixed(2)}:${cap}:${join}`;
  let p = paints.get(key);
  if (!p) {
    p = Skia.Paint();
    p.setAntiAlias(true);
    p.setStyle(PaintStyle.Stroke);
    p.setColor(Skia.Color(color));
    p.setStrokeWidth(width);
    p.setStrokeCap(CAPS[cap] ?? StrokeCap.Butt);
    p.setStrokeJoin(JOINS[join] ?? StrokeJoin.Miter);
    paints.set(key, p);
  }
  if (paints.size > 400) paints.clear();
  return p;
}

/** Recorded path commands → an immutable Skia path. */
export function buildPath(cmds: readonly PathCmd[]): SkPath {
  const b = Skia.PathBuilder.Make();
  for (const c of cmds) {
    switch (c.k) {
      case "M":
        b.moveTo(c.x, c.y);
        break;
      case "L":
        b.lineTo(c.x, c.y);
        break;
      case "C":
        b.cubicTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
        break;
      case "Q":
        b.quadTo(c.x1, c.y1, c.x, c.y);
        break;
      case "Z":
        b.close();
        break;
      case "RR": {
        const [tl, tr, br, bl] = c.r;
        b.addRRect({
          rect: { x: c.x, y: c.y, width: c.w, height: c.h },
          topLeft: { x: tl, y: tl },
          topRight: { x: tr, y: tr },
          bottomRight: { x: br, y: br },
          bottomLeft: { x: bl, y: bl },
        });
        break;
      }
      case "A": {
        const oval = { x: c.x, y: c.y, width: c.w, height: c.h };
        // A full turn in one arcTo collapses; draw it as two halves.
        if (Math.abs(c.sweep) >= 360) {
          const half = c.sweep > 0 ? 180 : -180;
          b.arcToOval(oval, c.start, half, false);
          b.arcToOval(oval, c.start + half, half, false);
        } else b.arcToOval(oval, c.start, c.sweep, false);
        break;
      }
    }
  }
  return b.build();
}

/** Draws compiled ops on a Skia canvas. */
export function replay(canvas: SkCanvas, ops: readonly CompiledOp[]): void {
  for (const op of ops) {
    switch (op.op) {
      case "save":
        canvas.save();
        break;
      case "restore":
        canvas.restore();
        break;
      case "translate":
        canvas.translate(op.x, op.y);
        break;
      case "scale":
        canvas.scale(op.x, op.y);
        break;
      case "rects": {
        const path = Skia.Path.MakeFromSVGString(rectsToSvg(op.rects));
        if (path) canvas.drawPath(path, fillPaint(op.color));
        break;
      }
      case "fill":
        canvas.drawPath(buildPath(op.path), fillPaint(op.color));
        break;
      case "stroke":
        canvas.drawPath(buildPath(op.path), strokePaint(op.color, op.width, op.cap, op.join));
        break;
      case "clip":
        canvas.clipPath(buildPath(op.path), ClipOp.Intersect, true);
        break;
    }
  }
}
