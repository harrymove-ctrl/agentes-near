import { describe, expect, test } from "bun:test";
import {
  createFakeJudge,
  formatPlanReport,
  type JudgeBox,
  locateOnImage,
  runPlan,
  type ScreenImage,
  type ScreenRegion,
} from "../src";
import { acted, closeUpOf, fakeScreen, screenImage, THUNAR, ticking } from "./screen-fixtures";

const ids = { orgId: "o", agentId: "a", runId: "r" };

type Answer = { box: JudgeBox; present: number };

const where = (call: { questions: Record<string, unknown> } | undefined) =>
  (call?.questions.where as { instructions?: string } | undefined)?.instructions ?? "";

/** Jev's Box: `full` on the whole screen, `close` on a close-up (the question says which). */
function boxes(full: Answer, close?: Answer, costly = 0) {
  return createFakeJudge((kind, id, _state, _q, request) => {
    if (kind !== "screen_locate") return undefined;
    if (id === "costly") return costly;
    const a = where(request).includes("is a close-up") ? close : full;
    if (!a) return undefined;
    return id === "present" ? a.present : { box: a.box, confidence: 0.8 };
  });
}

/** The size and format of the image a judge was shown. */
const shown = (call: { images?: Record<string, { data: string }> } | undefined) =>
  new Bun.Image(Buffer.from(Object.values(call?.images ?? {})[0]?.data ?? "", "base64")).metadata();

/** A close-up taker that records the regions asked for. */
function zoomer(make: (region: ScreenRegion) => ScreenImage | null = closeUpOf) {
  const asked: ScreenRegion[] = [];
  return {
    asked,
    zoom: async (region: ScreenRegion) => {
      asked.push(region);
      return make(region);
    },
  };
}

/** A menu item's size on a 1280×800 screen, and where it sits once looked at up close. */
const SMALL: Answer = { box: { top: 0.1, bottom: 0.13, left: 0.2, right: 0.25 }, present: 0.9 };
const UP_CLOSE: Answer = { box: { top: 0.4, bottom: 0.5, left: 0.5, right: 0.6 }, present: 0.85 };

