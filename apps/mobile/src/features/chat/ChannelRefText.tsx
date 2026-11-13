import {
  useArchivedChannels,
  useChannelCard,
  useChannels,
  useJoinChannel,
  useUnarchiveChannel,
} from "@agenteschat/client";
import { joinable } from "@agenteschat/client/lib/channel-access";
import { channelCardFacts, resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import { Button, Icon, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";

/**
 * `#name` in a message (the web's `ChannelRef`): a tap opens the channel it means, a long press shows its card
 * (topic, counts, Join or Open). A channel the viewer can't see stays the text as written; an archived one is
 * struck through and says so.
 */
export function ChannelRefText({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const orgId = useOrgId();
  const sheet = useSheetIfAny();
  const channels = useChannels(orgId).data ?? [];
  const ref = resolveChannelRef(name, refs, channels);
  const lookup = useChannelCard(orgId, ref?.id ?? "", Boolean(ref && !ref.known));
  if (!ref || (!ref.known && !lookup.data)) return <RNText>{text}</RNText>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  const id = ref.id;
  const card = sheet
    ? {
        onLongPress: () => sheet.open(<ChannelCardSheet channelId={id} onDone={sheet.close} />),
        accessibilityActions: [{ name: "longpress", label: t("channelRefs.card", { name: shown }) }],
        onAccessibilityAction: () => sheet.open(<ChannelCardSheet channelId={id} onDone={sheet.close} />),
      }
    : {};
  if (!ref.known && lookup.data?.archived) {
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={t("mobile.channelRef.archivedA11y", { name: shown })}
        onPress={() => toast({ title: t("mobile.channelRef.archived", { name: shown }), icon: "archive" })}
        {...card}
        style={[styles.ref, styles.archived, { color: c.muted }]}
      >
        #{shown}
      </RNText>
    );
  }
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("mobile.channelRef.a11y", { name: shown })}
      onPress={() => router.push(chatHref(id))}
      {...card}
      style={[styles.ref, { color: c.ink }]}
    >
      #{shown}
    </RNText>
  );
}

/**
 * A channel's card in a sheet: what it is, who is in it, and Join or Open (the web's hover card); an archived one, Restaurar
 * for who may bring it back.
 */
function ChannelCardSheet({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const card = useChannelCard(orgId, channelId);
  const join = useJoinChannel(orgId, channelId);
  const restorable = useArchivedChannels(orgId, card.data?.archived === true).data?.some((x) => x.id === channelId);
  const restore = useUnarchiveChannel(orgId);
  const colors = useColors();
  const c = card.data;
  if (!c) {
    return card.isError ? (
      <Text variant="body" tone="muted">
        {t("channelRefs.gone")}
      </Text>
    ) : (
      <ActivityIndicator color={colors.faint} accessibilityLabel={t("channelRefs.loading")} />
    );
  }
  const openIt = () => {
    onDone();
    router.push(chatHref(channelId));
  };
  return (
    <>
      <SheetTitle
        leading={<Icon name={c.archived ? "archive" : c.visibility === "private" ? "lock" : "hash"} size={20} />}
        title={`#${c.name}`}
        subtitle={c.archived ? `${t("channelRefs.archived")} · ${channelCardFacts(t, c)}` : channelCardFacts(t, c)}
      />
      {c.topic ? <Text variant="body">{c.topic}</Text> : null}
      {c.archived && restorable ? (
        <View style={styles.actions}>
          <Button
            variant="secondary"
            wide
            label={t("channel.restore")}
            loading={restore.isPending}
            onPress={() =>
              restore.mutate(channelId, {
                onSuccess: () => {
                  toast({ title: t("channel.restored", { channel: c.name }), icon: "check" });
                  openIt();
                },
                onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
              })
            }
          />
        </View>
      ) : null}
      {c.archived ? null : (
        <View style={styles.actions}>
          {joinable(c) ? (
            <Button
              variant="primary"
              wide
              label={t("channelRefs.join")}
              loading={join.isPending}
              onPress={() => join.mutate(undefined, { onSuccess: openIt })}
            />
          ) : null}
          <Button variant="secondary" wide label={t("channelRefs.open")} onPress={openIt} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "700" },
  archived: { textDecorationLine: "line-through" },
  actions: { gap: 8 },
});
