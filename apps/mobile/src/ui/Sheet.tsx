import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { concentricRadius, displayCornerRadius } from "./display-corner";
import { Glass } from "./Glass";
import { hintBackOr } from "./hints";
import { useTheme } from "./theme";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  /** An opaque surface instead of glass (requests to approve, forms). */
  solid?: boolean;
  /**
   * Once the sheet is gone from the screen (slid out and its modal dismissed). Something the system presents (the
   * photo library, the camera) must wait for it: presented over a sheet still leaving, iOS dismisses it with the
   * sheet, and its answer never comes.
   */
  onGone?: () => void;
  /**
   * Pinned over the content while it scrolls (a picker's bar and its search): it drags the sheet as the grabber does,
   * and a tap still reaches what is in it.
   */
  header?: ReactNode;
}

/** After the sheet unmounts, the time iOS takes to dismiss its modal before something else may be presented. */
const GONE_MS = 80;

/** How far the grabber must be dragged down to close (points), as on the web. */
const CLOSE_DRAG = 90;
/** How far the sheet floats from the screen's edges. */
const INSET = 8;
/** The sheet's top corners (and the least for its bottom ones). */
const RADIUS = 34;
/** The sheet's width with the phone sideways: a form as wide as the phone is hard to read. */
const WIDE_WIDTH = 560;

/**
 * The bottom sheet (no dialogs on the phone): floats 8 points from the edges, its bottom corners following
 * the screen's curve, glass on iOS and an opaque surface on Android, a grabber to drag down, a scrim to tap
 * away. Keyboard-aware for forms: with the keyboard up it fits the room above it and scrolls.
 */
export function Sheet({ open, onClose, children, solid = false, onGone, header }: SheetProps) {
  const { colors, shadows, reducedMotion, motion } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const bottomRadius = concentricRadius(
    displayCornerRadius(Platform.OS === "ios" ? "ios" : "android", width, height, insets.bottom),
    INSET,
    RADIUS,
  );
  const corners = { borderBottomLeftRadius: bottomRadius, borderBottomRightRadius: bottomRadius };
  const room = width - 2 * Math.max(insets.left, insets.right);
  const wide = width > height ? { width: Math.min(WIDE_WIDTH, room), alignSelf: "center" as const } : null;
  const [mounted, setMounted] = useState(open);
  const y = useSharedValue(height);
  const scrim = useSharedValue(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const wasMounted = useRef(mounted);
  // Unmounted, the modal still dismisses for a moment on iOS: what follows waits for that too.
  useEffect(() => {
    if (wasMounted.current && !mounted) setTimeout(() => goneRef.current?.(), GONE_MS);
    wasMounted.current = mounted;
  }, [mounted]);

  const ease = Easing.bezier(0.32, 0.72, 0, 1);
  const ms = reducedMotion ? 0 : 420;

  // Only `open` drives the animation; the rest is read at that moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only `open` drives the animation
  useEffect(() => {
    if (open) {
      // The screen's own field (the composer) lets go of the keyboard first. Kept, iOS gave the keyboard back
      // when the sheet closed and the composer stayed under it.
      if (!mounted) Keyboard.dismiss();
      setMounted(true);
      y.value = height;
      y.value = withTiming(0, { duration: ms, easing: ease });
      scrim.value = withTiming(1, { duration: reducedMotion ? 0 : motion.panel });
    } else if (mounted) {
      scrim.value = withTiming(0, { duration: reducedMotion ? 0 : motion.base });
      y.value = withTiming(height, { duration: reducedMotion ? 0 : motion.panel, easing: ease }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
  }, [open]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // A tap goes to what is under the finger (the header's buttons and field); a move down takes the sheet.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          y.value = Math.max(0, g.dy);
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy > CLOSE_DRAG || g.vy > 1.2) closeRef.current();
          else y.value = withTiming(0, { duration: 220, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
        },
        onPanResponderTerminate: () => {
          y.value = withTiming(0, { duration: 220 });
        },
      }),
    [y],
  );

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));

  if (!mounted) return null;
  return (
    // Both ways, or iOS aborts: a modal's default is portrait, and a view lying down shares no orientation with it.
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={hintBackOr(onClose)}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t("mobile.a11y.closeSheet")} />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.dock, { paddingTop: insets.top + INSET }]}
        pointerEvents="box-none"
      >
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, corners, wide, { maxHeight: height * 0.86, boxShadow: shadows.e3 }, sheetStyle]}
        >
          <Glass solid={solid} intensity={70} style={[styles.surface, corners]}>
            <View
              {...pan.panHandlers}
              style={styles.grab}
              accessibilityRole="adjustable"
              accessibilityLabel={t("mobile.a11y.grabber")}
            >
              <View style={[styles.grabBar, { backgroundColor: colors.grabber }]} />
            </View>
            {header ? <View {...pan.panHandlers}>{header}</View> : null}
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24 + Math.max(0, insets.bottom - INSET) }}
            >
              {children}
            </ScrollView>
          </Glass>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dock: { flex: 1, justifyContent: "flex-end" },
  // Shrinks to the room above the keyboard (its content scrolls), never past the status bar.
  sheet: { marginHorizontal: INSET, marginBottom: INSET, borderRadius: RADIUS, flexShrink: 1 },
  surface: { borderRadius: RADIUS, paddingTop: 8, overflow: "hidden", flexShrink: 1 },
  grab: { alignItems: "center", paddingTop: 4, paddingBottom: 10 },
  // The system's own grabber (as `SheetSurface` draws it): 36 × 5, round ends; the hairline's tone was too faint on
  // the glass.
  grabBar: { width: 36, height: 5, borderRadius: 2.5 },
});
