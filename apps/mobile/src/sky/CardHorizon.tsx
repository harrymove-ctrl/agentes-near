import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  HORIZON_CELL as CELL,
  horizonCrest,
  horizonHeight,
  horizonTones,
  HORIZON_WAVE as WAVE,
} from "@agenteschat/ui/sky/horizon";
import { bayerAt } from "@agenteschat/ui/sky/math";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { rectsToSvg } from "@/agent/recorder";
import { useTheme } from "@/ui/theme";

/**
 * The agents' horizon at the foot of a card with room to spare, as on the web (`CardHorizon` in the design system): a
 * low, still dither from the card's own ground into the sky's light tones. The card says how wide it is, how much room
 * is left under its content and what its ground is; with too little room it draws nothing, so a full card never has
 * it. `x`: where the card starts on its row, so cards side by side continue one wave. It sits at the bottom of its
 * parent, under whatever comes after it.
 */
export function CardHorizon({
  width,
  room,
  surface,
  color = "sky",
  x = 0,
  minRoom,
  style,
}: {
  width: number;
  room: number;
  /** The card's ground, as "#rrggbb": the dither rises out of it. */
  surface: string;
  color?: AgentColorName;
  x?: number;
  /** Less room is enough on a small card (the home's strip). */
  minRoom?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  const cols = Math.ceil(Math.max(0, width) / CELL);
  const rows = Math.ceil(horizonHeight(room, minRoom) / CELL);
  const layers = useMemo(() => {
    if (cols === 0 || rows === 0) return [];
    const tones = horizonTones(color, surface, dark);
    const last = tones.length - 1;
    const rects: number[][] = tones.map(() => []);
    for (let cx = 0; cx < cols; cx++) {
      const crest = horizonCrest((x + cx * CELL) / WAVE);
      for (let cy = Math.ceil(crest * rows); cy < rows; cy++) {
        const f = Math.min(1, 0.2 + ((cy / rows - crest) / (1 - crest)) * 0.85);
        const k = f * last;
        const lo = Math.floor(k);
        const tone = Math.min(last, lo + (k - lo > bayerAt(cx, cy) ? 1 : 0));
        // The card's own ground needs no paint.
        if (tone > 0) rects[tone]?.push(cx * CELL, cy * CELL, CELL, CELL);
      }
    }
    return rects.flatMap((r, tone) => {
      const path = r.length > 0 ? Skia.Path.MakeFromSVGString(rectsToSvg(r)) : null;
      return path ? [{ tone, color: tones[tone] ?? surface, path }] : [];
    });
  }, [cols, rows, x, color, surface, dark]);
  if (layers.length === 0) return null;
  return (
    <View pointerEvents="none" style={[styles.foot, { width: cols * CELL, height: rows * CELL }, style]}>
      <Canvas style={StyleSheet.absoluteFill}>
        {layers.map((l) => (
          <Path key={l.tone} path={l.path} color={l.color} />
        ))}
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { position: "absolute", left: 0, bottom: 0 },
});
