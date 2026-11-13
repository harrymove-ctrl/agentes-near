/**
 * @agenteschat/tokens: the design system's values for platforms without CSS
 * (the phone app). `docs/design/design-system/tokens.css` is the source of
 * truth; a test keeps these equal to it. Names are the CSS custom properties
 * in camelCase (`--line2` → `line2`, `--raised-2` → `raised2`).
 */

export interface ThemeColors {
  bg: string;
  raised: string;
  raised2: string;
  sunken: string;
  /** The app shell: the sidebar's paper and the work area beside it. */
  side: string;
  pane: string;
  glass: string;
  glassSolid: string;
  line: string;
  line2: string;
  lineStrong: string;
  ink: string;
  ink2: string;
  muted: string;
  faint: string;
  /** The keyboard focus ring's color (`--focus-color`, the strong line). */
  focusColor: string;
  agent: string;
  agent2: string;
  agentSoft: string;
  onAgent: string;
  ok: string;
  warn: string;
  warnSoft: string;
  onWarn: string;
  danger: string;
  info: string;
  plate: string;
  plateSoft: string;
  scrim: string;
  /** Names from v1 (aliases that follow the theme). */
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  inkMuted: string;
  action: string;
  onAction: string;
  attention: string;
  onAttention: string;
  attentionSoft: string;
  success: string;
}

export const light: ThemeColors = {
  bg: "#fbfbfa",
  raised: "#ffffff",
  raised2: "#ffffff",
  sunken: "#f3f3f0",
  side: "#f6f9fd",
  pane: "#ffffff",
  glass: "rgba(255, 255, 255, 0.88)",
  glassSolid: "#fbfbf9",
  line: "rgba(23, 23, 22, 0.07)",
  line2: "rgba(23, 23, 22, 0.12)",
  lineStrong: "#82827d",
  ink: "#151514",
  ink2: "#2a2a28",
  muted: "#5c5c58",
  faint: "#6f6f6a",
  focusColor: "#82827d",
  agent: "#0063d1",
  agent2: "#3d8bff",
  agentSoft: "#e3eefd",
  onAgent: "#ffffff",
  ok: "#1f7a45",
  warn: "#9a5b00",
  warnSoft: "#fbeed5",
  onWarn: "#ffffff",
  danger: "#b42a20",
  info: "#0a6f9e",
  plate: "rgba(127, 127, 127, 0.1)",
  plateSoft: "rgba(127, 127, 127, 0.06)",
  scrim: "rgba(10, 10, 10, 0.32)",
  surface: "#fbfbfa",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f3f3f0",
  inkMuted: "#5c5c58",
  action: "#151514",
  onAction: "#fbfbfa",
  attention: "#9a5b00",
  onAttention: "#ffffff",
  attentionSoft: "#fbeed5",
  success: "#151514",
};

export const dark: ThemeColors = {
  bg: "#0f0f0e",
  raised: "#1c1c1b",
  raised2: "#242423",
  sunken: "#0a0a09",
  side: "#0b0d11",
  pane: "#181817",
  glass: "rgba(30, 30, 28, 0.86)",
  glassSolid: "#1e1e1c",
  line: "rgba(255, 255, 255, 0.1)",
  line2: "rgba(255, 255, 255, 0.15)",
  lineStrong: "#71716c",
  ink: "#efefec",
  ink2: "#d6d6d2",
  muted: "#a3a39e",
  faint: "#8f8f89",
  focusColor: "#71716c",
  agent: "#5aa8ff",
  agent2: "#8cc3ff",
  agentSoft: "#11253f",
  onAgent: "#00203f",
  ok: "#5fc48a",
  warn: "#e0a84a",
  warnSoft: "#33260e",
  onWarn: "#2a1c00",
  danger: "#f08a80",
  info: "#5cc4ea",
  plate: "rgba(127, 127, 127, 0.14)",
  plateSoft: "rgba(127, 127, 127, 0.08)",
  scrim: "rgba(0, 0, 0, 0.5)",
  surface: "#0f0f0e",
  surfaceRaised: "#1c1c1b",
  surfaceSunken: "#0a0a09",
  inkMuted: "#a3a39e",
  action: "#efefec",
  onAction: "#0f0f0e",
  attention: "#e0a84a",
  onAttention: "#2a1c00",
  attentionSoft: "#33260e",
  success: "#efefec",
};

