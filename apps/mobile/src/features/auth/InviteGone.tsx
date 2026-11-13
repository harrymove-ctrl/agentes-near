import { invitationStateQuery, keys, useApi, useAuthConfig, useMe } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { firstName } from "@/features/shared/logic";
import { useOrgGate } from "@/providers/org";
import { Button, PersonAvatar, Text, useTheme } from "@/ui";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { ErrorLine, LeaveButton } from "./invite-parts";

/** An invitation that couldn't be read for a moment: never mistaken for one that's gone. */
export function InviteLoadFailed({ retry, retrying }: { retry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <AuthScaffold title={t("common.loadFailed")} stepKey="failed">
      <Button variant="primary" wide label={t("common.retry")} loading={retrying} onPress={retry} />
      <LeaveButton />
    </AuthScaffold>
  );
}

export function InviteLoading() {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

/**
 * An email invitation the preview no longer opens (ADR 0090 §6): accepted (the workspace to open), expired (ask
 * whoever invited for a new one, where email goes out), or nothing known (cancelled, or never one), which says only
 * that.
 */
export function InviteGone({ token }: { token: string }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  const me = useMe();
  // Asking for a new one is an email to whoever invited: a server that sends none would never deliver it.
  const emails = sendsEmail(useAuthConfig().data);
  const state = useQuery(invitationStateQuery(api, token));
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.isPending) return <InviteLoading />;
  if (state.isError) return <InviteLoadFailed retrying={state.isFetching} retry={() => void state.refetch()} />;
  const dead = state.data;
  if (!dead)
    return (
      <AuthScaffold title={t("invite.goneTitle")} subtitle={t("invite.goneLead")} expression="closed">
        <LeaveButton />
      </AuthScaffold>
    );
  const date = formatShortDate(i18n.language, dead.at);

  if (dead.state === "accepted") {
    const { orgId, orgName } = dead;
    const member = me.data?.organizations.some((o) => o.id === orgId) === true;
    const open = async () => {
      if (!member) return router.replace("/sign-in");
      await qc.invalidateQueries({ queryKey: keys.me });
      gate.choose(orgId);
      router.replace("/");
    };
    return (
      <AuthScaffold
        title={t("invite.usedTitle", { org: orgName })}
        subtitle={t("invite.usedLead", { date })}
        expression="happy"
      >
        <Button variant="primary" wide label={t("invite.open", { org: orgName })} onPress={() => void open()} />
      </AuthScaffold>
    );
  }

  const by = dead.invitedBy ? firstName(dead.invitedBy) : null;
  const askNew = async () => {
    setPending(true);
    setError(null);
    try {
      await api.invites.requestNew(token);
      setAsked(true);
    } catch (e) {
      // A link replaced by a newer invitation, cancelled or already accepted has no one to ask.
      setError(knownErrorText(t, e, i18n.language) ?? t("invite.askNewFailed"));
    } finally {
      setPending(false);
    }
  };
  const lead = !emails
    ? by
      ? t("invite.expiredNoEmail", { name: by })
      : t("auth.flow.expiredLeadAsk")
    : asked
      ? by
        ? t("invite.expiredAsked", { name: by })
        : t("invite.expiredAskedNoName")
      : by
        ? t("invite.expiredAsk", { name: by })
        : t("invite.expiredAskNoName");
  return (
    <AuthScaffold
      title={t("invite.expiredOn", { date })}
      subtitle={lead}
      stepKey={asked ? "asked" : "expired"}
      expression={asked ? "happy" : "closed"}
      // Who invited you, on the sky, when known: the one the new invitation is asked of.
      hero={dead.invitedBy ? <PersonAvatar name={dead.invitedBy} size={72} /> : undefined}
    >
      {emails ? (
        <>
          <ErrorLine error={error} />
          <Button
            variant="primary"
            wide
            label={asked ? t("invite.askedNew") : by ? t("mobile.invite.askNewOf", { name: by }) : t("invite.askNew")}
            disabled={asked}
            loading={pending}
            onPress={() => void askNew()}
          />
          {asked ? (
            <Text variant="small" tone="muted" style={CENTER}>
              {t("invite.expiredComes")}
            </Text>
          ) : null}
        </>
      ) : null}
      <LeaveButton />
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
