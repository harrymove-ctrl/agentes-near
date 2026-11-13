import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { BRAIN_KINDS, BRAIN_STATES, BrainIcon, BrainPortrait, bodyTones, drawBrain, OptionList } from "../src";
import { liveBrainCount } from "../src/brain/live";

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
const colors = (draw: (ctx: ReturnType<typeof fakeCtx>["ctx"]) => void) => {
  const { ctx, cells } = fakeCtx();
  draw(ctx);
  return new Set(cells.values());
};

describe("engine portraits", () => {
  test("every kind and state draws inside the 48×48 grid", () => {
    for (const kind of BRAIN_KINDS)
      for (const state of BRAIN_STATES) {
        const { ctx, cells } = fakeCtx();
        drawBrain(ctx, kind, state, { t: 1.2 });
        expect(cells.size).toBeGreaterThan(150);
        for (const key of cells.keys()) {
          const [x, y] = key.split(",").map(Number);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(48);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(48);
        }
      }
  });

  test("the small agent wears the agent's own color and accessory; the default is sky", () => {
    const rose = bodyTones("rose");
    const sky = bodyTones("sky");
    const own = colors((ctx) =>
      drawBrain(ctx, "claude_code", "idle", { agentLook: { color: "rose", accessory: "crown" } }),
    );
    expect(rose.some((c) => own.has(c))).toBe(true);
    expect(own.has("#f2c14e")).toBe(true); // the crown's gold
    const plain = colors((ctx) => drawBrain(ctx, "codex", "idle"));
    expect(sky.some((c) => plain.has(c))).toBe(true);
    expect(rose.some((c) => plain.has(c))).toBe(false);
  });

  test("Codex's screen shows the code when on and goes dark when off; the agent's bubble only while awake", () => {
    expect(colors((ctx) => drawBrain(ctx, "codex", "idle")).has("#6fd6bf")).toBe(true);
    expect(colors((ctx) => drawBrain(ctx, "codex", "off")).has("#6fd6bf")).toBe(false);
    expect(colors((ctx) => drawBrain(ctx, "agent", "idle")).has("#c4c4be")).toBe(true);
    expect(colors((ctx) => drawBrain(ctx, "agent", "off")).has("#c4c4be")).toBe(false);
  });

  test("the portrait is a 48-cell canvas scaled by whole numbers; decorative unless labeled; off is gray", () => {
    const { container, unmount } = render(
      <div>
        <BrainPortrait kind="claude_code" />
        <BrainPortrait kind="codex" state="off" size={96} label="Codex" agent={{ color: "teal" }} />
        <BrainIcon kind="agent" state="working" />
      </div>,
    );
    const [small, big] = [...container.querySelectorAll("canvas.ac-brain")] as HTMLCanvasElement[];
    expect(small?.width).toBe(48);
    expect(small?.style.width).toBe("48px");
    expect(small?.getAttribute("aria-hidden")).toBe("true");
    expect(small?.dataset.kind).toBe("claude_code");
    expect(small?.dataset.state).toBe("idle");
    expect(big?.style.width).toBe("96px");
    expect(big?.classList.contains("ac-brain--off")).toBe(true);
    expect(big?.getAttribute("aria-label")).toBe("Codex");
    const icon = container.querySelector("svg.ac-icon.ac-brain-icon");
    expect(icon?.classList.contains("ac-brain-icon--working")).toBe(true);
    expect(icon?.querySelectorAll(".ac-brain-eye")).toHaveLength(2);
    expect(liveBrainCount()).toBe(2);
    unmount();
    expect(liveBrainCount()).toBe(0);
  });

  test("option cards: illustration on top, a foot, and the chosen one's settings under all the cards", () => {
    const { container } = render(
      <OptionList
        aria-label="Motor"
        layout="cards"
        value="agent"
        onValueChange={() => {}}
        options={[
          { value: "agent", title: "Agente", leading: <BrainPortrait kind="agent" />, foot: "Pela API", children: "x" },
          { value: "codex", title: "Codex", leading: <BrainPortrait kind="codex" />, foot: "MacBook" },
        ]}
      />,
    );
    const grid = container.querySelector(".ac-optlist--cards .ac-optlist__cards") as HTMLElement;
    expect(grid.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect([...grid.querySelectorAll(".ac-optrow__foot")].map((f) => f.textContent)).toEqual(["Pela API", "MacBook"]);
    expect(grid.querySelector(".ac-optrow__more")).toBeNull();
    expect(container.querySelector(".ac-optrow__more--cards")?.textContent).toBe("x");
  });
});
