import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGAIN_MS, contrastRatio, needsHeaderBlur, pushOnce, TAB_BADGE, tabBadge } from "../src/lib/nav";
import { coverTransform, PARALLAX, progress } from "../src/lib/parallax";
import { parseTabGlyphKey, TAB_GLYPHS, tabGlyphKey, tabGlyphSvg } from "../src/ui/tabGlyphs";

describe("native navigation helpers", () => {
  test("tab badge: hidden at zero, the count, then 99+", () => {
    expect(tabBadge(0)).toBeUndefined();
    expect(tabBadge(-3)).toBeUndefined();
    expect(tabBadge(Number.NaN)).toBeUndefined();
    expect(tabBadge(1)).toBe("1");
    expect(tabBadge(99)).toBe("99");
    expect(tabBadge(100)).toBe("99+");
  });

  test("header blur only on iOS before Liquid Glass (26)", () => {
    expect(needsHeaderBlur("ios", "18.4")).toBe(true);
    expect(needsHeaderBlur("ios", "26.0")).toBe(false);
    expect(needsHeaderBlur("ios", "27.1")).toBe(false);
    expect(needsHeaderBlur("android", 35)).toBe(false);
    expect(needsHeaderBlur("ios", "unknown")).toBe(false);
  });

  test("contrast ratio: WCAG values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  test("tab badge colors: white text is legible on the badge (iOS draws it white)", () => {
    expect(TAB_BADGE.text).toBe("#ffffff");
    expect(contrastRatio(TAB_BADGE.background, TAB_BADGE.text)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("cover parallax", () => {
  test("progress clamps to 0..1", () => {
    expect(progress(-10, 0, 40)).toBe(0);
    expect(progress(20, 0, 40)).toBe(0.5);
    expect(progress(80, 0, 40)).toBe(1);
    expect(progress(5, 10, 10)).toBe(0);
    expect(progress(10, 10, 10)).toBe(1);
  });

  test("at rest the cover doesn't move", () => {
    expect(coverTransform(0, 300)).toEqual({ translateY: 0, scale: 1 });
  });

  test("scrolled up, the cover lags behind the content", () => {
    expect(coverTransform(100, 300)).toEqual({ translateY: 100 * PARALLAX, scale: 1 });
    // Capped at the cover's height.
    expect(coverTransform(5000, 300)).toEqual({ translateY: 300 * PARALLAX, scale: 1 });
  });

  test("pulled down, the cover grows from its bottom edge to fill the gap", () => {
    const h = 300;
    const pull = 60;
    const t = coverTransform(-pull, h);
    expect(t.scale).toBeCloseTo((h + pull) / h, 6);
    // Scaled around its center and moved up: the bottom stays, the top rises by the pull.
    const bottom = h / 2 + (h / 2) * t.scale + t.translateY;
    const top = h / 2 - (h / 2) * t.scale + t.translateY;
    expect(bottom).toBeCloseTo(h, 6);
    expect(top).toBeCloseTo(-pull, 6);
  });

  test("no size or a bad offset: no transform", () => {
    expect(coverTransform(-50, 0)).toEqual({ translateY: 0, scale: 1 });
    expect(coverTransform(Number.NaN, 300)).toEqual({ translateY: 0, scale: 1 });
  });
});

describe("tab glyphs", () => {
  test("five tabs: Conversas, Threads, Agentes, Atividade and Buscar", () => {
    expect([...TAB_GLYPHS]).toEqual(["chats", "threads", "agents", "activity", "search"]);
  });

  test("every glyph in both states is a 24×24 SVG with finite numbers", () => {
    for (const glyph of TAB_GLYPHS) {
      for (const selected of [false, true]) {
        const svg = tabGlyphSvg(glyph, selected, "#000");
        expect(
          svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'),
        ).toBe(true);
        expect(svg.endsWith("</svg>")).toBe(true);
        expect(svg).not.toContain("NaN");
        expect(svg).not.toContain("undefined");
      }
    }
  });

  test("outline when unselected, filled when selected", () => {
    for (const glyph of TAB_GLYPHS.filter((g) => g !== "search")) {
      const outline = tabGlyphSvg(glyph, false, "#000");
      const filled = tabGlyphSvg(glyph, true, "#000");
      expect(outline).not.toBe(filled);
      expect(outline).toContain('fill="none"');
      expect(filled).toContain('fill="#000"');
    }
  });

  test("the selected agent is a solid body with the eyes cut out", () => {
    const svg = tabGlyphSvg("agents", true, "#000");
    expect(svg).toContain('fill-rule="evenodd"');
    // Body plus two eyes: three closed subpaths in one path.
    expect(svg.match(/Z/g)?.length).toBe(3);
  });

  test("Threads: two bubbles (filled when selected) and the branch between them stays a line", () => {
    const outline = tabGlyphSvg("threads", false, "#000");
    const filled = tabGlyphSvg("threads", true, "#000");
    expect(outline.match(/<path /g)?.length).toBe(3);
    expect(outline.match(/fill="none"/g)?.length).toBe(3);
    expect(filled.match(/fill="#000"/g)?.length).toBe(2);
    expect(filled.match(/fill="none"/g)?.length).toBe(1);
  });

  test("Buscar: the magnifier, never filled, bolder when selected", () => {
    const outline = tabGlyphSvg("search", false, "#000");
    const bold = tabGlyphSvg("search", true, "#000");
    expect(outline).toContain("<circle ");
    expect(bold).not.toContain('fill="#000"');
    expect(outline).toContain('stroke-width="1.7"');
    expect(bold).toContain('stroke-width="2.3"');
  });

  test("glyph keys round-trip and reject unknown names", () => {
    for (const glyph of TAB_GLYPHS) {
      for (const selected of [false, true]) {
        expect(parseTabGlyphKey(tabGlyphKey(glyph, selected))).toEqual({ glyph, selected });
      }
    }
    expect(parseTabGlyphKey("house")).toBeNull();
    expect(parseTabGlyphKey("house.selected")).toBeNull();
  });
});

describe("a quick double tap opens a screen once", () => {
  test("the same screen pushed again within a moment goes once; another screen, or the same later, goes", () => {
    let now = 1000;
    const pushed: unknown[] = [];
    const push = pushOnce(
      (to: unknown) => pushed.push(to),
      () => now,
    );
    push("/chat/c1");
    now += 120;
    push("/chat/c1");
    expect(pushed).toEqual(["/chat/c1"]);
    push("/agent/a1");
    expect(pushed).toEqual(["/chat/c1", "/agent/a1"]);
    now += AGAIN_MS;
    push("/agent/a1");
    expect(pushed).toEqual(["/chat/c1", "/agent/a1", "/agent/a1"]);
    // The same path with other params is another screen.
    push({ pathname: "/chat/[channelId]", params: { channelId: "c1" } });
    push({ pathname: "/chat/[channelId]", params: { channelId: "c2" } });
    expect(pushed).toHaveLength(5);
  });

  test("every screen navigates with the app's router, never expo-router's own (which pushes a double tap twice)", () => {
    const root = join(import.meta.dir, "..");
    const own = join(root, "src/ui/navigation.tsx");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const direct = [...files(join(root, "src")), ...files(join(root, "app"))].filter(
      (f) => f !== own && /import\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*"expo-router"/.test(readFileSync(f, "utf8")),
    );
    expect(direct).toEqual([]);
    expect(readFileSync(own, "utf8")).toContain("export const router: typeof expoRouter = new Proxy(expoRouter");
  });
});
