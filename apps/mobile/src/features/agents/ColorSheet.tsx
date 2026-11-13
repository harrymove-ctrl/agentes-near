import {
  BODY_CUT,
  BODY_RADIUS,
  gradientOf,
  hexToHsv,
  hsvToHex,
  isHexColor,
  pickerStart,
} from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type GestureResponderEvent, StyleSheet, TextInput, View } from "react-native";
import { Button, fieldText, Sheet, Text } from "@/ui";
import { useColors } from "../shared/hooks";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const HUES = ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"] as const;

/**
 * "Personalizar" on the phone: the web's popover as a sheet. A saturation/brightness area, a hue bar, a hex field
 * and a tile in the agent's shape painted as the color really shows (contrast-clamped by `gradientOf`).
 */
export function ColorSheet({
  open,
  value,
  onChange,
  onClose,
}: {
  open: boolean;
  value: string;
  onChange: (hex: `#${string}`) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(pickerStart(value)));
  const [text, setText] = useState<string>(hsvToHex(...hsv));
  const [area, setArea] = useState({ w: 1, h: 1 });
  const [bar, setBar] = useState(1);
  const [h, s, v] = hsv;
  const hex = hsvToHex(h, s, v);
  const [top, bottom] = gradientOf(hex);
  const set = (next: [number, number, number]) => {
    setHsv(next);
    const out = hsvToHex(...next);
    setText(out);
    onChange(out as `#${string}`);
  };
  const onArea = (e: GestureResponderEvent) =>
    set([h, clamp01(e.nativeEvent.locationX / area.w), clamp01(1 - e.nativeEvent.locationY / area.h)]);
  const onBar = (e: GestureResponderEvent) => set([clamp01(e.nativeEvent.locationX / bar) * 359, s, v]);
  // The sheet scrolls: without refusing, a vertical drag hands the gesture to the ScrollView mid-way.
  const grab = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
  };
  // Applied even untouched: the color shown is the color chosen.
  const done = () => {
    onChange(hex as `#${string}`);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} solid>
      <View style={styles.wrap}>
        <Text variant="title">{t("look.customColor")}</Text>
        <View
          {...grab}
          onResponderGrant={onArea}
          onResponderMove={onArea}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          accessibilityRole="adjustable"
          accessibilityLabel={t("look.colorArea")}
          accessibilityValue={{ text: `${Math.round(s * 100)}%, ${Math.round(v * 100)}%` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) =>
            set([h, s, clamp01(v + (e.nativeEvent.actionName === "increment" ? 0.1 : -0.1))])
          }
          style={styles.area}
        >
          <LinearGradient
            pointerEvents="none"
            colors={["#ffffff", hsvToHex(h, 1, 1)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient pointerEvents="none" colors={["transparent", "#000000"]} style={StyleSheet.absoluteFill} />
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: s * area.w - 11, top: (1 - v) * area.h - 11, backgroundColor: hex }]}
          />
        </View>
        <View
          {...grab}
          onResponderGrant={onBar}
          onResponderMove={onBar}
          onLayout={(e) => setBar(e.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel={t("look.hue")}
          accessibilityValue={{ min: 0, max: 359, now: Math.round(h) }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => set([(h + (e.nativeEvent.actionName === "increment" ? 10 : 350)) % 360, s, v])}
          style={styles.bar}
        >
          <LinearGradient
            pointerEvents="none"
            colors={HUES}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[StyleSheet.absoluteFill, styles.barTrack]}
          />
          <View pointerEvents="none" style={[styles.thumb, { left: (h / 359) * bar - 11, top: -3 }]} />
        </View>
        <View style={styles.foot}>
          <LinearGradient colors={[top, bottom]} style={styles.tile} />
          <TextInput
            value={text}
            onChangeText={(raw) => {
              const next = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
              setText(next);
              if (isHexColor(next)) {
                setHsv(hexToHsv(next));
                onChange(next.toLowerCase() as `#${string}`);
              }
            }}
            onEndEditing={() => setText(hex)}
            onSubmitEditing={done}
            maxLength={7}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("look.hex")}
            style={[styles.hex, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
          />
        </View>
        <Button variant="primary" label={t("look.useColor")} onPress={done} />
      </View>
    </Sheet>
  );
}

/** The chosen color's tile, in the agent's own shape. */
const TILE = 44;

const styles = StyleSheet.create({
  // The sheet already gives its 18 pt sides: the color sheet's title and area line up with every other sheet's.
  wrap: { gap: 14 },
  area: { height: 180, borderRadius: 14, overflow: "hidden" },
  thumb: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
    borderColor: "#ffffff",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  bar: { height: 16, justifyContent: "center" },
  barTrack: { borderRadius: 999 },
  foot: { flexDirection: "row", alignItems: "center", gap: 12 },
  // The agent's shape: its body's corners, the cut one at bottom-left.
  tile: { width: TILE, height: TILE, borderRadius: TILE * BODY_RADIUS, borderBottomLeftRadius: TILE * BODY_CUT },
  hex: { flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
});
