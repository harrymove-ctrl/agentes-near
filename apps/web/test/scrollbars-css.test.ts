import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";
import { withShim } from "@/components/artifacts/HtmlFrame";
import { atRule, declarations, rules, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];
const KIT = "packages/ui/src/styles/components.css";
/** The only place for the standard properties: Chrome ignores the pseudo-elements on an element that sets them. */
const FIREFOX = "@supports not selector(::-webkit-scrollbar)";
/** Where the kit draws ours: a touch screen keeps the platform's indicator, which takes no room. */
const POINTER = "@media (hover: hover) and (pointer: fine)";

const read = (file: string) => Bun.file(path.join(ROOT, file)).text();
/** Every stylesheet of the web app, the kit and the desktop app, as [path, text]. */
async function sheets() {
  const out: [string, string][] = [];
  for (const dir of SOURCES)
    for await (const file of new Glob("**/*.css").scan(path.join(ROOT, dir)))
      out.push([`${dir}/${file}`, await read(`${dir}/${file}`)]);
  return out;
}
/** The value a selector's rules end up giving a property. */
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1] ?? "";
const px = (v: string) => Number.parseFloat(v);
/** A `margin` or `padding` shorthand's four sides, in px. */
const sides = (v: string) => {
  const [top = Number.NaN, right = top, bottom = top, left = right] = v.split(/\s+/).map(px);
  return { top, right, bottom, left };
};
/** How far the focus ring reaches outside its element, in px. */
async function focusRing() {
  const tokens = await read("packages/ui/src/styles/tokens.css");
  const ring = tokens.match(/--focus-ring:([^;]+);/)?.[1] ?? "";
  return Math.max(...[...ring.matchAll(/0 0 0 ([\d.]+)px/g)].map((m) => Number(m[1])));
}
/** `wide` matches whatever `selector` matches: the same, or its last part after a descendant or child combinator. */
const covers = (wide: string, selector: string) =>
  selector === wide || selector.endsWith(` ${wide}`) || selector.endsWith(`>${wide}`);

/** Selectors whose rules say `property: value`, across every stylesheet. */
async function selectorsWith(match: (property: string, value: string) => boolean) {
  const out: string[] = [];
  for (const [, css] of await sheets())
    for (const rule of rules(css)) if (rule.declarations.some(([p, v]) => match(p, v))) out.push(...rule.selectors);
  return out;
}

/**
 * Everything that scrolls sideways: a strip that scrolls by swipe hides its scrollbar, content read with a pointer
 * keeps the kit's. A new one goes here, one way or the other.
 */
const SIDEWAYS: Record<string, "strip" | "content"> = {
  ".agp-subnav": "strip",
  ".ac-tabs": "strip",
  ".settings__groups": "strip",
  ".channel-settings__nav": "strip",
  ".onb__steps": "strip",
  ".newag .onb__steps": "strip",
  ".newag__tips": "strip",
  ".issues-now__list": "strip",
  ".threads-tabs": "strip",
  ".nt-segwrap": "strip",
  ".mi-files__tabs": "strip",
  ".ac-seg": "strip",
  ".ac-toolbar__filters": "strip",
  ".ac-toolbar[data-stack]>.ac-toolbar__filters": "strip",
  ".ac-carousel__track": "strip",
  ".dk-orgpick": "strip",
  ".wiki-doc .wiki-editor__bar": "strip",
  ".nac-band__path": "strip",
  ".code-card__code": "content",
  ".code-card__preview": "content",
  ".level-matrix": "content",
  ".pu-table-card": "content",
  ".spec-block__table": "content",
  ".machine-command__code": "content",
  ".md__table-scroll": "content",
  ".issues-boardwrap": "content",
  ".team-tree": "content",
  ".mi-log": "content",
  ".mi-cmd__line": "content",
  ".ac-msg__text pre": "content",
};

