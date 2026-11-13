import { type ReactNode, useEffect, useRef } from "react";
import { Pressable, Text as RNText, ScrollView, type ScrollViewInstance, View } from "react-native";
import { Count } from "./Count";
import { haptics } from "./haptics";
import type { IconName } from "./icons.data";
import { SCREEN_X, TOOL_H, TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** How much of the pill before stays in sight when the row follows the selected one. */
const PEEK = 40;

export interface FilterItem {
  key: string;
  /** Words, or text of its own sizes inside the label's (Segmented only: Tamanho do texto's growing A's). */
  label: ReactNode;
  count?: number;
  /** A small icon before the label (Segmented only). */
  icon?: IconName;
  /** What a screen reader says where the label doesn't say it in words (Segmented only). */
  accessibilityLabel?: string;
}

export interface FiltersProps {
  items: FilterItem[];
  value: string;
  onChange: (key: string) => void;
}

/** Horizontal pills over a list; the selected one is ink, and the row follows it when it changes from outside. */
export function Filters({ items, value, onChange }: FiltersProps) {
  const { colors } = useTheme();
  const row = useRef<ScrollViewInstance>(null);
  const lefts = useRef(new Map<string, number>());
  useEffect(() => {
    const left = lefts.current.get(value);
    if (left !== undefined) row.current?.scrollTo({ x: Math.max(0, left - PEEK), animated: true });
  }, [value]);
  return (
    <ScrollView
      ref={row}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // A ScrollView grows and shrinks by default: in a screen's column beside another one, the chips took half the
      // height, and under a list that fills the rest (the tasks board) they were squeezed and cut at the bottom.
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: SCREEN_X, paddingBottom: 4 }}
    >
      {items.map((item) => {
        const on = item.key === value;
        const color = on ? colors.bg : colors.muted;
        return (
          <Pressable
            key={item.key}
            onLayout={(e) => lefts.current.set(item.key, e.nativeEvent.layout.x)}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            // The slop makes the pill's target the 44 a finger needs without spacing the row out.
            hitSlop={{ top: (TOUCH - TOOL_H) / 2, bottom: (TOUCH - TOOL_H) / 2 }}
            style={({ pressed }) => (pressed && !on ? { opacity: 0.6 } : null)}
          >
            <View
              style={{
                minHeight: TOOL_H,
                paddingHorizontal: 14,
                borderRadius: 999,
                backgroundColor: on ? colors.ink : colors.sunken,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("subhead", weights.semibold), { color }]}
              >
                {item.label}
              </RNText>
              {item.count !== undefined ? <Count value={item.count} size={15} color={color} /> : null}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
