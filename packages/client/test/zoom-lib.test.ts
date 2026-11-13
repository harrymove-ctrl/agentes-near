import { describe, expect, test } from "bun:test";
import {
  clampPan,
  clickZoom,
  fitScale,
  fitView,
  isZoomed,
  lensLayout,
  lensMag,
  panBy,
  stepZoom,
  wheelIntent,
  ZOOM_MAX,
  zoomAt,
} from "../src/lib/zoom";

const stage = { w: 1200, h: 700 };
const wide = { w: 3600, h: 600 };
const tall = { w: 800, h: 2800 };
const small = { w: 300, h: 200 };

describe("fit", () => {
  test("the whole picture as big as the stage allows, by width or height, never past its real size", () => {
    expect(fitScale(wide, stage)).toBeCloseTo(1 / 3);
    expect(fitScale(tall, stage)).toBeCloseTo(0.25);
    expect(fitScale(small, stage)).toBe(1);
    expect(fitScale({ w: 0, h: 0 }, stage)).toBe(1);
  });
  test("fitted and centered", () => {
    expect(fitView(wide, stage)).toEqual({ scale: 1 / 3, x: 0, y: 250 });
    expect(fitView(small, stage)).toEqual({ scale: 1, x: 450, y: 250 });
  });
});

describe("zoom at a point", () => {
  test("the point under the cursor stays under it", () => {
    const v = fitView(wide, stage);
    const z = zoomAt(v, 1, { x: 600, y: 350 }, wide, stage);
    expect(z.scale).toBe(1);
    // The stage point (600, 350) was picture pixel (1800, 300) and still is.
    expect((600 - z.x) / z.scale).toBeCloseTo(1800);
    expect((350 - z.y) / z.scale).toBeCloseTo(300);
  });
  test("kept between the fitted size and the maximum", () => {
    const v = fitView(tall, stage);
    expect(zoomAt(v, 0.01, { x: 0, y: 0 }, tall, stage).scale).toBe(0.25);
    expect(zoomAt(v, 99, { x: 0, y: 0 }, tall, stage).scale).toBe(ZOOM_MAX);
  });
  test("− and + walk the stops, the fitted size among them", () => {
    expect(stepZoom(1 / 3, 1, 1 / 3)).toBe(0.5);
    expect(stepZoom(0.5, -1, 1 / 3)).toBe(1 / 3);
    expect(stepZoom(1 / 3, -1, 1 / 3)).toBe(1 / 3);
    expect(stepZoom(1.2, 1, 0.25)).toBe(1.5);
    expect(stepZoom(8, 1, 0.25)).toBe(ZOOM_MAX);
  });
  test("a click goes to the real size, or twice the fit when the picture is small", () => {
    expect(clickZoom(1 / 3)).toBe(1);
    expect(clickZoom(1)).toBe(2);
    expect(clickZoom(0.8)).toBe(1.6);
  });
  test("zoomed only past the fitted size", () => {
    expect(isZoomed(fitView(wide, stage), wide, stage)).toBe(false);
    expect(isZoomed({ scale: 1, x: 0, y: 0 }, wide, stage)).toBe(true);
  });
});

describe("pan bounds", () => {
  test("a side bigger than the stage never leaves an empty edge; a smaller one stays centered", () => {
    const v = { scale: 1, x: 0, y: 0 };
    expect(panBy(v, 500, 0, wide, stage)).toEqual({ scale: 1, x: 0, y: 50 });
    expect(panBy(v, -99_999, 0, wide, stage)).toEqual({ scale: 1, x: -2400, y: 50 });
    expect(clampPan({ scale: 2, x: -100, y: 40 }, wide, stage)).toEqual({ scale: 2, x: -100, y: 0 });
    expect(clampPan({ scale: 2, x: -100, y: -9999 }, wide, stage)).toEqual({ scale: 2, x: -100, y: -500 });
  });
});

describe("the hover lens", () => {
  test("a tall picture: the pane in the free strip beside it, the lens on the pointer inside the picture", () => {
    const fit = fitScale(tall, stage);
    const v = fitView(tall, stage);
    const box = { x: v.x, y: v.y, w: tall.w * fit, h: tall.h * fit };
    const mag = lensMag(fit);
    expect(mag).toBe(4);
    const l = lensLayout(stage, box, { x: box.x + 10, y: 690 }, mag);
    // Centered, the strips each side are as wide: the pane goes on the right.
    expect(l.pane.x).toBeGreaterThanOrEqual(box.x + box.w);
    expect(l.pane.w).toBeCloseTo(l.lens.w * mag);
    expect(l.lens.x).toBe(box.x);
    expect(l.lens.y + l.lens.h).toBeCloseTo(box.y + box.h);
    expect(l.offset.x).toBeCloseTo(0);
  });
  test("a wide picture: the pane in the strip under it", () => {
    const v = fitView(wide, stage);
    const box = { x: 0, y: v.y, w: 1200, h: 200 };
    const l = lensLayout(stage, box, { x: 600, y: 350 }, 3);
    expect(l.pane.y).toBeGreaterThanOrEqual(box.y + box.h);
    expect(l.lens.h).toBeLessThanOrEqual(box.h);
    expect(l.offset.x).toBeCloseTo(-(l.lens.x - box.x) * 3);
  });
  test("no strip wide enough: the pane floats over the half away from the pointer", () => {
    const box = { x: 0, y: 0, w: 1200, h: 700 };
    expect(lensLayout(stage, box, { x: 100, y: 100 }, 2).pane.x).toBeGreaterThanOrEqual(600);
    expect(lensLayout(stage, box, { x: 1100, y: 100 }, 2).pane.x + 1).toBeLessThan(600);
  });
});

describe("what a wheel event is", () => {
  const w = (deltaY: number, deltaX = 0, deltaMode = 0, ctrlKey = false) =>
    wheelIntent({ ctrlKey, deltaMode, deltaX, deltaY });
  test("ctrl is a trackpad pinch", () => expect(w(-3.5, 0, 0, true)).toBe("pinch"));
  test("lines, pages or a large whole step on Y alone are a mouse wheel", () => {
    expect(w(3, 0, 1)).toBe("wheel");
    expect(w(-100)).toBe("wheel");
    expect(w(120)).toBe("wheel");
  });
  test("small, fractional or sideways steps are a two-finger scroll", () => {
    expect(w(4)).toBe("scroll");
    expect(w(-62.5)).toBe("scroll");
    expect(w(100, 2)).toBe("scroll");
  });
});
