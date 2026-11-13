import { expect, spyOn, test } from "bun:test";
import { canvasPage, setupDom } from "@agenteschat/ui/testing";

setupDom();

import { agentTones, EYE, pixelOf, SKY_TONES, softTones, spriteTone } from "@agenteschat/ui";
import { act, render } from "@testing-library/react";
import { ComputerSky } from "../src/components/Sky";

const W = 320;
const H = 200;

/** The colors the computer's sky draws (a still frame) on a window whose surface, `--raised`, is `surface`. */
async function colorsOn(surface: string) {
  const page = canvasPage({ width: W, height: H, reduced: true });
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
  // The theme's tokens, as the sky reads them from its canvas.
  const style = spyOn(globalThis, "getComputedStyle").mockImplementation(
    () => ({ getPropertyValue: (name: string) => (name === "--raised" ? surface : "") }) as CSSStyleDeclaration,
  );
  const view = render(<ComputerSky color="sky" />);
  await act(async () => {});
  page.frames(100);
  view.unmount();
  page.close();
  context.mockRestore();
  rect.mockRestore();
  style.mockRestore();
  const image = shown as ImageData | null;
  return new Set(image ? new Uint32Array(image.data.buffer.slice(0)) : []);
}

const subset = (drawn: Set<number>, tones: readonly string[]) => {
  const allowed = new Set([...tones, spriteTone("sky"), EYE].map(pixelOf));
  return [...drawn].every((p) => allowed.has(p));
};

test("the computer's sky: the agent's day sky in a light window, the dark window's own surface rising into it", async () => {
  const light = await colorsOn("#ffffff");
  expect(light.size).toBeGreaterThan(3);
  expect(subset(light, agentTones("sky"))).toBe(true);

  const dark = await colorsOn("#1c1c1b");
  expect(dark.size).toBeGreaterThan(3);
  expect(subset(dark, softTones("sky", "#1c1c1b"))).toBe(true);
  // None of the day sky's own tones: neither its deep blues nor its near whites.
  expect(SKY_TONES.some((tone) => dark.has(pixelOf(tone)))).toBe(false);
});
