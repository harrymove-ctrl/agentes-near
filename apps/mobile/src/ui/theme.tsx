import { durations, motion as motionCurves, radius as radii, type ShadowLayer } from "@agenteschat/tokens";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Platform, useColorScheme } from "react-native";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { type AppColors, appColors, appShadows, type Scheme } from "./palette";

/**
 * The theme for React Native, from `@agenteschat/tokens` (tokens.css is the source of truth), with the light
 * theme made native like iOS (`palette.ts`). Rules (design system): neutral cards, chips with icons (never
 * colored dots), the brand blue only for agent identity, amber only for what waits on you, names in ink,
 * the mono font only for code; counts in the system font (Doto only for a rare hero number).
 */
export type { AppColors, Scheme } from "./palette";
export { weights } from "./type-scale";
export type ThemePreference = "system" | Scheme;

/** A token shadow as React Native's `boxShadow` string (New Architecture: layers, spread and inset). */
export const boxShadow = (layers: readonly ShadowLayer[]) =>
  layers.map((l) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${l.color}`).join(", ");

/**
 * Brand font families as loaded by `useAppFonts` (static files: React Native has no variable axes).
 * Body and UI text use the system font (SF Pro / Roboto) through `Text` and `systemText`, with `weights`.
 */
export const fonts = {
  /** Funnel Display Light: large titles. */
  display: "FunnelDisplay-Light",
  /** Doto, ROND 100 instance (weight 600): only a rare large hero number (`Count hero`). */
  dot: "Doto",
  /** Code only. */
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
} as const;

const bezier = (c: readonly number[]) => c as unknown as [number, number, number, number];

/**
 * Motion: the token curves and durations (ms: `fast` presses, menus and exits, `base` dialogs, toasts and arrivals,
 * `panel` a sheet's slide), plus spring settings for Reanimated (the tokens' springy curve).
 */
export const motion = {
  spring: bezier(motionCurves.spring),
  out: bezier(motionCurves.out),
  ios: bezier(motionCurves.ios),
  ...durations,
  /** `withSpring` config close to cubic-bezier(.34, 1.4, .5, 1): a small overshoot. */
  press: { damping: 15, stiffness: 420, mass: 0.6 },
  pop: { damping: 13, stiffness: 260, mass: 0.7 },
  sheet: { damping: 26, stiffness: 260, mass: 0.9 },
} as const;

export interface Theme {
  scheme: Scheme;
  colors: AppColors;
  shadows: { e1: string; e2: string; e3: string; top: string };
  radius: typeof radii;
  fonts: typeof fonts;
  motion: typeof motion;
  /** The person asked the phone for less motion: static agents, no orbit walk, no springs. */
  reducedMotion: boolean;
  preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

export function makeTheme(scheme: Scheme, reducedMotion = false): Omit<Theme, "preference" | "setPreference"> {
  const s = appShadows(scheme);
  return {
    scheme,
    colors: appColors(scheme),
    shadows: { e1: boxShadow(s.e1), e2: boxShadow(s.e2), e3: boxShadow(s.e3), top: boxShadow(s.top) },
    radius: radii,
    fonts,
    motion,
    reducedMotion,
  };
}

const ThemeContext = createContext<Theme | null>(null);

/** System light/dark, or the person's choice (kept in SecureStore), and the reduced-motion setting. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPref] = useState<ThemePreference>("system");
  const reducedMotion = useReducedMotionSetting();

  useEffect(() => {
    let alive = true;
    readValue(STORED.theme).then((v) => {
      if (alive && (v === "light" || v === "dark" || v === "system")) setPref(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPref(next);
    void writeValue(STORED.theme, next);
  }, []);

  const scheme: Scheme = preference === "system" ? (system === "dark" ? "dark" : "light") : preference;
  const value = useMemo<Theme>(
    () => ({ ...makeTheme(scheme, reducedMotion), preference, setPreference }),
    [scheme, reducedMotion, preference, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** A part of the screen with colors of its own (a sheet's content): the same theme, other colors. */
export function ThemeColorsOverride({ colors, children }: { colors: AppColors; children: ReactNode }) {
  const theme = useTheme();
  const value = useMemo(() => ({ ...theme, colors }), [theme, colors]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const fallback: Theme = { ...makeTheme("light"), preference: "system", setPreference: () => {} };

/** The current theme (light outside a provider). */
export function useTheme(): Theme {
  return useContext(ThemeContext) ?? fallback;
}

/** `AccessibilityInfo.isReduceMotionEnabled`, kept up to date. */
export function useReducedMotionSetting(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** Whether to keep things still (reads the theme's setting). */
export const useReducedMotion = () => useTheme().reducedMotion;
