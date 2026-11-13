import { LinearGradient } from "expo-linear-gradient";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { type AgentLookInput, lookOf } from "@/agent/looks";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { type ToastTone, toastGlow, toastToneOf, toneColor } from "./palette";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface ToastInput {
  title: string;
  subtitle?: string;
  /** Default: a check (done). */
  icon?: IconName;
  /** The glow's and the icon's color; by default from the icon (`toastToneOf`: a failure, done, anything else). */
  tone?: ToastTone;
  /** Show this agent's face instead of the icon (looks from `rememberAgentLooks`). */
  agentId?: string;
  /** Or pass the look directly. */
  agent?: AgentLookInput;
  /**
   * One word at the toast's end that acts on what it reports ("Desfazer" after "Feito"): the toast stays longer
   * (`ACTION_MS`) and takes touches; tapping the word runs it and puts the toast away.
   */
  action?: { label: string; onPress: () => void };
}

type ToastFn = (input: ToastInput) => void;

const ToastContext = createContext<ToastFn | null>(null);
/** How long a plain toast stays; one with an action waits for the hand. */
const SHOW_MS = 2600;
const ACTION_MS = 5000;
/** How long the toast takes to arrive, and to leave (faster: the reading is done). */
const ENTER_MS = 280;
const LEAVE_MS = 220;
/** The toast's corner and the room around its icon tile: the tile's corner is the toast's less that room (concentric). */
const TOAST_R = 22;
const TOAST_PAD = 12;
/** Where the toast rests off screen, above the top edge. */
const HIDDEN_Y = -160;
/** A swipe up this far, or a flick, puts it away. */
const DISMISS_Y = -28;
const FLICK = -600;
/** Entering and leaving: the strong ease-out (starts fast, settles). */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const noop: ToastFn = () => {};

/** `const toast = useToast(); toast({ title, subtitle?, icon?, agentId?, action? })`: a glass note from the top. */
export function useToast(): ToastFn {
  return useContext(ToastContext) ?? noop;
}

/** Provides `useToast` and draws the toast above everything (place it once, near the root). */
export function ToastHost({ children }: { children?: ReactNode }) {
  const [current, setCurrent] = useState<(ToastInput & { key: number }) | null>(null);
  const counter = useRef(0);
  const toast = useCallback<ToastFn>((input) => {
    counter.current += 1;
    setCurrent({ ...input, key: counter.current });
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {current ? <ToastView key={current.key} item={current} onDone={() => setCurrent(null)} /> : null}
    </ToastContext.Provider>
  );
}

/**
 * The toast: it drops in from the top on a strong ease-out (no bounce: nobody threw it) and leaves the way it came,
 * a little faster. A swipe up follows the finger 1:1
 * (a pull down resists, the toast lives above) and lets go on distance or on a flick, the spring seeded with the
 * finger's speed; it goes by itself after a while. With an action, it waits longer and the word at its end runs it.
 */
function ToastView({ item, onDone }: { item: ToastInput; onDone: () => void }) {
  const { colors, shadows, reducedMotion, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const y = useSharedValue(reducedMotion ? 0 : HIDDEN_Y);
  const opacity = useSharedValue(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  // Gone once: the timer, a swipe or the action may each ask for it.
  const leaving = useRef(false);

  const leave = useCallback(
    (velocity = 0) => {
      if (leaving.current) return;
      leaving.current = true;
      opacity.set(withTiming(0, { duration: LEAVE_MS, easing: EASE_OUT }));
      if (reducedMotion) y.set(0);
      else y.set(withSpring(HIDDEN_Y, { duration: 300, dampingRatio: 1, velocity, overshootClamping: true }));
      setTimeout(() => doneRef.current(), LEAVE_MS + 120);
    },
    [opacity, reducedMotion, y],
  );

  useEffect(() => {
    y.set(reducedMotion ? 0 : withTiming(0, { duration: ENTER_MS, easing: EASE_OUT }));
    opacity.set(withTiming(1, { duration: reducedMotion ? LEAVE_MS : ENTER_MS, easing: EASE_OUT }));
    const hide = setTimeout(() => leave(), item.action ? ACTION_MS : SHOW_MS);
    return () => clearTimeout(hide);
  }, [y, opacity, reducedMotion, leave, item.action]);

  // Finger down: the toast is the finger (up freely, down with resistance). Finger up: distance or a flick dismisses,
  // else it springs home with the finger's speed.
  const start = useSharedValue(0);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-6, 6])
        .onStart(() => {
          start.set(y.get());
        })
        .onUpdate((e) => {
          const next = start.get() + e.translationY;
          y.set(next <= 0 ? next : rubberband(next));
        })
        .onEnd((e) => {
          if (y.get() < DISMISS_Y || e.velocityY < FLICK) {
            scheduleOnRN(leave, e.velocityY);
          } else {
            y.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: e.velocityY }));
          }
        }),
    [leave, start, y],
  );

  const style = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: y.get() }] }));
  const look = item.agent ?? (item.agentId ? lookOf(item.agentId) : undefined);
  const tone = item.tone ?? toastToneOf(item.icon);
  const glow = toastGlow(colors, tone, scheme);
  const act = () => {
    haptics.light();
    item.action?.onPress();
    leave();
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        // Touchable: a swipe up puts any toast away, and the word at its end acts.
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[styles.box, { top: insets.top + 6, borderRadius: TOAST_R, boxShadow: shadows.e3 }, style]}
      >
        <Glass intensity={70} style={styles.glass}>
          <LinearGradient
            colors={glow.colors}
            locations={glow.locations}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={[StyleSheet.absoluteFill, { borderRadius: TOAST_R }]}
            pointerEvents="none"
          />
          {look ? (
            <AgentAvatar agent={look} size={34} />
          ) : (
            <View style={[styles.tile, { backgroundColor: colors.raised, boxShadow: shadows.e1 }]}>
              <Icon name={item.icon ?? "check"} size={18} color={toneColor(colors, tone)} />
            </View>
          )}
          <View style={styles.words}>
            <Text variant="subhead" numberOfLines={1} style={styles.title}>
              {item.title}
            </Text>
            {item.subtitle ? (
              <Text variant="footnote" numberOfLines={2}>
                {item.subtitle}
              </Text>
            ) : null}
          </View>
          {item.action ? (
            <Pressable
              onPress={act}
              accessibilityRole="button"
              hitSlop={10}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text
                variant="subhead"
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={styles.actionText}
              >
                {item.action.label}
              </Text>
            </Pressable>
          ) : null}
        </Glass>
      </Animated.View>
    </GestureDetector>
  );
}

/** Pulled down past rest, the toast follows less the further it goes (it lives above, there is nothing below). */
function rubberband(overshoot: number, dimension = 80, constant = 0.55) {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const styles = StyleSheet.create({
  box: { position: "absolute", left: 12, right: 12 },
  glass: {
    borderRadius: TOAST_R,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: TOAST_PAD,
    paddingHorizontal: 14,
  },
  tile: { width: 34, height: 34, borderRadius: TOAST_R - TOAST_PAD, alignItems: "center", justifyContent: "center" },
  words: { flex: 1, minWidth: 0 },
  title: { fontWeight: weights.semibold },
  // The word stands on its own at the end: no plate, a 44-point target through the slop.
  action: { paddingLeft: 4, minHeight: 34, justifyContent: "center" },
  actionText: { fontWeight: weights.semibold },
  pressed: { opacity: 0.6 },
});
