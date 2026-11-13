import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, within } from "@testing-library/react";
import { Chip, ORBIT_RING, orbitShades, PixelSpinner, Spinner } from "../src";

afterEach(cleanup);

describe("PixelSpinner", () => {
  test("one lit cell walks the 8-cell ring with a two-cell fading trail", () => {
    expect(ORBIT_RING).toHaveLength(8);
    // Lit at the top-left: the trail is the two cells before it (counter-clockwise), the rest dim.
    expect(orbitShades(0)).toEqual([0, 3, 3, 3, 3, 3, 2, 1]);
    expect(orbitShades(3)).toEqual([3, 2, 1, 0, 3, 3, 3, 3]);
    for (let head = 0; head < 8; head++) {
      const shades = orbitShades(head);
      expect(shades.filter((s) => s === 0)).toHaveLength(1);
      expect(shades.filter((s) => s === 1)).toHaveLength(1);
      expect(shades.filter((s) => s === 2)).toHaveLength(1);
    }
  });

  test("decorative by default; a label makes it an image; sizes are the box", () => {
    const { container } = render(<PixelSpinner size={24} />);
    const canvas = container.querySelector("canvas.ac-pixspin") as HTMLCanvasElement;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.style.width).toBe("24px");
    expect(canvas.style.height).toBe("24px");
    render(<PixelSpinner size={32} label="Trabalhando" color="violet" />);
    const named = within(document.body).getByRole("img", { name: "Trabalhando" });
    expect(named.getAttribute("data-color")).toBe("violet");
  });

  test("Spinner (buttons, uploads) is the same orbit, snapped to 14/16/24/32", () => {
    const { container } = render(
      <>
        <Spinner size={10} />
        <Spinner />
        <Spinner size={40} />
      </>,
    );
    const sizes = [...container.querySelectorAll("canvas")].map((c) => (c as HTMLElement).style.width);
    expect(sizes).toEqual(["14px", "16px", "32px"]);
  });

  test("a chip can lead with the agent's orbit instead of its icon", () => {
    const { container } = render(
      <Chip icon="spinner" lead={<PixelSpinner size={14} color="amber" />}>
        Trabalhando
      </Chip>,
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector("canvas")?.getAttribute("data-color")).toBe("amber");
    expect(container.querySelector("svg")).toBeNull();
  });
});
