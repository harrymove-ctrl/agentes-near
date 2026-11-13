import { describe, expect, test } from "bun:test";

describe("equal side padding", () => {
  test("blocks with visible edges span their column, so no cap leaves the right side wider than the left", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0];
    for (const selector of [
      // First run: the server form, help card, found servers and problem line; Run here's form, ways, steps and bar.
      ".dk-fr__form",
      ".dk-fr__problem",
      ".dk-fr__found",
      ".dk-fr__none",
      ".dk-fr__ways",
      ".dk-fr__here",
      ".dk-fr__end[data-near]",
      ".dk-fr__steps",
      ".dk-bar",
    ]) {
      expect(rule(selector)).toBeDefined();
      expect(rule(selector)).not.toContain("max-width");
    }
  });
});

describe("Connect's found servers", () => {
  test("its heading, tiles and Use buttons sit in the column's edges, as the field and Connect above do", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".dk-fr__foundrow")).toContain("padding: 9px 0;");
    // Section titles elsewhere (Preferences' cards) keep their inset; this one has none.
    expect(rule(".dk-ctitle")).toContain("margin: 18px 4px 8px;");
    expect(rule(".dk-fr__found .dk-ctitle")).toContain("margin-inline: 0;");
  });
});

describe("Run here", () => {
  test("Start sits at the window's bottom: the form fills the window and Start's top margin stays auto", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".dk-fr__here")).toContain("flex: 1 0 auto;");
    expect(rule(".dk-fr__end")).toContain("margin-top: auto;");
    // The sticky bar's own margin shorthand would win over that auto: its top has to be auto too.
    expect(rule(".dk-fr__here .dk-fr__end")).toMatch(/\n\s*margin: auto -48px -28px;/);
  });

  test("Your own server's cards leave no word alone on a line", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    expect(css.split("\n.dk-fr__card small {")[1]?.split("}")[0]).toContain("text-wrap: pretty;");
  });
});

describe("switch rows", () => {
  test("a switch's label is regular weight, lighter than a field's label; other row titles stay bold", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".dk-crow__title")).toContain("font-weight: 600;");
    expect(rule(".dk-crow:has(> .dk-crow__end > .ac-switch) .dk-crow__title")).toContain("font-weight: 400;");
  });
});
