import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render } from "@testing-library/react";
import { ColorPicker } from "../src";

const labels = { area: "Saturação e brilho", hue: "Matiz", hex: "Código hex" };

describe("ColorPicker", () => {
  test("arrows move the area and the hue, the hex field sets a color, Enter is done", async () => {
    const picked: string[] = [];
    let done = 0;
    const view = render(
      <ColorPicker value="#ff0000" onChange={(h) => picked.push(h)} onDone={() => done++} labels={labels} />,
    );
    const area = view.getByRole("slider", { name: labels.area });
    const hue = view.getByRole("slider", { name: labels.hue });
    const hex = view.getByRole("textbox", { name: labels.hex }) as HTMLInputElement;
    expect(hex.value).toBe("#ff0000");

    // Full saturation and value: down 10% (Shift) darkens.
    await act(async () => fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true }));
    expect(picked.at(-1)).toBe("#e60000");
    expect(hex.value).toBe("#e60000");

    await act(async () => fireEvent.keyDown(hue, { key: "ArrowRight", shiftKey: true }));
    expect(picked.at(-1)).toBe("#e62600");

    await act(async () => fireEvent.change(hex, { target: { value: "1A2B3C" } }));
    expect(picked.at(-1)).toBe("#1a2b3c");
    const before = picked.length;
    await act(async () => fireEvent.change(hex, { target: { value: "#1a2" } }));
    expect(picked.length).toBe(before);

    await act(async () => fireEvent.keyDown(area, { key: "Enter" }));
    await act(async () => fireEvent.keyDown(hex, { key: "Enter" }));
    expect(done).toBe(2);
  });

  test("opened on a preset it starts from that preset's tone, and Enter applies the color shown untouched", async () => {
    const picked: string[] = [];
    let done = 0;
    const view = render(
      <ColorPicker value="amber" onChange={(h) => picked.push(h)} onDone={() => done++} labels={labels} />,
    );
    const hex = view.getByRole("textbox", { name: labels.hex }) as HTMLInputElement;
    expect(hex.value).toBe("#c07d0b");
    expect(picked).toEqual([]);
    await act(async () => fireEvent.keyDown(view.getByRole("slider", { name: labels.area }), { key: "Enter" }));
    expect(picked).toEqual(["#c07d0b"]);
    expect(done).toBe(1);
  });
});
