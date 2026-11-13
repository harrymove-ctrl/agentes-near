import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
}

/** Every rule as [file, selector, body], comments removed; rules inside @media and @supports included. */
async function allRules() {
  const out: [string, string, string][] = [];
  for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".css"))) {
    const css = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const selector of (m[1] ?? "").split(","))
        out.push([relative(ROOT, file), selector.replace(/\s+/g, " ").trim(), m[2] ?? ""]);
  }
  return out;
}

/** A selector for a line's lead: an icon, a maker's mark, a bare svg, a row's first child, or a part named so. */
const LEAD = /(?:\.ac-icon|\.ac-brand[\w-]*|__[\w-]*(?:icon|avatar|mark|dot)|(?:^|[\s>+~])(?:svg|:first-child))$/;
const PX = String.raw`-?[1-4](?:\.\d+)?px`;
/** The hand-tuned nudges `.ac-iconline` replaces: a top margin (alone or the shorthand's first value), an offset. */
const NUDGE = new RegExp(
  String.raw`(?:^|;)\s*(?:margin(?:-top)?|top|vertical-align):\s*${PX}|(?:^|;)\s*translate:\s*0\s+${PX}|translateY\(\s*${PX}`,
);

/** A placement that adds part of an em under a line's middle: the x-height's middle, lower than where the eye centres. */
const X_HEIGHT_AIM = /(?:^|;)\s*(?:translate|top|margin(?:-top)?|vertical-align):[^;]*\+\s*[\d.]+em\b/;

/** Leads still placed by hand, and why. An entry leaves when its rule does. */
const PLACED_BY_HAND: Record<string, string> = {
  "packages/ui/src/styles/components.css .ac-menu__item .ac-icon":
    "menu items are one line (no wrapping) of 14px text on their own 20px line, which the 16px icon sits on",
  "apps/web/src/components/import-flow.css .imp-row__mark":
    "an import plan row's 18px check column centres on the row's 26px lead tile (.imp-row__lead), not on its text",
};

/** Where the opening tag that starts at `start` ends: braces are skipped, so an `=>` in an attribute doesn't end it. */
function openingEnd(src: string, start: number) {
  for (let i = start, depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === ">" && depth === 0) return i;
  }
  return src.length;
}

