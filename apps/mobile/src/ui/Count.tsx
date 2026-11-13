import { formatInt } from "@agenteschat/client/lib/format";
import { useTranslation } from "react-i18next";
import { Text as RNText, View } from "react-native";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, countBadge, countStyle, type Weight } from "./type-scale";

export interface CountProps {
  value: number;
  /** Font size (default 14). */
  size?: number;
  /** A badge: the number in the background color on an ink pill (unread counts, tab badges). */
  inverted?: boolean;
  /** Text color override (e.g. on a selected filter). */
  color?: string;
  /** The badge's pill color, ink by default (red for a count that calls on the person, as a mention). */
  fill?: string;
  /** Past this, shows "max+" (unread counts: the server stops counting at 100). */
  max?: number;
  /** A rare large hero number: drawn in Doto (ROND 100). Everything else is the system font. */
  hero?: boolean;
  /** The weight (default semibold; section counts are medium). */
  weight?: Weight;
}

/**
 * Every counter in the app: the system font, semibold, tabular figures (badges, section counts). Doto only
 * for the rare hero number (`hero`).
 */
export function Count({ value, size = 14, inverted = false, color, fill, max, hero = false, weight }: CountProps) {
  const { colors, fonts } = useTheme();
  const { i18n } = useTranslation();
  // In the person's language ("1.284" in Portuguese).
  const label =
    max !== undefined && value > max ? `${formatInt(i18n.language, max)}+` : formatInt(i18n.language, value);
  const face = hero
    ? { fontFamily: fonts.dot, fontSize: size, lineHeight: Math.round(size * 1.2) }
    : countStyle(size, weight);
  if (inverted) {
    const badge = countBadge(size);
    return (
      <View style={[badge.box, { backgroundColor: fill ?? colors.ink }]}>
        <RNText style={[face, badge.text, { color: color ?? colors.bg }]} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {label}
        </RNText>
      </View>
    );
  }
  return (
    <RNText maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[face, { color: color ?? colors.ink }]}>
      {label}
    </RNText>
  );
}
