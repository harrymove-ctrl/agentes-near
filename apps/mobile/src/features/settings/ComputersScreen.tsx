import type { OrgSummary } from "@agenteschat/client";
import {
  useAgents,
  useAuthConfig,
  useComputerSetup,
  useHostComputer,
  useHostComputerOn,
  useMachines,
  useSetComputerTarget,
} from "@agenteschat/client";
import { type NoComputer, setupView } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerState, machineTitle } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet } from "react-native";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { openPage } from "../ai/parts";
import { computerIcon } from "../outages/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useMeId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { type AgentComputerPick, agentComputerPick, NO_COMPUTER, noComputerKey } from "./logic";
import { Gap, SettingsPage } from "./parts";

/**
 * What "no computer" stands for, by name: the workspace's own computer on its way reads in its mode's words (a
 * personal one's: its person's agents', ADR 0159), else plainly none.
 */
function noComputerName(t: TFunction, org: OrgSummary | null, choice: NoComputer) {
  const key = noComputerKey(choice);
  return t(choice === "workspace" ? modeKey(org, key) : key, { org: org?.name ?? "" });
}

/** A choice's name in "Qual computador cada agente usa": a computer by its name, or what "no computer" stands for. */
function choiceName(t: TFunction, org: OrgSummary | null, pick: AgentComputerPick, id: string) {
  if (id === NO_COMPUTER) return noComputerName(t, org, pick.noComputer ?? "none");
  const m = pick.choices.find((x) => x.id === id);
  return m ? machineTitle(m, t("machines.host.label")) : "";
}

/**
 * This server's computer (`HOST_COMPUTER_TOKEN`) when it isn't in the devices list: an admin who stopped it here can
 * use it again; with none, admins read how to make it one, but only while sign-up is closed.
 */
export function HostComputerOff() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const admin = can(org, "configure");
  const machines = useMachines(orgId);
  const host = useHostComputer(orgId);
  const auth = useAuthConfig();
  const turnOn = useHostComputerOn(orgId);
  const label = t("machines.host.label");
  const m = machines.data?.find((x) => x.kind === "host");
  const off = host.data?.on === false;
  const missing = host.isSuccess && host.data === null && admin && auth.data?.signupOpen === false;
  if (m || (!off && !missing)) return null;
  return (
    <>
      <GroupedHeader>{label}</GroupedHeader>
      {off ? (
        <GroupedList>
          <GroupedRow
            leading={<ComputerPortrait kind="linux" state="offline" />}
            label={label}
            sub={t("machines.host.offText")}
            subLines={2}
            media
          />
          {admin ? (
            <GroupedRow
              icon="play"
              label={t("machines.host.use")}
              labelLines={2}
              disabled={turnOn.isPending}
              onPress={() =>
                turnOn.mutate(undefined, {
                  onSuccess: () => {
                    successHaptic();
                    toast({ title: t("machines.host.used"), icon: "check" });
                  },
                  onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                })
              }
            />
          ) : null}
        </GroupedList>
      ) : (
        <GroupedFooter>
          <Trans
            i18nKey="computers.hostMissing"
            components={{
              guide: (
                <Text
                  variant="footnote"
                  accessibilityRole="link"
                  style={styles.link}
                  onPress={() => openPage(helpUrl("install-on-a-server", i18n.language, "computers"))}
                />
              ),
            }}
          />
        </GroupedFooter>
      )}
    </>
  );
}

/**
 * "Qual computador cada agente usa": each agent and its computer. Who manages agents picks any; an agent's owner,
 * the ones they connected (the server checks again); a row anyone else can't change only says it.
 */
export function AgentComputers() {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const machines = useMachines(orgId);
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const list = agents.data ?? [];
  return (
    <>
      <GroupedHeader>{t("computers.agents.title")}</GroupedHeader>
      {agents.isLoading || machines.isLoading ? (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      ) : list.length === 0 ? (
        <GroupedFooter>{t("computers.agents.empty")}</GroupedFooter>
      ) : (
        <GroupedList>
          {list.map((a) => {
            const pick = agentComputerPick({ agent: a, meId, admin, machines: machines.data ?? [], setup });
            return (
              <GroupedRow
                key={a.id}
                leading={<AgentFace agentId={a.id} size={30} live={false} />}
                label={a.name}
                value={choiceName(t, org ?? null, pick, pick.value)}
                chevron={pick.canPick}
                {...(pick.canPick
                  ? {
                      onPress: () => router.push({ pathname: "/settings/computers/agent", params: { agentId: a.id } }),
                    }
                  : {})}
              />
            );
          })}
        </GroupedList>
      )}
    </>
  );
}

/**
 * "Computador de Dev", pushed from "Qual computador cada agente usa": the computers this person may pick for the
 * agent (online, paused or offline under each), and "no computer" where it means something; a pick saves and goes
 * back with a toast.
 */
export function AgentComputerScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const machines = useMachines(orgId);
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const setTarget = useSetComputerTarget(orgId);
  const agent = agents.data?.find((a) => a.id === agentId);
  if (!agent) {
    return (
      <SettingsPage title={t("computers.agents.title")}>
        {agents.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      </SettingsPage>
    );
  }
  const pick = agentComputerPick({ agent, meId, admin, machines: machines.data ?? [], setup });
  const choose = (id: string) => {
    if (id === pick.value) {
      goBack();
      return;
    }
    setTarget.mutate(
      { agentId, machineId: id === NO_COMPUTER ? null : id },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t("computers.agents.saved", { name: agent.name, computer: choiceName(t, org, pick, id) }),
            icon: "check",
          });
          goBack();
        },
        onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage title={t("computers.agents.pick", { name: agent.name })}>
      <Gap />
      <GroupedList>
        {pick.noComputer ? (
          <GroupedRow
            icon={pick.noComputer === "workspace" ? computerIcon("other") : "circle"}
            label={noComputerName(t, org, pick.noComputer)}
            sub={pick.noComputer === "workspace" && setup ? t(setup.chipKey) : t("computer.target.noneText")}
            checked={pick.value === NO_COMPUTER}
            disabled={setTarget.isPending}
            onPress={() => choose(NO_COMPUTER)}
          />
        ) : null}
        {pick.choices.map((m) => (
          <GroupedRow
            key={m.id}
            icon={computerIcon(m.os)}
            label={machineTitle(m, t("machines.host.label"))}
            sub={t(`computers.agents.state.${computerState(m)}`)}
            checked={pick.value === m.id}
            disabled={setTarget.isPending}
            onPress={() => choose(m.id)}
          />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: 16 },
  link: { textDecorationLine: "underline" },
});
