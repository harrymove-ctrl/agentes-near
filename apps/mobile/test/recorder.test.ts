import { describe, expect, test } from "bun:test";
import { drawAccessory, drawAgent } from "@agenteschat/ui/agent/engine";
import { arcSweep, asCtx, compile, cornerRadii, RecordingContext, rectsToSvg } from "../src/agent/recorder";

describe("arcSweep (canvas ellipse → Skia arc)", () => {
  test("clockwise half turns, as the eyes draw them", () => {
    expect(arcSweep(Math.PI, 0)).toEqual({ start: 180, sweep: 180 });
    expect(arcSweep(0, Math.PI)).toEqual({ start: 0, sweep: 180 });
  });
  test("a full turn stays a full turn", () => {
    expect(arcSweep(0, Math.PI * 2).sweep).toBe(360);
  });
  test("anticlockwise sweeps are negative", () => {
    expect(arcSweep(0, Math.PI, true).sweep).toBeCloseTo(-180);
  });
});

describe("cornerRadii", () => {
  test("a number applies to all corners", () => {
    expect(cornerRadii(4, 20, 20)).toEqual([4, 4, 4, 4]);
  });
  test("four values keep their order (tl, tr, br, bl) and are clamped to half the box", () => {
    expect(cornerRadii([3, 3, 3, 1], 20, 20)).toEqual([3, 3, 3, 1]);
    expect(cornerRadii([30, 2, 2, 2], 20, 10)).toEqual([5, 2, 2, 2]);
  });
  test("two and three values follow the canvas spec", () => {
    expect(cornerRadii([1, 2], 20, 20)).toEqual([1, 2, 1, 2]);
    expect(cornerRadii([1, 2, 3], 20, 20)).toEqual([1, 2, 3, 2]);
  });
});

describe("RecordingContext + compile", () => {
  test("records the engine's whole agent: body cells, clip, eyes", () => {
    const rec = new RecordingContext();
    drawAgent(asCtx(rec), 0, 0, 40, { color: "teal", eyes: "round", pose: { turn: [0.4, 0.1] } });
    const ops = rec.commands.map((c) => c.op);
    expect(ops).toContain("clip");
    expect(ops).toContain("fillRect");
    expect(ops).toContain("fill");
    expect(ops.filter((o) => o === "save").length).toBe(ops.filter((o) => o === "restore").length);
  });

  test("compile groups each run of cells into one path per tone", () => {
    const rec = new RecordingContext();
    drawAgent(asCtx(rec), 0, 0, 64, { color: "sky", eyes: "dots" });
    const cells = rec.commands.filter((c) => c.op === "fillRect").length;
    const compiled = compile(rec.commands);
    const groups = compiled.filter((c) => c.op === "rects");
    expect(cells).toBeGreaterThan(100);
    // Five body tones (plus a few for the extruded sides at most).
    expect(groups.length).toBeLessThanOrEqual(8);
    const total = groups.reduce((n, g) => n + (g.op === "rects" ? g.rects.length / 4 : 0), 0);
    expect(total).toBe(cells);
  });

  test("an accessory's pixels are recorded too", () => {
    const rec = new RecordingContext();
    drawAgent(asCtx(rec), 0, 0, 48, {
      color: "amber",
      eyes: "round",
      after: (ctx, s, frame) => drawAccessory(ctx, s, "cap", frame, 0, false),
    });
    const colors = new Set(rec.commands.flatMap((c) => (c.op === "fillRect" ? [c.color] : [])));
    expect(colors.has("#23272e")).toBe(true);
  });

  test("save/restore restore the style", () => {
    const rec = new RecordingContext();
    rec.fillStyle = "#111111";
    rec.save();
    rec.fillStyle = "#222222";
    rec.restore();
    rec.fillRect(0, 0, 1, 1);
    expect(rec.commands.at(-1)).toEqual({ op: "fillRect", x: 0, y: 0, w: 1, h: 1, color: "#111111" });
  });

  test("fill keeps a copy of the path", () => {
    const rec = new RecordingContext();
    rec.beginPath();
    rec.moveTo(0, 0);
    rec.lineTo(1, 1);
    rec.fill();
    rec.lineTo(2, 2);
    const fill = rec.commands[0];
    expect(fill?.op === "fill" ? fill.path.length : -1).toBe(2);
  });
});

test("rectsToSvg writes closed rectangles", () => {
  expect(rectsToSvg([0, 0, 2, 3, 1.5, 2, 1, 1])).toBe("M0 0h2v3h-2ZM1.5 2h1v1h-1Z");
});
