import type { Message, TeamCheck } from "@agenteschat/client";
import { targetKind, teamChecksOf } from "@agenteschat/client/lib/team-checks";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ACT_LINE, type IconName, LineIcon, ROW_CARD_INSET, RowAction, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { agoOf } from "../agents/logic";
import { agoText } from "../agents/work";
import { chatHref } from "../links/logic";
import { boldRuns } from "./actions";
import { useCardTop } from "./look";

const ICONS: Record<ReturnType<typeof targetKind>, IconName> = {
  email: "mail",
  phone: "chat",
  code: "code",
  url: "globe",
  other: "reply",
};

/**
 * Team actions (ADR 0064) on the phone: under an agent's reply, what it didn't do because the team
 * already had (the same address, number, page or pull request), whose action it found and Ver, which
 * opens that conversation. The receipts' card (Receipts.tsx), its words whole; nothing to undo.
 */
export function TeamChecks({ message: m }: { message: Message }) {
  const list = teamChecksOf(m.meta);
  // Cards under the message's words: the body's card gap above them, as every card in a message.
  const cardTop = useCardTop();
  if (m.author.type !== "agent" || list.length === 0) return null;
  return (
    <View style={[styles.list, cardTop]}>
      {list.map((c) => (
        <Row key={c.id} check={c} selfId={m.author.id} />
      ))}
    </View>
  );
}

function Row({ check, selfId }: { check: TeamCheck; selfId: string | null }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const match = check.matches[0];
  const target = check.targets[0] ?? "";
  if (!match) return null;
  const when = agoText(t, agoOf(match.at, Date.now()));
  const key = !match.agentId
    ? "teamChecks.someone"
    : match.agentId === selfId
      ? "teamChecks.self"
      : "teamChecks.teammate";
  const runs = boldRuns(t(key as "teamChecks.teammate", { target, when, who: match.agentName ?? "" }) as string);
  const detail = [match.summary, match.channelName ? t("teamChecks.inChannel", { channel: match.channelName }) : null]
    .filter(Boolean)
    .join(" · ");
  const channelId = match.channelId;
  return (
    <View style={[styles.one, { backgroundColor: colors.raised, borderColor: colors.line2 }]}>
      <View style={styles.tx}>
        <LineIcon name={ICONS[targetKind(target)]} size={15} color={colors.muted} variant="small" />
      </View>
      {/* The words and Abrir in one line past the icon: Abrir under them, from their edge, once they wrap. */}
      <View style={[ACT_LINE.row, styles.line]}>
        <View style={[ACT_LINE.text, styles.tx]}>
          <Text variant="small" tone="ink2">
            {runs.map((r, i) =>
              r.bold ? (
                <Text key={String(i)} variant="small" tone="ink" style={styles.bold}>
                  {r.text}
                </Text>
              ) : (
                r.text
              ),
            )}
          </Text>
          {detail ? (
            <Text variant="caption" tone="faint" style={styles.detail}>
              {detail}
            </Text>
          ) : null}
        </View>
        {channelId ? (
          <RowAction
            label={t("teamChecks.open")}
            accessibilityRole="link"
            onPress={() => router.push(chatHref(channelId))}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  bold: { fontWeight: "600" },
  // The receipts' card: a hairline, the cut corner; the icon (as the conversation's event lines), the first line and
  // the action (32, in a 50 row) share one middle.
  one: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    minHeight: 50,
    paddingVertical: (50 - 32) / 2,
    ...ROW_CARD_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
  },
  // The "small" line (20) on the action's middle.
  tx: { paddingTop: (32 - 20) / 2 },
  line: { flex: 1, minWidth: 0, alignItems: "flex-start", columnGap: 8 },
  detail: { marginTop: 2 },
});
