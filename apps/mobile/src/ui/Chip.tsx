import type { ReactNode } from "react";
import { Text as RNText, useWindowDimensions, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface ChipProps {
  /** Chips carry an icon, never a colored dot. */
  icon?: IconName;
  label: string;
  /** Anything before the label instead of an icon (a small avatar). */
  leading?: ReactNode;
  /** Words after the label that never shrink (a state): a long label wraps first. */
  trailing?: string;
  /** `wait`: it waits on a person (amber words on an amber tint, the one color for that). */
  tone?: "neutral" | "wait";
}

const LABEL = systemText("caption", weights.semibold);
const LINE = LABEL.lineHeight ?? 16;
const HEIGHT = 24;

/**
 * A small neutral tag: a light gray pill, muted text. A label wider than its row wraps inside the chip instead of
 * ending in "…", its icon staying on the first line; on one line it is the 24 pill.
 */
export function Chip({ icon, label, leading, trailing, tone = "neutral" }: ChipProps) {
  const { colors } = useTheme();
  // The label's line as the system's text size draws it (chrome stops growing at CHROME_MAX_SCALE).
  const line = LINE * Math.min(useWindowDimensions().fontScale, CHROME_MAX_SCALE);
  const ink = tone === "wait" ? colors.amberInk : colors.muted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 4,
        minHeight: HEIGHT,
        paddingHorizontal: 10,
        paddingVertical: (HEIGHT - LINE) / 2,
        borderRadius: HEIGHT / 2,
        backgroundColor: tone === "wait" ? `${colors.amber}22` : colors.chip,
        alignSelf: "flex-start",
        maxWidth: "100%",
      }}
    >
      {leading || icon ? (
        <View style={{ height: line, justifyContent: "center" }}>
          {leading ?? (icon ? <Icon name={icon} size={12} color={ink} /> : null)}
        </View>
      ) : null}
      <RNText maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[LABEL, { color: ink, flexShrink: 1 }]}>
        {label}
      </RNText>
      {trailing ? (
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText("caption", weights.regular), { color: ink, flexShrink: 0 }]}
        >
          {trailing}
        </RNText>
      ) : null}
    </View>
  );
}
