import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { LIST_STAGGER_MS, List } from "../src";

afterEach(() => cleanup());

const css = () => Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("motion", () => {
  test("enters and exits are short and live only inside a no-preference block", async () => {
    const all = await css();
    const section = all.slice(all.indexOf("Motion (2026-10)"));
    expect(section.length).toBeGreaterThan(100);
    const outside = section.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\banimation(-name)?:/);
    // 120–200 ms, opacity and transform only (no layout properties in the keyframes).
    for (const ms of section.matchAll(/animation: [a-z-]+ (\d+)ms/g)) {
      expect(Number(ms[1])).toBeGreaterThanOrEqual(120);
      expect(Number(ms[1])).toBeLessThanOrEqual(200);
    }
    // Exits are faster than entrances; ⌘K, opened by keyboard many times a day, has none.
    expect(section).toContain('.ac-dialog[data-state="closed"]');
    expect(section).toContain('.ac-menu[data-state="closed"]');
    expect(section).toContain(".ac-toast[data-leaving]");
    expect(all).not.toMatch(/\.ac-palette(__scrim)?\[data-state="open"\] \{\s*animation/);
    for (const exit of section.matchAll(/\[data-state="closed"\][^{]*\{\s*animation: [\w-]+ ([^ ]+)/g))
      expect(["var(--dur-fast)", "var(--dur-base)"]).toContain(exit[1] ?? "");
    for (const block of all.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)) {
      expect({ name: block[1], layout: /\b(width|height|top|left|margin|padding):/.test(block[2] ?? "") }).toEqual({
        name: block[1],
        layout: false,
      });
    }
  });

  test("a list staggers its rows only when it first appears", async () => {
    const { container } = render(
      <List>
        <div>Ada</div>
        <div>Atlas</div>
      </List>,
    );
    const list = container.querySelector(".ac-list") as HTMLElement;
    expect(list.classList.contains("ac-list--stagger")).toBe(true);
    await wait(LIST_STAGGER_MS + 30);
    expect(list.classList.contains("ac-list--stagger")).toBe(false);
  });
});
