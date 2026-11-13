import { describe, expect, test } from "bun:test";
import { parseColor } from "../src/sky/math";
import {
  CLOUDS,
  cloudAt,
  cloudOrigin,
  HEADER_AREA,
  headerField,
  isDarkSurface,
  PHONE_AREA,
  phoneField,
  skyHourOf,
  starAt,
  workspaceInk,
  workspaceTones,
} from "../src/sky/workspace";

describe("which sky a server gets", () => {
  test("agentes.chat and its subdomains are the Cloud's day", () => {
    for (const host of ["agentes.chat", "app.agentes.chat", "AGENTES.CHAT", "agentes.chat:443"])
      expect(skyHourOf(host)).toBe("day");
  });
  test("any other host is one's own: dusk", () => {
    for (const host of ["macbook.tail1234.ts.net", "chat.acme.com", "localhost:5173", "notagentes.chat", ""])
      expect(skyHourOf(host)).toBe("dusk");
  });
});

describe("tones", () => {
  test("from the surface into the hour's light, four in all", () => {
    for (const hour of ["day", "dusk"] as const)
      for (const surface of ["#f6f9fd", "#0d1015"]) {
        const tones = workspaceTones(hour, surface);
        expect(tones).toHaveLength(4);
        expect(tones[0]).toBe(surface);
      }
    expect(workspaceTones("day", "#f6f9fd")).not.toEqual(workspaceTones("dusk", "#f6f9fd"));
  });
  test("a dark surface gets deeper tones and dimmer clouds", () => {
    expect(isDarkSurface("#0d1015")).toBe(true);
    expect(isDarkSurface("#f6f9fd")).toBe(false);
    expect(workspaceInk("day", "#f6f9fd").bright).toBe("#ffffff");
    expect(workspaceInk("day", "#0d1015").bright).not.toBe("#ffffff");
    // Over the header's faint field on a light surface: the sky's own deeper tones, thinned toward the surface.
    const surface = parseColor("#f6f9fd");
    const away = (color: string) => parseColor(color).reduce((sum, c, i) => sum + Math.abs(c - (surface[i] ?? 0)), 0);
    const ink = workspaceInk("dusk", "#f6f9fd", true);
    expect(away(ink.bright)).toBeGreaterThan(0);
    expect(away(ink.bright)).toBeLessThan(away(workspaceTones("dusk", "#f6f9fd")[3] ?? ""));
    expect(away(ink.dim)).toBeLessThan(away(ink.bright));
  });
});

describe("fields", () => {
  test("the header's sky: light, from the left, gone before the sidebar's edge and at its foot", () => {
    expect(headerField(0.02, 0.2, 0)).toBeGreaterThan(0.3);
    expect(headerField(0.02, 0.2, 0)).toBeLessThan(0.5);
    expect(headerField(0.2, 0.2, 0)).toBeGreaterThan(headerField(0.5, 0.2, 0));
    for (const t of [0, 3]) expect(headerField(0.85, 0.3, t)).toBeLessThan(0.01);
    expect(headerField(0.1, 1, 0)).toBeLessThan(0.01);
  });
  test("the phone's sky: fullest on top, gone toward the list", () => {
    expect(phoneField(0.5, 0.05, 0)).toBeGreaterThan(0.6);
    expect(phoneField(0.5, 1, 0)).toBeLessThan(0.06);
  });
});

describe("clouds and stars", () => {
  const w = 68;
  const h = 26;
  test("nothing over the name nor at the sidebar's edge, in either", () => {
    for (let t = 0; t < 40; t += 0.5)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (x >= w * HEADER_AREA.x0 && x < w * HEADER_AREA.x1) continue;
          expect(cloudAt(x, y, w, h, t, HEADER_AREA)).toBe(0);
          expect(starAt(x, y, w, h, t, HEADER_AREA)).toBe(0);
        }
  });
  test("a cloud is drawn where its origin says, lit on top", () => {
    const t = 3;
    const [cx, cy] = cloudOrigin(0, w, h, t, HEADER_AREA);
    const first = CLOUDS[0];
    if (!first) throw new Error("no clouds");
    const [a] = first.rows[2] ?? [0];
    const fade = HEADER_AREA.fade ?? 0;
    const solid = (x: number) => x >= w * (HEADER_AREA.x0 + fade) && x < w * (HEADER_AREA.x1 - fade);
    if (solid(cx + a)) expect(cloudAt(cx + a, cy + 2, w, h, t, HEADER_AREA)).toBe(1);
    if (solid(cx + 2)) expect(cloudAt(cx + 2, cy, w, h, t, HEADER_AREA)).toBe(2);
  });
  test("a cloud dissolves at the area's edges, never a straight cut", () => {
    const cells = (x: number) => {
      let n = 0;
      for (let t = 0; t < 120; t += 0.5) for (let y = 0; y < h; y++) if (cloudAt(x, y, w, h, t, HEADER_AREA)) n++;
      return n;
    };
    const last = Math.ceil(w * HEADER_AREA.x1) - 1;
    const middle = Math.floor(w * ((HEADER_AREA.x0 + HEADER_AREA.x1) / 2));
    expect(cells(last)).toBeLessThan(cells(middle) * 0.5);
    // The phone's area ends at the screen's edge: no fade there.
    expect(PHONE_AREA.fade).toBeUndefined();
  });
  test("clouds drift left and come back from the right", () => {
    const [x0] = cloudOrigin(1, w, h, 10, HEADER_AREA);
    const [x1] = cloudOrigin(1, w, h, 11, HEADER_AREA);
    expect(x1 === x0 - 1 || x1 === x0 - 2 || x1 > x0).toBe(true);
  });
  test("on the phone, clouds stay above the title (the area's top band)", () => {
    const ph = 50;
    for (const t of [0, 7.3, 120])
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < w; x++)
          if (cloudAt(x, y, w, ph, t, PHONE_AREA)) expect(y).toBeLessThan(ph * PHONE_AREA.y1 + 4);
  });
  test("a few stars in the area, none outside it", () => {
    let stars = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = starAt(x, y, w, h, 1, HEADER_AREA);
        if (s && (y < h * HEADER_AREA.y0 || y > h * HEADER_AREA.y1)) throw new Error(`star outside at ${x},${y}`);
        if (s) stars++;
      }
    expect(stars).toBeGreaterThan(0);
    expect(stars).toBeLessThan(40);
  });
});
