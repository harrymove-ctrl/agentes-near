import { useChannelCategories } from "@agenteschat/client";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Text } from "@/ui";
import { router } from "@/ui/navigation";
import { mayCreate } from "../new/logic";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { FocusLive, PushedHeader } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";
import { useHidesQuietGeneral } from "./ChatsScreen";
import { ConversationRowView } from "./ConversationRowView";
import { type ConversationRow, type ListKind, rightHandPin, rowsOfKind, withoutQuietGeneral } from "./logic";
import { useAgentRowStates } from "./useHomeNow";
import { useWaitingItems } from "./WaitingStrip";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Every conversation of one kind, pushed from a section's "Ver todos" on Conversas (agents, channels,
 * people), by latest activity, in Conversas' rows (an agent's says it waits on you, or what it is doing). A personal
 * workspace (ADR 0159) titles its channels as group conversations and, as on the home, leaves a quiet #general out
 * while its person is alone in it.
 */
export function ConversationListScreen({ kind, categoryId }: { kind: ListKind; categoryId?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const list = useConversations();
  const dir = useDirectory();
  const categories = useChannelCategories(useOrgId());
  // One channel category's "Ver todos": its channels, titled with its name.
  const category = categoryId ? categories.data?.find((x) => x.id === categoryId) : undefined;
  const inCategory = (r: ConversationRow) => r.kind === "channel" && r.categoryId === categoryId;
  const hideGeneral = useHidesQuietGeneral();
  // The right hand has its own row on Conversas, never one in Agentes (ADR 0137).
  const all = withoutQuietGeneral(rightHandPin(list.rows, rightHandOf(dir.agents)).rows, hideGeneral);
  const rows = categoryId ? rowsOfKind(all, "channels").filter(inCategory) : rowsOfKind(all, kind);
  const work = useWorkingNow();
  const waiting = useWaitingItems();
  const agentStates = useAgentRowStates(list.rows, work, waiting.items);
  const pull = usePullRefresh(list.refetch);
  const { org } = useOrg();
  const personal = isPersonal(org);
  const title = categoryId
    ? (category?.name ?? "")
    : kind === "channels" && personal
      ? t("shell.channelsPersonal")
      : t(`mobile.chats.section.${kind}`);
  const firstStep =
    categoryId || kind === "channels"
      ? {
          place: "channels" as const,
          acts: mayCreate(org, "channel"),
          label: t(personal ? "shell.sidebarMenu.newChannelPersonal" : "mobile.empty.channels.action"),
          onPress: () => router.push("/new-channel"),
        }
      : kind === "people"
        ? {
            place: "people" as const,
            acts: mayCreate(org, "invite"),
            label: t("members.inviteTitle"),
            onPress: () => router.push("/invite-people"),
          }
        : {
            place: "chats" as const,
            acts: true,
            label: t("mobile.empty.chats.action"),
            icon: "chat" as const,
            onPress: () => router.push("/new-chat"),
          };
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={title} solid={false} />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24 }}
        >
          {list.loading ? (
            <Text tone="faint" style={styles.center}>
              {t("mobile.common.loading")}
            </Text>
          ) : list.failed && rows.length === 0 ? (
            <LoadFailed onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <FirstUse {...firstStep} />
          ) : (
            rows.map((r, i) => (
              <ConversationRowView
                key={r.key}
                row={r}
                divider={i > 0}
                live={i < LIVE_ROWS}
                agent={agentStates.get(r.key)}
              />
            ))
          )}
        </ScrollView>
      </FocusLive>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { textAlign: "center", paddingVertical: 40 },
});
