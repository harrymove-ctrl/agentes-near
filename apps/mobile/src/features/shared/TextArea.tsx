import type { Ref } from "react";
import { StyleSheet, TextInput, type TextInputInstance, type TextInputProps } from "react-native";
import { useSystemText } from "@/ui";
import { useColors } from "./hooks";

/**
 * A multi-line field on a raised surface (sheets: reason to refuse, a new
 * agent, a task, a mission's goal). The design system has the composer and
 * the search field but no plain text area, so it is composed here. `ref`: the
 * field, for a screen that focuses it (an idea added to a text).
 */
export function TextArea({
  style,
  minHeight = 84,
  ref,
  ...props
}: Omit<TextInputProps, "ref"> & { minHeight?: number; ref?: Ref<TextInputInstance | null> }) {
  const c = useColors();
  // What people write grows with their text size, as the text around it.
  const words = useSystemText("body");
  return (
    <TextInput
      ref={ref}
      multiline
      textAlignVertical="top"
      placeholderTextColor={c.faint}
      {...props}
      style={[styles.field, words, { minHeight, backgroundColor: c.raised, color: c.ink, borderColor: c.line }, style]}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
});
