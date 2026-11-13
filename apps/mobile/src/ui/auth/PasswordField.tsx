import { passwordState } from "@agenteschat/client/lib/text";
import { type ComponentRef, forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TextInput, View } from "react-native";
import { IconButton } from "../IconButton";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { AuthField } from "./AuthField";

export interface PasswordFieldProps {
  value: string;
  onChangeText: (value: string) => void;
  /** A new password: the 8-pixel meter below and the system's strong-password suggestion. */
  fresh?: boolean;
  /** Focused and hidden, or shown: the agent shuts its eyes or winks. */
  onSecretChange?: (secret: boolean) => void;
  onShow?: () => void;
  onSubmitEditing?: () => void;
  label: string;
  /** Focused as it appears (default): the one field of its step. Off when it stands among other fields. */
  autoFocus?: boolean;
  /** Return hands the keyboard to the next field (`onSubmitEditing` focuses it) instead of closing it. */
  keepFocus?: boolean;
}

/** A password with "show" beside it; a new one also gets the 8-pixel meter. */
export const PasswordField = forwardRef<ComponentRef<typeof TextInput>, PasswordFieldProps>(function PasswordField(
  { value, onChangeText, fresh, onSecretChange, onShow, onSubmitEditing, label, autoFocus = true, keepFocus = false },
  ref,
) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [focus, setFocus] = useState(false);
  const report = (nextFocus: boolean, nextShow: boolean) => onSecretChange?.(nextFocus && !nextShow);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ justifyContent: "center" }}>
        <AuthField
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={fresh ? "new-password" : "current-password"}
          textContentType={fresh ? "newPassword" : "password"}
          passwordRules={fresh ? "minlength: 8; maxlength: 128;" : undefined}
          returnKeyType={keepFocus ? "next" : "go"}
          submitBehavior={keepFocus ? "submit" : undefined}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => {
            setFocus(true);
            report(true, show);
          }}
          onBlur={() => {
            setFocus(false);
            report(false, show);
          }}
          accessibilityLabel={label}
          autoFocus={autoFocus}
          paddingRight={52}
        />
        <View style={{ position: "absolute", right: 4 }}>
          <IconButton
            icon={show ? "eyeoff" : "eye"}
            label={show ? t("auth.hidePassword") : t("auth.showPassword")}
            onPress={() => {
              const next = !show;
              setShow(next);
              report(focus, next);
              if (next) onShow?.();
            }}
          />
        </View>
      </View>
      {fresh ? <PasswordMeter password={value} /> : null}
    </View>
  );
});

/** One pixel per character up to the 8 needed, then "Senha ok." (the web's `PasswordHelp`). */
export function PasswordMeter({ password }: { password: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const state = passwordState(password);
  const text =
    state === "empty"
      ? t("auth.passwordHelp")
      : state === "ok"
        ? t("auth.passwordOk")
        : state === "long"
          ? t("auth.passwordTooLong")
          : t("auth.passwordMissing", { count: 8 - password.length });
  const on = state === "ok" ? colors.ok : state === "long" ? colors.danger : colors.ink2;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 4 }}
    >
      <View style={{ flexDirection: "row", gap: 2 }} accessibilityElementsHidden importantForAccessibility="no">
        {Array.from({ length: 8 }, (_, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: eight fixed cells
            key={i}
            style={{ width: 6, height: 6, backgroundColor: i < password.length ? on : colors.line }}
          />
        ))}
      </View>
      <Text variant="footnote" tone={state === "ok" ? "ok" : state === "long" ? "danger" : "muted"}>
        {text}
      </Text>
    </View>
  );
}
