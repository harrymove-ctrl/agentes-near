import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { Button, FilterChip, FilterToggle, SearchField, Toolbar } from "../src";

const body = () => within(document.body);

describe("Toolbar", () => {
  /** A ResizeObserver whose callbacks the test calls, as a window or a filter changing width would. */
  const observe = () => {
    const callbacks: (() => void)[] = [];
    const was = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    return {
      resize: () =>
        act(() => {
          for (const callback of callbacks) callback();
        }),
      callbacks,
      restore: () => (globalThis.ResizeObserver = was),
    };
  };
  const width = (el: Element, w: number) => {
    (el as HTMLElement).getBoundingClientRect = () => ({ width: w }) as DOMRect;
  };

  test("takes two rows when its parts at their widths, the search at its floor, don't fit one, and one when they do", () => {
    const ro = observe();
    try {
      const { container } = render(
        <Toolbar
          search={<SearchField aria-label="Buscar arquivos" placeholder="Buscar arquivos" />}
          actions={<Button size="sm">Data</Button>}
        >
          <FilterToggle pressed={false} onPressedChange={() => {}}>
            Canal
          </FilterToggle>
        </Toolbar>,
      );
      const bar = container.querySelector(".ac-toolbar") as HTMLElement;
      const [search, filters, actions] = [...bar.children] as HTMLElement[];
      Object.defineProperty(bar, "clientWidth", { configurable: true, value: 400 });
      bar.style.columnGap = "8px";
      (search as HTMLElement).style.minWidth = "160px";
      width(filters as HTMLElement, 150);
      width(actions as HTMLElement, 60);
      ro.resize();
      // 160 + 150 + 60 and two gaps: 386 of 400.
      expect(bar.hasAttribute("data-stack")).toBe(false);
      width(filters as HTMLElement, 200);
      ro.resize();
      expect(bar.hasAttribute("data-stack")).toBe(true);
      width(filters as HTMLElement, 150);
      ro.resize();
      expect(bar.hasAttribute("data-stack")).toBe(false);
    } finally {
      ro.restore();
    }
  });

  test("stacked, the search keeps its floor: when it and the actions can't share the top row, it takes it alone", () => {
    const ro = observe();
    try {
      const { container } = render(
        <Toolbar
          search={<SearchField aria-label="Buscar no time" placeholder="Buscar no time" />}
          actions={<Button size="sm">Agrupar por: responsável</Button>}
        >
          <FilterToggle pressed={false} onPressedChange={() => {}}>
            Meus
          </FilterToggle>
        </Toolbar>,
      );
      const bar = container.querySelector(".ac-toolbar") as HTMLElement;
      const [search, filters, actions] = [...bar.children] as HTMLElement[];
      Object.defineProperty(bar, "clientWidth", { configurable: true, value: 288 });
      bar.style.columnGap = "8px";
      (search as HTMLElement).style.minWidth = "160px";
      width(filters as HTMLElement, 90);
      width(actions as HTMLElement, 200);
      ro.resize();
      // 160 + 8 + 200 is wider than 288: the search alone on top, the actions leading the filters' row.
      expect(bar.getAttribute("data-stack")).toBe("split");
      width(actions as HTMLElement, 112);
      ro.resize();
      // 160 + 8 + 112 fits: the search and the actions on top.
      expect(bar.getAttribute("data-stack")).toBe("");
    } finally {
      ro.restore();
    }
  });

  test("a toolbar without a search wraps as it is: nothing measures it", () => {
    const ro = observe();
    try {
      const { container } = render(
        <Toolbar actions={<button type="button">Hoje</button>}>
          <button type="button">Rotinas</button>
        </Toolbar>,
      );
      expect(ro.callbacks).toEqual([]);
      expect(container.querySelector(".ac-toolbar")?.hasAttribute("data-stack")).toBe(false);
    } finally {
      ro.restore();
    }
  });
});

describe("FilterChip", () => {
  test("an option says how many there are of it, before the check (Tipo: each kind)", async () => {
    render(
      <FilterChip
        label="Tipo"
        icon="file"
        clearLabel="Limpar Tipo"
        multiple
        value={["docs"]}
        onChange={() => {}}
        options={[
          { value: "docs", label: "Documentos", count: 3 },
          { value: "tables", label: "Tabelas", count: 1 },
          { value: "pages", label: "Páginas HTML" },
        ]}
      />,
    );
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Tipo: Documentos" })));
    const options = within(body().getByRole("listbox", { name: "Tipo" })).getAllByRole("option");
    expect(options.map((o) => [...o.children].map((c) => c.getAttribute("class")))).toEqual([
      ["ac-filter__label", "ac-countchip", "ac-tz__check"],
      ["ac-filter__label", "ac-countchip", "ac-tz__check"],
      ["ac-filter__label", "ac-tz__check"],
    ]);
    expect(options.map((o) => o.querySelector(".ac-countchip")?.textContent ?? null)).toEqual(["3", "1", null]);
  });
});

test("a raised button in a toolbar takes the field look of the search beside it: nothing outside it for a scroller to cut", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
  const raised =
    '.ac-toolbar .ac-btn:not(.ac-btn--primary, .ac-btn--ghost, .ac-btn--agent, .ac-btn--danger, [aria-pressed="true"])';
  const look = css.split(`\n${raised} {`)[1]?.split("}")[0] ?? "";
  expect(look).toContain("background: var(--field-bg)");
  expect(look).toContain("box-shadow: inset 0 0 0 1px var(--field-line)");
  // The search's own look, so the row reads as one kind of control.
  expect(css.split("\n.ac-searchfield {")[1]?.split("}")[0]).toContain("box-shadow: inset 0 0 0 1px var(--field-line)");
});
