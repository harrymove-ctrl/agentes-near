import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();

/** CSS rules as [selector, body], comments removed. */
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (m) => [(m[1] ?? "").trim(), m[2] ?? ""] as const,
  );

const FIELD =
  /ac-input|ac-select__trigger|ac-search|ac-option|ac-pill|ac-composer|textarea|input|\.field|segmented|\.pill\b/;
const INK_BORDER = /border(-[a-z]+)?(-color)?\s*:[^;]*var\(--ink\)/;

describe("fields are v2 (no black borders)", () => {
  for (const [name, path] of [
    ["packages/ui components.css", "../src/styles/components.css"],
    ["apps/web layout.css", "../../../apps/web/src/layout.css"],
  ] as const) {
    test(`${name}: inputs, selects, search, radio cards and pills never use an ink border`, async () => {
      const offending = rules(await read(path))
        .filter(([selector, body]) => FIELD.test(selector) && INK_BORDER.test(body))
        .map(([selector]) => selector);
      expect(offending).toEqual([]);
    });
  }

  test("inputs, textareas and select triggers rest on the soft field surface with a hairline", async () => {
    const css = await read("../src/styles/components.css");
    const body = (selector: string) => rules(css).find(([s]) => s === selector)?.[1] ?? "";
    for (const selector of [".ac-input", ".ac-select__trigger", ".ac-input-affix"]) {
      expect(body(selector)).toContain("background: var(--field-bg)");
      expect(body(selector)).toContain("border: 1px solid var(--field-line)");
    }
    expect(body(".ac-input:focus")).toContain("var(--field-ring)");
    // Option and radio cards: chosen is the kit's chosen state (held down into the page, the same in both themes),
    // never a thick ring. It keeps the card's outline and never moves, so the gaps around it stay the same.
    const chosen = rules(css).find(([s]) => s.includes('.ac-option[data-state="checked"]') && !s.includes(":has"))?.[1];
    expect(chosen).toContain("background: var(--chosen-bg)");
    expect(chosen).toContain("box-shadow: var(--pressed)");
    expect(chosen).toMatch(
      /--pressed:\s*0 0 0 1px var\(--line2\),\s*0 0 0 1px var\(--line\),\s*var\(--chosen-press\);/,
    );
    expect(chosen).not.toContain("0 0 0 2px var(--ink)");
    expect(chosen).not.toMatch(/transform|translate/);
    // No dark-only look for a chosen card or row, or for the others of its group (only the check's mark changes color).
    const darkOnly = rules(css).filter(
      ([s]) => s.includes('[data-theme="dark"]') && /\.ac-(option|optrow)(?![\w-])/.test(s) && !s.endsWith("::after"),
    );
    expect(darkOnly).toEqual([]);
    // Its own radio marks it: the corner check is a pressed card's alone.
    expect(rules(css).filter(([s]) => s.includes("::after") && s.includes('.ac-option[data-state="checked"]'))).toEqual(
      [],
    );
    expect(rules(css).some(([s]) => s === '.ac-option[aria-pressed="true"]::after')).toBe(true);
  });
});

describe("Field: a stack's controls fill it", () => {
  test("every kind of control in a field is as wide as the field, a select's trigger too", async () => {
    const css = await read("../src/styles/components.css");
    const fill = rules(css).find(([s]) => s.startsWith(".ac-field > :is("))?.[1] ?? "";
    expect(fill).toContain("width: 100%");
    expect(fill).toContain("align-self: stretch");
    const kinds = rules(css).find(([s]) => s.startsWith(".ac-field > :is("))?.[0] ?? "";
    for (const kind of [".ac-select", ".ac-select__trigger", ".ac-input", ".ac-input-affix", ".ac-seg", "textarea"])
      expect(kinds).toContain(kind);
  });

  test("a people or agent select shows the chosen face, 20 and 8 from the trigger's edge", async () => {
    const css = await read("../src/styles/components.css");
    const body = (selector: string) => rules(css).find(([s]) => s === selector)?.[1] ?? "";
    expect(body(".ac-select__lead > .ac-avatar")).toContain("width: 20px");
    expect(body(".ac-select__trigger:has(.ac-select__lead > .ac-avatar)")).toContain(
      "padding-inline-start: var(--space-2)",
    );
    expect(body(".ac-select__value > span:has(> .ac-select__lead)")).toContain("gap: var(--space-2)");
  });
});
