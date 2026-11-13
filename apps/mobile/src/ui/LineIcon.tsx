import type { ReactNode } from "react";
import { View } from "react-native";
import { Icon, type IconProps } from "./Icon";
import { type TextVariant, textLineOf } from "./Text";
import { useFontScale } from "./text-scale";
import { leadBox } from "./type-scale";

export type LineIconProps = {
  /** The text beside it (default body). */
  variant?: TextVariant;
  /** The text's own size, when it sets one over its variant (e.g. `LIST_PREVIEW`). */
  text?: { fontSize?: number; lineHeight?: number };
} & (
  | IconProps
  | { /** In place of the icon (a maker's mark), `size` points tall. */ children: ReactNode; size: number }
);

/**
 * An icon (or a maker's mark) before a line of text: a box as tall as the text's first line (it grows with the
 * text size setting), the icon centered where the eye reads the letters, a hair under the line's middle. In a
 * row aligned to the top it sits on the first line of wrapping text; in a centered row, on its only line.
 */
export function LineIcon({ variant = "body", text, ...lead }: LineIconProps) {
  const fontScale = useFontScale();
  const size = lead.size ?? 20;
  return (
    <View style={leadBox(textLineOf(variant, fontScale, text), size)}>
      {"children" in lead ? lead.children : <Icon {...lead} size={size} />}
    </View>
  );
}
