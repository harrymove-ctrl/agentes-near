import { useRef, useState } from "react";
import { Pressable, Text as RNText, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { haptics } from "./haptics";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface CodeInputProps {
  /** How many digits the code has (one box each). */
  length: number;
  value: string;
  onChange: (value: string) => void;
  /** What a screen reader says for the field ("Code for github.com"). */
  label: string;
  /** The boxes' edges in the danger color. */
  error?: boolean;
  autoFocus?: boolean;
  /** The keyboard's return key (and the last digit typed, with `submitOnComplete`). */
  onSubmit?: () => void;
  /** Sends as soon as every box is filled. Off by default: a person checks the code before it goes. */
  submitOnComplete?: boolean;
}

/**
 * A code of a few digits, one box per digit (ADR 0144 §6: a code a site sent by text or email, typed by the agent's
 * browser). One real field lies over the boxes, so the system's number pad, "paste" and the code it offers from a
 * message fill every box at once; typing moves to the next box and deleting goes back by itself. The boxes only draw
 * what the field holds, with the next one to fill outlined.
 */
export function CodeInput({
  length,
  value,
  onChange,
  label,
  error = false,
  autoFocus = false,
  onSubmit,
  submitOnComplete = false,
}: CodeInputProps) {
  const { colors } = useTheme();
  const input = useRef<TextInputInstance | null>(null);
  const [focused, setFocused] = useState(false);
  const digits = value.replace(/\D/g, "").slice(0, length);
  const change = (text: string) => {
    const next = text.replace(/\D/g, "").slice(0, length);
    if (next.length > digits.length) haptics.selection();
    onChange(next);
    if (submitOnComplete && next.length === length && digits.length < length) onSubmit?.();
  };
  // Twelve boxes still fit a card on a small phone: narrower gaps for long codes.
  const gap = length > 8 ? 4 : 8;
  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false} style={styles.wrap}>
      <View style={[styles.row, { gap }]} pointerEvents="none">
        {Array.from({ length }, (_, i) => {
          const char = digits[i] ?? "";
          const next = focused && i === Math.min(digits.length, length - 1);
          const edge = error ? colors.danger : next ? colors.ink : colors.line2;
          return (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the boxes are positions, in order
              key={i}
              style={[
                styles.box,
                {
                  backgroundColor: colors.raised,
                  borderColor: edge,
                  borderWidth: next || error ? 1.5 : StyleSheet.hairlineWidth,
                },
              ]}
            >
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("title3", weights.semibold), styles.digit, { color: colors.ink }]}
              >
                {char}
              </RNText>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={input}
        value={digits}
        onChangeText={change}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={autoFocus}
        maxLength={length}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoCorrect={false}
        spellCheck={false}
        caretHidden
        selectionColor="transparent"
        returnKeyType="send"
        onSubmitEditing={onSubmit}
        submitBehavior="submit"
        accessibilityLabel={label}
        style={[StyleSheet.absoluteFill, styles.field]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  row: { flexDirection: "row", justifyContent: "center" },
  box: {
    flex: 1,
    maxWidth: 46,
    height: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  digit: { fontVariant: ["tabular-nums"] },
  // The real field is there to be touched and typed into; the boxes show what it holds.
  field: { color: "transparent", opacity: 0.02, fontSize: 1 },
});
