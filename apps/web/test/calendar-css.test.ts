import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AGENT_COLORS } from "@agenteschat/ui";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { contrastRatio, mix } from "@agenteschat/ui/sky/math";
import { atRule, declarations, rules, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

describe("calendar items the Google Calendar way", () => {
  test("no edge stripe and no shadow on an item: only the open one's ring and the focus ring", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    const shadows = rules(css)
      .filter((r) => r.selectors.some((s) => s.includes("cal-chip")))
      .flatMap((r) => r.declarations.filter(([p]) => p === "box-shadow").map(([, v]) => v));
    expect([...new Set(shadows)].sort()).toEqual(["inset 0 0 0 1.5px var(--cal-ink)", "var(--field-ring)"]);
    // Small corners, Google's: the kit's 6.
    expect(last(declarations(css, ".cal-chip"), "border-radius")).toBe("var(--radius-sm)");
  });

  test("names wrap whole: nothing in the calendar ends a name in …", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    expect(css).not.toContain("text-overflow");
    expect(last(declarations(css, ".cal-chip"), "overflow-wrap")).toBe("anywhere");
    expect(last(declarations(css, ".cal-chip__title"), "white-space")).toBeUndefined();
    // Narrower than a long word, it breaks at a syllable with its hyphen, never between two letters.
    expect(last(declarations(atRule(css, "@container (max-width: 110px)"), ".cal-chip__title"), "hyphens")).toBe(
      "auto",
    );
  });

  test("a meeting's time takes no room of its own, so a block grows for its title alone", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    expect(last(declarations(css, ".cal-chip--block"), "grid-template-rows")).toBe("auto minmax(0, 1fr)");
    expect(last(declarations(css, ".cal-chip__when"), "container-type")).toBe("size");
    expect(
      last(
        declarations(atRule(css, "@container (max-height: 15.5px)"), ".cal-chip__when > .cal-chip__time"),
        "visibility",
      ),
    ).toBe("hidden");
  });

  test("a narrow column keeps a run's face and name, the time gives way; a wide one names the owner after it", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    expect(
      last(declarations(atRule(css, "@container (max-width: 119.5px)"), ".cal-chip--run .cal-chip__time"), "display"),
    ).toBe("none");
    expect(last(declarations(topLevel(css), ".cal-chip__who"), "display")).toBe("none");
    expect(last(declarations(atRule(css, "@container (min-width: 220px)"), ".cal-chip__who"), "display")).toBe(
      "inline",
    );
  });

  test("a column too narrow for a word beside a face (a phone's week or month) shows each item as its face, never a tower of words", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    const narrow = atRule(css, "@container (max-width: 63.5px)");
    expect(
      last(
        declarations(
          narrow,
          ".cal-chip:not(.cal-chip--block) :is(.cal-chip__name, .cal-chip__time, .cal-chip__repeat)",
        ),
        "display",
      ),
    ).toBe("none");
    // Two meetings at once in a week's day at 1280 (50px each inside) said only "J" and "W": a meeting keeps its name
    // down to 45.5px inside, a word a line under it.
    const meeting = atRule(css, "@container (max-width: 45.5px)");
    expect(
      last(
        declarations(meeting, ".cal-chip--block :is(.cal-chip__name, .cal-chip__time, .cal-chip__repeat)"),
        "display",
      ),
    ).toBe("none");
    expect(last(declarations(narrow, ".cal-chip--line > .cal-chip__title"), "display")).toBe("none");
    // A task nobody has: its kind's glyph there, hidden where its name has room.
    expect(last(declarations(narrow, ".cal-chip__glyph"), "display")).toBe("inline-block");
    expect(last(declarations(topLevel(css), ".cal-chip__glyph"), "display")).toBe("none");
    // Every item is measured by its own column: a bar by its days, a month's row by its day.
    for (const box of [".cal-chip--block", ".cal-week__runs", ".cal-chip--bar", ".cal-month__cell"])
      expect(last(declarations(css, box), "container-type")).toBe("inline-size");
    // A bar across days of such a week too: by its lane, a day's width times the days (67.5px a day).
    expect(last(declarations(css, ".cal-week__barlane"), "container")).toBe("lane / inline-size");
    for (const [days, px] of [
      [7, 472],
      [5, 337],
    ] as const) {
      const lane = atRule(css, `@container lane (max-width: ${px}px)`);
      const bar = `.cal-week[data-days="${days}"] .cal-chip--bar`;
      expect(last(declarations(lane, `${bar} :is(.cal-chip__name, .cal-chip__repeat)`), "display")).toBe("none");
      expect(last(declarations(lane, `${bar} .cal-chip__glyph`), "display")).toBe("inline-block");
    }
  });

  test("side by side, a column of runs alone gives the meeting beside it room for its name, never under a face's width or past an even share", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    const items = declarations(css, ".cal-week__col > :is(.cal-chip--block, .cal-week__runs)");
    expect(last(items, "--thin")).toBe("min(var(--even), max(32px, var(--even) - 60px))");
    expect(last(items, "width")).toBe("var(--wide)");
    expect(last(declarations(css, ".cal-week__col > .cal-week__runs[data-thin]"), "width")).toBe("var(--thin)");
  });

  test("six meetings at once: their side room gives way to keep the faces, and narrower than a face a block is its tint", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    const room = last(declarations(css, ".cal-week__col > .cal-chip--block"), "padding-inline");
    expect(room).toBe("clamp(2px, calc(17px - var(--cols) * 2.5px), 6px)");
    // A 131px day (a week at 1280): six blocks of 19.5px keep 15.5 for the face (14.4, 1.15em of a block's 12.5px).
    const padding = (cols: number) => Math.min(6, Math.max(2, 17 - cols * 2.5));
    const content = (day: number, cols: number) => (day - 2 * (cols + 1)) / cols - 2 * padding(cols);
    expect(content(131, 6)).toBeGreaterThanOrEqual(14.4);
    expect(padding(3)).toBe(6);
    expect(
      last(
        declarations(atRule(css, "@container (max-width: 14.5px)"), ".cal-chip--block > .cal-chip__title"),
        "display",
      ),
    ).toBe("none");
  });

  test("a day's +N mais list takes the room under it, not the menu's 280 that cut a dozen rows by a sliver", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    expect(last(declarations(css, ".cal-more.ac-popover"), "max-height")).toBe(
      "min(480px, var(--radix-popover-content-available-height, 480px))",
    );
  });

  test("an all-day lane's bars share its height with their names from the top, not centred like a button's", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    expect(last(declarations(css, ".cal-chip--bar"), "display")).toBe("flex");
    expect(last(declarations(css, ".cal-chip--bar"), "flex-direction")).toBe("column");
    expect(last(declarations(css, ".cal-week__barlane"), "grid-auto-rows")).toBe("auto");
    // A month's week as tall as its names, never squeezed to the window so one row runs over the next.
    expect(last(declarations(css, ".cal-month__grid"), "grid-auto-rows")).toBe("minmax(max-content, 1fr)");
    expect(last(declarations(css, ".cal-month__cell > *"), "flex")).toBe("none");
  });
});

