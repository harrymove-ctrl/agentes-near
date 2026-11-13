import { describe, expect, spyOn, test } from "bun:test";
import { canvasPage, setupDom } from "@agenteschat/ui/testing";

setupDom();

import { act, render } from "@testing-library/react";
import { OnboardingProgress } from "../src/components/Sky";

const W = 240;
const H = 27;

/**
 * The setup's progress bar on a page whose frames run by hand (`canvasPage`), laid out W×H, its canvas drawn into
 * memory: `fill` is how far the sky reaches along the bar's middle row, 0..1 (the pixel agent at its front adds a
 * little).
 */
async function progressBar(progress: number, reduced: boolean) {
  const page = canvasPage({ width: W, height: H, reduced });
  let shown: ImageData | null = null;
  const context = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (image: ImageData) => {
      shown = image;
    },
  })) as unknown as HTMLCanvasElement["getContext"]);
  const rect = spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ x: 0, y: 0, left: 0, top: 0, right: W, bottom: H, width: W, height: H }) as DOMRect,
  );
  const view = render(<OnboardingProgress progress={progress} />);
  await act(async () => {});
  return {
    ...page,
    fill() {
      if (!shown) return 0;
      const { data, width, height } = shown;
      const row = Math.floor(height / 2) * width;
      let sky = 0;
      // The empty strip is grey; the sky (and the agent's dark blue body) is far bluer than red.
      for (let x = 0; x < width; x++) if ((data[(row + x) * 4 + 2] ?? 0) - (data[(row + x) * 4] ?? 0) > 50) sky++;
      return sky / width;
    },
    async step(next: number) {
      await act(async () => view.rerender(<OnboardingProgress progress={next} />));
    },
    async motion(on: boolean) {
      await act(async () => page.motion(on));
    },
    close() {
      view.unmount();
      page.frames(100);
      page.close();
      context.mockRestore();
      rect.mockRestore();
    },
  };
}

describe("the setup's progress bar", () => {
  test("reduced motion turned off with the page open (a browser's emulated media switched): the next steps still fill it", async () => {
    const bar = await progressBar(4 / 6, true);
    try {
      bar.frames(500);
      expect(bar.fill()).toBeCloseTo(4 / 6, 1);
      await bar.motion(false);
      await bar.step(5 / 6);
      bar.frames(2000);
      expect(bar.fill()).toBeGreaterThan(0.8);
      await bar.step(1);
      bar.frames(2000);
      expect(bar.fill()).toBeGreaterThan(0.95);
    } finally {
      bar.close();
    }
  });

  test("reduced motion turned on while it fills: it lands on the step at once and stays still", async () => {
    const bar = await progressBar(4 / 6, false);
    try {
      bar.frames(500);
      await bar.step(5 / 6);
      bar.frames(50);
      expect(bar.fill()).toBeLessThan(0.8);
      await bar.motion(true);
      bar.frames(100);
      expect(bar.fill()).toBeGreaterThan(0.8);
      expect(bar.pending()).toBe(0);
    } finally {
      bar.close();
    }
  });
});
