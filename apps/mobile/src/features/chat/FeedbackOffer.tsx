import { type Message, useAuthConfig, useFeedbackOffer, useSetChatPrefs } from "@agenteschat/client";
import { feedbackOfferFor } from "@agenteschat/client/lib/feedback-offer";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { LineIcon, ROW_CARD_INSET, RowAction, Text, useTheme } from "@/ui";
import { useMeId } from "../shared/hooks";
import { boldRuns } from "./actions";
import { useCardTop } from "./look";

/**
 * A report about the app the agent offered on its own (`meta.feedbackOffer`, ADR 0160 §12) on the phone: under its
 * reply, only for the person it goes in the name of. The receipts' card: the problem in a few words, where it goes,
 * and its actions in a row under the words (Send, Not now, See the report, which opens the agent's text in the card).
 * Sent, the same card says so, with View and Always send; one that went with the reply holds Ask before sending. Put
 * away, it is gone.
 */
export function FeedbackOfferRow({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const cloud = useAuthConfig().data?.cloud === true;
  const offer = m.author.type === "agent" ? feedbackOfferFor(m.meta, meId) : null;
  const decide = useFeedbackOffer(orgId, { channelId: m.channelId, threadId: m.threadId, messageId: m.id });
  const prefs = useSetChatPrefs(orgId);
  const [open, setOpen] = useState(false);
  // A card under the message's words: the body's card gap above it, as every card in a message.
  const cardTop = useCardTop();
  if (!offer) return null;
  const sent = offer.state === "sent";
  const always = org?.chatPrefs?.feedbackAuto === true;
  const words = sent
    ? offer.auto
      ? t("feedback.offer.sentAuto", { summary: offer.summary })
      : t(cloud ? "feedback.offer.sentCloud" : "feedback.offer.sentServer")
    : t("feedback.offer.ready", { summary: offer.summary });
  const under = sent
    ? always && !offer.auto
      ? t("feedback.offer.alwaysOn")
      : null
    : t(cloud ? "feedback.offer.goesCloud" : "feedback.offer.goesServer");
  return (
    <View
      accessibilityLabel={t("feedback.offer.group")}
      style={[styles.one, cardTop, { backgroundColor: colors.raised, borderColor: colors.line2 }]}
    >
      <View style={styles.tx}>
        <LineIcon name={sent ? "check" : "flag"} size={15} color={colors.muted} variant="small" />
      </View>
      <View style={styles.body}>
        <View style={styles.tx}>
          <Text variant="small" tone="ink2">
            {boldRuns(words as string).map((r, i) =>
              r.bold ? (
                <Text key={String(i)} variant="small" tone="ink" style={styles.bold}>
                  {r.text}
                </Text>
              ) : (
                r.text
              ),
            )}
          </Text>
          {under ? (
            <Text variant="caption" tone="faint" style={styles.detail}>
              {under}
            </Text>
          ) : null}
        </View>
        {open ? (
          <View style={[styles.report, { borderTopColor: colors.line }]}>
            <Text variant="small" tone="ink2">
              {offer.text}
            </Text>
            <Text variant="caption" tone="faint" style={styles.detail}>
              {t("feedback.offer.answer")}
            </Text>
          </View>
        ) : null}
        {/* The actions in a row under the words, from their edge: beside them they would squeeze the sentence. */}
        <View style={styles.acts}>
          {sent ? null : (
            <>
              <RowAction
                strong
                label={t("feedback.offer.send")}
                disabled={decide.isPending}
                onPress={() => decide.mutate("send")}
              />
              <RowAction
                label={t("feedback.offer.notNow")}
                disabled={decide.isPending}
                onPress={() => decide.mutate("dismiss")}
              />
            </>
          )}
          <RowAction
            label={t(open ? "feedback.offer.hide" : sent ? "feedback.offer.view" : "feedback.offer.see")}
            onPress={() => setOpen(!open)}
          />
          {/* A server from before the choice can't keep it. */}
          {sent && org?.chatPrefs !== undefined ? (
            <RowAction
              label={t(always ? "feedback.offer.askFirst" : "feedback.offer.always")}
              disabled={prefs.isPending}
              onPress={() => prefs.mutate({ feedbackAuto: !always })}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  // The receipts' card (TeamChecks.tsx): a hairline, the cut corner, the icon on the first line's middle.
  one: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingTop: (50 - 32) / 2,
    paddingBottom: 4,
    ...ROW_CARD_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
  },
  // The "small" line (20) on a 32 row's middle, as the other cards' first line.
  tx: { paddingTop: (32 - 20) / 2 },
  body: { flex: 1, minWidth: 0 },
  detail: { marginTop: 2 },
  report: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  // The words of the actions start on the sentence's edge: the first one's own padding taken back.
  acts: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, marginTop: 2, marginLeft: -4 },
});
