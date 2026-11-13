import { type ReactNode, useEffect, useId, useState } from "react";
import { AccessibilityInfo, BackHandler, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { hintBack, hintClosed, hintOpened, hintTouched } from "./hints";
import { Icon } from "./Icon";
import { Text, type TextVariant, textLineOf } from "./Text";
import { useFontScale } from "./text-scale";
import { motion, useTheme } from "./theme";
import { leadBox } from "./type-scale";

/** The ⓘ as drawn (points); `hitSlop` makes its target 44. */
const GLYPH = 18;
const SLOP = (44 - GLYPH) / 2;
const HINT_IN = FadeIn.duration(motion.fast);

export interface InfoHintOptions {
  /** The ⓘ's accessible name, translated: `t("common.about", { label })` → "About Time zone". */
  name: string;
  /** Plain sentences only: no links, buttons or lists. */
  text: string;
  /** The label's text variant: the ⓘ sits on its first line. Without it (beside a control), centered on it. */
  variant?: TextVariant;
  /** A centered label (a title over a centered screen): the text shows centered too. */
  center?: boolean;
}

/**
 * The ⓘ and its text, apart, for a row that places them itself (`GroupedField`): the text goes right under the
 * row, after the ⓘ in reading order. A tap on the ⓘ shows it and a second hides it, as do a tap anywhere else and
 * Android's back (`hints.ts`); one hint is open at a time.
 */
export function useInfoHint({ name, text, variant, center = false }: InfoHintOptions) {
  const id = useId();
  const { colors: c, reducedMotion } = useTheme();
  const fontScale = useFontScale();
  const [open, setOpen] = useState(false);
  useEffect(() => () => hintClosed(id), [id]);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", hintBack);
    return () => sub.remove();
  }, [open]);
  const toggle = () => {
    if (open) hintClosed(id);
    else {
      hintOpened({ id, close: () => setOpen(false) });
      // VoiceOver has no live regions: without this it hears only "expanded" and has to look for the text.
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(text);
    }
    setOpen(!open);
  };
  const touched = () => hintTouched(id);
  const button = (
    <Pressable
      onPress={toggle}
      onTouchStart={touched}
      hitSlop={SLOP}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [
        variant ? leadBox(textLineOf(variant, fontScale), GLYPH) : null,
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Icon name="info" size={GLYPH} color={open ? c.ink : c.muted} />
    </Pressable>
  );
  // Always there, so TalkBack reads the text as it appears (VoiceOver: the announcement above).
  const body = (
    <View accessibilityLiveRegion="polite" onTouchStart={touched}>
      {/* It fades in as it opens; closing, it goes at once (a fading copy would sit over what moves up). */}
      {open ? (
        <Animated.View entering={reducedMotion ? undefined : HINT_IN}>
          <Text variant="footnote" tone="muted" style={[styles.text, center ? styles.centered : null]}>
            {text}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
  return { button, text: body, open };
}

/**
 * A label with an ⓘ right after it, and the setting's explanation under them while it is open (an inline
 * disclosure: several hints live inside sheets, where a popover or a second sheet would be awkward).
 */
export function InfoHint({ children, ...options }: InfoHintOptions & { children: ReactNode }) {
  const hint = useInfoHint(options);
  return (
    <View>
      <View style={[styles.row, options.variant ? null : styles.control, options.center ? styles.centerRow : null]}>
        <View style={styles.label}>{children}</View>
        {hint.button}
      </View>
      {hint.text}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  control: { alignItems: "center" },
  centerRow: { justifyContent: "center" },
  label: { flexShrink: 1, minWidth: 0 },
  text: { marginTop: 4 },
  centered: { textAlign: "center" },
});
