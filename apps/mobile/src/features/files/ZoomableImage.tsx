import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet } from "react-native";
import {
  GestureDetector,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  clampZoomTranslate,
  containSize,
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  doubleTapZoom,
  MAX_ZOOM,
  zoomAround,
} from "./zoom";

/**
 * One picture of the viewer: pinch to zoom (around the fingers), double tap to zoom in at that spot or
 * back out, drag to move when zoomed. Not zoomed, a vertical drag moves the picture and lets go to
 * close (`drag` drives the viewer's fade); a horizontal one goes to the pager.
 */
export function ZoomableImage({
  uri,
  headers,
  cacheKey,
  width,
  height,
  drag,
  onZoomChange,
  onTap,
  onDismiss,
}: {
  uri: string;
  headers: Record<string, string>;
  cacheKey: string;
  width: number;
  height: number;
  /** The vertical drag while closing (0 at rest), shared with the viewer. */
  drag: SharedValue<number>;
  onZoomChange: (zoomed: boolean) => void;
  onTap: () => void;
  onDismiss: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // The picture's own size (0 until it loads): the pan stops at its edges as drawn, not the screen's.
  const natural = useSharedValue({ w: 0, h: 0 });

  const report = (z: boolean) => {
    setZoomed(z);
    onZoomChange(z);
  };

  const settle = () => {
    "worklet";
    if (scale.value <= 1.01) {
      scale.value = withTiming(1);
      tx.value = withTiming(0);
      ty.value = withTiming(0);
      scheduleOnRN(report, false);
      return;
    }
    const d = containSize(natural.value.w, natural.value.h, width, height);
    const c = clampZoomTranslate(tx.value, ty.value, scale.value, width, height, d.w, d.h);
    tx.value = withTiming(c.x);
    ty.value = withTiming(c.y);
    scheduleOnRN(report, true);
  };

  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      startScale.value = scale.value;
      startX.value = tx.value;
      startY.value = ty.value;
    },
    onUpdate: (e) => {
      "worklet";
      const next = Math.min(Math.max(startScale.value * e.scale, 0.8), MAX_ZOOM + 1);
      const z = zoomAround(
        { x: startX.value, y: startY.value },
        startScale.value,
        next,
        e.focalX - width / 2,
        e.focalY - height / 2,
      );
      scale.value = next;
      tx.value = z.x;
      ty.value = z.y;
    },
    onDeactivate: () => {
      "worklet";
      if (scale.value > MAX_ZOOM) scale.value = withTiming(MAX_ZOOM);
      settle();
    },
  });

  const pan = usePanGesture({
    // Not zoomed: only a vertical drag (closing); the pager keeps the horizontal swipe. Zoomed: any
    // direction moves the picture. Plain values, no spread: the worklets plugin rejects a spread here.
    activeOffsetY: zoomed ? [-1, 1] : [-12, 12],
    failOffsetX: zoomed ? [-10_000, 10_000] : [-14, 14],
    maxPointers: zoomed ? 2 : 1,
    onBegin: () => {
      "worklet";
      startX.value = tx.value;
      startY.value = ty.value;
    },
    onUpdate: (e) => {
      "worklet";
      if (scale.value > 1.01) {
        tx.value = startX.value + e.translationX;
        ty.value = startY.value + e.translationY;
      } else {
        drag.value = e.translationY;
      }
    },
    onDeactivate: (e) => {
      "worklet";
      if (scale.value > 1.01) {
        settle();
        return;
      }
      if (Math.abs(drag.value) > DISMISS_DISTANCE || Math.abs(e.velocityY) > DISMISS_VELOCITY) {
        scheduleOnRN(onDismiss);
        return;
      }
      drag.value = withSpring(0, { damping: 20, stiffness: 220 });
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      if (scale.value > 1.01) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        scheduleOnRN(report, false);
        return;
      }
      const d = containSize(natural.value.w, natural.value.h, width, height);
      const next = doubleTapZoom(d.w, d.h, width, height);
      const z = zoomAround({ x: 0, y: 0 }, 1, next, e.x - width / 2, e.y - height / 2);
      const c = clampZoomTranslate(z.x, z.y, next, width, height, d.w, d.h);
      scale.value = withTiming(next);
      tx.value = withTiming(c.x);
      ty.value = withTiming(c.y);
      scheduleOnRN(report, true);
    },
  });

  const singleTap = useTapGesture({
    requireToFail: doubleTap,
    onDeactivate: (e) => {
      "worklet";
      if (!e.canceled) scheduleOnRN(onTap);
    },
  });

  const taps = useExclusiveGestures(doubleTap, singleTap);
  const gesture = useSimultaneousGestures(pinch, pan, taps);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value + drag.value },
      { scale: scale.value * (1 - Math.min(Math.abs(drag.value) / (height * 2), 0.25)) },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height }, style]}>
        <Image
          source={{ uri, headers, cacheKey }}
          recyclingKey={cacheKey}
          contentFit="contain"
          transition={160}
          onLoad={(e) => {
            natural.value = { w: e.source.width, h: e.source.height };
          }}
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      </Animated.View>
    </GestureDetector>
  );
}