describe("our scrollbars, never the browser's", () => {
  test("the kit draws one for whatever scrolls under a mouse or a trackpad: thin and rounded on a clear track, no arrows, in the theme's ink", async () => {
    const source = await read(KIT);
    const kit = atRule(source, POINTER);
    // A touch screen keeps the platform's: nothing of ours outside that block.
    expect(declarations(source, "::-webkit-scrollbar")).toEqual(declarations(kit, "::-webkit-scrollbar"));
    expect(atRule(source, FIREFOX)).toBe(atRule(kit, FIREFOX));
    expect(px(value(kit, "::-webkit-scrollbar", "width"))).toBeLessThanOrEqual(10);
    expect(value(kit, "::-webkit-scrollbar", "height")).toBe(value(kit, "::-webkit-scrollbar", "width"));
    expect(value(kit, "::-webkit-scrollbar-track", "background")).toBe("transparent");
    expect(value(kit, "::-webkit-scrollbar-corner", "background")).toBe("transparent");
    expect(value(kit, "::-webkit-scrollbar-button", "display")).toBe("none");
    expect(value(kit, "::-webkit-scrollbar-thumb", "border-radius")).toBe("var(--radius-full)");
    expect(value(kit, "::-webkit-scrollbar-thumb", "background")).toStartWith("var(--scroll-thumb) ");
    expect(value(kit, "::-webkit-scrollbar-thumb:hover", "background-color")).toBe("var(--scroll-thumb-hover)");
    // Mixed from the ink on the page's root and on any subtree with its own theme; stronger under the pointer.
    const tokens = topLevel(source);
    const share = (token: string) => {
      const mix = value(tokens, "[data-theme]", token);
      expect(value(tokens, ":root", token)).toBe(mix);
      return Number(mix.match(/^color-mix\(in srgb, var\(--ink\) (\d+)%, transparent\)$/)?.[1]);
    };
    expect(share("--scroll-thumb")).toBeGreaterThan(0);
    expect(share("--scroll-thumb-hover")).toBeGreaterThan(share("--scroll-thumb"));
    expect(declarations(atRule(kit, FIREFOX), "*")).toEqual([
      ["scrollbar-width", "thin"],
      ["scrollbar-color", "var(--scroll-thumb) transparent"],
    ]);
  });

  test("nothing brings the browser's back: the standard properties only for Firefox, a pseudo-element only to hide", async () => {
    const standard = (p: string, v: string) => p === "scrollbar-color" || (p === "scrollbar-width" && v !== "none");
    const stated = (css: string) =>
      rules(css).flatMap((r) =>
        r.selectors.flatMap((s) =>
          r.declarations.filter(([p, v]) => standard(p, v)).map(([p, v]) => `${s} {${p}: ${v}}`),
        ),
      );
    const found: string[] = [];
    for (const [file, css] of await sheets()) {
      const outside = stated(css);
      for (const allowed of stated(atRule(css, FIREFOX))) outside.splice(outside.indexOf(allowed), 1);
      found.push(...outside.map((d) => `${file}: ${d}`));
      for (const rule of rules(css))
        for (const s of rule.selectors.filter((s) => s.includes("::-webkit-scrollbar")))
          for (const [p, v] of rule.declarations)
            if (!(p === "display" && v === "none") && !(file === KIT && s.startsWith("::-webkit-scrollbar")))
              found.push(`${file}: ${s} {${p}: ${v}}`);
    }
    expect(found).toEqual([]);
  });

  test("a strip hides its scrollbar in every engine: `scrollbar-width: none` and `::-webkit-scrollbar` hidden", async () => {
    const hidden = (await selectorsWith((p, v) => p === "display" && v === "none"))
      .filter((s) => s.endsWith("::-webkit-scrollbar"))
      .map((s) => s.slice(0, -"::-webkit-scrollbar".length));
    const none = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    expect(none.filter((s) => !hidden.some((h) => covers(h, s)))).toEqual([]);
  });

  test("whatever scrolls sideways is a strip that hides its scrollbar or content that keeps ours", async () => {
    const sideways = await selectorsWith((p, v) => p === "overflow-x" && /auto|scroll/.test(v));
    expect([...new Set(sideways)].sort()).toEqual(Object.keys(SIDEWAYS).sort());
    const none = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    const kinds = Object.keys(SIDEWAYS).map((s) => [s, none.some((h) => covers(h, s)) ? "strip" : "content"]);
    expect(Object.fromEntries(kinds)).toEqual(SIDEWAYS);
  });

  test("the thumb stops short of a box's ends, inside the curve of any corner a box that scrolls rounds", async () => {
    const kit = atRule(await read(KIT), POINTER);
    const tokens = await read("packages/ui/src/styles/tokens.css");
    const token = (name: string) => px(tokens.match(new RegExp(`${name}:\\s*([\\d.]+)px`))?.[1] ?? "");
    // Chrome draws a scrollbar over its own box's rounded corners: half the largest radius off each end…
    expect(value(kit, "::-webkit-scrollbar-track:vertical", "margin")).toBe("calc(var(--radius-section) / 2) 0");
    expect(value(kit, "::-webkit-scrollbar-track:horizontal", "margin")).toBe("0 calc(var(--radius-section) / 2)");
    // …and nothing that scrolls with a bar rounds its corners more than that.
    // Each corner's radius (a `calc()` one as the sum of its lengths), the largest.
    const radius = (v: string) =>
      Math.max(
        0,
        ...(v.match(/(?:[^\s/()]|\([^()]*(?:\([^()]*\)[^()]*)*\))+/g) ?? []).map((r) =>
          (r.match(/var\(--[\w-]+\)|[\d.]+px/g) ?? [])
            .map((n) => (n.startsWith("var(") ? token(n.slice(4, -1)) : px(n)))
            .filter(Number.isFinite)
            .reduce((a, b) => a + b, 0),
        ),
      );
    const scrollers = new Set(await selectorsWith((p, v) => /^overflow(-[xy])?$/.test(p) && /auto|scroll/.test(v)));
    const strips = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    const rounder: string[] = [];
    for (const [file, css] of await sheets())
      for (const rule of rules(css))
        for (const s of rule.selectors.filter((s) => scrollers.has(s) && !strips.some((h) => covers(h, s))))
          for (const [p, v] of rule.declarations)
            if (p === "border-radius" && radius(v) > token("--radius-section")) rounder.push(`${file}: ${s} {${v}}`);
    expect(rounder).toEqual([]);
  });

  test("a fade at a scroller's end spares our scrollbar: its mask adds the kit's strip, as wide as the scrollbar", async () => {
    const source = await read(KIT);
    const kit = atRule(source, POINTER);
    const width = value(kit, "::-webkit-scrollbar", "width");
    expect(value(atRule(kit, "@supports selector(::-webkit-scrollbar)"), ":root", "--scroll-strip")).toBe(
      `linear-gradient(to left, #000 ${width}, transparent 0)`,
    );
    expect(value(atRule(kit, "@supports selector(::-webkit-scrollbar)"), ":root", "--scroll-strip-x")).toBe(
      `linear-gradient(to top, #000 ${width}, transparent 0)`,
    );
    // Nothing where the kit draws no scrollbar.
    expect(value(topLevel(source), ":root", "--scroll-strip")).toBe("linear-gradient(transparent 0 0)");
    expect(value(topLevel(source), ":root", "--scroll-strip-x")).toBe("linear-gradient(transparent 0 0)");
    const scrollers = await selectorsWith((p, v) => /^overflow(-[xy])?$/.test(p) && /auto|scroll/.test(v));
    const strips = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    const on = (scroller: string, s: string) =>
      covers(scroller, s) || s.startsWith(`${scroller}[`) || s.startsWith(`${scroller}:`);
    const masks: [string, string][] = [];
    for (const [file, css] of await sheets())
      for (const rule of rules(css))
        for (const s of rule.selectors.filter((s) => scrollers.some((t) => on(t, s)) && !strips.some((t) => on(t, s))))
          for (const [p, v] of rule.declarations)
            if (/^(-webkit-)?mask(-image)?$/.test(p)) masks.push([`${file}: ${s} {${p}}`, v]);
    expect(masks.map(([at]) => at)).toContain("apps/web/src/layout.css: .channel__messages {mask-image}");
    expect(masks.filter(([, v]) => !/,\s*var\(--scroll-strip(-x)?\)$/.test(v)).map(([at]) => at)).toEqual([]);
  });

  test("an agent's HTML page scrolls with ours: the kit's sizes, a grey for any page, the track on its own background", async () => {
    const kit = atRule(await read(KIT), POINTER);
    const page = atRule(withShim("<p>x</p>").match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "", POINTER);
    for (const [selector, property] of [
      ["::-webkit-scrollbar", "width"],
      ["::-webkit-scrollbar", "height"],
      ["::-webkit-scrollbar-button", "display"],
      ["::-webkit-scrollbar-thumb", "border"],
      ["::-webkit-scrollbar-thumb:hover", "border-width"],
    ] as const)
      expect(value(page, selector, property)).toBe(value(kit, selector, property));
    // The page's own scrollbar is styled from its <body>, and a clear track would show the frame's white beside it.
    expect(value(page, "::-webkit-scrollbar-track", "background-color")).toBe("inherit");
    expect(value(page, "::-webkit-scrollbar-thumb", "background")).toMatch(
      /^rgba\(128,\s*128,\s*128,\s*\.\d+\) padding-box$/,
    );
  });

  test("a code card's longer code scrolls into its height in a message too, where the kit keeps code from scrolling up and down", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    expect(value(topLevel(await read(KIT)), ".ac-msg__text pre", "overflow-y")).toBe("hidden");
    expect(value(layout, ".code-card__code", "max-height")).toBe("420px");
    expect(value(layout, ".ac-msg__text .code-card__code", "overflow-y")).toBe("auto");
  });

  test("an agent's face by a scroller's edge never scrolls it: the room for its accessories is drawn, not laid out", async () => {
    const kit = topLevel(await read(KIT));
    // The canvas reaches past the face (ACCESSORY_REACH): as ink overflow, a scroller doesn't count it.
    expect(value(kit, ".ac-avatar__canvas", "height")).toBe("200%");
    expect(value(kit, ".ac-avatar--agent", "contain")).toBe("layout");
  });
});

