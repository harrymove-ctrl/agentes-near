import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, type IconName, InfoHint, Locked, Text } from "@/ui";
import { TextArea } from "./TextArea";

/**
 * A sheet's title row: an optional face or tile, the title (with an ⓘ, "About <title>", when `hint` says why) and a
 * line under it.
 */
export function SheetTitle({
  leading,
  title,
  subtitle,
  hint,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const text = <Text variant="title">{title}</Text>;
  return (
    <View style={[styles.title, hint ? styles.top : null]}>
      {leading}
      <View style={styles.grow}>
        {hint ? (
          <InfoHint name={t("common.about", { label: title })} text={hint} variant="title">
            {text}
          </InfoHint>
        ) : (
          text
        )}
        {subtitle ? (
          <Text variant="small" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One question in a sheet: a title, a line of help, the text and one button
 * ("O que mudar?", "Novo agente", "Tarefa para o Dev").
 */
export function PromptForm({
  leading,
  title,
  intro,
  placeholder,
  submitLabel,
  icon,
  initial = "",
  allowEmpty = false,
  maxLength,
  children,
  onSubmit,
}: {
  leading?: ReactNode;
  title: string;
  intro?: string;
  placeholder: string;
  submitLabel: string;
  icon?: IconName;
  initial?: string;
  allowEmpty?: boolean;
  /** The most characters the answer takes (the server's own limit). */
  maxLength?: number;
  /** Extra rows between the text and the button (who does it, where). */
  children?: ReactNode;
  /** May return a promise: the button waits for it. */
  onSubmit: (text: string) => unknown;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || (!allowEmpty && !text.trim())) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SheetTitle leading={leading} title={title} />
      {intro ? (
        <Text variant="body" tone="muted">
          {intro}
        </Text>
      ) : null}
      <Locked when={busy} style={styles.fields}>
        <TextArea
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          accessibilityLabel={title}
          autoFocus
          {...(maxLength ? { maxLength } : {})}
        />
        {children}
      </Locked>
      <Button
        variant="primary"
        wide
        {...(icon ? { icon } : {})}
        label={submitLabel}
        loading={busy}
        disabled={!allowEmpty && !text.trim()}
        onPress={() => void submit()}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { flexDirection: "row", alignItems: "center", gap: 10 },
  // The hint opens under the title: the face stays on its first line.
  top: { alignItems: "flex-start" },
  grow: { flex: 1 },
  fields: { gap: 12 },
});
