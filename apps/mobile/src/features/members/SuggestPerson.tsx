import { useAuthConfig, usePeople, useRoles, useSuggestPerson } from "@agenteschat/client";
import { errorCode, knownErrorText } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { JOIN_NOTE_MAX, sendsEmail } from "@agenteschat/client/lib/join-requests";
import { isEmail } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { fieldText, GROUPED_ROW, GroupedFooter, GroupedHeader, GroupedList, Text, useToast } from "@/ui";
import { Page } from "../me/parts";
import { useColors } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { invitersOf, suggestRefusal } from "./logic";

/**
 * Sugerir pessoa, for a member who may not invite (ADR 0090 §7): an address and, if they like, who it is, which reach
 * the people who invite as a request. "Mandar" in the bar; refusals said under the address, in our words.
 */
export function SuggestPersonScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const toast = useToast();
  const people = usePeople(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const suggest = useSuggestPerson(orgId);
  // Where no email goes out, whoever approves hands the person the link instead.
  const emails = sendsEmail(useAuthConfig().data);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (!isEmail(address)) return setError(t("members.suggest.refused.invalid"));
    setError(null);
    try {
      await suggest.mutateAsync({ email: address, ...(note.trim() ? { note: note.trim() } : {}) });
      const inviters = invitersOf(people, roles);
      successHaptic();
      toast({
        title: inviters.length
          ? t("members.suggest.sent", { count: inviters.length, names: namesText(t, inviters, 2) })
          : t("members.suggest.sentNoNames"),
      });
      goBack();
    } catch (e) {
      const refusal = suggestRefusal(errorCode(e));
      setError(
        refusal
          ? t(`members.suggest.refused.${refusal}`, { email: address, org: org?.name ?? "" })
          : (knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed")),
      );
    }
  };

  return (
    <Page
      title={t("members.suggest.button")}
      action={{
        label: t("mobile.invitePeople.send"),
        disabled: suggest.isPending || !email.trim(),
        onPress: () => void submit(),
      }}
      locked={suggest.isPending}
    >
      <GroupedHeader>{t("members.suggest.email")}</GroupedHeader>
      <GroupedList>
        <View style={styles.field}>
          <TextInput
            value={email}
            onChangeText={(next) => {
              setEmail(next);
              setError(null);
            }}
            placeholder={t("members.emailsPlaceholder")}
            placeholderTextColor={c.faint}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            spellCheck={false}
            returnKeyType="done"
            autoFocus
            accessibilityLabel={t("members.suggest.email")}
            style={[fieldText("callout"), styles.input, { color: c.ink }]}
          />
        </View>
      </GroupedList>
      {error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <GroupedHeader>
        {t("common.joinSentences", { a: t("members.suggest.who"), b: t("members.dialog.optional") })}
      </GroupedHeader>
      <TextArea
        value={note}
        onChangeText={setNote}
        placeholder={t("members.suggest.whoPlaceholder")}
        accessibilityLabel={t("members.suggest.who")}
        maxLength={JOIN_NOTE_MAX}
      />
      <GroupedFooter>{t(emails ? "members.suggest.dialogText" : "members.suggest.dialogTextNoEmail")}</GroupedFooter>
    </Page>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: GROUPED_ROW.minHeight, paddingHorizontal: GROUPED_ROW.padX, justifyContent: "center" },
  input: { paddingVertical: GROUPED_ROW.tallPadY, paddingHorizontal: 0 },
  error: { paddingTop: 8, paddingHorizontal: 16 },
});
