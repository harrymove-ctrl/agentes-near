import { type ArchivedChannel, useArchivedChannels, useUnarchiveChannel } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatShortDate } from "@agenteschat/client/lib/format";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, EmptyState, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { chooseAction } from "../settings/parts";
import { useColors, useOrgId } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { successHaptic } from "../shared/parts";

/**
 * "Canais arquivados", as the web's: the archived channels this person may bring back (their creator or who manages
 * channels), each opening Restaurar, which brings it back as it was and opens it.
 */
export function ArchivedChannelsScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const list = useArchivedChannels(orgId);
  const restore = useUnarchiveChannel(orgId);
  const channels = list.data ?? [];
  const ask = (ch: ArchivedChannel) =>
    chooseAction(
      `#${ch.name}`,
      [
        {
          label: t("channel.restore"),
          onPress: () =>
            restore.mutate(ch.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("channel.restored", { channel: ch.name }), icon: "check" });
                router.replace(chatHref(ch.id));
              },
              onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
            }),
        },
      ],
      t("common.cancel"),
    );
  return (
    <PushedLargeTitle title={t("channel.archivedTitle")} grouped>
      {list.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {list.isError && !list.data ? (
        <View style={styles.center}>
          <Text tone="muted">{t("common.loadFailed")}</Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void list.refetch()} />
        </View>
      ) : null}
      {list.isSuccess && channels.length === 0 ? <EmptyState icon="archive" title={t("channel.archivedNone")} /> : null}
      {channels.length > 0 ? (
        <View style={styles.in}>
          <GroupedList>
            {channels.map((ch) => (
              <GroupedRow
                key={ch.id}
                icon={ch.visibility === "private" ? "lock" : "hash"}
                label={`#${ch.name}`}
                labelLines={3}
                sub={t("channel.archivedOn", { date: formatShortDate(i18n.language, ch.archivedAt) })}
                media
                disabled={restore.isPending}
                onPress={() => ask(ch)}
              />
            ))}
          </GroupedList>
        </View>
      ) : null}
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  // The grouped card on the screen's 16 margin, as every grouped page's.
  in: { paddingHorizontal: 16, paddingTop: 4 },
  loading: { marginVertical: 24 },
  center: { alignItems: "center", gap: 12, paddingVertical: 32 },
});