describe("the collapsed sidebar", () => {
  const RAIL = '.sidebar[data-rail="true"]';

  test("a channel is a tile of its initials, as big as an agent's face, centred in its row", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    const kit = topLevel(await read(KIT));
    const tile = (property: string) => value(layout, `${RAIL} .sidebar__channel-abbr`, property);
    expect([tile("width"), tile("height")]).toEqual([
      value(kit, ".ac-avatar--sm", "width"),
      value(kit, ".ac-avatar--sm", "height"),
    ]);
    expect([tile("display"), tile("place-items")]).toEqual(["grid", "center"]);
    expect(tile("background")).not.toBe("");
    expect(tile("border-radius")).not.toBe("");
    // The rows a face sits in.
    expect(value(layout, `${RAIL} .sidebar__item`, "width")).toBe("var(--control-h-md)");
    expect(value(layout, `${RAIL} .sidebar__item`, "justify-content")).toBe("center");
  });

  test("nothing cut: one column for an item and its focus ring, on the rail's middle, with the scrollbar's room beside it", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    const kit = atRule(await read(KIT), POINTER);
    const tokens = await read("packages/ui/src/styles/tokens.css");
    const item = px(tokens.match(/--control-h-md:\s*([\d.]+)px/)?.[1] ?? "");
    const ring = await focusRing();
    const rail = { width: px(value(layout, RAIL, "width")), padding: sides(value(layout, RAIL, "padding")) };
    const list = `${RAIL} .sidebar__scroll`;
    const column = px(value(layout, list, "grid-template-columns"));
    const padding = sides(value(layout, list, "padding"));
    const margin = sides(value(layout, list, "margin"));
    expect(value(layout, list, "display")).toBe("grid");
    expect(value(layout, list, "justify-items")).toBe("center");
    // Edge to edge on the rail…
    expect([margin.left, margin.right]).toEqual([-rail.padding.left, -rail.padding.right]);
    // …one column that holds an item and its ring…
    expect(column).toBeGreaterThanOrEqual(item + 2 * ring);
    // …on the rail's middle, as the header and the foot…
    expect(padding.left + column / 2).toBe(rail.width / 2);
    // …and after it the room for the kit's scrollbar, so a scrollbar never squeezes the column…
    expect(rail.width - padding.left - column - padding.right).toBeGreaterThanOrEqual(
      px(value(kit, "::-webkit-scrollbar", "width")),
    );
    // …nor makes the list scroll sideways, whatever an engine's takes (Firefox's thin is 11px on macOS).
    expect(value(layout, list, "overflow-x")).toBe("hidden");
  });

  test("its scrollbar shows only while the pointer is on the list or the keyboard moves through it", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    // Through the token: Chrome repaints a scrollbar on a change to its element's style, not to its pseudo-elements'.
    const quiet = rules(layout).find((r) => r.selectors.some((s) => s.endsWith(":not(:hover,:has(:focus-visible))")));
    expect(quiet?.declarations).toEqual([["--scroll-thumb", "transparent"]]);
    expect(quiet?.selectors[0]).toContain(".sidebar__scroll");
  });
});

