import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, builtCss, declarations, rules, topLevel } from "./built-css";

/** A colour's alpha as the minifier writes it (#rgba, #rrggbbaa) or as rgba(). */
const alphaOf = (color: string) => {
  const hex = /^#([0-9a-f]+)$/i.exec(color)?.[1] ?? "";
  if (hex.length === 4) return Number.parseInt(hex.slice(3).repeat(2), 16) / 255;
  if (hex.length === 8) return Number.parseInt(hex.slice(6), 16) / 255;
  const a = /rgba\(([^)]*)\)/.exec(color)?.[1]?.split(",")[3];
  return a === undefined ? 1 : Number.parseFloat(a);
};

/** A box-shadow's layers: what shapes each (inset, offsets, blur) and its colour's alpha. */
const layers = (shadow = "") =>
  shadow.split(/,(?![^(]*\))/).map((layer) => {
    const color = /(#[0-9a-f]+|rgba?\([^)]*\))/i.exec(layer)?.[1] ?? "";
    return { shape: layer.replace(color, "").trim().replace(/\s+/g, " "), alpha: alphaOf(color) };
  });

/** A hex colour's first channel (the greys here are neutral). */
const level = (hex = "") => Number.parseInt(hex.replace("#", "").slice(0, 2), 16);

test("what ships keeps dark's chosen press visible, the ready line apart from the account, the key's note on its steps' columns", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  const last = (selector: string, property: string) =>
    declarations(shipped, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const light = '[data-theme="light"]';
  const dark = '[data-theme="dark"]';

  // Dark presses a chosen option into a face lighter than a card, where a black shadow shows, under light's shadow made
  // deeper: the same layers, each at least three times as dark. Light stays as it was.
  expect(level(last(dark, "--chosen-bg"))).toBeGreaterThan(level(last(dark, "--raised")));
  const darkPress = layers(last(dark, "--chosen-press"));
  const lightPress = layers(last(light, "--chosen-press"));
  expect(darkPress.map((l) => l.shape)).toEqual(lightPress.map((l) => l.shape));
  expect(darkPress.map((l, i) => l.alpha >= 3 * (lightPress[i]?.alpha ?? 1))).toEqual([true, true]);
  expect(last(light, "--chosen-bg")).toBe("var(--sunken)");
  expect(lightPress.map((l) => +l.alpha.toFixed(2))).toEqual([0.16, 0.12]);
  // Only the two theme blocks give the face: no later rule hands dark light's again.
  const giving = [...shipped.matchAll(/([^{}]+)\{[^{}]*--chosen-bg:/g)].map((m) =>
    (m[1] ?? "").replace(/\s+/g, "").replace(/"/g, ""),
  );
  expect(giving).toEqual([":root,[data-theme=light]", "[data-theme=dark]"]);

  // The computer ready, in a plan's panel: a group of its own over a hairline edge to edge. Its zero margin comes
  // after every margin a panel's note gets, @supports blocks included, so the account's words keep the group's gap.
  const ready = ".ai-panel--plan > .ai-panel__ready";
  expect(last(ready, "border-bottom")).toBe("1px solid var(--line)");
  expect(last(ready, "margin-inline")).toBe("calc(-1 * var(--card-pad))");
  expect(last(ready, "margin-bottom")).toBe("0");
  const at = (pattern: RegExp) => [...css.matchAll(pattern)].map((m) => m.index ?? -1);
  const noteMargins = at(/\.ai-panel--plan\s*>\s*\.ac-setnote\s*\{[^}]*margin/g);
  const readyRule = at(/\.ai-panel--plan\s*>\s*\.ai-panel__ready\s*\{[^}]*margin-bottom:\s*0/g);
  expect(noteMargins.length).toBeGreaterThan(0);
  expect(readyRule).toHaveLength(1);
  expect(Math.max(...noteMargins)).toBeLessThan(readyRule[0] ?? -1);
  expect(css).toMatch(/\.ai-panel--plan\s*>\s*\.ai-panel__ready\s*\{\s*padding-bottom:\s*calc\([^}]*lh\)/);

  // Under the key's steps its note keeps their columns: the icon centred in the 20px numbers', the words on the text's.
  expect(last(".ai-panel > .agp-addacct__step ~ .ac-setnote", "gap")).toBe("12px");
  expect(last(".ai-panel > .agp-addacct__step ~ .ac-setnote > :first-child", "margin-inline")).toBe("3px");

  // The computer's wait: every line under the steps' bar balances, and without it the status or hold line, which the
  // panel's pretty wrap ends on a word alone at 320 px. The email line takes the panel's wrap, and balances where
  // pretty isn't supported.
  const well = ".ai-panel__wait";
  expect(last(`${well}:has(> .setup-progress)`, "text-wrap")).toBe("balance");
  expect(last(`${well} > [role="status"]`, "text-wrap")).toBe("balance");
  expect(last(well, "text-wrap")).toBeUndefined();
  expect(last(".ai-panel", "text-wrap")).toBe("pretty");
  expect(declarations(atRule(css, "@supports not (text-wrap: pretty)"), well)).toEqual([["text-wrap", "balance"]]);
});

test("what ships rests a chosen control's neighbours on its pressed face, and a chosen card's tile is that face", async () => {
  // The pages' own sheets with the app's: a control and its chosen state may live in one.
  const sheets = [...new Bun.Glob("src/{pages,components}/**/*.css").scanSync({ cwd: join(import.meta.dir, "..") })];
  const css = await builtCss("src/styles.css", ...sheets);
  const shipped = rules(css);
  const sets = (r: (typeof shipped)[number], value: string) =>
    r.declarations.some(([p, v]) => (p === "background" || p === "background-color") && v === value);

  // Light's pressed face is its --sunken, dark's is lighter than its own: a control resting sunken while its chosen
  // state is the pressed face reads lighter chosen than not, in dark alone. Each rests on the pressed face instead.
  const STATE =
    /(\[aria-pressed=true\]|\[data-state=checked\]|\[aria-current=true\]|\[data-checked=true\]|\.is-on|\.is-selected)$/;
  const chosen = shipped
    .filter((r) => sets(r, "var(--chosen-bg)"))
    .flatMap((r) => r.selectors.filter((s) => STATE.test(s)).map((s) => s.replace(STATE, "")));
  expect(chosen).toEqual(expect.arrayContaining([".ac-recur__day", ".newag__opt", ".cal-mini__day", ".ac-optrow"]));
  const sunken = shipped
    .filter((r) => sets(r, "var(--sunken)") || sets(r, "var(--surface-sunken)"))
    .flatMap((r) => r.selectors);
  expect(sunken.length).toBeGreaterThan(0);
  expect(sunken.filter((s) => chosen.some((base) => s === base || s.startsWith(`${base}[`)))).toEqual([]);

  // A tile resting sunken on an option card is the chosen card's pressed face, as light's sunken is.
  const background = (selector: string) =>
    declarations(css, selector)
      .filter(([p]) => p === "background")
      .at(-1)?.[1];
  for (const tile of [".audience-card__icon", ".agp-wdlg__key"])
    expect([background(tile), background(`.ac-optrow[data-state="checked"] ${tile}`)]).toEqual([
      "var(--surface-sunken)",
      "var(--chosen-bg)",
    ]);
});
