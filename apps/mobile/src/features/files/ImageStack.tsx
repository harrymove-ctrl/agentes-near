import type { ArtifactDetail } from "@agenteschat/client";
import { Image } from "expo-image";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AccessibilityActionEvent, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, Icon, Text, useReducedMotion, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { DECK_DRAG, DECK_RISE, deckCard, deckIndex, deckTarget, wrapPlace } from "./deck";
import { encodeFileList } from "./logic";
import type { MessageFile } from "./MessageFiles";
import { useRemoteFile } from "./source";
import { listenViewerPlace } from "./viewer-place";

export interface StackImage {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
}

/** The cards keep inside the block when they lean out from behind. */
const SIDE = 7;
/** More pictures than this say "3 de 7" instead of dots. */
const MAX_DOTS = 5;
const SETTLE = { stiffness: 190, damping: 25, mass: 1 };

/**
 * Two or more pictures in a message: a deck to swipe through, its dots under it. A tap opens the viewer at the
 * picture on top, and closing it brings the deck back on the one the person stopped at.
 */
export function ImageStack({ images, width }: { images: StackImage[]; width: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const key = useId();
  const count = images.length;
  const size = width - SIDE * 2;
  const per = size * DECK_DRAG;
  const place = useSharedValue(0);
  const from = useSharedValue(0);
  const [active, setActive] = useState(0);

  useAnimatedReaction(
    () => deckIndex(place.value, count),
    (now, before) => {
      if (before !== null && now !== before) scheduleOnRN(setActive, now);
    },
    [count],
  );
  useEffect(
    () =>
      listenViewerPlace(key, (at) => {
        place.value = at;
        setActive(at);
      }),
    [key, place],
  );

  // Opening the pictures is plain navigation: no haptic (a swipe through the stack has its own).
  const open = (at: number) => {
    router.push({
      pathname: "/images",
      params: {
        files: encodeFileList(
          images.map(({ file, detail }) => ({ id: file.id, version: detail?.shownVersion ?? file.version })),
        ),
        at: String(at),
        from: key,
      },
    });
  };

  const settle = (target: number, velocity: number) => {
    "worklet";
    place.value = reduced
      ? wrapPlace(target, count)
      : withSpring(target, { ...SETTLE, velocity }, (done) => {
          if (done) place.value = wrapPlace(target, count);
        });
  };

  const pan = usePanGesture({
    // Sideways only: a vertical drag stays the conversation's scroll.
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      cancelAnimation(place);
      from.value = place.value;
    },
    onUpdate: (e) => {
      "worklet";
      place.value = from.value - e.translationX / per;
    },
    onDeactivate: (e) => {
      "worklet";
      const target = deckTarget(from.value, place.value, e.velocityX);
      if (target !== Math.round(from.value)) scheduleOnRN(haptics.selection);
      settle(target, -e.velocityX / per);
    },
  });
  const tap = useTapGesture({
    onDeactivate: (e) => {
      "worklet";
      if (!e.canceled) scheduleOnRN(open, deckIndex(place.value, count));
    },
  });
  const gesture = useExclusiveGestures(pan, tap);

  const turn = (by: number) => {
    const target = Math.round(place.get()) + by;
    place.set(wrapPlace(target, count));
    setActive(wrapPlace(target, count));
  };
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") turn(1);
    else if (e.nativeEvent.actionName === "decrement") turn(-1);
    else if (e.nativeEvent.actionName === "activate") open(active);
  };

  const label = t("mobile.files.imageOf", { index: active + 1, count });
  return (
    <View style={[styles.block, { width }]}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.stage, { width, height: size + DECK_RISE }]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={images[active]?.detail?.title || images[active]?.file.title || label}
          accessibilityValue={{ text: label }}
          accessibilityHint={t("mobile.files.openImage")}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "activate" }]}
          onAccessibilityAction={onAction}
        >
          {images.map((item, i) => (
            <StackCard
              key={item.file.id}
              item={item}
              index={i}
              count={count}
              size={size}
              place={place}
              // The pictures in sight, or the next to come into it.
              near={wrapPlace(i - active, count) <= 3 || wrapPlace(active - i, count) <= 1}
            />
          ))}
        </Animated.View>
      </GestureDetector>
      <View style={styles.dots} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {count > MAX_DOTS ? (
          <Text variant="caption" tone="muted" style={styles.count}>
            {t("mobile.files.place", { index: active + 1, count })}
          </Text>
        ) : (
          images.map((item, i) => <Dot key={item.file.id} index={i} count={count} place={place} color={c.ink} />)
        )}
      </View>
    </View>
  );
}

function StackCard({
  item: { file, detail },
  index,
  count,
  size,
  place,
  near,
}: {
  item: StackImage;
  index: number;
  count: number;
  size: number;
  place: SharedValue<number>;
  near: boolean;
}) {
  const orgId = useOrgId();
  const c = useColors();
  const { shadows } = useTheme();
  const version = detail?.shownVersion ?? file.version;
  const link = useRemoteFile(orgId, near ? file.id : null, version);
  const [failed, setFailed] = useState(false);
  const placed = useAnimatedStyle(() => {
    const s = deckCard(index, place.value, count, size);
    return {
      opacity: s.opacity,
      zIndex: s.z,
      transform: [{ translateX: s.x }, { translateY: s.y }, { rotate: `${s.rotate}deg` }, { scale: s.scale }],
    };
  });
  return (
    <Animated.View
      style={[
        styles.card,
        { width: size, height: size, backgroundColor: c.sunken, borderColor: c.line2, boxShadow: shadows.e2 },
        placed,
      ]}
    >
      <View style={styles.clip}>
        {link.data && !failed ? (
          <Image
            source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${file.id}@${version ?? "latest"}` }}
            recyclingKey={`${file.id}@${version ?? "latest"}`}
            contentFit="cover"
            transition={160}
            style={StyleSheet.absoluteFill}
            onError={() => setFailed(true)}
            accessible={false}
          />
        ) : null}
        {failed || link.isError ? (
          <View style={styles.center}>
            <Icon name="image" size={22} color={c.faint} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** A dot that grows as its picture comes to the top, moving with the finger. */
function Dot({
  index,
  count,
  place,
  color,
}: {
  index: number;
  count: number;
  place: SharedValue<number>;
  color: string;
}) {
  const shape = useAnimatedStyle(() => {
    const away = wrapPlace(place.value - index, count);
    const near = Math.max(0, 1 - Math.min(away, count - away));
    return { width: 6 + 8 * near, opacity: 0.22 + 0.78 * near };
  });
  return <Animated.View style={[styles.dot, { backgroundColor: color }, shape]} />;
}

const styles = StyleSheet.create({
  block: { marginTop: 8 },
  stage: { position: "relative" },
  card: {
    position: "absolute",
    top: DECK_RISE,
    left: SIDE,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  clip: { flex: 1, borderRadius: 20, overflow: "hidden" },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  dots: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 20, marginTop: 8 },
  dot: { height: 6, borderRadius: 3 },
  count: { fontWeight: "600" },
});
