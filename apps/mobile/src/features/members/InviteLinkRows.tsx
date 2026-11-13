import {
  type InviteLink,
  useInviteLinks,
  useMakeInviteLink,
  useRenewInviteLink,
  useTurnOffInviteLink,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { formatShortDate, relativeTime } from "@agenteschat/client/lib/format";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Share, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedList, GroupedRow, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { copyText, successHaptic } from "../shared/parts";

/** How long "Copiado" stays on the copy row. */
const COPIED_MS = 1800;

/**
 * The workspace's invitation link on Convidar pessoas (ADR 0068, 0090): share it or copy it, 30 more days for the
 * same link, turn it off; links made before links could be shown again, to turn off; make one where there's none.
 */
export function InviteLinkRows() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const toast = useToast();
  const links = useInviteLinks(orgId);
  const make = useMakeInviteLink(orgId);
  const renew = useRenewInviteLink(orgId);
  const turnOff = useTurnOffInviteLink(orgId);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (links.isPending) return <ActivityIndicator color={c.muted} style={styles.loading} />;
  const all = links.data ?? [];
  const current = all.find((l) => l.url !== null);
  const url = current?.url ?? null;
  const until = (iso: string) => formatShortDate(i18n.language, iso);
  const failed = (e: unknown) =>
    toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });

  /** Turning a link off closes its waiting requests too: the confirmation counts them. */
  const confirmTurnOff = (l: InviteLink) =>
    Alert.alert(t("members.link.turnOffTitle"), t("members.link.turnOffText", { count: l.waiting }), [
      { text: t("mobile.common.cancel"), style: "cancel" },
      {
        text: t("members.link.turnOff"),
        style: "destructive",
        onPress: () => turnOff.mutate(l.id, { onError: failed }),
      },
    ]);
  const renewIt = async (id: string) => {
    try {
      const res = await renew.mutateAsync(id);
      successHaptic();
      toast({ title: t("members.link.renewed", { date: until(res.expiresAt) }) });
    } catch (e) {
      failed(e);
    }
  };

  return (
    <>
      <GroupedList>
        {current && url ? (
          <GroupedRow
            key="share"
            icon="share"
            label={t("mobile.joinRequests.share")}
            onPress={() =>
              void Share.share({ message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url }) }).catch(
                () => undefined,
              )
            }
          />
        ) : null}
        {current && url ? (
          <GroupedRow
            key="copy"
            icon={copied ? "check" : "copy"}
            label={copied ? t("common.copied") : t("members.copyLink")}
            onPress={() =>
              void copyText(url).then((ok) => {
                if (!ok) return;
                successHaptic();
                setCopied(true);
              })
            }
          />
        ) : null}
        {current ? (
          <GroupedRow
            key="renew"
            icon="clock"
            label={t("members.link.renew")}
            disabled={renew.isPending}
            onPress={() => void renewIt(current.id)}
          />
        ) : (
          <GroupedRow
            key="make"
            icon="plus"
            label={t("members.link.make")}
            disabled={make.isPending}
            onPress={() => make.mutate(undefined, { onError: failed })}
          />
        )}
        {current ? (
          <GroupedRow
            key="off"
            icon="x"
            label={t("members.link.turnOff")}
            danger
            disabled={turnOff.isPending}
            onPress={() => confirmTurnOff(current)}
          />
        ) : null}
        {all
          .filter((l) => l.url === null)
          .map((l) => {
            const when = relativeTime(t, i18n.language, l.createdAt);
            const date = until(l.expiresAt);
            return (
              <GroupedRow
                key={l.id}
                icon="x"
                label={t("members.link.turnOff")}
                sub={
                  l.createdBy
                    ? t("members.link.earlier", { when, name: l.createdBy, date })
                    : t("members.link.earlierNoName", { when, date })
                }
                subLines={3}
                media
                danger
                disabled={turnOff.isPending}
                onPress={() => confirmTurnOff(l)}
              />
            );
          })}
      </GroupedList>
      {current ? <GroupedFooter>{t("members.link.help", { date: until(current.expiresAt) })}</GroupedFooter> : null}
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 16 },
});
