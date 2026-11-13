import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import type { CSSProperties } from "react";
import { SkyStrip } from "../src";
import { AGENT_GRADIENTS, mixHex } from "../src/agent/engine.js";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("the agent's sky strip", () => {
  test("drawn again in the dark theme's tones as the page turns dark, on its holder's own ground", async () => {
    const fills: string[] = [];
    const context = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
      set fillStyle(color: string) {
        fills.push(color);
      },
      fillRect() {},
    })) as unknown as HTMLCanvasElement["getContext"]);
    // Inside a raised container (a dialog) the strip's own --raised is a step up; its holder's is its ground.
    const style = document.createElement("style");
    style.textContent = ".ac-sky-strip { --raised: #242423; }";
    document.head.append(style);
    try {
      document.documentElement.dataset.theme = "light";
      render(
        <div style={{ "--raised": "#1c1c1b" } as CSSProperties}>
          <SkyStrip color="sky" moving={false} />
        </div>,
      );
      await act(async () => {});
      const light = new Set(fills.splice(0));
      expect(light.size).toBeGreaterThan(1);
      // Still, nothing redraws it but the theme.
      await act(async () => {
        document.documentElement.dataset.theme = "dark";
      });
      const dark = new Set(fills.splice(0));
      const [, bottom] = AGENT_GRADIENTS.sky;
      expect(dark.has(mixHex("#1c1c1b", bottom, 0.45))).toBe(true);
      expect(light.has(mixHex("#1c1c1b", bottom, 0.45))).toBe(false);
      expect(dark.has("#1c1c1b")).toBe(true);
      expect(dark.has("#242423")).toBe(false);
    } finally {
      style.remove();
      context.mockRestore();
    }
  });
});
