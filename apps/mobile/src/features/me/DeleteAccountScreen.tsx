import { ApiError, useAccountDeletionPlan, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import {
  type AccountDeletionLine,
  accountDeletionLines,
  deletableWorkspaces,
  deletionDueFrom,
  deletionProof,
  proofToSend,
  soleOwnerWaysOut,
  workspaceLabel,
  workspaceNotes,
  workspaceOpens,
} from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate, joinNames } from "@agenteschat/client/lib/format";
import { settingUp } from "@agenteschat/client/lib/guards";
import { typedCode } from "@agenteschat/client/lib/join-requests";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { deleteAccount } from "@/features/account";
import { Button, CARD_PAD, Card, HoldButton, type IconName, LineIcon, Locked, SCREEN_X, Text, useToast } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { PasswordField } from "@/ui/auth/PasswordField";
import { openWebPath } from "../links/open-web";
import { useColors, useNow } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { preflightMissing } from "./logic";

const LINE_ICON: Record<AccountDeletionLine["kind"], IconName> = {
  when: "clock",
  closes: "x",
  leaves: "out",
  computers: "laptop",
  staysBehind: "lock",
  plan: "clock",
  messages: "chat",
  serverOwner: "server",
};

/**
 * Apagar conta (App Store 5.1.1(v)). The title and first line say it's the whole account, not one workspace, 7 days out
 * with a way back until then. What goes and what stays, from the preflight (each workspace that closes with what it holds, what they leave, the computers
 * removed, what stays behind with where to disconnect it on the website, and where plans are billed that theirs stop
 * renewing), the way to delete just a workspace on the website, then a hold. A workspace that still needs this person
 * as its only owner comes first, with its two ways out on the website (People, or deleting it; its onboarding, while
 * it's still being set up). Then the proof that it's them (ADR 0088 §2): a code emailed to them, or on a server that
 * sends no email their password, which the website adds first to an account without one. A server from before the
 * preflight gets the fixed lines and the hold, as it always did.
 */
