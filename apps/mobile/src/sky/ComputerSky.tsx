import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { agentTones, SPRITE, softTones, spriteTone } from "@agenteschat/ui/sky/math";
import { Canvas, Group, Path, Skia, type SkPath, useClock } from "@shopify/react-native-skia";
import { useMemo, useState } from "react";
import { type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { rectsToSvg } from "@/agent/recorder";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { COMPUTER_SPRITES, type ComputerSprite, computerSpriteAt, computerSpriteBlinks } from "./math";

/** Points per sky cell (the sprites stand on the same grid). */
const PX = 4;

/** The rectangles of one kind of cell in the sprite, in points. */
function spritePath(cell: string): SkPath | null {
  const rects = SPRITE.flatMap((row, y) => [...row].flatMap((c, x) => (c === cell ? [x * PX, y * PX, PX, PX] : [])));
  return Skia.Path.MakeFromSVGString(rectsToSvg(rects));
}

/**
 * Behind an agent's computer while its screen opens, as on the web: its sky, calm, filling the stage, with a few pixel
 * agents going up at the sides, clear of the card in the middle. In light its day sky; in dark the surface rising into
 * its color.
 */
export function ComputerSky({ color = "sky", style }: { color?: AgentColorName; style?: StyleProp<ViewStyle> }) {
  const { colors, scheme } = useTheme();
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const clock = useClock();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };
  const tones = scheme === "dark" ? softTones(color, colors.raised) : agentTones(color);
  const paths = useMemo(() => ({ body: spritePath("X"), eyes: spritePath("o") }), []);
  const solid = spriteTone(color);
  // Far agents are faint light silhouettes, near ones solid (the web's sky).
  const ghost = tones[tones.length - 2] ?? solid;
  return (
    <View
      style={style}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Dither kind="computer" tones={tones} pixel={PX} style={StyleSheet.absoluteFill} />
      {size.width > 0 && size.height > 0 && paths.body && paths.eyes ? (
        <Canvas style={StyleSheet.absoluteFill}>
          {COMPUTER_SPRITES.map((sprite) => (
            <Passing
              key={sprite.x}
              sprite={sprite}
              clock={clock}
              moving={!reduced && !paused}
              width={size.width}
              height={size.height}
              body={paths.body as SkPath}
              eyes={paths.eyes as SkPath}
              tone={sprite.ghost ? ghost : solid}
            />
          ))}
        </Canvas>
      ) : null}
    </View>
  );
}

function Passing({
  sprite,
  clock,
  moving,
  width,
  height,
  body,
  eyes,
  tone,
}: {
  sprite: ComputerSprite;
  clock: SharedValue<number>;
  moving: boolean;
  width: number;
  height: number;
  body: SkPath;
  eyes: SkPath;
  tone: string;
}) {
  const transform = useDerivedValue(() => {
    const at = computerSpriteAt(sprite, moving ? clock.value / 1000 : 0, width / PX, height / PX);
    return [{ translateX: at.x * PX }, { translateY: at.y * PX }];
  });
  const eyeColor = useDerivedValue(() =>
    moving && computerSpriteBlinks(sprite, clock.value / 1000) ? tone : "#ffffff",
  );
  return (
    <Group transform={transform}>
      <Path path={body} color={tone} />
      <Path path={eyes} color={eyeColor} />
    </Group>
  );
}