export const themes = { light, dark } as const;
export type ThemeName = keyof typeof themes;

/** One layer of a CSS `box-shadow` (px). */
export interface ShadowLayer {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  inset?: boolean;
}

export type ShadowName = "e1" | "e2" | "e3" | "top";

/** Elevations (`--e1`…`--e3`) and the raised top edge (`--top`), per theme, as layer lists. */
export const shadows: Record<ThemeName, Record<ShadowName, ShadowLayer[]>> = {
  light: {
    e1: [
      { x: 0, y: 1, blur: 1, spread: 0, color: "rgba(23, 23, 22, 0.04)" },
      { x: 0, y: 2, blur: 4, spread: -1, color: "rgba(23, 23, 22, 0.05)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(23, 23, 22, 0.07)" },
    ],
    e2: [
      { x: 0, y: 1, blur: 1, spread: 0, color: "rgba(23, 23, 22, 0.04)" },
      { x: 0, y: 6, blur: 16, spread: -4, color: "rgba(23, 23, 22, 0.1)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(23, 23, 22, 0.07)" },
    ],
    e3: [
      { x: 0, y: 2, blur: 4, spread: 0, color: "rgba(23, 23, 22, 0.04)" },
      { x: 0, y: 24, blur: 56, spread: -16, color: "rgba(23, 23, 22, 0.3)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(23, 23, 22, 0.12)" },
    ],
    top: [{ x: 0, y: 1, blur: 0, spread: 0, color: "rgba(255, 255, 255, 0.9)", inset: true }],
  },
  dark: {
    e1: [
      { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0, 0, 0, 0.5)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(255, 255, 255, 0.1)" },
    ],
    e2: [
      { x: 0, y: 8, blur: 20, spread: -6, color: "rgba(0, 0, 0, 0.6)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(255, 255, 255, 0.1)" },
    ],
    e3: [
      { x: 0, y: 28, blur: 64, spread: -16, color: "rgba(0, 0, 0, 0.8)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgba(255, 255, 255, 0.15)" },
    ],
    top: [{ x: 0, y: 1, blur: 0, spread: 0, color: "rgba(255, 255, 255, 0.08)", inset: true }],
  },
};

/** Corner radii (px). */
export const radius = {
  xs: 4,
  sm: 6,
  item: 10,
  md: 10,
  btn: 12,
  lg: 14,
  xl: 18,
  section: 20,
  cut: 2,
  full: 999,
} as const;

/** The agent symbol's corners (`--radius-agent`), as fractions of its size: top-left, top-right, bottom-right, bottom-left. */
export const agentRadius = [0.3, 0.3, 0.3, 0.09] as const;

/** Spacing steps (px), by `--space-N`. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const;

/** Type sizes (px). */
export const text = {
  xs: 12,
  sm: 13,
  md: 14.5,
  base: 15,
  lg: 16,
  h3: 17,
  h2: 20,
  h1: 28,
  display: 32,
} as const;

/** Letter spacing (em). */
export const tracking = {
  tight: -0.025,
  tighter: -0.035,
} as const;

/** Font families (the first family of each CSS stack; display and dot come from the brand pages). */
export const fonts = {
  sans: "Onest",
  display: "Funnel Display",
  dot: "Doto",
  mono: "Martian Mono",
} as const;

/** Cubic bezier curves `[x1, y1, x2, y2]`: `spring` and `out` from the tokens; `ios` for sheets (`--drawer`). */
export const motion = {
  spring: [0.34, 1.4, 0.5, 1],
  out: [0.2, 0.8, 0.2, 1],
  ios: [0.32, 0.72, 0, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Durations in ms (`--dur-*`): fast for presses, menus and exits, base for dialogs, toasts and arrivals, panel for a
 *  side panel's slide. */
export const durations = { fast: 140, base: 180, panel: 240 } as const;
