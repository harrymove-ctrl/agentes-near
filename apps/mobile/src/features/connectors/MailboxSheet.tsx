import { keys, useApi, useMailAccounts, useMailAction } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import { choiceOf, fromMailLevel, MAIL_BRANDS, mailReviewTools, setMailLevel } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { confirmAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import { Problem } from "./Problem";
import { pickLevel } from "./pick-level";
import { MailReview } from "./ToolReview";

/**
 * A connected mailbox (any kind), opened from the gallery's connected row, in the settings' groups as a connection's
 * screen: who uses it and how far, what agents may do in it (Ferramentas, in the sheet), and disconnecting it after a
 * confirmation. Mailboxes connect on the web.
 */
export function MailboxSheet({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const accounts = useMailAccounts(orgId);
  const { disconnect } = useMailAction(orgId);
  const admin = can(org, "manage_connectors");
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState(false);
  const account = accounts.data?.find((a) => a.id === accountId);
  if (!account) return <ActivityIndicator color={c.muted} />;
  const choice = choiceOf(account);
  const fail = (text: string) => {
    errorHaptic();
    setError(text);
  };
  const leave = () => {
    setError(null);
    disconnect.mutate(account.id, {
      onSuccess: () => {
        successHaptic();
        sheet.close();
        toast({ title: t("mobile.connectors.disconnected", { name: account.address }) });
      },
      onError: () => fail(t("mobile.connectors.disconnectFailed", { name: account.address })),
    });
  };
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={MAIL_BRANDS[choice] ?? null} label={account.label} size={52} check />
        <View style={styles.grow}>
          <Text variant="title" numberOfLines={1}>
            {t(`mail.choice.${choice}.name`)}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {account.status === "needs_reconnect"
              ? `${account.address} · ${t("mail.status.needs_reconnect")}`
              : account.address}
          </Text>
        </View>
      </View>
      {tools ? (
        <MailReview account={account} onNext={() => setTools(false)} onScreen />
      ) : (
        <>
          <WhoUses accountId={account.id} />
          {admin ? (
            <GroupedList>
              <GroupedRow
                leading={<Tile icon="list" size={30} />}
                label={t("connectors.tools")}
                value={String(mailReviewTools(t, account).length)}
                chevron
                onPress={() => setTools(true)}
              />
            </GroupedList>
          ) : null}
          <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
          {admin ? (
            // Disconnecting, alone in red after the system's confirmation, as on a connection's screen.
            <GroupedList>
              <GroupedRow
                label={t("mobile.connectors.disconnect")}
                danger
                disabled={disconnect.isPending}
                onPress={() =>
                  confirmAction({
                    title: t("connectors.disconnectTitle", { name: account.address }),
                    action: t("mobile.connectors.disconnect"),
                    cancel: t("common.cancel"),
                    onConfirm: leave,
                  })
                }
              />
            </GroupedList>
          ) : null}
          {error ? <Problem key={error} text={error} /> : null}
        </>
      )}
    </View>
  );
}

/**
 * Who uses a mailbox and how far, as a connection's (`AgentLevelList`): one row per agent, the level as its value
 * in the web's words, a tap opens the system's choice; each change keeps that agent's rules there.
 */
function WhoUses({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  return (
    <View>
      <GroupedHeader>{t("mobile.connectors.whoTitle")}</GroupedHeader>
      <GroupedList>
        {dir.agents.map((a) => (
          <AgentMailLevel
            key={a.id}
            agentId={a.id}
            accountId={accountId}
            leading={<AgentFace agentId={a.id} size={30} live={false} />}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("mobile.connectors.safe")}</GroupedFooter>
    </View>
  );
}

function AgentMailLevel({ agentId, accountId, leading }: { agentId: string; accountId: string; leading: ReactNode }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const orgId = useOrgId();
  const toast = useToast();
  const { org } = useOrg();
  const dir = useDirectory();
  const accounts = useMailAccounts(orgId);
  const agent = dir.agentById.get(agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const account = accounts.data?.find((a) => a.id === accountId);
  const current = saving ?? fromMailLevel(account?.agents.find((a) => a.agentId === agentId)?.level);
  // Giving an agent a mailbox is an admin's call, like its scopes (the server checks it again).
  const mayChange = can(org, "manage_agents");
  const choose = (level: Level) => {
    if (level === current) return;
    setSaving(level);
    void setMailLevel(api, orgId, agentId, accountId, level)
      .then(() => {
        successHaptic();
        return qc.invalidateQueries({ queryKey: keys.mail(orgId) });
      })
      .catch(() => {
        errorHaptic();
        toast({ title: t("mobile.connectors.levelFailed", { name: agent?.name ?? "" }), icon: "x" });
      })
      .finally(() => setSaving(null));
  };
  const open = () =>
    void pickLevel(t, agent?.name ?? "", current).then((level) => {
      if (level) choose(level);
    });
  return (
    <GroupedRow
      leading={leading}
      label={agent?.name ?? ""}
      {...(agent?.role ? { sub: agent.role } : {})}
      value={t(`access.level.${current}`)}
      // The value changes in its row, through the app's picker: its mark, not a chevron to a screen.
      menu={mayChange}
      disabled={Boolean(saving)}
      {...(mayChange ? { onPress: open } : {})}
    />
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
});
