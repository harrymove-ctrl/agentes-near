import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { ImageZoom } from "@/components/artifacts/ImageZoom";
import { createI18n } from "@/i18n";

const STAGE = { w: 1200, h: 700 };
/**
 * Patched where happy-dom defines them (getBoundingClientRect on Element, clientWidth/Height on HTMLElement) and put
 * back as they were: a copy left on HTMLElement.prototype, or a deleted getter, breaks later test files' layout.
 */
const realRect = Element.prototype.getBoundingClientRect;
const realSize = ["clientWidth", "clientHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);
// On happy-dom's window itself: `setupDom`'s afterAll may detach the global `window` before this file's runs.
const realMatch = domWindow().matchMedia;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    // Mid open animation (the dialog scales in from 0.97): the fit must come from the layout size, not this one.
    const [w, h] = [STAGE.w * 0.97, STAGE.h * 0.97];
    const r = { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    return { ...r, toJSON: () => r } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => STAGE.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => STAGE.h });
  // A mouse (the hover lens is offered), or a finger when `touch` is set.
  domWindow().matchMedia = ((query: string) => ({
    matches: !touch && query.includes("hover: hover"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof realMatch;
});
let touch = false;
afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect;
  for (const [k, d] of realSize) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
  domWindow().matchMedia = realMatch;
});
afterEach(() => {
  cleanup();
  touch = false;
  try {
    localStorage.clear();
  } catch {}
});

/** A 3600×600 banner (fits at a third of its size, centered 250 px down) in a 1200×700 stage. */
const show = async (w = 3600, h = 600, onSwipe?: (dir: 1 | -1) => void) => {
  const r = render(
    <I18nextProvider i18n={createI18n("pt-BR")}>
      <ImageZoom src="blob:picture" alt="Imagem: banner.png" onSwipe={onSwipe} />
    </I18nextProvider>,
  );
  const img = r.container.querySelector<HTMLImageElement>(".izoom__img");
  if (!img) throw new Error("no picture");
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  await act(async () => fireEvent.load(img));
  const stage = r.getByRole("group", { name: "Imagem: banner.png" });
  const bar = within(r.getByRole("toolbar", { name: "Zoom" }));
  return { ...r, img, stage, bar };
};
const scaleOf = (img: HTMLImageElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]);
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

