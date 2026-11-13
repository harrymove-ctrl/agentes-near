import { type Agent, useAgentAccess } from "@agenteschat/client";
import { levelOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { canTalk } from "@agenteschat/client/lib/audience";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, GroupedList, GroupedRow, SearchField, Text, useTheme } from "@/ui";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { useConnectedById } from "../settings/hooks";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader } from "../shared/parts";
import { chooseAgent, useAgentPick } from "./agent-pick";
import { AGENT_SEARCH_FROM, agentsMatching } from "./logic";

/** Logos shown on a row before "+N". */
const LOGOS_SHOWN = 4;

/**
 * "Who looks after it", pushed from New widget's card (ADR 0135; screens, never sheets): the agents the person can
 * talk to, each with its face, name, role and the connected apps it reads, the current one checked. A search field
 * past a handful of agents. Choosing one goes back to the card at once.
 */
export function AgentPickScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const pick = useAgentPick();
  const [query, setQuery] = useState("");
  const agents = useMemo(() => dir.agents.filter((a) => canTalk(a)), [dir.agents]);
  const shown = useMemo(() => agentsMatching(agents, query), [agents, query]);
  // Opened with no card under it (its address on its own): nothing to pick for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  const choose = (id: string) => {
    chooseAgent(id);
    goBack();
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("dashboards.newWidget.who")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {agents.length >= AGENT_SEARCH_FROM ? (
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t("mobile.dashboards.agentPick.search")}
              accessibilityLabel={t("mobile.dashboards.agentPick.search")}
            />
          </View>
        ) : null}
        {pick && shown.length > 0 ? (
          <GroupedList>
            {shown.map((a) => (
              <AgentRow key={a.id} agent={a} checked={a.id === pick.agentId} onPress={() => choose(a.id)} />
            ))}
          </GroupedList>
        ) : null}
        {pick && shown.length === 0 && !dir.loading ? (
          <Text variant="footnote" tone="faint" style={styles.empty}>
            {agents.length === 0 ? t("dashboards.newWidget.noAgents") : t("mobile.dashboards.agentPick.noMatch")}
          </Text>
        ) : null}
        {pick && agents.length > 0 ? <GroupedFooter>{t("mobile.dashboards.agentPick.note")}</GroupedFooter> : null}
      </ScrollView>
    </View>
  );
}

/** An agent: face, name, role, and under them the apps it reads (their logos, then their names in one line). */
function AgentRow({ agent, checked, onPress }: { agent: Agent; checked: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const apps = useAgentApps(agent.id);
  const names = apps.map((a) => a.label);
  return (
    <GroupedRow
      leading={
        <View style={styles.faceTop}>
          <AgentFace agentId={agent.id} size={36} live={false} />
        </View>
      }
      label={agent.name}
      {...(agent.role ? { sub: agent.role } : {})}
      below={
        apps.length > 0 ? (
          <View style={styles.apps}>
            {apps.slice(0, LOGOS_SHOWN).map((a) => (
              <ConnectorIcon key={a.key} def={a.def} image={a.image} label={a.label} size={20} />
            ))}
            {apps.length > LOGOS_SHOWN ? (
              <Text variant="caption" tone="faint">{`+${apps.length - LOGOS_SHOWN}`}</Text>
            ) : null}
          </View>
        ) : null
      }
      belowText={
        apps.length > 0
          ? t("mobile.dashboards.agentPick.reads", { apps: names.join(", ") })
          : t("mobile.dashboards.agentPick.noApps")
      }
      checked={checked}
      onPress={onPress}
    />
  );
}

/** The connected apps an agent may use (its connector grants), as the agent's page lists them. */
function useAgentApps(agentId: string) {
  const orgId = useOrgId();
  const access = useAgentAccess(orgId, agentId);
  const connected = useConnectedById();
  return useMemo(() => {
    if (!access.data) return [];
    return resourcesOf(access.data)
      .filter((r) => r.kind === "connector" && levelOf(r) !== "none")
      .map((r) => {
        const item = r.connectionId ? connected.get(r.connectionId) : undefined;
        return { key: r.id, label: r.label, def: item?.def ?? null, image: item?.image ?? null };
      });
  }, [access.data, connected]);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  search: { paddingBottom: 12 },
  faceTop: { alignSelf: "flex-start", paddingTop: 2 },
  apps: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 6, paddingBottom: 2 },
  empty: { textAlign: "center", paddingVertical: 24 },
});