describe("a target on the screen image", () => {
  test("a small box is looked at again on an enlarged close-up around it, and the close-up's point is taken", async () => {
    const judge = boxes(SMALL, UP_CLOSE);
    const z = zoomer();
    const base = { ...ids, target: "Settings in the menu", kind: "desktop" as const, zoom: z.zoom };
    const spot = await locateOnImage({ ...base, judge, image: screenImage() });
    // The first box's center (288, 92): 240×150 around it, moved down to stay on the screen.
    expect(z.asked).toEqual([{ x: 168, y: 17, width: 240, height: 150 }]);
    // Jev sees it twice as large; its box maps back onto those 240×150 screen pixels.
    expect(await shown(judge.calls[1])).toEqual({ width: 480, height: 300, format: "jpeg" });
    expect(spot).toEqual({ found: true, x: 300, y: 85, ref: null, confidence: 0.85 });
    expect(judge.calls).toHaveLength(2);
    expect(where(judge.calls[0])).toStartWith("In `screenshot` (a computer's desktop: windows, menus, a panel)");
    expect(where(judge.calls[1])).toStartWith("`screenshot` is a close-up of part of a computer's desktop.");
    // The point lands on the element marked there.
    const marked = await locateOnImage({
      ...base,
      judge,
      image: screenImage([{ ref: "e7", number: 7, role: "menuitem", box: { x: 250, y: 75, width: 120, height: 24 } }]),
    });
    expect(marked).toMatchObject({ found: true, ref: "e7" });
  });

  test("a close-up shows three times a taller box's height, and Jev sees it at 480×300", async () => {
    // A folder's first box on its icon, 77×88 on the screen.
    const folder: Answer = { box: { top: 0.29, bottom: 0.4, left: 0.7, right: 0.76 }, present: 0.9 };
    const judge = boxes(folder, UP_CLOSE);
    const z = zoomer();
    const spot = await locateOnImage({ judge, ...ids, target: "x", image: screenImage(), zoom: z.zoom });
    expect(z.asked).toEqual([{ x: 723, y: 144, width: 422, height: 264 }]);
    expect(await shown(judge.calls[1])).toEqual({ width: 480, height: 300, format: "jpeg" });
    expect(spot).toEqual({ found: true, x: 955, y: 263, ref: null, confidence: 0.85 });
  });

  test("a target boxed whole up close is taken, up to the largest first box that gets a close-up", async () => {
    for (const screen of [
      { width: 1280, height: 800 },
      { width: 1280, height: 900 },
    ]) {
      // [width, height] of the first box: a glyph, a folder's icon, the largest, a menu row.
      for (const [w, h] of [
        [0.02, 0.02],
        [0.06, 0.08],
        [0.14, 0.14],
        [0.14, 0.03],
      ] as const) {
        const first: JudgeBox = { top: 0.4, bottom: 0.4 + h, left: 0.5, right: 0.5 + w };
        const at = { x: (0.5 + w / 2) * screen.width, y: (0.4 + h / 2) * screen.height };
        const z = zoomer();
        // Up close, the whole target: 1.4 times as tall and 1.15 times as wide as at first (an icon with its name).
        const judge = createFakeJudge((kind, id, _state, _q, request) => {
          if (kind !== "screen_locate") return undefined;
          if (id === "present") return 0.9;
          const r = z.asked[0];
          if (!r || !where(request).includes("is a close-up")) return { box: first, confidence: 0.8 };
          const [halfW, halfH] = [(1.15 * w * screen.width) / 2, (1.4 * h * screen.height) / 2];
          const box = {
            left: (at.x - halfW - r.x) / r.width,
            right: (at.x + halfW - r.x) / r.width,
            top: (at.y - halfH - r.y) / r.height,
            bottom: (at.y + halfH - r.y) / r.height,
          };
          return { box, confidence: 0.8 };
        });
        const image = { ...screenImage(), width: screen.width, height: screen.height, viewport: screen };
        const spot = await locateOnImage({ judge, ...ids, target: "x", kind: "desktop", image, zoom: z.zoom });
        expect(spot).toMatchObject({ found: true });
        if (!spot.found) continue;
        expect(Math.abs(spot.x - at.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(spot.y - at.y)).toBeLessThanOrEqual(1);
        expect(judge.calls).toHaveLength(2);
      }
    }
  });

  test("the close-up stays inside the screen at its edge", async () => {
    const corner: Answer = { box: { top: 0.985, bottom: 0.99, left: 0.98, right: 0.99 }, present: 0.9 };
    const z = zoomer();
    await locateOnImage({ judge: boxes(corner, UP_CLOSE), ...ids, target: "x", image: screenImage(), zoom: z.zoom });
    expect(z.asked).toEqual([{ x: 1040, y: 650, width: 240, height: 150 }]);
  });

  test("a large box needs no close-up", async () => {
    const judge = boxes({ box: { top: 0.1, bottom: 0.3, left: 0.1, right: 0.4 }, present: 0.9 });
    const z = zoomer();
    const spot = await locateOnImage({ judge, ...ids, target: "the address bar", image: screenImage(), zoom: z.zoom });
    expect(spot).toMatchObject({ found: true, x: 320, y: 160 });
    expect(z.asked).toHaveLength(0);
    expect(judge.calls).toHaveLength(1);
  });

  test("a box that isn't one control is not found, on the browser's page too", async () => {
    const shapes: JudgeBox[] = [
      // Most of the screen's height, a sliver wide.
      { top: 0, bottom: 0.9, left: 0.1, right: 0.15 },
      // Most of its width, a sliver tall.
      { top: 0.1, bottom: 0.15, left: 0.05, right: 0.95 },
      { top: 0.2, bottom: 0.1, left: 0.1, right: 0.2 },
    ];
    for (const box of shapes) {
      for (const kind of ["browser", "desktop"] as const) {
        const spot = await locateOnImage({
          judge: boxes({ box, present: 0.9 }),
          ...ids,
          target: "x",
          kind,
          image: screenImage(),
        });
        expect(spot).toEqual({ found: false, reason: "no clear element there" });
      }
    }
  });

  test("a close-up that doesn't show it, or shows no one control, finds nothing", async () => {
    for (const close of [
      { ...UP_CLOSE, present: 0.3 },
      { box: { top: 0.05, bottom: 0.95, left: 0.4, right: 0.5 }, present: 0.9 },
    ]) {
      const spot = await locateOnImage({
        judge: boxes(SMALL, close),
        ...ids,
        target: "x",
        image: screenImage(),
        zoom: zoomer().zoom,
      });
      expect(spot).toEqual({ found: false, reason: "not clear on a close-up" });
    }
  });

  test("a close-up that can't be taken leaves the first answer", async () => {
    const first = { found: true as const, x: 288, y: 92, ref: null, confidence: 0.9 };
    const none = boxes(SMALL, UP_CLOSE);
    expect(
      await locateOnImage({ judge: none, ...ids, target: "x", image: screenImage(), zoom: zoomer(() => null).zoom }),
    ).toEqual(first);
    // An image that doesn't say where it sits can't be mapped back, and one that can't be enlarged
    // isn't one: neither is asked about.
    for (const make of [
      (r: ScreenRegion) => ({ ...closeUpOf(r), origin: undefined }),
      (r: ScreenRegion) => ({ ...closeUpOf(r), data: "bm90IGFuIGltYWdl" }),
    ]) {
      const judge = boxes(SMALL, UP_CLOSE);
      expect(
        await locateOnImage({ judge, ...ids, target: "x", image: screenImage(), zoom: zoomer(make).zoom }),
      ).toEqual(first);
      expect(judge.calls).toHaveLength(1);
    }
  });

  test("a target the judge finds can't be undone is never taken at a bare point, on any screen, in any language", async () => {
    const big: Answer = { box: { top: 0.4, bottom: 0.5, left: 0.4, right: 0.6 }, present: 0.95 };
    for (const kind of ["browser", "desktop"] as const) {
      for (const target of ["o botão Excluir", "the Delete button", "削除ボタン", "die Löschen-Taste"]) {
        const judge = boxes(big, undefined, 0.95);
        expect(await locateOnImage({ judge, ...ids, target, kind, image: screenImage() })).toMatchObject({
          found: false,
          refused: true,
        });
        expect(judge.calls[0]?.questions.costly).toMatchObject({ type: "noul" });
        expect(await locateOnImage({ judge: boxes(big), ...ids, target, kind, image: screenImage() })).toMatchObject({
          found: true,
        });
      }
    }
    // On an element found there, it is as exact as its number.
    const onMark = await locateOnImage({
      judge: boxes(big, undefined, 0.95),
      ...ids,
      target: "the Delete button",
      image: screenImage([{ ref: "e9", number: 9, role: "button", box: { x: 600, y: 350, width: 80, height: 100 } }]),
    });
    expect(onMark).toMatchObject({ found: true, ref: "e9" });
  });
});

describe("plans with images", () => {
  test("a surface that takes close-ups gets the zoom; one that can't (the browser) never asks for a region", async () => {
    const judge = boxes(SMALL, UP_CLOSE);
    const zooming = fakeScreen(THUNAR, { capture: (r) => (r ? closeUpOf(r) : screenImage()), regions: true });
    const report = await runPlan({ judge, ...ids, surface: zooming, scope: "a", vision: true }, [
      { do: "click", target: "the gear icon" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(zooming.captures).toEqual([undefined, { x: 168, y: 17, width: 240, height: 150 }]);
    expect(acted(zooming.actions)).toEqual([{ kind: "click", at: { x: 300, y: 85 } }]);
    expect(report.steps[0]?.via).toBe("image");

    const flat = boxes(SMALL, UP_CLOSE);
    const plain = fakeScreen(THUNAR, { kind: "browser", url: "https://app.example/", capture: () => screenImage() });
    await runPlan({ judge: flat, ...ids, surface: plain, scope: "a", vision: true }, [
      { do: "click", target: "the gear icon" },
    ]);
    expect(plain.captures).toEqual([undefined]);
    expect(flat.calls.filter((c) => c.kind === "screen_locate")).toHaveLength(1);
    expect(acted(plain.actions)).toEqual([{ kind: "click", at: { x: 288, y: 92 } }]);
  });

  test("a costly target only on the image stops the plan and says why; nothing is clicked", async () => {
    const judge = boxes({ box: { top: 0.4, bottom: 0.5, left: 0.4, right: 0.6 }, present: 0.95 }, undefined, 0.95);
    const surface = fakeScreen(THUNAR, { capture: () => screenImage() });
    const report = await runPlan({ judge, ...ids, surface, scope: "a", vision: true }, [
      { do: "click", target: "Move to Trash" },
    ]);
    expect(report.stopped?.reason).toStartWith(
      "found \"Move to Trash\" only on the screen image, not as an element: something that can't be undone isn't done at a bare spot",
    );
    expect(acted(surface.actions)).toHaveLength(0);
  });

  test("an expectation the text leaves unsure is judged once more with an image", async () => {
    const judge = createFakeJudge((kind, _id, _state, _q, request) =>
      kind === "screen_check" ? (request.images ? 0.9 : 0.5) : undefined,
    );
    const surface = fakeScreen(THUNAR, { capture: () => screenImage() });
    const report = await runPlan({ judge, ...ids, surface, scope: "a", vision: true, now: ticking() }, [
      { do: "click", target: "Back", expect: "the home folder shows" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(report.steps[0]?.expected).toEqual({ met: true, p: 0.9 });
    const checks = judge.calls.filter((c) => c.kind === "screen_check");
    expect(checks.filter((c) => c.images)).toHaveLength(1);
    expect(checks.at(-1)?.images).toBeDefined();
    expect(formatPlanReport(report).summary).toBe('Clicked button (e25) (✓ "the home folder shows").');

    // Without vision it stays unsure, and the plan says it couldn't confirm it.
    const blind = createFakeJudge((kind) => (kind === "screen_check" ? 0.5 : undefined));
    const unsure = await runPlan({ judge: blind, ...ids, surface, scope: "a", now: ticking() }, [
      { do: "click", target: "Back", expect: "the home folder shows" },
    ]);
    expect(unsure.stopped?.reason).toBe('couldn\'t confirm "the home folder shows" on the screen');
    expect(blind.calls.some((c) => c.images)).toBe(false);

    // A clear no on the text isn't asked again.
    const no = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
    await runPlan({ judge: no, ...ids, surface, scope: "a", vision: true, now: ticking() }, [
      { do: "click", target: "Back", expect: "the home folder shows" },
    ]);
    expect(no.calls.some((c) => c.images)).toBe(false);
  });

  test("a wait the text leaves unsure ends when the image shows it", async () => {
    const judge = createFakeJudge((kind, _id, _state, _q, request) =>
      kind === "screen_check" ? (request.images ? 0.9 : 0.5) : undefined,
    );
    const surface = fakeScreen(THUNAR, { capture: () => screenImage() });
    const report = await runPlan({ judge, ...ids, surface, scope: "a", vision: true, now: ticking() }, [
      { do: "wait", until: "the copy finished", seconds: 10 },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(report.steps[0]?.note).toBe('"the copy finished" is true');
    expect(judge.calls.map((c) => Boolean(c.images))).toEqual([false, true]);
  });
});
