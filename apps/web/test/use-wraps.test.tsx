import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { FlowTitle } from "@/components/FlowTitle";
import { useWraps } from "@/hooks/useWraps";

const real = globalThis.ResizeObserver;
/** Each observer's report, sent when a test says so. */
let reports: (() => void)[] = [];
/** How many lines the browser lays the words out on. */
let lines = 1;

beforeEach(() => {
  reports = [];
  // A browser's observer reports after layout, and React applies that only after the frame has painted.
  globalThis.ResizeObserver = class {
    constructor(report: ResizeObserverCallback) {
      reports.push(() => report([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = real;
});

/** Words on `lines` lines of 22px. */
function Words({ words }: { words: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const wraps = useWraps(ref);
  return (
    <p
      ref={(el) => {
        ref.current = el;
        if (el) Object.defineProperty(el, "clientHeight", { configurable: true, get: () => lines * 22 });
      }}
      style={{ lineHeight: "22px" }}
      data-wraps={wraps}
    >
      {words}
    </p>
  );
}

describe("useWraps", () => {
  test("knows the first words and new ones before they paint, with no word from the observer", () => {
    lines = 2;
    const { container, rerender } = render(<Words words="Felipe Ramos e Renata Lima pedem para entrar agora" />);
    const p = container.querySelector("p") as HTMLElement;
    expect(p.dataset.wraps).toBe("true");
    lines = 1;
    rerender(<Words words="Felipe Ramos pede para entrar agora" />);
    expect(p.dataset.wraps).toBe("false");
  });

  test("and the observer keeps it current as the words reflow (a narrower window)", () => {
    lines = 1;
    const { container } = render(<Words words="Felipe Ramos pede para entrar agora" />);
    const p = container.querySelector("p") as HTMLElement;
    expect(p.dataset.wraps).toBe("false");
    lines = 2;
    act(() => {
      for (const report of reports) report();
    });
    expect(p.dataset.wraps).toBe("true");
  });
});

describe("a connect flow's title", () => {
  test("one line centres on the tile; words that wrap take .ac-captop, their first line on its top", async () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => lines * 24 });
    try {
      lines = 1;
      const title = (words: string) => (
        <h2 style={{ lineHeight: "24px" }}>
          <FlowTitle tile={<span className="connector-icon connector-icon--lg" />}>{words}</FlowTitle>
        </h2>
      );
      const { container, rerender } = render(title("Conectar Banco de dados"));
      const text = () => container.querySelector(".cflow__title > span:last-child") as HTMLElement;
      expect(text().className).toBe("");
      lines = 2;
      rerender(title("Quem pode usar Postgres de produção"));
      expect(text().className).toBe("ac-captop");
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
    const css = (await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".cflow__title")).toContain("align-items: center");
    // One line: the tile rises to the title's capitals' middle, as measured for the app's 18/24 title.
    expect(rule(".cflow__title > :first-child")).toContain("translate: 0 calc(-1 * var(--title-cap-mid))");
    const app = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    expect(app).toContain("--title-cap-mid: 1.19px;");
    expect(rule(".cflow__title:has(> .ac-captop)")).toContain("align-items: flex-start");
    expect(rule(".cflow__title:has(> .ac-captop) > :first-child")).toContain("translate: none");
  });
});