/** The theme's tokens, light and dark, from the kit's sheet. */
async function themes() {
  const tokens = await sheet("packages/ui/src/styles/tokens.css");
  const block = (selector: string) => {
    const at = tokens.indexOf(selector);
    return tokens.slice(tokens.indexOf("{", at) + 1, tokens.indexOf("}", at));
  };
  const read = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1] as string, m[2] as string]),
    );
  return { light: read(block(':root,\n[data-theme="light"]')), dark: read(block('[data-theme="dark"] {')) };
}

/** `color-mix(in srgb, var(--a) N%, var(--b))` with these values. */
function colorMix(expr: string | undefined, vars: Record<string, string>) {
  const m = /^color-mix\(in srgb, var\(--([\w-]+)\) ([\d.]+)%, var\(--([\w-]+)\)\)$/.exec(expr ?? "");
  if (!m) throw new Error(`not a mix: ${expr}`);
  const [, a, pct, b] = m as unknown as [string, string, string, string];
  return mix(vars[b] as string, vars[a] as string, Number(pct) / 100);
}

describe("every item's words read on its fill", () => {
  test("4.5:1 in both themes, past and hovered, for every agent colour, a person's and a due date's", async () => {
    const css = await sheet("apps/web/src/pages/calendar.css");
    const base = declarations(css, ".cal-chip");
    const past = declarations(css, ".cal-chip[data-past]");
    const dark = declarations(css, '[data-theme="dark"] .cal-chip');
    const darkPast = declarations(css, '[data-theme="dark"] .cal-chip[data-past]');
    const t = await themes();
    // Presets (sky through the theme's own tokens, as `useAccent` gives them) and custom colours at every hue, the
    // darkest and the lightest the picker allows.
    const custom = [
      "#ff0000",
      "#ff8000",
      "#ffff00",
      "#80ff00",
      "#00ff00",
      "#00ff80",
      "#00ffff",
      "#0080ff",
      "#0000ff",
      "#8000ff",
      "#ff00ff",
      "#ff0080",
      "#7f7f7f",
      "#101010",
      "#f2f2f2",
      "#00008f",
    ];
    // Each owner's [deep, light] ends: what `useAccent` and the CSS give `--cal-accent` and `--cal-light`.
    type Ends = (v: Record<string, string>) => [string, string];
    const owners: { name: string; ends: Ends }[] = [
      { name: "sky", ends: (v) => [v.agent as string, v.agent2 as string] },
      { name: "person", ends: (v) => [v.ink2 as string, v.ink2 as string] },
      { name: "due date", ends: (v) => [v.warn as string, v.warn as string] },
      ...[...AGENT_COLORS.filter((c) => c !== "sky"), ...custom].map((c) => {
        const [top, bottom] = gradientOf(c);
        return { name: c, ends: () => [bottom, top] as [string, string] };
      }),
    ];
    const low: string[] = [];
    for (const [theme, tokens] of Object.entries(t)) {
      for (const owner of owners) {
        const [accent, light] = owner.ends(tokens);
        const vars: Record<string, string> = { ...tokens, "cal-accent": accent, "cal-light": light };
        const ink = (on: (readonly [string, string])[], fallback: (readonly [string, string])[]) =>
          colorMix(last(on, "--cal-ink") ?? last(fallback, "--cal-ink"), vars);
        const now = theme === "dark" ? ink(dark, base) : ink(base, base);
        const over = theme === "dark" ? ink(darkPast, past) : ink(past, past);
        const cases = [
          ["fill", now, colorMix(last(base, "--cal-fill"), vars)],
          ["hover", now, colorMix(last(base, "--cal-fill-on"), vars)],
          ["past", over, colorMix(last(past, "--cal-fill"), vars)],
          ["past hover", over, colorMix(last(past, "--cal-fill-on"), vars)],
        ] as const;
        for (const [state, words, fill] of cases) {
          const ratio = contrastRatio(words, fill);
          if (ratio < 4.5) low.push(`${theme} ${owner.name} ${state}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(low).toEqual([]);
  });
});
