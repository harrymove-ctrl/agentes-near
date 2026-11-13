import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render } from "@testing-library/react";
import { CardMore, horizonCrest, horizonHeight, horizonTones, WidgetCard } from "../src";
import type { WidgetSpec } from "../src/widgets/spec";

afterEach(() => cleanup());

const labels = { seeMore: "See more", hidden: (n: number) => `${n} more` };

const card = (spec: WidgetSpec | null, over: Partial<Parameters<typeof WidgetCard>[0]> = {}) =>
  render(
    <WidgetCard
      title="Late orders"
      spec={spec}
      status="ok"
      color="green"
      size={{ w: 2, h: 1 }}
      locale="en"
      footer={<span>Rui · 5 min ago</span>}
      onOpen={() => {}}
      {...over}
    />,
  );

describe("a card's horizon", () => {
  test("only with real room under the content, and always low", () => {
    expect(horizonHeight(0)).toBe(0);
    expect(horizonHeight(71)).toBe(0);
    expect(horizonHeight(72)).toBe(48);
    expect(horizonHeight(400)).toBe(112);
  });

  test("a small card (the phone's home strip) may ask for less room, and it still stays low", () => {
    expect(horizonHeight(60)).toBe(0);
    expect(horizonHeight(60, 56)).toBe(36);
    expect(horizonHeight(55, 56)).toBe(0);
    expect(horizonHeight(400, 56)).toBe(112);
  });

  test("light: from the card's own ground into the color's light end, never past half of it", () => {
    const light = horizonTones("sky", "#f6f6f4", false);
    expect(light[0]).toBe("#f6f6f4");
    expect(light).toHaveLength(5);
    const dark = horizonTones("sky", "#191918", true);
    expect(dark[0]).toBe("#191918");
    // Each step a little further from the ground than the one before.
    const lum = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(5, 7), 16);
    for (let i = 1; i < dark.length; i++) expect(lum(dark[i] ?? "")).toBeGreaterThan(lum(dark[i - 1] ?? ""));
  });

  test("the crest stays in the horizon's upper half", () => {
    for (let u = 0; u < 4; u += 0.05) {
      expect(horizonCrest(u)).toBeGreaterThan(0.15);
      expect(horizonCrest(u)).toBeLessThan(0.5);
    }
  });
});

describe("a widget on a board", () => {
  test("is capped and has the horizon under its text", () => {
    const { container } = card({ kind: "text", items: ["All orders shipped."] }, { board: labels });
    const el = container.querySelector(".wg");
    expect(el?.hasAttribute("data-capped")).toBe(true);
    expect(container.querySelector("canvas.ac-card-horizon")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("a number with its trend keeps the trend at its foot, no horizon", () => {
    const { container } = card({ kind: "kpi", value: 7, spark: [1, 3, 2, 5] }, { board: labels });
    expect(container.querySelector(".ac-card-horizon")).toBeNull();
  });

  test("off a board (a panel, a preview) and in Organize: neither cap nor horizon", () => {
    const off = card({ kind: "text", items: ["Hi"] });
    expect(off.container.querySelector(".wg")?.hasAttribute("data-capped")).toBe(false);
    expect(off.container.querySelector(".ac-card-horizon")).toBeNull();
    cleanup();
    const organizing = card(
      { kind: "text", items: ["Hi"] },
      {
        board: labels,
        organize: {
          sizeLabel: "Size",
          sizeText: "M",
          removeLabel: "Remove",
          dragLabel: "Drag",
          onSize: () => {},
          onRemove: () => {},
        },
      },
    );
    expect(organizing.container.querySelector(".wg")?.hasAttribute("data-capped")).toBe(false);
  });
});

describe("See more", () => {
  test("says how many rows the cut hides and opens the card", () => {
    let opened = 0;
    const { getByRole } = render(<CardMore label="See more" hiddenLabel="5 more" hidden={5} onOpen={() => opened++} />);
    const button = getByRole("button", { name: "See more, 5 more" });
    expect(button.textContent).toBe("See more+5");
    fireEvent.click(button);
    expect(opened).toBe(1);
  });
});
