import { previewBody } from "@agenteschat/client/lib/message-body";
import { useTranslation } from "react-i18next";
import { Pressable, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";
import type { AgentMode } from "@/agent/poses";
import { Text } from "@/ui";
import { router } from "@/ui/navigation";
import type { ConversationRow } from "../chats/logic";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useSurface } from "../shared/parts";

/**
 * The right hand on Conversas (ADR 0137): one place to ask anything, under the greeting on the sky, shaped as the
 * conversation's composer ("Mensagem para Atlas", its face before it), the app's card with its cut corner. It opens
 * its DM (starting one when there is none yet). It never carries a count or a dot: when the right hand answered and
 * you haven't read it, its last line takes the invitation's place, in the text's own color ("Atlas: deixei o
 * resumo na sua conversa"). It is not one of Agentes' rows.
 */
export function RightHandAsk({
  row,
  onStart,
  faceMode = "idle",
  faceStyle,
}: {
  row: ConversationRow;
  onStart: (agentId: string) => void;
  /** The face's mode: asleep under the splash, it wakes as Conversas arrives (`useWake`). */
  faceMode?: AgentMode;
  /** The face's own motion (the hop as it wakes). */
  faceStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
}) {
  const { t } = useTranslation();
  const surface = useSurface();
  if (row.kind !== "dm") return null;
  const invite = t("mobile.chat.messageTo", { name: row.with.name });
  // Its own last words, unread: shown in place of the invitation (a reply from you keeps the invitation).
  const theirs =
    row.unread > 0 && row.last && row.last.author?.type === row.with.type && row.last.author.id === row.with.id
      ? previewBody(t, row.last.text, row.last.meta ?? null, row.last.mediaKind)
      : "";
  const words = theirs ? `${row.with.name}: ${theirs}` : invite;
  const open = () => {
    if (!row.channelId) onStart(row.with.id);
    else router.push(chatHref(row.channelId));
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={words}
      accessibilityHint={theirs ? invite : undefined}
      style={({ pressed }) => [styles.field, surface, pressed && styles.pressed]}
    >
      <Animated.View style={faceStyle}>
        <AgentFace agentId={row.with.id} size={FACE} mode={faceMode} />
      </Animated.View>
      <Text variant="body" tone={theirs ? "ink" : "faint"} numberOfLines={1} style={styles.grow}>
        {words}
      </Text>
    </Pressable>
  );
}

/** The field's height and its face (framed in its sky at 36): the face sits as far from the left edge as from the top and bottom. */
const HEIGHT = 52;
const FACE = 36;

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: HEIGHT,
    paddingLeft: (HEIGHT - FACE) / 2,
    paddingRight: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
  },
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.85 },
});
