import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentRadius,
  dark,
  durations,
  fonts,
  light,
  motion,
  radius,
  type ShadowLayer,
  shadows,
  space,
  type ThemeColors,
  text,
  tracking,
} from "../src/index";

/** tokens.css is the source of truth; these tests keep the TS values equal to it. */
const CSS = readFileSync(
  join(import.meta.dir, "..", "..", "..", "docs", "design", "design-system", "tokens.css"),
  "utf8",
);

type Vars = Map<string, string>;

/** The custom properties of each rule, in order: light, dark, then the theme-independent ones. */
function blocks(css: string): { selector: string; vars: Vars }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    vars: new Map(
      [...(m[2] ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((d): [string, string] => [
        d[1] ?? "",
        (d[2] ?? "").trim(),
      ]),
    ),
  }));
}

const all = blocks(CSS);
const block = (match: (selector: string) => boolean) => {
  const found = all.find((b) => match(b.selector));
  if (!found) throw new Error("tokens.css: block not found");
  return found.vars;
};
const lightVars = block((s) => s.includes('[data-theme="light"]'));
const darkVars = block((s) => s.includes('[data-theme="dark"]'));
const sharedVars = block((s) => s.includes("[data-theme]") && !s.includes("="));

const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const SHADOWS = ["e1", "e2", "e3", "top"] as const;
/** CSS-only state tokens (the web's chosen state, the sidebar's plates): composite values with no RN equivalent. */
const CSS_ONLY = ["chosen-bg", "chosen-press", "chosen-shadow", "chosen-lift", "side-hover", "side-chosen"];
const resolve = (value: string, theme: Vars) =>
  value.replace(/var\(--([\w-]+)\)/g, (_, n: string) => theme.get(n) ?? "");

/** The theme's colors as the TS should have them: its own variables, plus the v1 aliases resolved. */
function expectedColors(theme: Vars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of theme)
    if (!(SHADOWS as readonly string[]).includes(name) && !CSS_ONLY.includes(name)) out[camel(name)] = value;
  for (const [name, value] of sharedVars) {
    const ref = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
    if (ref && theme.has(ref) && !(SHADOWS as readonly string[]).includes(ref) && !CSS_ONLY.includes(name))
      out[camel(name)] = theme.get(ref) ?? "";
  }
  return out;
}

/** `0 1px 2px -1px rgba(…), inset 0 1px 0 #fff` → layers. */
function parseShadow(value: string, theme: Vars): ShadowLayer[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of resolve(value, theme)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(current.trim());
      current = "";
    } else current += ch;
  }
  layers.push(current.trim());
  return layers.map((layer) => {
    const inset = layer.startsWith("inset ");
    const m = /^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(?:(-?[\d.]+)(?:px)?\s+)?(.+)$/.exec(
      inset ? layer.slice(6) : layer,
    );
    if (!m) throw new Error(`tokens.css: unreadable shadow layer "${layer}"`);
    return {
      x: Number(m[1]),
      y: Number(m[2]),
      blur: Number(m[3]),
      spread: Number(m[4] ?? 0),
      color: m[5] ?? "",
      ...(inset ? { inset: true } : {}),
    };
  });
}

const px = (name: string) => Number.parseFloat(sharedVars.get(name) ?? "NaN");

describe("@agenteschat/tokens equals tokens.css", () => {
  for (const [name, colors, vars] of [
    ["light", light, lightVars],
    ["dark", dark, darkVars],
  ] as [string, ThemeColors, Vars][]) {
    test(`${name} colors`, () => {
      expect<unknown>({ ...colors }).toEqual(expectedColors(vars));
    });

    test(`${name} shadows`, () => {
      const theme = name === "light" ? shadows.light : shadows.dark;
      for (const s of SHADOWS) expect<unknown>(theme[s]).toEqual(parseShadow(vars.get(s) ?? "", vars));
    });
  }

  test("radius, space, text and tracking", () => {
    for (const [key, value] of Object.entries(radius)) expect<unknown>(value).toBe(px(`radius-${key}`));
    const cssRadii = [...sharedVars.keys()].filter((k) => k.startsWith("radius-") && k !== "radius-agent");
    expect<unknown>(cssRadii.map((k) => k.slice("radius-".length)).sort()).toEqual(Object.keys(radius).sort());
    expect<unknown>(agentRadius.map((v) => `${Math.round(v * 100)}%`).join(" ")).toBe(
      sharedVars.get("radius-agent") ?? "",
    );
    for (const [key, value] of Object.entries(space)) expect<unknown>(value).toBe(px(`space-${key}`));
    for (const [key, value] of Object.entries(text)) expect<unknown>(value).toBe(px(`text-${key}`));
    for (const [key, value] of Object.entries(tracking)) expect<unknown>(value).toBe(px(`track-${key}`));
  });

  test("fonts and motion", () => {
    const first = (stack: string) => (stack.split(",")[0] ?? "").trim().replace(/^"|"$/g, "");
    expect<unknown>(fonts.sans).toBe(first(sharedVars.get("font-sans") ?? ""));
    expect<unknown>(fonts.mono).toBe(first(sharedVars.get("font-mono") ?? ""));
    const bezier = (name: string) =>
      (/cubic-bezier\(([^)]*)\)/.exec(sharedVars.get(name) ?? "")?.[1] ?? "").split(",").map((n) => Number(n.trim()));
    expect<unknown>([...motion.spring]).toEqual(bezier("spring"));
    expect<unknown>([...motion.out]).toEqual(bezier("out"));
    expect<unknown>([...motion.ios]).toEqual(bezier("drawer"));
    for (const [key, value] of Object.entries(durations))
      expect<unknown>(`${value}ms`).toBe(sharedVars.get(`dur-${key}`));
    // UI motion stays short: presses, menus and arrivals within 120 to 200ms, a panel's slide at most 260ms.
    for (const ms of [durations.fast, durations.base]) expect(ms >= 120 && ms <= 200).toBe(true);
    expect(durations.panel).toBeLessThanOrEqual(260);
  });
});
