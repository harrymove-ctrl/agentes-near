import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GroupedList, GroupedRow } from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { AlwaysApproved } from "./AgentProfileScreen";
import { BrakesSection } from "./BrakesSection";
import { openAgentDelete } from "./DeleteAgentScreen";
import { MergeReposSection } from "./MergeReposSection";
import { ReportsToSection } from "./ReportsToSection";

/**
 * An agent's Advanced, as the web's tab in a personal workspace (ADR 0159 §3): its brakes (work nobody asked for), who
 * it reports to, the actions approved for good, its repositories, and deleting it. Each saves on its own, as on the
 * screens they left; nothing here is new, only out of the way.
 */
export function AgentMoreScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const meId = useMeId();
  const org = useOrg().org;
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const mine = Boolean(meId && agent?.ownerUserId === meId);
  const admin = can(org, "manage_agents");
  const rightHand = isRightHand(agent);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.tabs.advanced")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {agent && !rightHand ? (
          <>
            <BrakesSection agent={agent} />
            <ReportsToSection agentId={agentId} />
          </>
        ) : null}
        <AlwaysApproved agentId={agentId} name={name} mayRemove={mine || can(org, "approve_actions")} />
        <MergeReposSection agentId={agentId} name={name} mayEdit={mine || can(org, "manage_agents")} />
        {/* Deleting for good asks for its name on a screen of its own (ADR 0082). */}
        {admin && agent && !rightHand ? (
          <GroupedList>
            <GroupedRow
              icon="x"
              label={t("agentPage.delete.action", agentGrammar(name))}
              sub={t("agentPage.delete.help")}
              subLines={2}
              danger
              chevron
              onPress={() => openAgentDelete(agentId)}
            />
          </GroupedList>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
});
