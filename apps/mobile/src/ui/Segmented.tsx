import { useEffect, useRef, useState } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Count } from "./Count";
import type { FiltersProps } from "./Filters";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { TOOL_H, TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export type SegmentedProps = FiltersProps & {
  /**
   * As wide as its box, the segments sharing it evenly (a screen's views, as an agent's Hoje · Acesso · Memória).
   * `fit`: each as wide as its words first, so long labels stay on one line (a form's choice).
   */
  wide?: boolean | "fit";
};

/** The track's inset around the segments; a segment's corner is the track's less it, so the two stay concentric. */
const PAD = 4;
/** 30% of the control's height, as every control's corner. */
const RADIUS = Math.round(TOOL_H * 0.3);

/** A segmented control: a sunken track, the selected segment raised; the raised plate slides to a new choice. */
export function Segmented({ items, value, onChange, wide = false }: SegmentedProps) {
  const { colors, shadows, motion, reducedMotion } = useTheme();
  const [boxes, setBoxes] = useState<Record<string, { x: number; width: number }>>({});
  const at = boxes[value];
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  // The first place is taken at once; only a change of choice slides.
  const placed = useRef(false);
  useEffect(() => {
    if (!at) return;
    const timing = {
      duration: reducedMotion || !placed.current ? 0 : motion.base,
      easing: Easing.bezier(...motion.out),
    };
    x.value = withTiming(at.x, timing);
    width.value = withTiming(at.width, timing);
    placed.current = true;
  }, [at, x, width, reducedMotion, motion]);
  const plate = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], width: width.value }));
  const raised = { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` };
  return (
    <View
      style={{
        flexDirection: "row",
        padding: PAD,
        borderRadius: RADIUS,
        backgroundColor: colors.sunken,
        boxShadow: "inset 0px 1px 2px 0px rgba(0, 0, 0, 0.06)",
        alignSelf: wide ? "stretch" : "flex-start",
      }}
      accessibilityRole="tablist"
    >
      {at ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", left: 0, top: PAD, bottom: PAD, borderRadius: RADIUS - PAD }, raised, plate]}
        />
      ) : null}
      {items.map((item) => {
        const on = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={item.accessibilityLabel}
            onLayout={(e) => {
              const { x: left, width: w } = e.nativeEvent.layout;
              setBoxes((b) =>
                b[item.key]?.x === left && b[item.key]?.width === w ? b : { ...b, [item.key]: { x: left, width: w } },
              );
            }}
            style={({ pressed }) => [
              wide === "fit" ? { flexGrow: 1 } : wide ? { flex: 1 } : null,
              pressed && !on ? { opacity: 0.6 } : null,
            ]}
            // The slop gives a segment the 44 a finger needs, past the track's own padding.
            hitSlop={{ top: (TOUCH - TOOL_H) / 2 + PAD, bottom: (TOUCH - TOOL_H) / 2 + PAD }}
          >
            <View
              style={[
                {
                  // Inside the track's inset: the control is a toolbar's 32.
                  minHeight: TOOL_H - 2 * PAD,
                  paddingHorizontal: 12,
                  borderRadius: RADIUS - PAD,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                },
                on && !at ? raised : null,
              ]}
            >
              {item.icon ? <Icon name={item.icon} size={13} color={on ? colors.ink : colors.muted} /> : null}
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("footnote", weights.semibold), { color: on ? colors.ink : colors.muted }]}
              >
                {item.label}
              </RNText>
              {item.count !== undefined ? (
                <Count value={item.count} size={13} color={on ? colors.ink : colors.muted} />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
