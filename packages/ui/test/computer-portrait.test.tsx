import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { COMPUTER_KINDS, COMPUTER_STATES, ComputerIcon, ComputerPortrait, drawComputer } from "../src";
import { liveComputerCount } from "../src/computer/live";
import { COMPUTER_ART, COMPUTER_ROWS } from "../src/computer/portrait.js";

/** Records the cells drawn, by color. */
function fakeCtx() {
  const cells = new Map<string, string>();
  const ctx = {
    fillStyle: "" as unknown,
    fillRect(x: number, y: number) {
      cells.set(`${x},${y}`, String(ctx.fillStyle));
    },
    clearRect(x: number, y: number, w: number, h: number) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.delete(`${i},${j}`);
    },
  };
  return { ctx, cells };
}

describe("computer portraits", () => {
  test("every kind and state draws inside the 48×48 grid", () => {
    for (const kind of COMPUTER_KINDS)
      for (const state of COMPUTER_STATES) {
        const { ctx, cells } = fakeCtx();
        drawComputer(ctx, kind, state, { t: 1.2 });
        expect(cells.size).toBeGreaterThan(200);
        for (const key of cells.keys()) {
          const [x, y] = key.split(",").map(Number);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(48);
        }
      }
  });

  test("the screen shows the sky when on and goes dark when offline", () => {
    const sky = (state: "online" | "offline") => {
      const { ctx, cells } = fakeCtx();
      drawComputer(ctx, "mac", state);
      return [...cells.values()].some((c) => c === "#0063d1" || c === "#2f80e0");
    };
    expect(sky("online")).toBe(true);
    expect(sky("offline")).toBe(false);
  });

  test("each kind draws only inside its art's columns, in every state and frame, its shadow included", () => {
    for (const kind of COMPUTER_KINDS) {
      const [first, count] = COMPUTER_ART[kind];
      const xs = new Set<number>();
      for (const state of COMPUTER_STATES)
        for (const dark of [false, true])
          for (let t = 0; t < 8; t += 0.1) {
            const { ctx, cells } = fakeCtx();
            drawComputer(ctx, kind, state, { dark, t });
            for (const key of cells.keys()) xs.add(Number(key.split(",")[0]));
          }
      // Both edges are drawn: the box is no wider than the art.
      expect(Math.min(...xs)).toBe(first);
      expect(Math.max(...xs)).toBe(first + count - 1);
    }
  });

  test("each kind draws only inside its art's rows, in every state and frame: the box says where they start", () => {
    for (const kind of COMPUTER_KINDS) {
      const [first, count] = COMPUTER_ROWS[kind];
      const ys = new Set<number>();
      for (const state of COMPUTER_STATES)
        for (const dark of [false, true])
          for (let t = 0; t < 8; t += 0.1) {
            const { ctx, cells } = fakeCtx();
            drawComputer(ctx, kind, state, { dark, t });
            for (const key of cells.keys()) ys.add(Number(key.split(",")[1]));
          }
      expect(Math.min(...ys)).toBe(first);
      expect(Math.max(...ys)).toBe(first + count - 1);
    }
    const { container, unmount } = render(<ComputerPortrait kind="mac" state="online" size={96} />);
    // The Mac starts 6 cells down and ends 9 cells over the bottom (48 − 6 − 33): 12px and 18px at twice the grid.
    const box = container.querySelector("canvas") as HTMLElement;
    expect(box.style.getPropertyValue("--art-top")).toBe("12px");
    expect(box.style.getPropertyValue("--art-bottom")).toBe("18px");
    unmount();
  });

  test("the portrait is its art's columns by the 48-cell grid, scaled by whole numbers; decorative unless labeled", () => {
    const { container, unmount } = render(
      <div>
        <ComputerPortrait kind="mac" state="online" />
        <ComputerPortrait kind="windows" state="paused" size={96} label="Computador do escritório" />
        <ComputerPortrait kind="linux" state="online" size={96} />
        <ComputerIcon kind="windows" />
      </div>,
    );
    const [small, big, tower] = [...container.querySelectorAll("canvas.ac-computer")] as HTMLCanvasElement[];
    expect(small?.width).toBe(42);
    expect(small?.height).toBe(48);
    expect(small?.style.width).toBe("42px");
    expect(small?.style.height).toBe("48px");
    expect(small?.getAttribute("aria-hidden")).toBe("true");
    expect(small?.dataset.kind).toBe("mac");
    expect(big?.style.width).toBe("80px");
    expect(big?.style.height).toBe("96px");
    // The tower is narrow: its box no longer leaves half the grid empty around it.
    expect(tower?.width).toBe(25);
    expect(tower?.style.width).toBe("50px");
    expect(big?.dataset.state).toBe("paused");
    expect(big?.getAttribute("aria-label")).toBe("Computador do escritório");
    expect(container.querySelector("svg.ac-icon")).not.toBeNull();
    expect(liveComputerCount()).toBe(3);
    unmount();
    expect(liveComputerCount()).toBe(0);
  });
});
