import { Canvas, Fill, Shader, Skia, type SkRuntimeEffect, useClock } from "@shopify/react-native-skia";
import { useState } from "react";
import { type LayoutChangeEvent, type StyleProp, View, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { useReducedMotion } from "@/ui/theme";
import { paletteUniform } from "./math";
import { type DitherKind, shaderSource } from "./shaders";

const effects = new Map<DitherKind, SkRuntimeEffect | null>();

/** The compiled shader for a drawing (compiled once; null if the device refuses it). */
export function effectOf(kind: DitherKind): SkRuntimeEffect | null {
  if (!effects.has(kind)) {
    let effect: SkRuntimeEffect | null = null;
    try {
      effect = Skia.RuntimeEffect.Make(shaderSource(kind));
    } catch {
      effect = null;
    }
    if (!effect) console.warn(`dither shader "${kind}" did not compile`);
    effects.set(kind, effect);
  }
  return effects.get(kind) ?? null;
}

export interface DitherProps {
  kind: DitherKind;
  /** Tones, deep to light (up to 8). */
  tones: readonly string[];
  /** Points per dither cell. */
  pixel: number;
  /** Drawing-specific uniforms (`remaining`, `value`, `count` + `states`). */
  extra?: Record<string, number | number[]>;
  /** Moves with time (sky, fuse, plan track); the spend bar stays still. */
  animated?: boolean;
  /** Fade out to the bottom from this height share (2 = none). */
  fade?: number;
  /** Come in from nothing, in dither steps, down to this height share (0 = none): a band that doesn't start at the top. */
  fadeTop?: number;
  /** The first tone is see-through (a drawing over glass). */
  clear?: boolean;
  /** The drawing's width, from the UI thread, when it changes faster than a layout should (the canvas stays). */
  liveWidth?: SharedValue<number>;
  /** The `pill` drawing's `work` uniform, from the UI thread: 0 at rest, 1 working. */
  liveWork?: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
}

/**
 * A pixel/dither drawing on a Skia shader. Time runs on the UI thread (Skia's clock), so it costs the JS
 * thread nothing; with reduced motion it is drawn once at t = 0. If the shader can't compile, the first
 * tone fills the box.
 */
export function Dither({
  kind,
  tones,
  pixel,
  extra,
  animated = true,
  fade = 2,
  fadeTop = 0,
  clear = false,
  liveWidth,
  liveWork,
  style,
}: DitherProps) {
  const reduced = useReducedMotion();
  // Off screen (LivePause): drawn still, so Skia stops redrawing.
  const paused = useLivePaused();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };
  const effect = effectOf(kind);
  const { pal, last } = paletteUniform(tones);
  const moving = animated && !reduced && !paused;
  const clock = useClock();
  const base = {
    size: [size.width, size.height],
    px: pixel,
    last,
    fade,
    fadeTop,
    clear: clear ? 1 : 0,
    pal,
    ...(extra ?? {}),
  };
  const uniforms = useDerivedValue(() => ({
    ...base,
    ...(liveWidth ? { size: [Math.max(1, liveWidth.value), size.height] } : {}),
    ...(liveWork ? { work: liveWork.value } : {}),
    t: moving ? clock.value / 1000 : 0,
  }));

  if (!effect)
    return (
      <View
        style={[{ backgroundColor: clear ? "transparent" : (tones[0] ?? "transparent") }, style]}
        onLayout={onLayout}
      />
    );
  return (
    <View
      style={style}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size.width > 0 && size.height > 0 ? (
        <Canvas style={{ width: size.width, height: size.height }}>
          <Fill>
            <Shader source={effect} uniforms={uniforms} />
          </Fill>
        </Canvas>
      ) : null}
    </View>
  );
}