/** The literal class names an opening tag gives (`className="…"`, or the strings of `className={…}`). */
function classesOf(opening: string) {
  const at = opening.indexOf("className=");
  if (at < 0) return [];
  const value = opening.slice(at + 10);
  const expr = value.startsWith('"') ? value.slice(0, value.indexOf('"', 1) + 1) : value.slice(0, openingEnd(value, 0));
  return [...expr.matchAll(/["'`]([^"'`]*)["'`]/g)].flatMap((m) =>
    (m[1] ?? "").split(/\s+/).filter((c) => /^[a-z][\w-]*$/.test(c)),
  );
}

/** Every JSX element with literal classes, in the apps' and the kit's TSX: [where, tag, classes, children's source]. */
async function elements() {
  const out: { where: string; classes: string[]; body: string }[] = [];
  for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".tsx"))) {
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(/<([A-Za-z][\w.]*)[\s>]/g)) {
      const start = m.index ?? 0;
      const end = openingEnd(src, start);
      const opening = src.slice(start, end + 1);
      const classes = classesOf(opening);
      if (classes.length === 0) continue;
      let body = "";
      if (!opening.endsWith("/>")) {
        // Its closing tag: tags of the same name nest.
        const tag = m[1] ?? "";
        const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
        re.lastIndex = end + 1;
        let depth = 1;
        for (let t = re.exec(src); t; t = re.exec(src)) {
          if (t[0].startsWith("</")) depth--;
          else if (!src.slice(t.index, openingEnd(src, t.index) + 1).endsWith("/>")) depth++;
          if (depth === 0) {
            body = src.slice(end + 1, t.index);
            break;
          }
        }
      }
      const line = src.slice(0, start).split("\n").length;
      out.push({ where: `${relative(ROOT, file)}:${line}`, classes, body });
    }
  }
  return out;
}

/** The tags of an element's own children: not their children's, nor JSX inside an attribute. */
function childTags(body: string) {
  const tags: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.]*)/g;
  let depth = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1]) {
      depth--;
      continue;
    }
    const end = openingEnd(body, m.index);
    if (depth === 0) tags.push(m[2] ?? "");
    if (!body.slice(m.index, end + 1).endsWith("/>")) depth++;
    re.lastIndex = end + 1;
  }
  return tags;
}

/** A lead that starts a line: an icon, a spinner, a maker's mark or a face. */
const LEADS_WITH = /^\s*(?:\{[^<{}]*)?<(?:Icon|Spinner|PixelSpinner|ProviderLogo|\w*Avatar)\b/;
/** A control as tall as a button. */
const CONTROL = /^\w*Button$/;

describe("an icon before text sits on the text's first line", () => {
  test("no lead is nudged by hand: rows take .ac-iconline", async () => {
    const nudged = (await allRules())
      .filter(([, selector, body]) => LEAD.test(selector) && NUDGE.test(body))
      .map(([file, selector]) => `${file} ${selector}`);
    expect(nudged.filter((rule) => !(rule in PLACED_BY_HAND))).toEqual([]);
    // A rule that no longer nudges leaves the list too.
    expect(Object.keys(PLACED_BY_HAND).filter((rule) => !nudged.includes(rule))).toEqual([]);
  });

  test("a row's class that .ac-iconline lays out carries it wherever a lead starts that row", async () => {
    const all = await elements();
    const rows = new Set(
      all
        .filter((e) => e.classes.includes("ac-iconline"))
        .flatMap((e) => e.classes)
        // Utilities (`small`, `muted`) go with any row.
        .filter((c) => c !== "ac-iconline" && /[-_]/.test(c)),
    );
    const bare = all.filter(
      (e) => !e.classes.includes("ac-iconline") && e.classes.some((c) => rows.has(c)) && LEADS_WITH.test(e.body),
    );
    expect(bare.map((e) => `${e.where} ${e.classes.join(" ")}`)).toEqual([]);
  });

  test("a row that ends with a button keeps the button out of its .ac-iconline, so the row centres them", async () => {
    const lines = (await elements()).filter(
      (e) => e.classes.includes("ac-iconline") && childTags(e.body).some((tag) => CONTROL.test(tag)),
    );
    expect(lines.map((e) => `${e.where} ${e.classes.join(" ")}`)).toEqual([]);
  });

  test("a lead and an ⓘ sit on their line's capitals' middle (--cap-mid), a 22px-line fallback first", async () => {
    const rules = await allRules();
    const body = (selector: string) =>
      rules
        .filter(([file, s]) => file === "packages/ui/src/styles/components.css" && s === selector)
        .map(([, , b]) => b)
        .join("\n");
    const tokens = await Bun.file(join(ROOT, "packages/ui/src/styles/tokens.css")).text();
    expect(tokens).toMatch(/--cap-mid:\s*[\d.]+ex;/);
    expect(body(".ac-iconline")).toContain("align-items: flex-start");
    expect(body(".ac-iconline > :first-child")).toContain("flex: none");
    // The ⓘ's half is its 14px glyph's: its target's negative margins put the glyph's top on the line's.
    for (const [selector, half] of [
      [".ac-iconline > :first-child", "50%"],
      [".ac-hint", "7px"],
    ] as const) {
      const css = body(selector);
      const fallback = css.indexOf(`translate: 0 calc(11px - var(--cap-mid) - ${half})`);
      const lh = css.indexOf(`translate: 0 calc(0.5lh - var(--cap-mid) - ${half})`);
      expect(fallback).toBeGreaterThan(-1);
      expect(lh).toBeGreaterThan(fallback);
    }
    // A face keeps its initials' type but reads the row's line; every face is one row as tall as it, so a photo of
    // any shape fills it; a key centred with its title only rises.
    expect(body(".ac-iconline > .ac-avatar:first-child")).toContain("line-height: inherit");
    expect(body(".ac-avatar")).toContain("grid-template-rows: 100%");
    expect(body(".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key")).toContain("var(--cap-mid)");
    // A title alone keeps its first line in the middle of the key's 22px, however many lines it wraps to.
    expect(body(".ac-card__key")).toContain("height: 22px");
    expect(body(".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key + .ac-card__heading")).toContain(
      "padding-block: 1px",
    );
  });

  // A declaration holding var() parses even where lh is unknown, so as the second of a pair it would replace the px
  // fallback there and then compute to nothing.
  test("the lh unit sits behind @supports (top: 1lh), so a browser without it keeps the px fallback", async () => {
    const bare: string[] = [];
    for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".css"))) {
      const css = (await Bun.file(file).text())
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/@supports\s*\(\s*top:\s*1lh\s*\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      for (const m of css.matchAll(/[^;{}]*\dlh\b[^;{}]*/g)) bare.push(`${relative(ROOT, file)}: ${m[0].trim()}`);
    }
    expect(bare).toEqual([]);
  });

  test("nothing beside text aims at the x-height's middle (part of an em under the line's middle)", async () => {
    const aimed = (await allRules())
      .filter(([, , body]) => X_HEIGHT_AIM.test(body))
      .map(([file, selector]) => `${file} ${selector}`);
    expect(aimed).toEqual([]);
  });
});

/** The rules of one selector in the kit's stylesheet, joined; `@supports (top: 1lh)` ones last, as in the file. */
async function kitRule(selector: string) {
  return (await allRules())
    .filter(([file, s]) => file === "packages/ui/src/styles/components.css" && s === selector)
    .map(([, , b]) => b)
    .join("\n");
}

describe("a picture beside lines, a bubble beside a face, a row of actions", () => {
  test("lines start at a picture's top: --cap-top, .ac-faceline and .ac-captop with a 22px-line fallback first", async () => {
    const tokens = await Bun.file(join(ROOT, "packages/ui/src/styles/tokens.css")).text();
    expect(tokens).toMatch(/--cap-top:\s*0\.71ex;/);
    expect(await kitRule(".ac-faceline")).toContain("align-items: flex-start");
    const rise = await kitRule(".ac-captop");
    const fallback = rise.indexOf("margin-block-start: calc(var(--cap-top) - 11px)");
    expect(fallback).toBeGreaterThan(-1);
    expect(rise.indexOf("margin-block-start: calc(var(--cap-top) - 0.5lh)")).toBeGreaterThan(fallback);
    // The chat's name on its line (20px at the default text size) whose box starts at the face's top, never raised to
    // put its capitals there: capitals flush with the face's edge read as a face hanging under the name. Never a line
    // as tall as the face.
    const head = await kitRule(".ac-msg__head");
    expect(head).toContain("line-height: var(--msg-line-tight)");
    expect(head).not.toContain("margin-block-start");
    expect(await kitRule(".ac-msg__head > .ac-msg__aside")).toContain("align-self: center");
  });

  test("every .ac-faceline holds an .ac-captop: its first line rises to the picture's top", async () => {
    const lines = (await elements()).filter((e) => e.classes.includes("ac-faceline"));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((e) => !/\bac-captop\b/.test(e.body)).map((e) => e.where)).toEqual([]);
  });

  test("a row on .ac-iconline or .ac-faceline isn't re-centred elsewhere unless its lead is placed again", async () => {
    const all = await elements();
    const rows = new Set(
      all
        .filter((e) => e.classes.includes("ac-iconline") || e.classes.includes("ac-faceline"))
        .flatMap((e) => e.classes)
        .filter((c) => c !== "ac-iconline" && c !== "ac-faceline" && /[-_]/.test(c)),
    );
    const rules = await allRules();
    const recentred = rules.filter(([file, selector, body]) => {
      const align = /(?:^|;)\s*align-items:\s*([\w-]+)/.exec(body)?.[1];
      if (!align || align === "flex-start" || align === "start") return false;
      const last = selector.split(/[\s>+~]+/).pop() ?? "";
      if (![...rows].some((row) => new RegExp(`\\.${row}(?![\\w-])`).test(last))) return false;
      // Excluded from the primitive, or its lead placed again for the new centre.
      if (/:not\(\.ac-(?:iconline|faceline)\)/.test(selector)) return false;
      return !rules.some(([f, s, b]) => f === file && s.startsWith(`${selector} > `) && /translate:/.test(b));
    });
    expect(recentred.map(([file, selector]) => `${file} ${selector}`)).toEqual([]);
  });

  test("a host's face and its bubble start at one top (no bubble row aligned to its bottom)", async () => {
    const asks = (await allRules()).filter(([, selector]) => /__ask$/.test(selector));
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.filter(([, , body]) => /align-items:\s*(?:flex-)?end/.test(body)).map(([f, s]) => `${f} ${s}`)).toEqual(
      [],
    );
  });

  test("a row of actions: 16px between what shows, on touch too, ghosts reaching into the gap by their plate", async () => {
    const css = (await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).toMatch(/:root \{\s*--ghost-plate: 8px;\s*\}/);
    // A small plate stays 32 on touch, so its ghost's plate does too.
    expect(css).not.toMatch(/@media \(pointer: coarse\) \{\s*:root \{\s*--ghost-plate:/);
    expect(await kitRule(".ac-acts")).toContain("column-gap: calc(2 * var(--ghost-plate))");
    expect(await kitRule(".ac-acts > .ac-acts")).toContain("display: contents");
    expect(await kitRule(".ac-acts > .ac-btn--ghost")).toContain("margin-inline: calc(-1 * var(--ghost-plate))");
    expect(await kitRule(".ac-acts > .ac-btn--ghost:not(.ac-btn--icon)")).toContain(
      "padding-inline: var(--ghost-plate)",
    );
  });

  test("buttons side by side stand 8 apart: two plates, and two icons' plates, by the first's end so a wrapped one starts on the edge", async () => {
    // The row's gap is two ghost plates (16): a pair of plates gives back 8 of it, a pair of icons the 8 their plates
    // reach into it, less the first's glyph air.
    const plates = await kitRule(".ac-acts > .ac-btn:not(.ac-btn--ghost):has(+ .ac-btn:not(.ac-btn--ghost))");
    expect(plates).toContain("margin-inline-end: calc(var(--space-2) - 2 * var(--ghost-plate))");
    // Its selector holds a comma inside `:is()`, which the rule list splits on: read from the sheet itself.
    const css = await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text();
    expect(css).toContain(
      ".ac-acts > :is(.ac-btn--ghost.ac-btn--icon, .ac-btn--glyph):has(+ :is(.ac-btn--ghost.ac-btn--icon, .ac-btn--glyph)) {\n  margin-inline-end: calc(var(--space-2) - var(--ghost-plate) - var(--glyph-air, 0px));\n}",
    );
    // Never by the second's start: on a line of its own it would stick out of the row.
    expect(css).not.toMatch(/\.ac-acts > [^{]*\+ [^{]*\{\s*margin-inline-start/);
  });

  test("the pixel marks in a line of text centre on its capitals, never on the x-height's middle", async () => {
    for (const mark of [".ac-pixspin", ".ac-pixdone", ".ac-pixstop"]) {
      const rule = await kitRule(mark);
      expect(rule).not.toContain("middle");
      expect(rule).toContain("vertical-align: calc(var(--cap-top) - var(--cap-mid) - var(--mark-size, 14px) / 2)");
    }
    // Their baseline is their box's bottom: the two drawn in CSS place their pixel in an absolute child.
    expect(await kitRule(".ac-pixdone")).toContain("position: relative");
    expect(await kitRule(".ac-pixstop")).toContain("position: relative");
  });
});
