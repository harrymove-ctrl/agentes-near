/**
 * The native type scale (pure: no React Native import, so it is unit-tested).
 *
 * Body and UI text use the system font (SF Pro on iOS, Roboto on Android) at the platform's own sizes:
 * Apple's HIG text styles at the default Dynamic Type size, Material 3 on Android. The brand stays in
 * a rare hero number (Doto, `Count hero`) and code (mono); large titles are the system's own (bold on iOS,
 * like Mail and Settings). Counts, badges, times and countdowns are the system font, semibold, tabular (`countStyle`).
 * Every style scales with the person's text size setting; dense chrome caps its growth with
 * `CHROME_MAX_SCALE`.
 */
export type OS = "ios" | "android";

/** System font weights (no custom family: the platform picks SF Pro / Roboto at this weight). */
export const weights = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
} as const;

export type Weight = (typeof weights)[keyof typeof weights];

export type TypeStyle =
  | "largeTitle"
  | "title1"
  | "title2"
  | "title3"
  | "headline"
  | "body"
  | "callout"
  | "subhead"
  | "footnote"
  | "caption"
  | "caption2";

export interface TypeMetrics {
  fontSize: number;
  lineHeight: number;
  fontWeight: Weight;
}

/** The most a dense piece of chrome (tab labels, chips, badges, timestamps) grows with the text size setting. */
export const CHROME_MAX_SCALE = 1.3;

const m = (fontSize: number, lineHeight: number, fontWeight: Weight = weights.regular): TypeMetrics => ({
  fontSize,
  lineHeight,
  fontWeight,
});

/** iOS: HIG text styles at the default ("Large") Dynamic Type size. */
const IOS: Record<TypeStyle, TypeMetrics> = {
  largeTitle: m(34, 41),
  title1: m(28, 34),
  title2: m(22, 28),
  title3: m(20, 25),
  headline: m(17, 22, weights.semibold),
  body: m(17, 22),
  callout: m(16, 21),
  subhead: m(15, 20),
  footnote: m(13, 18),
  caption: m(12, 16),
  caption2: m(11, 13),
};

/** Android: Material 3 (body large 16/24, body medium 14/20, title medium 16/24 medium, label/body small 12/16). */
const ANDROID: Record<TypeStyle, TypeMetrics> = {
  largeTitle: m(32, 40),
  title1: m(28, 36),
  title2: m(22, 28),
  title3: m(20, 26),
  headline: m(16, 24, weights.medium),
  body: m(16, 24),
  callout: m(15, 22),
  subhead: m(14, 20),
  footnote: m(12, 16),
  caption: m(12, 16),
  caption2: m(11, 16),
};

/**
 * The person's text size (Você › Conversa › Tamanho do texto: `textSize`, packages/client/src/lib/chat-look.ts) for the
 * whole app, as a multiplier over this scale: about 2 points a step on the 17 body (xs 13, sm 15, md 17, lg 19, xl 21),
 * the same steps the conversation's words take (`CHAT_TEXT`). It stacks on the system's own text size.
 */
export const APP_TEXT_SCALE = { xs: 13 / 17, sm: 15 / 17, md: 1, lg: 19 / 17, xl: 21 / 17 } as const;
export type AppTextSize = keyof typeof APP_TEXT_SCALE;

/** A size and its line at `k`, in whole points, the line keeping the style's own ratio to its size. */
export function scaleMetrics(
  fontSize: number,
  lineHeight: number,
  k: number,
): { fontSize: number; lineHeight: number } {
  if (k === 1) return { fontSize, lineHeight };
  const size = Math.round(fontSize * k);
  return { fontSize: size, lineHeight: Math.round((size * lineHeight) / fontSize) };
}

export function typeScale(os: OS): Record<TypeStyle, TypeMetrics> {
  return os === "android" ? ANDROID : IOS;
}

/** One style's metrics, with another weight when asked (e.g. footnote semibold for labels). */
export function typeStyle(os: OS, style: TypeStyle, fontWeight?: Weight): TypeMetrics {
  const base = typeScale(os)[style];
  return fontWeight ? { ...base, fontWeight } : base;
}

/**
 * A number in the chrome (unread badges, section counts, times, "expira em", the undo countdown): the system
 * font, semibold, tabular figures so it doesn't jump as it changes. Doto is only for a rare hero number.
 */
export function countStyle(fontSize: number, fontWeight: Weight = weights.semibold) {
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.2),
    fontWeight,
    fontVariant: ["tabular-nums"] as ["tabular-nums"],
  };
}

/**
 * A count on a pill (`<Count inverted />`: unread badges, tab badges): one line exactly the pill's height, centered
 * both ways, so "1", "12" and "99+" sit in its middle. Android's extra font padding off, or the figures sit low.
 */
export function countBadge(fontSize: number) {
  const height = Math.round(fontSize * 1.55);
  return {
    box: {
      minWidth: height,
      // Not a fixed height: the line grows with the person's text size (up to the chrome's cap) and the pill with it.
      minHeight: height,
      paddingHorizontal: Math.round(fontSize * 0.45),
      borderRadius: 999,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    text: {
      lineHeight: height,
      includeFontPadding: false,
      textAlign: "center" as const,
      textAlignVertical: "center" as const,
    },
  };
}

/**
 * A tile's initial (a person's face, a maker without a mark, a voter): one line exactly the tile's height, centred both
 * ways, Android's extra font padding off, as a count sits in its pill (`countBadge`). With no line height the line box
 * centres instead of the letter.
 */
export function initialText(size: number, fontSize = size * 0.42) {
  return {
    fontSize,
    lineHeight: size,
    includeFontPadding: false,
    textAlign: "center" as const,
    textAlignVertical: "center" as const,
  };
}

/**
 * Where the eye reads a line of text, from the top of its line box (points). The letters are centered in the
 * line, but text reads at its small letters (the x-height), a hair under the line's middle: an icon beside
 * text centers there, or it looks too high.
 */
export const readingMiddle = (fontSize: number, lineHeight: number) => lineHeight / 2 + 0.08 * fontSize;

/** The box that sets a lead `size` tall (an icon, a maker's mark) on a line's reading middle, never above its top. */
export function leadBox(line: { height: number; middle: number }, size: number) {
  const paddingTop = Math.max(0, line.middle - size / 2);
  return { paddingTop, height: Math.max(line.height, paddingTop + size) };
}
