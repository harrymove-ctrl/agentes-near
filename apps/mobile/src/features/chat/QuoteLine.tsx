import type { ReplyRef } from "@agenteschat/client";
import { quoteText } from "@agenteschat/client/lib/media";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { rowBodyInset } from "./logic";
import type { RowLook } from "./look";

/** What a reply answers, in one line (the web's `QuotedMessage`): face, name and words; a tap goes to the original. */
export function QuoteLine({
  reply,
  onJump,
  ink,
}: {
  reply: ReplyRef;
  onJump?: (reply: ReplyRef) => void;
  /** On my solid bubble. */
  ink?: string;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const color = ink ? { color: ink } : undefined;
  if (reply.deleted) {
    return (
      <Text variant="caption" tone="muted" style={[styles.gone, color]}>
        {t("channel.quoteGone")}
      </Text>
    );
  }
  const name = dir.nameOf(reply.author) || reply.authorName || t("mobile.chat.someone");
  const excerpt = quoteText(t, reply);
  return (
    <Pressable
      onPress={() => onJump?.(reply)}
      accessibilityRole="button"
      accessibilityLabel={t("channel.quoteOf", { name, excerpt })}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
    >
      {reply.author.id ? <Face who={reply.author} size={16} live={false} /> : null}
      <Text variant="caption" tone="ink2" numberOfLines={1} style={[styles.who, color]}>
        @{name}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={1} style={[styles.words, color]}>
        {excerpt}
      </Text>
    </Pressable>
  );
}

/** Where each style's face and words stand in a row (`styles.msg`, `lookRows`): the curve runs from one to the other. */
const FACE_MIDDLE = { comfortable: 31, left: 31, bubbles: 25, compact: 59 };
const WORDS_START = { comfortable: 59, left: 59, bubbles: 48, compact: 74 };

/** The line above a row, joined to its face by a small curve; a row with no face has it at its words, no curve. */
export function QuoteAbove({
  look,
  reply,
  onJump,
  gap,
}: {
  look: RowLook;
  reply: ReplyRef;
  /** It stands for its row: the row's gap goes above it. */
  gap: number;
  onJump?: (reply: ReplyRef) => void;
}) {
  const c = useColors();
  const middle = FACE_MIDDLE[look.style];
  const start = look.faces ? WORDS_START[look.style] : rowBodyInset(look).left;
  return (
    <View style={[styles.above, { paddingLeft: start, marginTop: gap }]}>
      {look.faces ? (
        <View style={[styles.curve, { left: middle - 1, width: start - middle - 4, borderColor: c.line2 }]} />
      ) : null}
      <QuoteLine reply={reply} onJump={onJump} />
    </View>
  );
}

/** Inside a bubble, on top of its words. */
export function QuotePlate({
  reply,
  onJump,
  ink,
}: {
  reply: ReplyRef;
  onJump?: (reply: ReplyRef) => void;
  ink?: string;
}) {
  const c = useColors();
  return (
    <View style={[styles.plate, { backgroundColor: ink ? `${ink}26` : c.sunken }]}>
      <QuoteLine reply={reply} onJump={onJump} {...(ink ? { ink } : {})} />
    </View>
  );
}

/** "Respondendo a Ana" above the field; its × drops it. */
export function QuoteBar({ name, onCancel }: { name: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.bar, { backgroundColor: c.sunken }]}>
      <Icon name="reply" size={16} color={c.muted} />
      <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.barName}>
        {t("channel.replyingTo", { name })}
      </Text>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={t("channel.cancelReply")}
        hitSlop={10}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Icon name="x" size={16} color={c.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 20 },
  pressed: { opacity: 0.6 },
  who: { flexShrink: 0, maxWidth: "50%", fontWeight: "600" },
  words: { flexShrink: 1 },
  gone: { fontStyle: "italic", lineHeight: 20 },
  above: { paddingRight: 16 },
  curve: {
    position: "absolute",
    top: 10,
    bottom: -3,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 7,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  barName: { flex: 1, fontWeight: "600" },
  plate: { alignSelf: "stretch", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginBottom: 4 },
});
