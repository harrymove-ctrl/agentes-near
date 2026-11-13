import {
  dark as darkTokens,
  light as lightTokens,
  type ShadowLayer,
  type ShadowName,
  type ThemeColors,
  shadows as tokenShadows,
} from "@agenteschat/tokens";

/**
 * The phone app's colors (pure: no React Native import, so it is unit-tested). The design system's tokens,
 * with the light theme made native like iOS: white lists and
 * chat, the grouped gray only where iOS groups (profile, Atividade, sheets) with white cards on it, lighter
 * fills, darker secondary text and lighter hairlines. The dark theme stays the tokens'.
 */
export type Scheme = "light" | "dark";

export interface AppColors extends ThemeColors {
  /** The grouped background (Settings-like screens, Atividade, sheets); white cards sit on it. */
  grouped: string;
  /** My own message bubble. */
  bubble: string;
  /** The only color for "waits on you" (requests, questions, what expires). */
  amber: string;
  /** Words in amber on an amber-tinted fill (a "Needs you" chip): darker in light, so they keep 4.5:1. */
  amberInk: string;
  /** A small tag's fill (chips, states). */
  chip: string;
  /** Unread: the row's dot, the same red as the tab bar's badge (the system red). */
  badge: string;
  /** A sheet's grabber where we draw it (Android; iOS draws its own), the system's tone for it. */
  grabber: string;
}

/** Light, native: what changes from the tokens. */
const NATIVE_LIGHT: Partial<ThemeColors> = {
  bg: "#ffffff",
  raised: "#ffffff",
  raised2: "#ffffff",
  sunken: "#f2f2f5",
  glass: "rgba(255, 255, 255, 0.78)",
  glassSolid: "#f9f9f9",
  line: "rgba(60, 60, 67, 0.08)",
  line2: "rgba(60, 60, 67, 0.14)",
  ink: "#000000",
  ink2: "#1c1c1e",
  muted: "#48484d",
  faint: "#6c6c70",
  plate: "rgba(120, 120, 128, 0.1)",
  plateSoft: "rgba(120, 120, 128, 0.06)",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f2f2f5",
  inkMuted: "#48484d",
  action: "#000000",
  onAction: "#ffffff",
  success: "#000000",
};

export function appColors(scheme: Scheme): AppColors {
  if (scheme === "dark") {
    return {
      ...darkTokens,
      glass: "rgba(28, 28, 27, 0.86)",
      grouped: darkTokens.bg,
      bubble: darkTokens.raised,
      amber: "#e8ac4c",
      amberInk: "#e8ac4c",
      chip: darkTokens.sunken,
      badge: "#ff453a",
      grabber: "rgba(235, 235, 245, 0.3)",
    };
  }
  const base = { ...lightTokens, ...NATIVE_LIGHT };
  return {
    ...base,
    grouped: "#f2f2f7",
    // The web's own bubble on white: the ink at 6%, no tint.
    bubble: "#efefee",
    amber: "#b26a00",
    amberInk: "#8a5200",
    chip: "rgba(120, 120, 128, 0.1)",
    badge: "#ff3b30",
    grabber: "rgba(60, 60, 67, 0.3)",
  };
}

/** A card inside a dark sheet: one step above the sheet, as the sheet is one above the screen. */
const DARK_SHEET_CARD = "#292928";

/**
 * The colors inside a form sheet. In dark the sheet is lifted one step above the screen behind it (the dark
 * page's own color made the two read as one) and its cards one more, as the system's own sheets do. Light
 * keeps the grouped gray with white cards on it, which already stands apart from the dimmed white screen.
 */
export function sheetColors(colors: AppColors, scheme: Scheme): AppColors {
  if (scheme !== "dark") return colors;
  return {
    ...colors,
    bg: colors.raised,
    grouped: colors.raised,
    surface: colors.raised,
    raised: DARK_SHEET_CARD,
    raised2: DARK_SHEET_CARD,
    surfaceRaised: DARK_SHEET_CARD,
    // Android's "glass" plates (round buttons) are opaque: a card's tone, so they don't vanish into the sheet.
    glassSolid: DARK_SHEET_CARD,
  };
}

/** Light elevations are softer (a hairline and a short shadow, like iOS); dark keeps the tokens'. */
const NATIVE_LIGHT_SHADOWS: Partial<Record<ShadowName, ShadowLayer[]>> = {
  e1: [
    { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0, 0, 0, 0.04)" },
    { x: 0, y: 0, blur: 0, spread: 0.5, color: "rgba(60, 60, 67, 0.12)" },
  ],
  e2: [
    { x: 0, y: 4, blur: 14, spread: -6, color: "rgba(0, 0, 0, 0.12)" },
    { x: 0, y: 0, blur: 0, spread: 0.5, color: "rgba(60, 60, 67, 0.14)" },
  ],
};

export function appShadows(scheme: Scheme): Record<ShadowName, ShadowLayer[]> {
  return scheme === "dark" ? tokenShadows.dark : { ...tokenShadows.light, ...NATIVE_LIGHT_SHADOWS };
}

/** A `#rrggbb` color at `alpha` (0–1), as `#rrggbbaa`. */
export const withAlpha = (hex: string, alpha: number) =>
  `${hex.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

export type ToastTone = "success" | "info" | "warning" | "danger" | "neutral";

/**
 * A toast's tone: a failure (`x`, `alert`) is danger, a done check (or no icon) success, any other icon neutral.
 * The web's toasts glow the same way per tone (`.ac-toast--*`).
 */
export const toastToneOf = (icon: string | undefined): ToastTone =>
  icon === "x" || icon === "alert" ? "danger" : icon === undefined || icon === "check" ? "success" : "neutral";

/** A tone's color: its icon's, and its glow's (neutral's glow is fainter than its icon). */
export const toneColor = (colors: AppColors, tone: ToastTone) =>
  ({ success: colors.ok, info: colors.agent, warning: colors.warn, danger: colors.danger, neutral: colors.ink2 })[tone];

/**
 * The tone's soft glow from the toast's right edge, as the web's (24% of the tone in light, 30% in dark, fading out
 * over the last 45%): the gradient's colors and stops, left to right.
 */
export function toastGlow(colors: AppColors, tone: ToastTone, scheme: Scheme) {
  const color = tone === "neutral" ? colors.faint : toneColor(colors, tone);
  return {
    colors: [withAlpha(color, 0), withAlpha(color, 0), withAlpha(color, scheme === "dark" ? 0.3 : 0.24)] as const,
    locations: [0, 0.55, 1] as const,
  };
}
