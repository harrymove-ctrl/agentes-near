import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  Pressable,
  Text as RNText,
  TextInput,
  type TextInputInstance,
  type TextInputProps,
  View,
} from "react-native";
import Animated, { FadeInRight, FadeOutRight, LinearTransition } from "react-native-reanimated";
import { Icon } from "./Icon";
import { searchCancelVisible } from "./searchMode";
import { systemText } from "./Text";
import { useTheme } from "./theme";

export interface SearchFieldProps extends Omit<TextInputProps, "style"> {
  value: string;
  onChangeText: (text: string) => void;
  ref?: Ref<TextInputInstance | null>;
  /**
   * Turns on the "Cancelar" button to the right of the field (like iOS's search bar): tapping it clears the
   * words, drops the keyboard and calls this (the screen goes back to its list).
   */
  onCancel?: () => void;
  /** Forces the cancel button on or off; by default it shows while the field is focused or has words. */
  showCancel?: boolean;
  /**
   * On the grouped gray, the field is white with a hairline (the system's search over grouped lists): the default
   * gray fill would sink into the gray around it.
   */
  raised?: boolean;
}

/** The search box: sunken, a magnifier, a clear button when there is text, and "Cancelar" with `onCancel`. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  ref,
  onCancel,
  showCancel,
  raised = false,
  onFocus,
  onBlur,
  ...rest
}: SearchFieldProps) {
  const { colors, reducedMotion } = useTheme();
  const { t } = useTranslation();
  const input = useRef<TextInputInstance | null>(null);
  useImperativeHandle(ref, () => input.current as TextInputInstance, []);
  const [focused, setFocused] = useState(false);
  const cancelShown = Boolean(onCancel) && searchCancelVisible({ focused, value, showCancel });
  const cancel = () => {
    onChangeText("");
    input.current?.blur();
    Keyboard.dismiss();
    setFocused(false);
    onCancel?.();
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Animated.View
        layout={reducedMotion ? undefined : LinearTransition.duration(220)}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 42,
          paddingHorizontal: 12,
          borderRadius: 14,
          // The system's fill (a gray at 10%) on white; white with a hairline on the grouped gray.
          backgroundColor: raised ? colors.raised : colors.plate,
          ...(raised ? { boxShadow: `0px 0px 0px 0.5px ${colors.line2}` } : {}),
        }}
      >
        <Icon name="search" size={18} color={colors.faint} />
        <TextInput
          {...rest}
          ref={input}
          value={value}
          onChangeText={onChangeText}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholder={placeholder ?? t("mobile.search.placeholder")}
          placeholderTextColor={colors.faint}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, fontSize: systemText("body").fontSize, color: colors.ink, paddingVertical: 8 }}
        />
        {value ? (
          <Pressable
            onPress={() => onChangeText("")}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.a11y.clearSearch")}
            // A 16-point glyph: 14 of slop around it gives the 44-point target.
            hitSlop={14}
            style={({ pressed }) => (pressed ? { opacity: 0.4 } : null)}
          >
            <Icon name="x" size={16} color={colors.faint} />
          </Pressable>
        ) : null}
      </Animated.View>
      {cancelShown ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInRight.duration(220)}
          exiting={reducedMotion ? undefined : FadeOutRight.duration(180)}
        >
          <Pressable
            onPress={cancel}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => ({ paddingLeft: 12, paddingVertical: 8, opacity: pressed ? 0.4 : 1 })}
          >
            <RNText numberOfLines={1} style={[systemText("body"), { color: colors.ink }]}>
              {t("mobile.common.cancel")}
            </RNText>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
