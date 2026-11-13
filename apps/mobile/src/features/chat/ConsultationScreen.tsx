import { useChannels, useExchangeConversation } from "@agenteschat/client";
import { consultLineState, consultOriginKey } from "@agenteschat/client/lib/consult-group";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { groupsWith } from "@agenteschat/client/lib/timeline";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, LineIcon, PixelOrbit, Text } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { FocusLive, goBack, PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { consultLineLabel } from "./ConsultGroup";
import { requestComposerText } from "./composer-request";
import { RowLookContext, useConversationLook } from "./look";
import { MessageRow } from "./MessageRow";
import { MessageText } from "./MessageText";

/**
 * A question an agent asked another from a conversation, on a screen of its own (the web opens it over the
 * channel, as a thread): "Theo ⇄ Iris", where it was asked, the question as it went to the other agent, what that
 * agent wrote and the cards it posted in the conversation (an approval, a question, a secret), drawn as the
 * conversation draws them. Read only: people don't write in the agents' DM; "Falar com o Theo" goes back to the
 * conversation with the agent that asked mentioned in its field. The DM sends the app no events: it reloads while
 * the question is out.
 */
export function ConsultationScreen({ consultationId, channelId }: { consultationId: string; channelId: string }) {
  // The cards drawn here open their sheets (a question answered "do meu jeito") as in the conversation.
  return (
    <SheetHostProvider>
      <FocusLive>
        <Consultation consultationId={consultationId} channelId={channelId} />
      </FocusLive>
    </SheetHostProvider>
  );
}

function Consultation({ consultationId, channelId }: { consultationId: string; channelId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const look = useConversationLook(false);
  const insets = useSafeAreaInsets();
  // The whole exchange its row stands for: the other questions between the same two agents come in it too.
  const query = useExchangeConversation(orgId, channelId, consultationId && channelId ? consultationId : null);
  // DMs aren't in the list: no channel name there.
  const channelName = useChannels(orgId).data?.find((x) => x.id === channelId)?.name ?? null;
  const q = query.data?.consultation;
  const list = query.data?.messages ?? [];
  const asker = q ? dir.agentById.get(q.agentId) : undefined;
  const consulted = q ? dir.agentById.get(q.consultedAgentId) : undefined;
  const from = agentGrammar(asker?.name ?? t("mobile.chat.someone"));
  const to = agentGrammar(consulted?.name ?? t("mobile.chat.someone"));
  const state = q ? consultLineState(q, Date.now()) : null;
  // The consulted agent's own words came: its last one is the answer. Left out (its run also answers a question
  // from another conversation), the answer shows on its own.
  const said = list.some((m) => m.author.id === q?.consultedAgentId && m.channelId !== channelId);
  const talk = () => {
    if (asker) requestComposerText(channelId, `@${asker.handle} `);
    goBack(chatHref(channelId));
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={q ? t("chat.consultPanel.title", { from: from.name, to: to.name }) : ""}
        subtitle={channelName ? t("chat.consultPanel.where", { channel: channelName }) : t("chat.consultPanel.whereDm")}
      />
      <ScrollView contentContainerStyle={styles.list}>
        {query.isLoading ? <ActivityIndicator color={c.muted} /> : null}
        {!query.isLoading && !query.data ? (
          <Text variant="small" tone="muted" style={styles.pad}>
            {query.isError ? t("common.loadFailed") : t("chat.consultPanel.missing")}
          </Text>
        ) : null}
        {q ? (
          <View style={[styles.line, styles.pad]}>
            <LineIcon variant="caption" name="agent" size={14} color={c.faint} />
            <Text variant="caption" tone="faint" style={styles.grow}>
              {t(consultOriginKey(q, Boolean(channelName)), {
                from: from.name,
                to: to.name,
                channel: channelName,
                time: when.time(q.createdAt),
              })}
            </Text>
          </View>
        ) : null}
        <RowLookContext.Provider value={look}>
          {list.map((m, i) => (
            <MessageRow
              key={m.id}
              message={m}
              grouped={groupsWith(list[i - 1], m.author, m.createdAt)}
              meId={meId}
              readOnly
            />
          ))}
        </RowLookContext.Provider>
        {q?.status === "answered" && q.answer && !said ? (
          <View style={[styles.answer, styles.pad]}>
            <Text variant="caption" tone="faint" style={styles.bold}>
              {t("chat.consultation.answerOf", { name: to.name, context: to.context })}
            </Text>
            <MessageText body={q.answer} />
          </View>
        ) : null}
        {q && state && state !== "answered" ? (
          <View style={[styles.line, styles.pad]} accessibilityLiveRegion="polite">
            {state === "working" ? (
              <LineIcon variant="caption" size={12}>
                <PixelOrbit color={agentLook(consulted).color} size={12} />
              </LineIcon>
            ) : (
              <LineIcon
                name={state === "waiting" || state === "offline" || state === "handedOn" ? "wait" : "clock"}
                size={12}
                color={c.faint}
                variant="caption"
              />
            )}
            <Text variant="caption" tone="faint" style={styles.grow}>
              {consultLineLabel(t, state, q, to)}
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.foot, { paddingBottom: insets.bottom + 8 }]}>
        <View style={[styles.note, { backgroundColor: c.sunken }]}>
          <LineIcon variant="footnote" name="lock" size={16} color={c.muted} />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            <Text variant="footnote" tone="ink2" style={styles.bold}>
              {t("chat.consultPanel.readOnly")}
            </Text>{" "}
            {t("chat.consultPanel.steer", { name: from.name, context: from.context })}
          </Text>
        </View>
        {asker ? (
          <Button
            variant="secondary"
            size="sm"
            icon="chat"
            wide
            label={t("chat.consultPanel.talk", { name: from.name, context: from.context })}
            onPress={talk}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingVertical: 12, gap: 2 },
  pad: { paddingHorizontal: 16 },
  // Sentences that wrap: the icon stays on their first line (`LineIcon`), not between the lines.
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  answer: { gap: 4, paddingVertical: 8 },
  foot: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 14 },
});
