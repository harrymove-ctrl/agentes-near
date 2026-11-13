import { keys, useAgentAccess, useApi, useCustomServerAction, useDisconnect, useGitHubApp } from "@agenteschat/client";
import {
  type Level,
  type LevelState,
  levelIn,
  levelOf,
  resourcesOf,
  saveLevels,
} from "@agenteschat/client/lib/access-levels";
import type { ConnectedItem } from "@agenteschat/client/lib/connected";
import { githubDisconnectNote } from "@agenteschat/client/lib/github-app";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Icon, useToast } from "@/ui";
import { useAgentsAccess } from "../settings/hooks";
import { confirmAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { pickLevel } from "./pick-level";

/**
 * Who uses a connection, as the phone's settings list it: one row per agent, its face in its sky at 36, the level
 * as the row's value ("Sem acesso", "Ler", "Ler e escrever", the web's words) with the mark of a value that changes
 * in place; a tap opens the system's choice. Who may not change it sees the value alone. What always asks is the
 * footer, in one sentence. One way to give a level, never two: the rows are the whole of it.
 */
export function AgentLevelList({ connectionId, title }: { connectionId: string; title?: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const qc = useQueryClient();
  const orgId = useOrgId();
  // A new connection: every agent's tree must be read again to show it.
  useEffect(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[2] === "access" });
  }, [qc]);
  // One block: a sheet's gap goes around it, never between the header and its rows.
  return (
    <View>
      <GroupedHeader>{title ?? t("mobile.connectors.whoTitle")}</GroupedHeader>
      <GroupedList>
        {dir.agents.map((a) => (
          <AgentLevelRow
            key={a.id}
            orgId={orgId}
            agentId={a.id}
            connectionId={connectionId}
            leading={<AgentFace agentId={a.id} size={36} live={false} />}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("mobile.connectors.safe")}</GroupedFooter>
    </View>
  );
}

/** A level in the web's words ("Personalizado" when the agent's tools were set one by one). */
const useLevelWord = () => {
  const { t } = useTranslation();
  return (level: LevelState) => t(`access.level.${level}`);
};

function AgentLevelRow({
  orgId,
  agentId,
  connectionId,
  leading,
}: {
  orgId: string;
  agentId: string;
  connectionId: string;
  leading: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const toast = useToast();
  const word = useLevelWord();
  const { org } = useOrg();
  const agent = dir.agentById.get(agentId);
  const access = useAgentAccess(orgId, agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const resource = access.data ? resourcesOf(access.data).find((r) => r.id === `connector:${connectionId}`) : undefined;
  const current: LevelState = saving ?? (resource ? levelOf(resource) : "none");
  // Giving an agent a connector is an admin's call, like its scopes (the server checks it again).
  const mayChange = can(org, "manage_agents") && Boolean(resource);
  const choose = (level: Level) => {
    if (!resource || level === current) return;
    setSaving(level);
    void saveLevels(api, orgId, agentId, { [resource.id]: level })
      .then((next) => {
        successHaptic();
        qc.setQueryData(keys.agentAccess(orgId, agentId), next);
      })
      .catch(() => {
        errorHaptic();
        toast({ title: t("mobile.connectors.levelFailed", { name: agent?.name ?? "" }), icon: "x" });
      })
      .finally(() => setSaving(null));
  };
  const open = () =>
    void pickLevel(t, agent?.name ?? "", current).then((level) => {
      if (level) choose(level);
    });
  return (
    <GroupedRow
      leading={leading}
      label={agent?.name ?? ""}
      {...(agent?.role ? { sub: agent.role } : {})}
      value={word(current)}
      // The value changes in its row, through the app's picker: its mark, not a chevron to a screen.
      menu={mayChange}
      disabled={Boolean(saving)}
      {...(mayChange ? { onPress: open } : {})}
    />
  );
}

/**
 * Disconnecting, alone in its group at the page's end in red, after the system's confirmation saying how many agents
 * lose it (the web's dialog).
 */
export function DisconnectRow({ item, name, onDone }: { item: ConnectedItem; name: string; onDone: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const dir = useDirectory();
  const access = useAgentsAccess(dir.agents);
  const disconnect = useDisconnect(orgId);
  const { disconnect: disconnectServer } = useCustomServerAction(orgId);
  const users = dir.agents.filter((a) => levelIn(access.byAgent.get(a.id), `connector:${item.id}`) !== "none").length;
  // GitHub and the agentes.chat app: the app alone is uninstalled with it, an account goes and the app stays.
  const installations = useGitHubApp(orgId, item.def?.id === "github").data?.installations ?? [];
  const githubNote = githubDisconnectNote(t, item, installations);
  const run = () => {
    const done = {
      onSuccess: () => {
        successHaptic();
        onDone();
        toast({
          title:
            githubNote && !item.viaGithubApp ? t("githubApp.keptApp") : t("mobile.connectors.disconnected", { name }),
        });
      },
      onError: () => {
        errorHaptic();
        toast({ title: t("mobile.connectors.disconnectFailed", { name }), icon: "x" });
      },
    };
    // A server connected by address is removed through its own endpoint (as on the web).
    if (item.custom) disconnectServer.mutate(item.id, done);
    else disconnect.mutate(item.id, done);
  };
  return (
    <GroupedList>
      <GroupedRow
        label={t("mobile.connectors.disconnect")}
        danger
        disabled={disconnect.isPending || disconnectServer.isPending}
        onPress={() =>
          confirmAction({
            title: t("connectors.disconnectTitle", { name }),
            text: [
              users > 0 ? t("connectors.disconnectText", { count: users }) : t("connectors.disconnectTextNone"),
              githubNote,
            ]
              .filter(Boolean)
              .join("\n\n"),
            action: t("mobile.connectors.disconnect"),
            cancel: t("common.cancel"),
            onConfirm: run,
          })
        }
      />
    </GroupedList>
  );
}

/** A row's leading tile with the amber wait mark: something here waits on the person (tools to decide). */
export function WaitTile() {
  const c = useColors();
  return (
    <View style={[styles.tile, { backgroundColor: c.sunken }]}>
      <Icon name="wait" size={16} color={c.amber} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