describe("the open sidebar", () => {
  test("its rows end where the header's and the foot's do, and keep their width when the list starts to scroll", async () => {
    const source = await read("apps/web/src/layout.css");
    const layout = topLevel(source);
    const kit = atRule(await read(KIT), POINTER);
    // Where the kit draws ours and the room is really kept, and only there: elsewhere the scrollbar takes no room, or
    // room of its own size, and a WebKit without `scrollbar-gutter` (the Mac app's) keeps none while the list doesn't
    // scroll, so the list keeps its full side padding.
    const ours = atRule(
      atRule(source, POINTER),
      "@supports selector(::-webkit-scrollbar) and (scrollbar-gutter: stable)",
    );
    const list = '.sidebar:not([data-rail="true"]) .sidebar__scroll';
    const sidebar = sides(value(layout, ".sidebar", "padding"));
    const padding = px(value(ours, list, "padding-right"));
    // The list reaches the sidebar's edge, where its scrollbar sits…
    expect(sides(value(layout, ".sidebar__scroll", "margin")).right).toBe(-sidebar.right);
    // …in room kept whether it scrolls or not…
    expect(value(ours, list, "scrollbar-gutter")).toBe("stable");
    // …taken from the list's side padding, so its rows end as far from the edge as everything else in the sidebar…
    expect(padding + px(value(kit, "::-webkit-scrollbar", "width"))).toBe(sidebar.right);
    // …with what is left of it holding a row's focus ring, which the list would clip.
    expect(padding).toBeGreaterThanOrEqual(await focusRing());
  });
});

describe("columns that scroll on their own", () => {
  /** The work area's columns: each one scrolls by itself, its thumb shows only while the pointer is on it. */
  const COLUMNS = [
    ".sidebar__scroll",
    ".shell__main",
    ".shell__main .page-split>*",
    ".issues-col>.issues-col__cards",
    ".members-side",
    ".dm-side__scroll",
    ".thread-panel__page",
    ".wiki-nav",
    ".wiki__center",
    ".cal-side",
    ".cal-agenda",
    ".cal-week__scroll",
  ];
  test("each hides its thumb until the pointer or the keyboard is on it, with its room kept", async () => {
    const layout = topLevel(await read("apps/web/src/layout.css"));
    const quiet = rules(layout).find((r) => r.selectors.some((s) => s.endsWith(":not(:hover,:has(:focus-visible))")));
    const listed = (quiet?.selectors[0] ?? "").replace(/^:is\(|\):not\(:hover,:has\(:focus-visible\)\)$/g, "");
    expect(listed.split(",")).toEqual(COLUMNS);
    // The scrollbar stays drawn (clear), so nothing moves when it shows.
    expect(quiet?.declarations).toEqual([["--scroll-thumb", "transparent"]]);
  });
});
