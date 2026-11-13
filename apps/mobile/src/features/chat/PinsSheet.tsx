import { cachePinned, type MessagePin, usePinMessage, usePins } from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { can } from "@agenteschat/client/lib/permissions";
import { pinsIn } from "@agenteschat/client/lib/pins";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Card, Count, Icon, IconButton, Row, Text, useToast, weights } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { Tile } from "../shared/parts";
import { orderPins } from "./logic";

/** A conversation's pins (in a thread, the thread's), the latest pin first. */
function usePinsHere(channelId: string, threadId: string | null) {
  const pins = usePins(useOrgId(), channelId);
  const list = useMemo(() => pinsIn(orderPins(pins.data ?? []), threadId), [pins.data, threadId]);
  return { pins, list };
}

/** How many pinned lines the pull reveals; the rest live in "Fixadas". */
const PEEK_ROWS = 3;

/**
 * The pinned messages revealed by pulling the conversation down past its top (no bar sits under the header any
 * more): "Fixadas" with how many, then up to three compact lines (a 24 face, one line of the message, the pin), the
 * latest pin first, and a hairline before the first message. A line goes to its message; the title opens "Fixadas".
 */
export function PinnedLines({
  channelId,
  threadId,
  onOpen,
  onPick,
}: {
  channelId: string;
  threadId: string | null;
  onOpen: () => void;
  onPick: (pin: MessagePin) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { list } = usePinsHere(channelId, threadId);
  if (list.length === 0) return null;
  return (
    <View style={styles.peek} accessibilityLabel={t("mobile.pins.bar", { count: list.length })}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.pins.title")}
        hitSlop={{ top: 8, bottom: 4 }}
        style={({ pressed }) => [styles.peekHead, pressed && styles.pressed]}
      >
        <Text variant="subhead" tone="ink" style={styles.bold}>
          {t("mobile.pins.peek")}
        </Text>
        <Count value={list.length} size={15} />
      </Pressable>
      {list.slice(0, PEEK_ROWS).map((pin) => (
        <Pressable
          key={pin.message.id}
          onPress={() => onPick(pin)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.peekRow, pressed && { backgroundColor: c.sunken }]}
        >
          <Face who={pin.message.author} size={24} live={false} />
          <Text variant="subhead" tone="ink2" numberOfLines={1} style={styles.grow}>
            {previewOf(textOrMedia(t, pin.message.body, pin.message.meta)) || t("mobile.chat.approvalPreview")}
          </Text>
          <Icon name="pin" size={13} color={c.faint} />
        </Pressable>
      ))}
      <View style={[styles.peekRule, { backgroundColor: c.line2 }]} />
    </View>
  );
}

/** "Fixadas": a conversation's pinned messages, the latest pin first; tap goes to the message, × unpins it. */
export function PinsSheet({
  channelId,
  threadId,
  onPick,
}: {
  channelId: string;
  threadId: string | null;
  onPick: (pin: MessagePin) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  // As on the web: unpinning needs "post" (the server answers 403 otherwise).
  const mayUnpin = can(org, "post");
  const toast = useToast();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const qc = useQueryClient();
  const pin = usePinMessage(orgId);
  const { pins, list } = usePinsHere(channelId, threadId);
  const unpin = (p: MessagePin) => {
    cachePinned(qc, orgId, channelId, p.messageId, false);
    pin.mutate(
      { channelId, messageId: p.messageId, pinned: false },
      {
        onError: () => {
          cachePinned(qc, orgId, channelId, p.messageId, true);
          toast({ title: t("mobile.app.failed"), icon: "x" });
        },
      },
    );
  };
  return (
    <>
      <SheetTitle leading={<Tile icon="pin" />} title={t("mobile.pins.title")} />
      {pins.isLoading ? (
        <ActivityIndicator color={c.muted} />
      ) : pins.isError ? (
        <Text tone="muted">{t("mobile.app.failed")}</Text>
      ) : list.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.empty}>
          {t("mobile.pins.empty")}
        </Text>
      ) : (
        <Card>
          {list.map((p) => {
            const name = dir.nameOf(p.message.author) || t("mobile.chat.someone");
            return (
              <Row
                key={p.messageId}
                leading={<Face who={p.message.author} size={30} live={false} />}
                title={name}
                // A pinned GIF or sticker says which (ADR 0091).
                subtitle={previewOf(textOrMedia(t, p.message.body, p.message.meta)) || t("mobile.chat.approvalPreview")}
                meta={
                  <View style={styles.meta}>
                    <Text variant="caption" tone="faint">
                      {when.short(p.message.createdAt)}
                    </Text>
                    {mayUnpin ? (
                      <IconButton icon="x" label={t("mobile.pins.unpinOf", { name })} onPress={() => unpin(p)} />
                    ) : null}
                  </View>
                }
                onPress={() => onPick(p)}
              />
            );
          })}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 8 },
  grow: { flex: 1 },
  bold: { fontWeight: weights.semibold },
  meta: { flexDirection: "row", alignItems: "center", gap: 2 },
  // Revealed by the pull: the title row, compact lines (24 face, one line), a hairline before the conversation.
  peek: { paddingTop: 8, paddingBottom: 4 },
  peekHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 4 },
  peekRow: { flexDirection: "row", alignItems: "center", gap: 12, height: 36, paddingHorizontal: 16 },
  peekRule: { height: StyleSheet.hairlineWidth, marginTop: 8, marginHorizontal: 16 },
  pressed: { opacity: 0.6 },
});
