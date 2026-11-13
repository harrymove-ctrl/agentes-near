import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("the rail keeps no room for the row's buttons it hides: a mark stays centred on its plate, hovered or chosen", async () => {
  const shipped = topLevel(await builtCss());
  // Each rule that makes that room, and the one hiding what the buttons replace, is for the full list alone.
  const rules = [...shipped.matchAll(/([^{}]*\.sidebar__row\[data-acts\][^{}]*)\{([^{}]*)\}/g)].filter(
    ([, , body]) => body?.includes("padding-right") || body?.includes("visibility"),
  );
  expect(rules.length).toBe(3);
  for (const [, selector] of rules) expect(selector?.replace(/"/g, "")).toContain(".sidebar:not([data-rail=true])");
  expect(last(shipped, ".sidebar[data-rail=true] .sidebar__row-acts", "display")).toBe("none");
  // The plate is a centring box of the rail's own size, its face (--sidebar-rail-face, 28px: sidebar-css.test.ts)
  // inside with room for the status mark.
  expect(last(shipped, ".sidebar[data-rail=true] .sidebar__item", "padding")).toBe("0");
  expect(last(shipped, ".sidebar[data-rail=true] .sidebar__item", "justify-content")).toBe("center");
  expect(last(shipped, ".sidebar__item>.ac-avatar--sm", "width")).toBe("var(--sidebar-rail-face)");
});

test("a grip is its row's height, so its dots share the row's middle", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  expect(last(shipped, ".sidebar__grip", "top")).toBe("0");
  expect(last(shipped, ".sidebar__tool-grip", "top")).toBe("0");
  expect(last(shipped, ".sidebar__grip", "height")).toBe("28px");
  expect(last(shipped, ".sidebar__block[data-section=tools]>.sidebar__grip", "height")).toBe("32px");
  expect(last(shipped, ".sidebar:not([data-rail=true]) .sidebar__item", "min-height")).toBe("32px");
  expect(last(shipped, ".sidebar__tool-grip", "bottom")).toBe("0");
  const touch = atRule(css, "@media (max-width: 760px), (pointer: coarse)");
  expect(last(touch, ".sidebar__block[data-section=tools]>.sidebar__grip", "height")).toBe("36px");
});

test("search results and floating panels", async () => {
  const css = await builtCss(
    "src/styles.css",
    "src/components/search/search.css",
    "src/components/threads/threads.css",
  );
  const shipped = topLevel(css);
  // "Ir para" has a column of its own, beside the row, so no text runs under it at any width.
  expect(last(shipped, ".search-result", "display")).toBe("grid");
  expect(last(shipped, ".search-result__jump.ac-btn", "position")).toBeUndefined();
  // A floating panel's scrim dims the whole window, the sidebar too.
  expect(last(shipped, ".thread-panel__scrim", "position")).toBe("fixed");
  // It hangs from <body> (SidePanel's portal), so no page's entrance can hold it inside the page: no rule on `main`.
  expect(css).not.toContain("main.shell__main:has(.thread-panel__scrim)");
  // Outside the work area it brings the area's surfaces along (headers and sticky bars paint `--bg`/`--surface`).
  expect(last(shipped, ".thread-panel", "--bg")).toBe("var(--pane)");
  expect(last(shipped, ".thread-panel", "--surface")).toBe("var(--pane)");
  // A thread's narrow head drops its channel's name; the results' line says what was searched and stays.
  const narrow = css.slice(css.indexOf("@container thread-dock"));
  expect(last(narrow, ".search-panel__head .thread-head__meta>.thread-head__where", "display")).toBe("block");
});
