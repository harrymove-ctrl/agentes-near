import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { type RailStep, StepRail } from "@/components/StepRail";

const NAMES = ["Workspace", "Contexto", "Seus agentes", "Computador", "Agentes e IA", "Time", "Pronto"];
const steps: RailStep[] = NAMES.map((name, i) => ({ id: `s${i}`, name, done: i < 6, disabled: false }));

/**
 * A step bar narrower than its steps (a phone zoomed in): a 231px strip from x = 16 and 32px pills 4px apart, moved
 * by the strip's own sideways scroll. Patched on Element.prototype, where the method lives: put back there, no copy
 * is left on HTMLElement.prototype to hide later test files' own patches.
 */
const real = Element.prototype.getBoundingClientRect;
const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 32, width, height: 32 });
function phoneWidth() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const strip = this.parentElement;
    if (this.classList.contains("onb__steps")) return box(16, 231) as DOMRect;
    if (strip?.classList.contains("onb__steps"))
      return box(16 + [...strip.children].indexOf(this) * 36 - strip.scrollLeft, 32) as DOMRect;
    return real.call(this);
  };
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = real;
  cleanup();
});

const rail = (current: number) => (
  <StepRail label="Passos para começar" steps={steps} current={current} onGo={() => {}} doneLabel="(concluído)" />
);

describe("the step bar on a phone", () => {
  test("it scrolls sideways to keep the current step in sight: Done, the last, shows whole", () => {
    phoneWidth();
    const { container, rerender } = render(rail(6));
    const strip = container.querySelector(".onb__steps") as HTMLElement;
    // Done's pill ends at 16 + 6 × 36 + 32 = 264, past the strip's 247: 17px more.
    expect(strip.scrollLeft).toBe(17);
    // Back to the first step: the strip scrolls back to show it.
    rerender(rail(0));
    expect(strip.scrollLeft).toBe(0);
  });

  test("the window narrowed to a phone's while on Done: the strip follows as it resizes", () => {
    const g = globalThis as unknown as { ResizeObserver: unknown };
    const saved = g.ResizeObserver;
    let resized = () => {};
    g.ResizeObserver = class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    };
    try {
      const { container } = render(rail(6));
      const strip = container.querySelector(".onb__steps") as HTMLElement;
      expect(strip.scrollLeft).toBe(0);
      phoneWidth();
      resized();
      expect(strip.scrollLeft).toBe(17);
    } finally {
      g.ResizeObserver = saved;
    }
  });

  test("a step already in sight, or a rail that fits (the desktop's column), moves nothing", () => {
    phoneWidth();
    const { container } = render(rail(3));
    expect((container.querySelector(".onb__steps") as HTMLElement).scrollLeft).toBe(0);
    Element.prototype.getBoundingClientRect = real;
    cleanup();
    const desktop = render(rail(6));
    expect((desktop.container.querySelector(".onb__steps") as HTMLElement).scrollLeft).toBe(0);
  });
});

describe("the step bar on a phone fits its seven steps", () => {
  const css = readFileSync(join(import.meta.dir, "../src/layout.css"), "utf8");
  const phone = css.slice(css.indexOf("/* Phone: the rail is a compact step bar"));
  const rule = (selector: string) => phone.slice(phone.indexOf(`  ${selector} {`)).split("}")[0] ?? "";
  const px = (body: string, prop: string) => Number(new RegExp(`\\n\\s*${prop}:\\s*(\\d+)px`).exec(body)?.[1]);

  test("the setup's: beside the whole logo at 390px (a 219px strip), beside its mark alone below 385px", () => {
    const step = 24 + 2 * px(rule(".onb:not(.newag) .onb__step"), "padding");
    const gap = px(rule(".onb:not(.newag) .onb__steps"), "gap");
    expect(7 * step + 6 * gap).toBeLessThanOrEqual(219);
    // The current step's 4px ring shows whole: room around the steps, inside the strip that scrolls.
    expect(
      px(rule(".onb:not(.newag) .onb__steps"), "padding") + px(rule(".onb:not(.newag) .onb__step"), "padding"),
    ).toBe(4);
    const narrow = phone.slice(phone.indexOf("@media (max-width: 384px)"));
    expect(narrow.split("}")[0]).toContain(".onb__brand .ac-logo > :not(.ac-logo__mark) {\n    display: none;");
  });

  test("Criar agente's and the landing's keep the shared strip: 32px steps 4px apart, on their page's edge", () => {
    expect(px(rule(".onb__steps"), "gap")).toBe(4);
    expect(px(rule(".onb__step"), "padding")).toBe(4);
    expect(rule(".onb__steps")).not.toMatch(/\n\s*(margin|padding)(-inline)?:/);
  });
});
