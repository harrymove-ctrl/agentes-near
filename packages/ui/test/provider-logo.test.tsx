import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { BrainLogo, ProviderLogo, ProviderStack } from "../src";
import { type MarkId, markOf, PROVIDER_MARKS } from "../src/brand/marks";

afterEach(() => cleanup());

const logo = (container: HTMLElement) => container.querySelector(".ac-brand") as HTMLElement;
/** A mark drawn from path data: every maker's but Gemini's, which is an image. */
const pathMark = (id: MarkId) => {
  const mark = PROVIDER_MARKS[id];
  if (!("path" in mark)) throw new Error(`${id} is an image mark`);
  return mark;
};

describe("provider marks", () => {
  test("every mark renders its path on the 24×24 grid in the brand's color or the theme's, or its image", () => {
    for (const id of Object.keys(PROVIDER_MARKS) as MarkId[]) {
      const { container } = render(<ProviderLogo id={id} size="sm" />);
      const el = logo(container);
      expect(el.dataset.mark).toBe(id);
      const mark = PROVIDER_MARKS[id];
      if ("image" in mark) {
        expect(el.querySelector("img")?.getAttribute("src")).toBe(mark.image);
        expect(el.classList.contains("ac-brand--mono")).toBe(true);
        cleanup();
        continue;
      }
      expect(el.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
      const d = el.querySelector("path")?.getAttribute("d") ?? "";
      expect(d).toBe(mark.path);
      expect(d).toMatch(/^[Mm][\d.\s,a-zA-Z-]+$/);
      if (mark.color) expect(el.style.getPropertyValue("--brand")).toBe(mark.color);
      else expect(el.classList.contains("ac-brand--mono")).toBe(true);
      cleanup();
    }
  });

  test("Gemini draws its own image on the neutral tile, at a path mark's size, dimmed only by opacity", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    for (const size of ["xs", "chip", "sm", "tile"] as const) {
      const el = logo(render(<ProviderLogo id="gemini" size={size} />).container);
      expect(el.dataset.mark).toBe("gemini");
      const img = el.querySelector("img") as HTMLImageElement;
      expect([img.getAttribute("src"), img.getAttribute("alt")]).toEqual(["/brands/gemini.png", ""]);
      // The size the stylesheet gives a path mark's drawing in this tile, so the kit's rules stay as they are.
      const px = /width: (\d+)px/.exec(rule(`.ac-brand--${size} svg`))?.[1];
      expect([size, img.getAttribute("width"), img.getAttribute("height")]).toEqual([size, px ?? "", px ?? ""]);
      expect(el.querySelector("svg")).toBeNull();
      // No brand tint: Google's sparkle sits on the neutral tile.
      expect(el.className).toBe(`ac-brand ac-brand--${size} ac-brand--mono`);
      expect(el.style.getPropertyValue("--brand")).toBe("");
      cleanup();
    }
    const off = logo(render(<ProviderLogo id="gemini" size="sm" off />).container);
    expect(off.className).toBe("ac-brand ac-brand--sm ac-brand--mono ac-brand--off");
    expect(rule(".ac-brand--off")).toContain("opacity: 0.5");
    expect(rule(".ac-brand--off")).not.toContain("filter");
    expect(off.querySelector("img")?.hasAttribute("style")).toBe(false);
  });

  test("brains, executors and API providers find their maker's mark; anything else has none", () => {
    expect(markOf("claude_code")).toBe("claude");
    expect(markOf("claude")).toBe("claude");
    expect(markOf("codex")).toBe("openai");
    expect(markOf("antigravity")).toBe("gemini");
    // People know the provider as Claude: its API key draws the Claude spark, never Anthropic's own symbol.
    expect(markOf("anthropic")).toBe("claude");
    expect(markOf("moonshot")).toBe("kimi");
    expect(markOf("zai")).toBe("zai");
    expect(markOf("gemini")).toBe("gemini");
    // An AI account's row draws its `provider` before its kind: an OpenCode key is OpenCode's, never a letter Z, and a
    // Gemini Enterprise seat Gemini's.
    expect(markOf("zen")).toBe("opencode");
    expect(markOf("enterprise")).toBe("gemini");
    // A plan names the makers it resells as written.
    expect(
      ["OpenCode", "xAI", "Alibaba", "Meituan", "Tencent", "StepFun", "Meta", "Reflection", "Xiaomi"].map(markOf),
    ).toEqual(["opencode", "xai", "alibaba", "meituan", "tencent", "stepfun", "meta", "reflection", "xiaomi"]);
    for (const id of ["model", "agent", "mosaic", "", null, undefined, "constructor", "__proto__", "toString"])
      expect(markOf(id)).toBeNull();
  });

  test("the anthropic provider is drawn as Claude, in Claude's color", () => {
    const el = logo(render(<ProviderLogo id="anthropic" size="sm" />).container);
    expect(el.dataset.mark).toBe("claude");
    expect(el.style.getPropertyValue("--brand")).toBe("#D97757");
    expect(el.querySelector("path")?.getAttribute("d")).toBe(pathMark("claude").path);
  });

  test("a mark's second color is its own part, with the maker's dark color where it has one", () => {
    const kimi = logo(render(<ProviderLogo id="moonshot" size="sm" />).container);
    const [k, dot] = [...kimi.querySelectorAll("path")];
    // The K follows the theme; the dot is always Kimi's blue, drawn over it.
    expect(k?.getAttribute("d")).toBe(pathMark("kimi").path);
    expect(k?.getAttribute("class")).toBeNull();
    expect(dot?.getAttribute("class")).toBe("ac-brand__part");
    expect(dot?.getAttribute("d")).toBe(pathMark("kimi").parts?.[0]?.path ?? "");
    expect(dot?.style.getPropertyValue("--part")).toBe("#1783FF");
    expect(dot?.style.getPropertyValue("--part-dark")).toBe("#1783FF");
    cleanup();
    const block = logo(render(<ProviderLogo id="opencode" />).container).querySelector(".ac-brand__part") as SVGElement;
    expect(block.style.getPropertyValue("--part")).toBe("#CFCECD");
    expect(block.style.getPropertyValue("--part-dark")).toBe("#4B4646");
  });

  test("MiniMax fills its mark with its gradient, under an id of its own on every logo", () => {
    const { container } = render(
      <>
        <ProviderLogo id="minimax" size="sm" />
        <ProviderLogo id="minimax" size="xs" />
      </>,
    );
    const ids = [...container.querySelectorAll(".ac-brand")].map((el) => {
      const gradient = el.querySelector("linearGradient") as SVGElement;
      expect([...gradient.querySelectorAll("stop")].map((s) => s.getAttribute("stop-color"))).toEqual([
        "#E21680",
        "#FF633A",
      ]);
      // Left to right across the whole grid.
      expect(gradient.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
      expect([gradient.getAttribute("x1"), gradient.getAttribute("x2")]).toEqual(["0", "24"]);
      expect(el.querySelector("path")?.getAttribute("fill")).toBe(`url(#${gradient.id})`);
      // Its brand color still tints the tile.
      expect((el as HTMLElement).style.getPropertyValue("--brand")).toBe("#E73562");
      return gradient.id;
    });
    expect(new Set(ids).size).toBe(2);
    cleanup();
    // A mark without a gradient keeps the tile's color.
    expect(
      logo(render(<ProviderLogo id="claude" />).container)
        .querySelector("path")
        ?.hasAttribute("fill"),
    ).toBe(false);
  });

  test("off only dims a mark, in its own colors; the chip is a 20 px tile with a 12 px mark", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-brand--off")).toContain("opacity: 0.5");
    expect(rule(".ac-brand--off")).not.toContain("filter");
    expect(rule(".ac-brand--chip")).toContain("width: 20px");
    expect(rule(".ac-brand--chip")).toContain("height: 20px");
    expect(rule(".ac-brand--chip")).toContain("border-radius: 7px 7px 7px 3px");
    expect(rule(".ac-brand--chip svg")).toContain("width: 12px");
    expect(rule('[data-theme="dark"] .ac-brand__part')).toContain("fill: var(--part-dark)");
    const chip = logo(render(<ProviderLogo id="zai" size="chip" off />).container);
    expect(chip.className).toBe("ac-brand ac-brand--chip ac-brand--mono ac-brand--off");
  });

  test("a stack draws its makers in order, overlapping, and is decorative unless labeled", async () => {
    const quiet = render(<ProviderStack ids={["claude_code", "codex", "zai", "kimi"]} />).container.firstElementChild;
    expect(quiet?.className).toBe("ac-brand-stack");
    expect(quiet?.getAttribute("aria-hidden")).toBe("true");
    expect([...(quiet?.children ?? [])].map((c) => [(c as HTMLElement).dataset.mark, c.className])).toEqual([
      ["claude", "ac-brand ac-brand--chip"],
      ["openai", "ac-brand ac-brand--chip ac-brand--mono"],
      ["zai", "ac-brand ac-brand--chip ac-brand--mono"],
      ["kimi", "ac-brand ac-brand--chip ac-brand--mono"],
    ]);
    cleanup();
    const named = render(<ProviderStack ids={["anthropic", "openai"]} label="Claude e OpenAI" />).container
      .firstElementChild as HTMLElement;
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("Claude e OpenAI");
    expect(named.hasAttribute("aria-hidden")).toBe(false);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    const px = (selector: string, property: RegExp) => Number(property.exec(rule(selector))?.[1]);
    const overlap = -px(".ac-brand-stack > .ac-brand + .ac-brand", /margin-left: (-?\d+)px/);
    const ring = px(".ac-brand-stack > .ac-brand", /0 0 0 (\d+)px var\(--stack-ring, var\(--surface\)\)/);
    const chip = px(".ac-brand--chip", /width: (\d+)px/);
    const mark = px(".ac-brand--chip svg", /width: (\d+)px/);
    expect([overlap, ring]).toEqual([2, 2]);
    // The next tile and its ring cover only the space around a mark, never the mark itself.
    expect(overlap + ring).toBeLessThanOrEqual((chip - mark) / 2);
  });

  test("a one-color mark is drawn in ink at every size, even beside muted text", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    // Every rule that sets a mark's color: the brand's, or the ink for a one-color mark (an initial isn't a mark).
    const colors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector?.includes(".ac-brand") && !selector.includes("__initial"))
      .flatMap(([, selector, body]) =>
        [...(body ?? "").matchAll(/(?:^|[\s;])color: ([^;]+);/g)].map((m) => [selector?.trim(), m[1]]),
      );
    expect(colors).toEqual([
      [".ac-brand", "var(--brand)"],
      [".ac-brand--mono", "var(--ink)"],
    ]);
    const xs = logo(render(<ProviderLogo id="codex" size="xs" />).container);
    expect(xs.className).toBe("ac-brand ac-brand--xs ac-brand--mono");
  });

  test("decorative unless labeled", () => {
    const quiet = logo(render(<ProviderLogo id="deepseek" />).container);
    expect(quiet.getAttribute("aria-hidden")).toBe("true");
    expect(quiet.getAttribute("role")).toBeNull();
    cleanup();
    const named = logo(render(<ProviderLogo id="deepseek" label="DeepSeek" />).container);
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("DeepSeek");
    expect(named.hasAttribute("aria-hidden")).toBe(false);
    expect(named.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("an id without a mark shows its initial on a neutral tile", () => {
    const el = logo(render(<ProviderLogo id="mosaic" size="sm" off />).container);
    expect(el.querySelector("svg")).toBeNull();
    expect(el.textContent).toBe("M");
    expect(el.dataset.mark).toBeUndefined();
    expect(el.className).toContain("ac-brand--mono");
    expect(el.className).toContain("ac-brand--off");
    cleanup();
    expect(logo(render(<ProviderLogo id="mosaic" size="chip" />).container).textContent).toBe("M");
  });

  test("a workspace's own endpoint is a generic mark, never the letter C of its id", () => {
    const el = logo(render(<ProviderLogo id="custom" size="xs" />).container);
    expect(el.querySelector(".ac-brand__initial")).toBeNull();
    expect(el.dataset.mark).toBe("custom");
    expect(el.querySelector("path")?.getAttribute("d")).toBe(pathMark("custom").path);
    expect(el.className).toContain("ac-brand--mono");
  });

  test("BrainLogo still draws Claude for Claude Code and OpenAI for Codex, at its sizes", () => {
    const claude = logo(render(<BrainLogo kind="claude_code" />).container);
    expect(claude.dataset.mark).toBe("claude");
    expect(claude.className).toContain("ac-brand--tile");
    expect(claude.querySelector("path")?.getAttribute("d")).toBe(pathMark("claude").path);
    cleanup();
    const codex = logo(render(<BrainLogo kind="codex" size="sm" off label="Codex" />).container);
    expect(codex.dataset.mark).toBe("openai");
    expect(codex.className).toContain("ac-brand--sm");
    expect(codex.className).toContain("ac-brand--off");
    expect(codex.getAttribute("aria-label")).toBe("Codex");
  });
});