export function DeleteAccountScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const plan = useAccountDeletionPlan();
  const meQuery = useMe();
  const me = meQuery.data;
  const config = useAuthConfig().data;
  // The account this screen is about: signing in again to another one deletes nothing.
  const account = useRef(me?.user.id);
  account.current ??= me?.user.id;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ email: string; resendAt: number } | null>(null);
  const [sending, setSending] = useState(false);
  // Why the proof was refused, under its field.
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An older server's own refusal: the workspaces it names.
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const legacy = plan.isError && preflightMissing(plan.error);
  const proof = legacy ? null : deletionProof(config, me?.user.hasPassword);
  const blockers = plan.data?.soleOwner ?? [];
  const left = sent ? Math.max(0, sent.resendAt - Date.now()) : 0;
  // A repaint every second while the countdown runs; the time itself is read just above.
  useNow(left > 0 ? 1000 : 60_000);
  const toSend = proof ? proofToSend(proof, { sent: sent !== null, code, password }) : null;
  const ready = toSend === null || toSend.ready;
  const web = openWebPath;
  const notes = workspaceNotes(t, i18n.language, me?.organizations ?? []);
  const named = (o: { id: string; name: string }) => workspaceLabel(o.name, notes.get(o.id));
  const lines = plan.data
    ? accountDeletionLines(t, i18n.language, plan.data, {
        cloud: config?.workspaceComputer === true,
        billing: Boolean(config?.billingUrl),
        notes,
      })
    : [];
  const inSetup = (id: string) => me?.organizations.some((o) => o.id === id && settingUp(o)) === true;
  // Where the website's account menu adds a password: a workspace of theirs that is open.
  const shell = me?.organizations.find(workspaceOpens);
  const own = deletableWorkspaces(me?.organizations ?? []);

  const codeOut = (email: string, resendIn: number) => setSent({ email, resendAt: Date.now() + resendIn * 1000 });
  const sendCode = async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await api.account.deletionCode();
      codeOut(r.email, r.resendIn);
      setCode("");
      setRefused(null);
    } catch (e) {
      // A code went out a moment ago (another try, another device): that one is still good.
      const retryIn = e instanceof ApiError && e.code === "reauth.code_wait" ? Number(e.params?.retryIn) : 0;
      if (retryIn > 0) codeOut(me?.user.email ?? "", retryIn);
      else if (errorCode(e) === "sole_owner") void plan.refetch();
      else setRefused(errorText(t, e));
    } finally {
      setSending(false);
    }
  };

  const confirm = async () => {
    if (busy || !ready) return;
    setBusy(true);
    const now = await api.account.me().catch(() => null);
    if (now && now.user.id !== account.current) {
      setBusy(false);
      toast({ title: t("mobile.delete.otherAccount"), icon: "x" });
      return;
    }
    const result = await deleteAccount(toSend?.input);
    setBusy(false);
    // Scheduled: the session ends and the gate shows sign-in, which comes back to the waiting screen.
    // An older server deletes at once: there is no date, and nothing to come back to.
    if (result.ok) {
      if (!legacy)
        toast({ title: t("mobile.account.deleted", { date: formatShortDate(i18n.language, deletionDueFrom()) }) });
    } else if (result.reason === "sole_owner") {
      if (legacy) setBlockedBy(result.organizations);
      else void plan.refetch();
    } else if (result.reason === "proof") {
      setRefused(errorText(t, result.error));
      setCode("");
      setPassword("");
    } else
      toast({
        title: t(result.reason === "rate_limited" ? "common.tooMany" : "mobile.account.deleteFailed"),
        icon: "x",
      });
  };

  const line = (key: string, icon: IconName, text: string, links?: AccountDeletionLine["links"]) => (
    <View key={key} style={styles.line}>
      <View style={styles.item}>
        <LineIcon name={icon} variant="small" size={16} color={c.muted} />
        <Text variant="small" tone="ink2" style={styles.grow}>
          {text}
        </Text>
      </View>
      {links?.length ? (
        <View style={styles.acts}>
          {links.map((l) => (
            <Button
              key={l.label}
              variant="secondary"
              size="sm"
              label={l.label}
              onPress={() => web(`/org/${l.orgId}/settings/${l.section}`)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={t("mobile.me.deleteAccount")} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <Text variant="display">{t("deleteAccount.title")}</Text>
        <Text variant="body" tone="muted">
          {t("deleteAccount.intro")} {t(legacy ? "mobile.delete.intro" : "mobile.delete.introGrace")}
        </Text>
        <Card>
          <View style={styles.list}>
            {line("account", "x", t("mobile.delete.goes.account"))}
            {legacy ? (
              <>
                {line("orgs", "x", t("mobile.delete.goes.orgs"))}
                {line("stays", "chat", t("mobile.delete.stays"))}
              </>
            ) : (
              lines.map((l) => line(`${l.kind}:${l.text}`, LINE_ICON[l.kind], l.text, l.links))
            )}
            {line("phones", "x", t("mobile.delete.goes.phones"))}
          </View>
        </Card>
        {own.length > 0 && blockers.length === 0 && blockedBy.length === 0 ? (
          <Card>
            <View style={styles.list}>
              <Text variant="small" tone="ink2">
                {t("deleteAccount.oneWorkspace")}
              </Text>
              <View style={styles.acts}>
                {own.map((o) => (
                  <Button
                    key={o.id}
                    variant="secondary"
                    size="sm"
                    label={t("deleteAccount.deleteOrg", { name: named(o) })}
                    onPress={() => web(soleOwnerWaysOut(o.id, settingUp(o)).delete)}
                  />
                ))}
              </View>
            </View>
          </Card>
        ) : null}
        {plan.isError && !legacy ? (
          <Button variant="secondary" label={t("mobile.common.retry")} onPress={() => void plan.refetch()} />
        ) : !plan.data && !legacy ? (
          <ActivityIndicator color={c.muted} />
        ) : blockers.length > 0 || blockedBy.length > 0 ? (
          <Card>
            <View style={styles.list}>
              <Text variant="title">{t("deleteAccount.blockers")}</Text>
              {blockers.map((o) => {
                const setup = inSetup(o.id);
                const out = soleOwnerWaysOut(o.id, setup);
                return (
                  <View key={o.id} style={styles.line}>
                    <Text variant="small" tone="ink2">
                      {t(setup ? "deleteAccount.soleOwnerSettingUp" : "deleteAccount.soleOwner", { name: named(o) })}
                    </Text>
                    <View style={styles.acts}>
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t(setup ? "deleteAccount.finishSetup" : "deleteAccount.openPeople")}
                        onPress={() => web(out.people)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        label={t("deleteAccount.deleteOrg", { name: named(o) })}
                        onPress={() => web(out.delete)}
                      />
                    </View>
                  </View>
                );
              })}
              {blockedBy.length > 0 ? (
                <Text variant="small" tone="ink2">
                  {t("mobile.delete.blocked", { names: joinNames(blockedBy, t) })}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : (
          <>
            {proof === "code" && !sent ? (
              <View style={styles.proof}>
                <Text variant="body" tone="ink2">
                  {t("proof.willSend", { email: me?.user.email ?? "" })}
                </Text>
                <Button variant="secondary" label={t("proof.send")} loading={sending} onPress={() => void sendCode()} />
              </View>
            ) : null}
            {proof === "code" && sent ? (
              <View style={styles.proof}>
                <Locked when={busy || sending}>
                  <AuthField
                    code
                    value={code}
                    onChangeText={(value) => setCode(typedCode(value))}
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
              </View>
            ) : null}
            {proof === "password" ? (
              <Locked when={busy} style={styles.proof}>
                <PasswordField label={t("proof.password")} value={password} onChangeText={setPassword} />
              </Locked>
            ) : null}
            {refused ? (
              <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
                {refused}
              </Text>
            ) : null}
            {proof === "addPassword" ? (
              <View style={styles.proof}>
                <Text variant="body" tone="ink2">
                  {t("mobile.delete.addPasswordFirst")}
                </Text>
                <Button
                  variant="secondary"
                  label={t("mobile.delete.addPasswordWeb")}
                  onPress={() => web(shell ? `/org/${shell.id}?account=password` : "/")}
                />
                <Button variant="ghost" label={t("mobile.common.retry")} onPress={() => void meQuery.refetch()} />
              </View>
            ) : null}
            <HoldButton label={t("mobile.delete.hold")} disabled={!ready || busy} onConfirm={() => void confirm()} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: SCREEN_X, paddingTop: 8, gap: 16 },
  list: { padding: CARD_PAD, gap: 10 },
  line: { gap: 8 },
  // A line that wraps keeps its icon on the first.
  item: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  grow: { flex: 1 },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  proof: { gap: 10 },
});
