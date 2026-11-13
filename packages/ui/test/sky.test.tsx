import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";
import { canvasPage } from "../testing/frames";

setupDom();

import { cleanup, render } from "@testing-library/react";
import {
  agentGradient,
  agentTones,
  EmptyState,
  EYE,
  glowTones,
  mix,
  PixelSky,
  parseColor,
  pixelOf,
  redrawSkies,
  SKY_TONES,
  SkyGlow,
  type SkyOptions,
  SPRITE,
  softTones,
  spriteTone,
  startSky,
} from "../src";
import { CLEAR_PX } from "../src/sky/engine";
import { type CalmZone, lightToward, opaque, placeSprite, riseColumn, spriteNear } from "../src/sky/math";

afterEach(() => cleanup());

const opts = { palette: SKY_TONES, base: () => 0.5 };

describe("sky tones", () => {
  test("parses hex (short and long) and rgb(); anything else is mid gray", () => {
    expect(parseColor("#0063d1")).toEqual([0, 99, 209]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColor("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30]);
    expect(parseColor("var(--bg)")).toEqual([128, 128, 128]);
  });

  test("mixes two colors and packs pixels as little-endian RGBA", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#abcdef", 0)).toBe("#123456");
    expect(mix("#123456", "#abcdef", 1)).toBe("#abcdef");
    expect(pixelOf("#0063d1")).toBe(0xffd16300);
  });

  test("an rgba token as the solid color it shows over a surface (the email palette's hairlines)", () => {
    expect(opaque("rgba(23, 23, 22, 0.12)", "#ffffff")).toBe("#e3e3e3");
    expect(opaque("rgba(255, 255, 255, 0.15)", "#1c1c1b")).toBe("#3e3e3d");
    expect(opaque("rgba(23 23 22 / 0.07)", "#f3f3f0")).toBe("#e4e4e1");
    expect(opaque("#151514", "#ffffff")).toBe("#151514");
  });

  test("an agent's sky goes from deep to light; sky is the landing's tones", () => {
    expect(agentTones("sky")).toEqual(SKY_TONES);
    const violet = agentTones("violet");
    expect(violet).toHaveLength(8);
    expect(violet[2]).toBe(agentGradient("violet")[1]);
    expect(violet[4]).toBe(agentGradient("violet")[0]);
    const light = (c: string) => parseColor(c).reduce((a, b) => a + b, 0);
    expect(light(violet[0] ?? "")).toBeLessThan(light(violet[7] ?? ""));
  });

  test("glows start on the surface, so they meet the page without a seam", () => {
    expect(glowTones("teal", "#f4f4f1")[0]).toBe("#f4f4f1");
    expect(softTones("sky", "#0a0a09")[0]).toBe("#0a0a09");
    expect(softTones("sky", "#0a0a09").at(-1)).not.toBe(agentGradient("sky")[1]);
  });

  test("eyes are white everywhere; the pixel agents' body is the agent's deep tone", () => {
    expect(EYE).toBe("#ffffff");
    expect(spriteTone("sky")).toBe("#04203f");
    const light = (c: string) =>
      (Number.parseInt(c.slice(1, 3), 16) + Number.parseInt(c.slice(3, 5), 16) + Number.parseInt(c.slice(5, 7), 16)) /
      3;
    expect(light(spriteTone("rose"))).toBeLessThan(light(agentGradient("rose")[1]));
  });
});

test("the pointer light follows at the same pace at any frame rate: 5% of the way each 60th of a second", () => {
  expect(lightToward(0, 1, 1 / 60)).toBeCloseTo(0.05, 10);
  let at60 = 0;
  for (let i = 0; i < 60; i++) at60 = lightToward(at60, 1, 1 / 60);
  let at30 = 0;
  for (let i = 0; i < 30; i++) at30 = lightToward(at30, 1, 1 / 30);
  expect(at30).toBeCloseTo(at60, 10);
  expect(at60).toBeCloseTo(1 - 0.95 ** 60, 10);
  // The pointer far off the sky: the light stops 0.3 past its edge.
  expect(lightToward(0, 5, 60)).toBeCloseTo(1.3, 10);
  expect(lightToward(0, -5, 60)).toBeCloseTo(-0.3, 10);
});

describe("PixelSky", () => {
  test("a decorative canvas with nothing to read", () => {
    const { container } = render(
      <div>
        <PixelSky options={opts} />
      </div>,
    );
    const canvas = container.querySelector("canvas");
    expect(canvas?.textContent).toBe("");
    expect(canvas?.classList.contains("ac-sky")).toBe(true);
  });

  test("without a 2D context nothing is drawn and the cleanup is safe", () => {
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => null) as typeof canvas.getContext;
    host.append(canvas);
    const stop = startSky(canvas, () => opts);
    expect(() => stop()).not.toThrow();
  });

  test("the glow is a decorative block", () => {
    const { container } = render(<SkyGlow color="green" />);
    expect(container.querySelector(".ac-sky-glow")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("EmptyState with sky", () => {
  test("the glow stands in for the icon; the text stays", () => {
    const { container, getByText } = render(
      <EmptyState sky icon="issues" title="Nada aqui">
        Quando alguém abrir uma issue, ela aparece aqui.
      </EmptyState>,
    );
    expect(container.querySelector(".ac-empty--sky .ac-sky-glow")).not.toBeNull();
    expect(container.querySelector(".ac-empty__icon")).toBeNull();
    expect(getByText("Nada aqui")).toBeTruthy();
  });

  test("without sky it keeps the icon (errors, no results)", () => {
    const { container } = render(<EmptyState icon="alert">Falhou</EmptyState>);
    expect(container.querySelector(".ac-empty__icon")).not.toBeNull();
    expect(container.querySelector(".ac-sky")).toBeNull();
  });

  test("with a size and an agent: the agent in its light instead of the icon, no box", () => {
    const { container } = render(
      <EmptyState size="page" agent={{ color: "green" }} mood="deal" icon="issues" title="Tudo certo" />,
    );
    expect(container.querySelector(".ac-empty--page")).not.toBeNull();
    const sticker = container.querySelector<HTMLElement>(".ac-empty__agent .ac-sticker");
    expect(sticker?.dataset.mood).toBe("deal");
    expect(sticker?.style.width).toBe("128px");
    expect(container.querySelector(".ac-empty__agent .ac-sky-glow")).not.toBeNull();
    expect(container.querySelector(".ac-empty__icon")).toBeNull();
  });

  test("a panel's agent is smaller, and an inline list never grows one", () => {
    const panel = render(<EmptyState size="panel" agent title="Aqui" />);
    expect(panel.container.querySelector<HTMLElement>(".ac-sticker")?.style.width).toBe("96px");
    const inline = render(<EmptyState size="inline" agent title="Nada com esse nome" />);
    expect(inline.container.querySelector(".ac-empty--inline .ac-sticker")).toBeNull();
    expect(inline.container.querySelector(".ac-empty--inline .ac-empty__agent")).toBeNull();
  });
});

describe("the sky's loop", () => {
  /**
   * A sky on a page whose frames run by hand. The page's own frames asked for before (the other tests' skies) run
   * first: the loop is one for the whole page.
   */
  async function skyPage(reduced: boolean) {
    await new Promise((r) => setTimeout(r, 100));
    const page = canvasPage({ width: 40, height: 40, reduced });
    const stop = startSky(page.canvas, () => opts);
    const close = page.close;
    return Object.assign(page, {
      close() {
        stop();
        page.frames(100);
        close();
      },
    });
  }

  test("moving: about 30 frames a second while on screen, none and no loop off screen", async () => {
    const page = await skyPage(false);
    try {
      expect(page.draws()).toBe(1);
      page.frames(1000);
      expect(page.draws()).toBeGreaterThanOrEqual(29);
      expect(page.draws()).toBeLessThanOrEqual(32);
      page.onScreen(false);
      page.frames(50);
      const drawn = page.draws();
      page.frames(1000);
      expect(page.draws()).toBe(drawn);
      expect(page.pending()).toBe(0);
      page.onScreen(true);
      page.frames(500);
      expect(page.draws()).toBeGreaterThan(drawn + 10);
    } finally {
      page.close();
    }
  });

  test("with reduced motion: one still frame and no loop after it; asked again (a theme, new options), one more", async () => {
    const page = await skyPage(true);
    try {
      expect(page.draws()).toBe(1);
      page.frames(1000);
      expect(page.draws()).toBe(1);
      expect(page.pending()).toBe(0);
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      expect(page.pending()).toBe(0);
    } finally {
      page.close();
    }
  });

  test("hidden and shown again before the observer called (a phone's width and back): on screen, so new options still draw", async () => {
    const page = await skyPage(true);
    try {
      page.onScreen(false, true);
      page.frames(100);
      // The onboarding's progress bar: a step done is new options, drawn once more.
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      // The other way round, it is off screen: nothing more until it shows again.
      page.onScreen(true, false);
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      page.onScreen(true);
      page.frames(1000);
      expect(page.draws()).toBe(3);
    } finally {
      page.close();
    }
  });

  test("reduced motion switched while the page is open: a still sky starts moving, a moving one stops", async () => {
    const page = await skyPage(true);
    try {
      page.frames(1000);
      expect(page.draws()).toBe(1);
      // Motion allowed again (the system's switch, a browser's emulated media): about 30 frames a second at once.
      page.motion(false);
      page.frames(1000);
      expect(page.draws()).toBeGreaterThanOrEqual(29);
      // Reduced again: one still frame with the setting, then no loop.
      page.motion(true);
      page.frames(100);
      const drawn = page.draws();
      page.frames(1000);
      expect(page.draws()).toBe(drawn);
      expect(page.pending()).toBe(0);
      expect(page.listening()).toBe(1);
    } finally {
      page.close();
    }
    // Stopped, the sky no longer listens.
    expect(page.listening()).toBe(0);
  });
});

describe("pixel agents and what stands on the sky", () => {
  /** A sky of 100×60 sky pixels (4 CSS pixels each) with a face on it at sky pixels 40–60 × 20–40. */
  async function faceSky(reduced: boolean, extra: Partial<SkyOptions> = {}) {
    await new Promise((r) => setTimeout(r, 50));
    const page = canvasPage({ width: 400, height: 240, reduced });
    const face = document.createElement("span");
    face.getBoundingClientRect = () =>
      ({ x: 160, y: 80, left: 160, top: 80, right: 240, bottom: 160, width: 80, height: 80 }) as DOMRect;
    page.host.append(face);
    // Near ones only: solid, in a body color the field never takes, so every agent's pixels can be found.
    const stop = startSky(page.canvas, () => ({ ...opts, sprites: 24, near: 1, clear: () => [face], ...extra }));
    return Object.assign(page, {
      done() {
        stop();
        page.frames(100);
        page.close();
      },
    });
  }
  const BODY = pixelOf(spriteTone("sky"));
  const WHITE = pixelOf("#ffffff");
  /** The agents' pixels in the last frame, as [x, y]. */
  const agentPixels = (page: { image: () => { pixels: Uint32Array; w: number } | null }) => {
    const img = page.image();
    const out: [number, number][] = [];
    for (const [i, c] of (img?.pixels ?? []).entries())
      if (c === BODY || c === WHITE) out.push([i % (img?.w ?? 1), Math.floor(i / (img?.w ?? 1))]);
    return out;
  };
  /** Every pixel of one whole near agent (2×2 per sprite pixel): a frame of whole ones has a multiple of it. */
  const WHOLE = SPRITE.join("").replaceAll(".", "").length * 4;
  /** The connected figures (4-neighbours) in the last frame, as [width, height]. */
  const figures = (page: Parameters<typeof agentPixels>[0]) => {
    const w = page.image()?.w ?? 0;
    const isAgent = new Set(agentPixels(page).map(([x, y]) => y * w + x));
    const seen = new Set<number>();
    const out: [number, number][] = [];
    for (const start of isAgent) {
      if (seen.has(start)) continue;
      const stack = [start];
      seen.add(start);
      let [x0, y0, x1, y1] = [w, Number.POSITIVE_INFINITY, 0, 0];
      while (stack.length) {
        const i = stack.pop() as number;
        const [x, y] = [i % w, Math.floor(i / w)];
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        for (const j of [i - 1, i + 1, i - w, i + w])
          if (isAgent.has(j) && !seen.has(j) && Math.abs((j % w) - x) <= 1) {
            seen.add(j);
            stack.push(j);
          }
      }
      out.push([x1 - x0 + 1, y1 - y0 + 1]);
    }
    return out;
  };
  const pad = CLEAR_PX / 4;
  const nearFace = ([x, y]: [number, number]) => x >= 40 - pad && x < 60 + pad && y >= 20 - pad && y < 40 + pad;

  test(`none comes within ${CLEAR_PX} px of a face, standing or rising past it`, async () => {
    for (let run = 0; run < 12; run++) {
      const still = await faceSky(true);
      try {
        expect(agentPixels(still).length).toBeGreaterThan(0);
        expect(agentPixels(still).filter(nearFace)).toEqual([]);
      } finally {
        still.done();
      }
    }
    const moving = await faceSky(false);
    try {
      for (let i = 0; i < 90; i++) {
        moving.frames(32);
        expect(agentPixels(moving).filter(nearFace)).toEqual([]);
      }
    } finally {
      moving.done();
    }
  });

  test("standing ones never touch: each figure is one agent, before and after the sky grows", async () => {
    for (let run = 0; run < 12; run++) {
      // Crowded: some find no room to stand at first.
      const page = await faceSky(true, { clear: undefined });
      try {
        for (const [w, h] of figures(page)) expect([w <= 18, h <= 18]).toEqual([true, true]);
        // Taller: the new room fills with agents standing apart from those already there.
        page.resize(400, 400);
        page.frames(200);
        for (const [w, h] of figures(page)) expect([w <= 18, h <= 18]).toEqual([true, true]);
      } finally {
        page.done();
      }
    }
  });

  test("with reduced motion they stand still: the pointer moving, a redraw and a new size move nothing", async () => {
    const page = await faceSky(true);
    try {
      const before = agentPixels(page);
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 390, clientY: 10 }));
      redrawSkies();
      page.frames(200);
      expect(agentPixels(page)).toEqual(before);
      // A scrollbar arriving: those still wholly inside keep their places, and none is cut by the new edge.
      page.resize(384, 240);
      page.frames(200);
      const after = agentPixels(page);
      expect(after).toEqual(expect.arrayContaining(before.filter(([x]) => x < 96 - 18)));
      expect(after.length % WHOLE).toBe(0);
    } finally {
      page.done();
    }
  });

  test("with reduced motion a redraw brings no one: one that found no room waits for a new size", async () => {
    // At first the whole sky is taken: no room for anyone.
    const wall = document.createElement("span");
    wall.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 240, width: 400, height: 240 }) as DOMRect;
    let walled = true;
    const page = await faceSky(true, { clear: () => (walled ? [wall] : []) });
    try {
      expect(agentPixels(page)).toEqual([]);
      walled = false;
      redrawSkies();
      page.frames(200);
      expect(agentPixels(page)).toEqual([]);
      page.resize(396, 240);
      page.frames(200);
      expect(agentPixels(page).length).toBeGreaterThan(0);
    } finally {
      page.done();
    }
  });

  test("narrowed with reduced motion, those it leaves outside give way to new ones standing inside", async () => {
    for (let run = 0; run < 12; run++) {
      await new Promise((r) => setTimeout(r, 50));
      // A cover at 1440 px, then at a phone's width: two agents before, two whole ones after.
      const page = canvasPage({ width: 1168, height: 176, reduced: true });
      const stop = startSky(page.canvas, () => ({ ...opts, sprites: 2, near: 1 }));
      try {
        expect(agentPixels(page)).toHaveLength(2 * WHOLE);
        page.resize(392, 176);
        page.frames(200);
        expect(agentPixels(page)).toHaveLength(2 * WHOLE);
      } finally {
        stop();
        page.frames(100);
        page.close();
      }
    }
  });

  /** A seeded random, so a failure replays the same. */
  const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  test("placing: inside the sky, below its ceiling, clear of every box; fewer rather than on top of each other", () => {
    const rand = seeded(7);
    const boxes: CalmZone[] = [[40, 20, 60, 40]];
    for (let i = 0; i < 200; i++) {
      const at = placeSprite(rand, 100, 60, 1, 10, boxes, 3);
      if (!at) continue;
      expect(at[0] >= 0 && at[0] + 9 <= 100 && at[1] >= 10 && at[1] + 9 <= 60).toBe(true);
      expect(spriteNear(boxes, at[0], at[1], 1, 3)).toBe(false);
    }
    expect(placeSprite(rand, 100, 60, 1, 0, [[0, 0, 100, 60]], 3)).toBeNull();
  });

  test("rising: a column clear of the boxes on its way up; one above the ceiling is no obstacle", () => {
    const rand = seeded(11);
    for (let i = 0; i < 100; i++) {
      const x = riseColumn(rand, 100, 1, 20, [[30, 30, 70, 50]], 3);
      expect(x + 9 + 3 <= 30 || x - 3 >= 70).toBe(true);
    }
    // A form above the horizon's ceiling (the sign-in page) leaves every column open.
    const xs = Array.from({ length: 200 }, () => riseColumn(rand, 100, 1, 20, [[30, -40, 70, 10]], 3));
    expect(xs.some((x) => x > 30 && x < 70)).toBe(true);
  });
});
