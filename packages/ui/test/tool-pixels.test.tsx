import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render, within } from "@testing-library/react";
import {
  AskPixels,
  HappyAgent,
  Segmented,
  SuggestSpark,
  ToolLevelBar,
  ToolLevelStrip,
  ToolLevelSwatch,
  toolLevelTones,
} from "../src";

describe("tool review pixels", () => {
  test("level tones: the agent's own body tones, approval in ink, one step lighter on dark", () => {
    const light = document.createElement("div");
    const dark = document.createElement("div");
    dark.setAttribute("data-theme", "dark");
    const inner = document.createElement("span");
    dark.append(inner);
    document.body.append(light, dark);
    const a = toolLevelTones(light, "sky");
    const b = toolLevelTones(inner, "sky");
    expect(a.read).not.toEqual(a.write);
    expect(a.read).not.toEqual(b.read);
    expect(a.approval[0]).toMatch(/^#[0-9a-f]{6}$/i);
    light.remove();
    dark.remove();
  });

  test("strip and bar carry their words; the marks are decorative", () => {
    const { container } = render(
      <div>
        <ToolLevelStrip levels={["write", "read", "off", "approval"]} label="1 consulta · 1 muda" />
        <ToolLevelBar counts={{ read: 2, write: 1 }} label="2 consultam · 1 muda" />
        <ToolLevelSwatch level="off" />
        <SuggestSpark />
        <AskPixels />
        <HappyAgent />
      </div>,
    );
    const imgs = within(container).getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("aria-label"))).toEqual(["1 consulta · 1 muda", "2 consultam · 1 muda"]);
    expect(container.querySelector(".ac-toolpx-swatch")?.getAttribute("data-level")).toBe("off");
    expect(container.querySelectorAll("canvas")).toHaveLength(6);
  });

  test("Segmented: a fourth option with a mark before the label, hover text, the label is the name", () => {
    const { container } = render(
      <Segmented
        size="sm"
        label="Nível"
        value="off"
        onValueChange={() => {}}
        options={(["read", "write", "approval", "off"] as const).map((v) => ({
          value: v,
          label: v,
          title: `help ${v}`,
          mark: <ToolLevelSwatch level={v} />,
        }))}
      />,
    );
    const radios = within(container).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["read", "write", "approval", "off"]);
    expect(radios[3]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.getAttribute("title")).toBe("help read");
    expect(radios[0]?.firstElementChild?.classList.contains("ac-toolpx-swatch")).toBe(true);
  });
});
