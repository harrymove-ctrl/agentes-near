import { ApiError, useApi, useAuthConfig, useDeleteWorkspace, useMe } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { deletionProof, proofToSend } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { typedCode } from "@agenteschat/client/lib/join-requests";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  HoldButton,
  Locked,
  Text,
  useToast,
} from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { PasswordField } from "@/ui/auth/PasswordField";
import { router } from "@/ui/navigation";
import { openWebPath } from "../links/open-web";
import { useNow } from "../shared/hooks";
import { errorHaptic } from "../shared/parts";
import { Gap, SettingsPage } from "./parts";

/**
 * Apagar o workspace, the screen after the alert on the workspace's page (owners): what it does, in the grouped
 * list's words (`deleteOrg.goes.*`), then the proof that it's them (ADR 0088 §2: a code emailed to them, or on a
 * server that sends no email their password, which the website adds first to an account without one), and the hold.
 * Done, the app's root shows the workspace as being deleted, with Restore for its owners, so this screen only goes
 * back. The hold is the one deliberate motion here: a linear fill while held, a quick snap back on release.
 */
export function DeleteWorkspaceScreen() {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const me = useMe().data;
  const config = useAuthConfig().data;
  const remove = useDeleteWorkspace(orgId);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [sending, setSending] = useState(false);
  // Why the proof was refused, under its field.
  const [refused, setRefused] = useState<string | null>(null);
  const proof = deletionProof(config, me?.user.hasPassword);
  const left = sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 ? 1000 : 60_000);
  const toSend = proofToSend(proof, { sent: sent !== null, code, password });
  const name = org?.name ?? "";
  const busy = remove.isPending;

  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const sendCode = async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await api.orgs.deletionCode(orgId);
      codeOut(r.email, r.resendIn);
      setCode("");
      setRefused(null);
    } catch (e) {
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "reauth.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(me?.user.email ?? "", retryIn);
      else setRefused(errorText(t, e));
    } finally {
      setSending(false);
    }
  };

  const confirm = () => {
    if (busy || !toSend.ready) return;
    remove.mutate(toSend.input, {
      onSuccess: () => {
        // The hold already answered the finger. Back at Conversas, the workspace reads as ever under its notice on top.
        router.dismissTo("/");
      },
      onError: (e) => {
        errorHaptic();
        const code = e instanceof ApiError ? e.code : "";
        if (code.startsWith("reauth.")) {
          setRefused(errorText(t, e));
          setCode("");
          setPassword("");
        } else toast({ title: errorText(t, e) || t("mobile.settings.deleteFailed"), icon: "x" });
      },
    });
  };

  return (
    <SettingsPage title={t("deleteOrg.card.title")} locked={busy}>
      <Gap />
      <Text variant="body" tone="ink2" style={styles.intro}>
        {t("mobile.settings.deleteIntro", { name })}
      </Text>
      <GroupedHeader>{t("deleteOrg.card.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow key="content" icon="archive" label={t("deleteOrg.goes.content")} labelLines={3} />
        <GroupedRow key="people" icon="members" label={t("deleteOrg.goes.peopleQuiet")} labelLines={3} />
        <GroupedRow key="connectors" icon="join" label={t("deleteOrg.goes.connectors")} labelLines={3} />
      </GroupedList>
      <GroupedFooter>{t("mobile.settings.deleteFoot")}</GroupedFooter>

      <View style={styles.proof}>
        {proof === "code" && !sent ? (
          <>
            <Text variant="body" tone="ink2">
              {t("proof.willSend", { email: me?.user.email ?? "" })}
            </Text>
            <Button variant="secondary" label={t("proof.send")} loading={sending} onPress={() => void sendCode()} />
          </>
        ) : null}
        {proof === "code" && sent ? (
          <>
            <Locked when={busy || sending}>
              <AuthField
                code
                value={code}
                onChangeText={(value) => {
                  setCode(typedCode(value));
                  setRefused(null);
                }}
                placeholder={t("proof.code")}
                accessibilityLabel={t("proof.code")}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                returnKeyType="done"
              />
            </Locked>
            <Text variant="small" tone="muted">
              {t("proof.sent", { email: sent.email })}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              label={left > 0 ? t("proof.resendIn", { time: formatTimeLeft(left) }) : t("proof.resend")}
              disabled={left > 0 || busy}
              loading={sending}
              onPress={() => void sendCode()}
            />
          </>
        ) : null}
        {proof === "password" ? (
          <Locked when={busy}>
            <PasswordField
              label={t("proof.password")}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setRefused(null);
              }}
            />
          </Locked>
        ) : null}
        {proof === "addPassword" ? (
          <>
            <Text variant="body" tone="ink2">
              {t("mobile.delete.addPasswordFirst")}
            </Text>
            <Button
              variant="secondary"
              label={t("mobile.delete.addPasswordWeb")}
              onPress={() => openWebPath(`/org/${orgId}?account=password`)}
            />
          </>
        ) : null}
        {refused ? (
          <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
            {refused}
          </Text>
        ) : null}
        <HoldButton label={t("mobile.settings.holdDelete")} disabled={!toSend.ready || busy} onConfirm={confirm} />
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16 },
  proof: { gap: 12, paddingTop: 24 },
});
