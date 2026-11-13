import { type Agent, useAgents } from "@agenteschat/client";
import {
  type AccessResource,
  asksAt,
  type Level,
  type LevelState,
  levelOf,
  nextLevel,
  resourcesOf,
} from "@agenteschat/client/lib/access-levels";
import { addsConnectors, can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, InfoHint, Segmented, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { mayCreate } from "../new/logic";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useErrorToast } from "../shared/hooks";
import { errorHaptic, tapHaptic } from "../shared/parts";
import { resourceName, useAgentsAccess, useConnectedById, useSetLevels } from "./hooks";
import { type AccessKind, AREA_ICON, accessColumns } from "./logic";
import { SettingsPage } from "./parts";

/**
 * Agentes e acesso (admins), as the web's matrix: agents × the connected services (or the built-in areas), each a
 * level. On the phone each agent is a group and each service a row: a tap moves its level on (Sem acesso → Ler →
 * Ler e escrever) and saves right away. Sensitive actions keep asking at any level (the row says so); fine-tuning
 * tool by tool is the connector's Ferramentas.
 */
export function AccessScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const failed = useErrorToast();
  const { orgId, org } = useOrg();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const list = agents.data ?? [];
  const access = useAgentsAccess(list, admin);
  const items = useConnectedById();
  const set = useSetLevels();
  const [kind, setKind] = useState<AccessKind>("connector");
  const [pending, setPending] = useState<Record<string, Level>>({});
  const first = list.map((a) => access.byAgent.get(a.id)).find((x) => x !== undefined);
  const columns = accessColumns(first, kind);
  const table = first !== undefined && columns.length > 0 && !access.loading;
  const busyAgents = new Set(Object.keys(pending).map((k) => k.split("|")[0]));

  const cycle = (agent: Agent, r: AccessResource, current: LevelState) => {
    if (busyAgents.has(agent.id)) return;
    tapHaptic();
    const level = nextLevel(r, current);
    const k = `${agent.id}|${r.id}`;
    setPending((p) => ({ ...p, [k]: level }));
    set.mutate(
      { agentId: agent.id, changes: { [r.id]: level } },
      {
        onError: (e) => {
          errorHaptic();
          failed(e);
        },
        onSettled: () =>
          setPending((p) => {
            const next = { ...p };
            delete next[k];
            return next;
          }),
      },
    );
  };

  if (!admin) {
    return (
      <SettingsPage title={t("settings.section.access")}>
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title={t("settings.section.access")}>
      <GroupedFooter>{t("settings.sectionText.access")}</GroupedFooter>
      <View style={styles.head}>
        <InfoHint
          name={t("common.about", { label: t("access.matrixTitle") })}
          text={t("access.matrixHint")}
          variant="title"
        >
          <Text variant="title" tone="ink">
            {t("access.matrixTitle")}
          </Text>
        </InfoHint>
        <Segmented
          items={[
            { key: "connector", label: t("access.kind.connectors") },
            { key: "builtin", label: t("access.kind.builtin") },
          ]}
          value={kind}
          onChange={(k) => setKind(k as AccessKind)}
        />
      </View>
      {access.unavailable ? <GroupedFooter>{t("access.unavailable")}</GroupedFooter> : null}
      {agents.isLoading || (list.length > 0 && access.loading) ? (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      ) : null}
      {agents.isSuccess && list.length === 0 ? (
        <FirstUse
          place="agents"
          size="panel"
          acts={mayCreate(org, "agent")}
          label={t("mobile.homeNow.first.create")}
          onPress={() => router.push("/new-agent")}
        />
      ) : null}
      {first && columns.length === 0 && kind === "connector" ? (
        <FirstUse
          place="access"
          size="panel"
          acts={addsConnectors(org)}
          label={t("mobile.empty.access.action")}
          onPress={() => router.push("/connectors")}
        />
      ) : null}
      {table
        ? list.map((a) => {
            const tree = access.byAgent.get(a.id);
            const mine = tree ? resourcesOf(tree) : [];
            return (
              <View key={a.id}>
                <GroupedHeader>{a.role ? `${a.name} · ${a.role}` : a.name}</GroupedHeader>
                <GroupedList>
                  {columns.map((col) => {
                    const name = resourceName(t, col, items);
                    const item = col.connectionId ? items.get(col.connectionId) : undefined;
                    const lead = col.connectionId
                      ? {
                          leading: <ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} size={30} />,
                        }
                      : { icon: AREA_ICON[col.area ?? ""] ?? "circle" };
                    const r = mine.find((x) => x.id === col.id);
                    if (!r) return <GroupedRow key={col.id} {...lead} label={name} value={t("access.level.none")} />;
                    const level = pending[`${a.id}|${r.id}`] ?? levelOf(r);
                    const asks = asksAt(r, level).length > 0;
                    return (
                      <GroupedRow
                        key={col.id}
                        {...lead}
                        label={name}
                        {...(asks ? { sub: t("access.asksLegend") } : {})}
                        value={t(`access.level.${level}`)}
                        disabled={busyAgents.has(a.id)}
                        onPress={() => cycle(a, r, level)}
                      />
                    );
                  })}
                </GroupedList>
              </View>
            );
          })
        : null}
      {table ? <GroupedFooter>{t("mobile.settings.access.how")}</GroupedFooter> : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  head: { gap: 12, paddingHorizontal: 4, paddingTop: 20, paddingBottom: 4 },
  loading: { marginVertical: 16 },
});