describe("the picture viewer's zoom", () => {
  test("fitted to the stage, centered, with − and Ajustar off until zoomed", async () => {
    const { img, bar } = await show();
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    expect(img.style.transform).toContain("translate(0px, 250px)");
    expect(bar.getByRole("button", { name: "Reduzir" }).hasAttribute("disabled")).toBe(true);
    expect(bar.getByRole("button", { name: "Ajustar" }).hasAttribute("disabled")).toBe(true);
    expect(bar.getByText("33%")).toBeTruthy();
  });

  test("a click zooms to the real size at the pointer, a second one fits it back", async () => {
    const { img, stage, getByText } = await show();
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    // The banner's middle stays under the pointer.
    expect(img.style.transform).toContain("translate(-1200px, 50px)");
    expect(getByText("Arraste para mover. Esc volta a ajustar")).toBeTruthy();
    // The second click of a double-click keeps the zoom.
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    await Bun.sleep(450);
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    });
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
  });

  test("a drag moves the zoomed picture, never past its edge", async () => {
    const { img, stage, bar } = await show();
    await act(async () => fireEvent.click(bar.getByRole("button", { name: "Tamanho real" })));
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 5600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 5600, clientY: 350 });
    });
    expect(scaleOf(img)).toBe(1);
    expect(img.style.transform).toContain("translate(0px, 50px)");
  });

  test("keys: + and − step, 1 is the real size, Esc fits first and only then lets the dialog close", async () => {
    const { img, stage } = await show();
    key(stage, "+");
    expect(scaleOf(img)).toBe(0.5);
    key(stage, "1");
    expect(scaleOf(img)).toBe(1);
    key(stage, "-");
    expect(scaleOf(img)).toBe(0.75);
    expect(key(stage, "Escape").defaultPrevented).toBe(true);
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    expect(key(stage, "Escape").defaultPrevented).toBe(false);
  });

  test("a mouse wheel and a trackpad pinch zoom around the cursor; two fingers move only a zoomed picture", async () => {
    const { img, stage } = await show();
    const wheel = (init: WheelEventInit) => {
      const e = new WheelEvent("wheel", { cancelable: true, ...init });
      // happy-dom's WheelEvent leaves out the mouse position and the modifier keys.
      Object.defineProperties(e, {
        clientX: { value: 0 },
        clientY: { value: 350 },
        ctrlKey: { value: Boolean(init.ctrlKey) },
      });
      act(() => {
        stage.dispatchEvent(e);
      });
      return e;
    };
    // A two-finger scroll on the fitted picture does nothing and leaves the event to the page.
    expect(wheel({ deltaY: 12.5, deltaX: 3 }).defaultPrevented).toBe(false);
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    wheel({ deltaY: -400 });
    expect(scaleOf(img)).toBeGreaterThan(0.6);
    expect(img.style.transform).toContain("translate(0px,");
    const zoomed = scaleOf(img);
    wheel({ deltaY: -20, ctrlKey: true });
    expect(scaleOf(img)).toBeGreaterThan(zoomed);
    const before = img.style.transform;
    expect(wheel({ deltaY: 0, deltaX: 40.5 }).defaultPrevented).toBe(true);
    expect(img.style.transform).not.toBe(before);
    expect(img.style.transform).toContain("translate(-40.5px,");
  });

  test("a Safari trackpad pinch (gesture events) zooms the picture, not the page", async () => {
    const { img, stage } = await show();
    const gesture = (type: string, scale: number) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { scale, clientX: 600, clientY: 350 });
      act(() => {
        stage.dispatchEvent(e);
      });
      return e;
    };
    expect(gesture("gesturestart", 1).defaultPrevented).toBe(true);
    gesture("gesturechange", 1.5);
    expect(scaleOf(img)).toBeCloseTo(0.5);
    gesture("gesturechange", 3);
    expect(scaleOf(img)).toBeCloseTo(1);
  });

  test("on a touch screen the hints say tap and pinch", async () => {
    touch = true;
    const { stage, getByText } = await show();
    expect(getByText("Toque ou faça pinça para ampliar")).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
      fireEvent.pointerUp(stage, { pointerId: 1, button: 0, clientX: 600, clientY: 350 });
    });
    expect(getByText("Arraste para mover. Toque para voltar a ajustar")).toBeTruthy();
  });

  test("the hover lens shows a magnified pane, and can be switched off", async () => {
    const { container, stage, bar } = await show(800, 2800);
    await act(async () =>
      fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "mouse", clientX: 600, clientY: 300 }),
    );
    expect(container.querySelector(".izoom__lens")).toBeTruthy();
    expect(container.querySelector(".izoom__pane img")).toBeTruthy();
    const lens = bar.getByRole("button", { name: "Lupa" });
    expect(lens.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(lens));
    expect(lens.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".izoom__lens")).toBeNull();
    expect(localStorage.getItem("agentes.image.lens")).toBe("0");
  });

  test("a finger drags a fitted picture sideways: far enough asks for the next or previous one, short springs back", async () => {
    touch = true;
    const swipes: number[] = [];
    const { img, stage } = await show(3600, 600, (dir) => swipes.push(dir));
    const finger = async (from: number, to: number, pointerType = "touch") => {
      await act(async () => {
        fireEvent.pointerDown(stage, { pointerId: 1, button: 0, pointerType, clientX: from, clientY: 350 });
      });
      await act(async () => {
        fireEvent.pointerMove(stage, { pointerId: 1, pointerType, clientX: (from + to) / 2, clientY: 350 });
      });
      const midway = img.style.transform;
      await act(async () => {
        fireEvent.pointerUp(stage, { pointerId: 1, button: 0, pointerType, clientX: to, clientY: 350 });
      });
      return midway;
    };
    // The picture follows the finger, then goes back to its place.
    expect(await finger(600, 400)).toContain("translate(-100px, 250px)");
    expect(img.style.transform).toContain("translate(0px, 250px)");
    expect(swipes).toEqual([1]);
    await finger(600, 800);
    expect(swipes).toEqual([1, -1]);
    await finger(600, 570);
    expect(swipes).toEqual([1, -1]);
    // A mouse drag on a fitted picture still does nothing.
    await finger(600, 200, "mouse");
    expect(swipes).toEqual([1, -1]);
    expect(scaleOf(img)).toBeCloseTo(1 / 3);
    // Zoomed, the finger moves around the picture instead.
    key(stage, "1");
    await finger(600, 300);
    expect(swipes).toEqual([1, -1]);
    expect(scaleOf(img)).toBe(1);
  });

  test("a second finger makes the swipe a pinch: the picture lets go of the pull, and the pinch never moves on", async () => {
    touch = true;
    const swipes: number[] = [];
    const { img, stage } = await show(3600, 600, (dir) => swipes.push(dir));
    const at = (type: "pointerDown" | "pointerMove" | "pointerUp", pointerId: number, x: number) =>
      act(async () => {
        fireEvent[type](stage, { pointerId, button: 0, pointerType: "touch", clientX: x, clientY: 350 });
      });
    // A finger pulls the picture sideways, then a second one lands: back in its place for the pinch.
    await at("pointerDown", 1, 600);
    await at("pointerMove", 1, 500);
    expect(img.style.transform).toContain("translate(-100px, 250px)");
    await at("pointerDown", 2, 800);
    expect(img.style.transform).toContain("translate(0px, 250px)");
    // Spread to zoom in, then both lift: fitted again, it sits where it should (no pull left over).
    await at("pointerMove", 2, 950);
    expect(scaleOf(img)).toBeGreaterThan(1 / 3);
    await at("pointerUp", 1, 500);
    await at("pointerUp", 2, 950);
    key(stage, "0");
    expect(img.style.transform).toContain("translate(0px, 250px)");
    // A pinch that stays fitted: the finger left on the glass dragging sideways is still the pinch, not a swipe.
    await at("pointerDown", 1, 600);
    await at("pointerDown", 2, 800);
    await at("pointerUp", 1, 600);
    await at("pointerMove", 2, 650);
    await at("pointerUp", 2, 650);
    expect(swipes).toEqual([]);
    expect(img.style.transform).toContain("translate(0px, 250px)");
  });

  test("without its bytes yet, the stage waits with its status", async () => {
    const r = render(
      <I18nextProvider i18n={createI18n("pt-BR")}>
        <ImageZoom src={null} alt="Imagem: x.png" />
      </I18nextProvider>,
    );
    expect(r.container.querySelector(".izoom__img")).toBeNull();
    expect(r.getByRole("status").textContent).toContain("Carregando");
    expect(r.getByRole("group", { name: "Imagem: x.png" })).toBeTruthy();
  });

  test("a picture the browser can't draw says so instead of an empty stage", async () => {
    const r = render(
      <I18nextProvider i18n={createI18n("pt-BR")}>
        <ImageZoom src="blob:broken" alt="Imagem: x.png" />
      </I18nextProvider>,
    );
    expect(r.getByRole("status").textContent).toContain("Carregando");
    const img = r.container.querySelector<HTMLImageElement>(".izoom__img");
    if (!img) throw new Error("no picture");
    await act(async () => fireEvent.error(img));
    expect(r.getByRole("status").textContent).toContain("Não deu para mostrar a prévia");
  });
});
