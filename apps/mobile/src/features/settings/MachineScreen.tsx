import type { Machine, ScopeGrant } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  isOpenHandoff,
  keys,
  machineProfiles,
  useAgents,
  useAgentsBrowserHandoffs,
  useApi,
  useBrowserHandoffMutations,
  useBrowserProfileMutations,
  useBrowserProfiles,
  useComputerSetup,
  useMachineAction,
  useMachinePause,
  useMachines,
  useReduceMachineAccess,
} from "@agenteschat/client";
import { computerName, setupView } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  allowedFolders,
  allowsInApp,
  canReduceAccess,
  commandInReason,
  computerKind,
  computerState,
  folderName,
  hostDescKey,
  isPaused,
  MACHINE_TOOLS,
  machineReasonText,
  PAUSE_CHOICES,
  pauseChoiceText,
  pausedByText,
  pauseUntil,
  sharedFolderFacts,
  sharedFolderOf,
  toolOnCommand,
} from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { countryFlagSvg } from "@agenteschat/ui/brand/flags";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import {
  Chip,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  ProviderLogo,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { ComputerSection } from "../devices/ComputerSection";
import { findDevice } from "../devices/logic";
import { StatusLine } from "../devices/parts";
import { useDevices } from "../devices/queries";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack, MONO, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { DESKTOP_TURN_ON, grantCommand, osOf, pauseText, type Reduce, reduceTexts, seenText } from "./logic";
import { CommandBlock, chooseAction, confirmAction, Gap, SettingsPage } from "./parts";

/**
 * One computer, as the web's page: its portrait and state (online, paused, who connected it) and what it is; the
 * agents that use it (each opens its page; Abrir shows its computer to whoever may watch it); then what it allows:
 * the folders and who uses each, its tools, the agents' browser, apps on the agents' screens, and how to allow more
 * (only ever on the computer itself). Admins and whoever connected it take things away, rename or remove it;
 * everyone else reads. The workspace's own computer (ADR 0056 §10) shows its size and its help page instead.
 */
export function MachineScreen({ machineId }: { machineId: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const machines = useMachines(orgId);
  const askReduce = useAskReduce(machineId);
  const action = useMachineAction(orgId);
  const pause = useMachinePause(orgId);
  const meId = useMeId();
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const m = machines.data?.find((x) => x.id === machineId);
  // Its state, who can use it and its phones (`GET …/devices`); the page reads without them while they load.
  const device = findDevice(useDevices().data?.devices, machineId)?.computer;
  // Each agent's screen as this person sees it (the agent page's cache): it answers only who may watch it.
  const desktops = useQueries({
    queries: (m?.agents ?? []).map((a) => ({
      queryKey: keys.agentDesktop(orgId, a.id),
      queryFn: () => api.desktop.status(orgId, a.id),
      retry: false,
    })),
  });

  if (!m) {
    return (
      <SettingsPage title={t("machines.page.back")}>
        {machines.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : machines.isError && !machines.data ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <View style={styles.missing}>
            <EmptyState title={t("machines.page.notFound")} subtitle={t("machines.page.notFoundText")} />
          </View>
        )}
      </SettingsPage>
    );
  }

  const managed = m.kind === "managed";
  const title = computerName(t, org?.name ?? "", m, isPersonal(org));
  const paused = pauseText(t, i18n.language, m.paused);
  const askRemove = () => {
    const host = m.kind === "host";
    const name = m.name;
    confirmAction({
      title: host ? t("machines.host.stopTitle") : t("machines.removeTitle", { name }),
      text: host ? t("machines.host.stopText") : t("machines.removeText"),
      action: host ? t("machines.host.stop") : t("machines.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        action.mutate(
          { machineId: m.id, action: "remove" },
          {
            onSuccess: () => {
              toast({ title: host ? t("machines.host.stopped") : t("machines.removed", { name }), icon: "check" });
              goBack();
            },
            onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
          },
        ),
    });
  };

  const setPause = (input: { until: string | null } | "resume") =>
    pause.mutate(
      { machineId: m.id, input },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t(input === "resume" ? "machines.remotePause.resumed" : "machines.remotePause.paused", {
              name: m.name,
            }),
            icon: "check",
          });
        },
        onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
      },
    );
  const askPause = () =>
    chooseAction(
      t("machines.remotePause.menu", { name: m.name }),
      PAUSE_CHOICES.map((choice) => ({
        label: pauseChoiceText(t, choice),
        onPress: () => setPause({ until: pauseUntil(choice) }),
      })),
      t("common.cancel"),
    );
  const pausedNow = isPaused(m);
  // Pause from here: whoever connected it and admins, while it's online; never the workspace's own computer.
  const pausable = m.canManage && m.online && !managed;

  const chips: { icon: IconName; label: string }[] = [
    ...(m.kind === "host" && m.name ? [{ icon: "server" as const, label: t("machines.host.label") }] : []),
    // The device's state says online, busy or paused in its own chip.
    ...(device
      ? []
      : [
          {
            icon: m.online ? ("check" as const) : ("circle" as const),
            label: m.online ? t("machines.online") : t("machines.offline"),
          },
          ...(paused ? [{ icon: "pause" as const, label: paused }] : []),
        ]),
    ...(m.pairedBy ? [{ icon: "members" as const, label: t("machines.pairedBy", { name: m.pairedBy.name }) }] : []),
  ];
  const facts = [
    m.kind === "host" ? t(`machines.host.${hostDescKey(m.os)}`) : null,
    managed ? t("computerSetup.users") : null,
    managed
      ? setup?.specs
        ? t("computerSetup.specs", setup.specs)
        : null
      : t("machines.details", {
          os: t(`machines.os.${osOf(m.os)}`),
          arch: m.arch,
          version: m.runnerVersion,
          seen: seenText(t, i18n.language, m),
        }),
    managed && !m.online ? seenText(t, i18n.language, m) : null,
    isPaused(m) ? (pausedByText(t, i18n.language, m.paused, meId ?? "") ?? t("machines.pausedHint")) : null,
    // System mode: each agent works in its own home, never in the folder the computer was connected from.
    m.mode === "system" && !managed && m.kind !== "host" ? t("machines.agentUsers") : null,
  ].filter((x): x is string => Boolean(x));

  return (
    <SettingsPage title={title}>
      <View style={styles.head}>
        <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} size={96} />
        {device ? <StatusLine status={device.status} center /> : null}
        <View style={styles.chips}>
          {chips.map((x) => (
            <Chip key={x.label} icon={x.icon} label={x.label} />
          ))}
        </View>
        {facts.map((line) => (
          <Text key={line} variant="small" tone="muted" style={styles.center}>
            {line}
          </Text>
        ))}
        {managed && m.online && m.egressWaiting && (
          <Text variant="small" tone="muted" style={styles.center}>
            {t("machines.egress.waiting")}
          </Text>
        )}
        {managed && m.networkTransition && (
          <Text variant="small" tone="muted" style={styles.center}>
            {t(m.networkTransition.state === "draining" ? "machines.egress.draining" : "machines.egress.restart", {
              when: new Date(m.networkTransition.deadline).toLocaleTimeString(),
            })}
          </Text>
        )}
        {managed && m.online && m.egress?.ip && (
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" }}>
            {countryFlagSvg(m.egress.country) ? (
              <SvgXml xml={countryFlagSvg(m.egress.country) as string} width={20} height={14} />
            ) : (
              <Icon name="globe" size={15} color={c.muted} />
            )}
            <Text variant="small" tone="muted">
              {t("machines.egress.line", { ip: m.egress.ip })}
            </Text>
          </View>
        )}
        {m.workspace && m.mode !== "system" ? (
          <Text variant="small" tone="muted" style={styles.center}>
            {t("machines.workspace")}{" "}
            <Text variant="small" tone="muted" style={styles.mono}>
              {m.workspace}
            </Text>
          </Text>
        ) : null}
      </View>

      {pausable ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={pausedNow ? "play" : "pause"}
              label={t(pausedNow ? "machines.remotePause.resume" : "machines.remotePause.button")}
              {...(m.remotePause ? {} : { sub: t("machines.remotePause.outdated"), subLines: 3 })}
              {...(pausedNow ? {} : { chevron: true })}
              disabled={!m.remotePause || pause.isPending}
              onPress={pausedNow ? () => setPause("resume") : askPause}
            />
          </GroupedList>
        </>
      ) : null}

      {device ? <ComputerSection device={device} name={title} /> : null}

      {m.agents.length > 0 ? (
        <>
          <GroupedHeader>{t("machines.page.agents")}</GroupedHeader>
          <GroupedList>
            {m.agents.flatMap((a, i) => {
              // What this agent may use here, beyond its own folder (only who may see the access knows).
              const folders = m.access?.folders.filter((f) => f.agents.includes(a.id)).map((f) => folderName(f.path));
              const line =
                folders && (folders.length > 0 || !managed)
                  ? folders.length > 0
                    ? t("machines.page.agentFolders", {
                        ...agentGrammar(a.name),
                        folders: joinNames(folders, t),
                      })
                    : t("machines.page.agentOwnFolder", agentGrammar(a.name))
                  : null;
              const agentRow = (
                <GroupedRow
                  key={a.id}
                  leading={<AgentFace agentId={a.id} size={30} live={false} />}
                  label={a.name}
                  sub={[`@${a.handle}`, line].filter(Boolean).join(" · ")}
                  subLines={2}
                  chevron
                  onPress={() => router.push(`/agent/${a.id}`)}
                />
              );
              // Abrir: the agent's computer, full screen, for whoever may watch it (its screen's state answers them;
              // anyone else gets a refusal), as on the agent's page. A row of its own, so screen readers reach it.
              if (!desktops[i]?.isSuccess) return [agentRow];
              return [
                agentRow,
                <GroupedRow
                  key={`${a.id}:computer`}
                  icon="laptop"
                  label={t("agentComputer.title", agentGrammar(a.name))}
                  value={t("agentComputer.open")}
                  chevron
                  onPress={() => router.push(`/computer/${a.id}`)}
                />,
              ];
            })}
          </GroupedList>
        </>
      ) : null}
      {/* Nobody in the workspace changes what its own computer allows, admins included. */}
      {!m.canManage && !managed ? (
        <GroupedFooter>
          {m.pairedBy ? t("machines.page.readOnly", { name: m.pairedBy.name }) : t("machines.page.readOnlyNobody")}
        </GroupedFooter>
      ) : null}

      {managed ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="help"
              label={t("computers.about")}
              chevron
              onPress={() => openPage(helpUrl("workspace-computer", i18n.language))}
            />
          </GroupedList>
        </>
      ) : (
        <>
          <FoldersSection machine={m} />
          <ToolsSection machine={m} onReduce={askReduce} />
          <BrowserSection machine={m} onTurnOff={() => askReduce({ kind: "tool", tool: "browser" })} />
          <ProfilesSection machine={m} />
          <DesktopUseSection machine={m} />
          <GrantSection machine={m} />
        </>
      )}

      {m.canManage ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="pen"
              label={t("machines.rename")}
              chevron
              onPress={() => router.push({ pathname: "/settings/computers/rename", params: { machineId: m.id } })}
            />
            {/* The workspace's own computer stays: people rename it, never remove it. */}
            {!managed ? (
              <GroupedRow
                icon={m.kind === "host" ? "stop" : "x"}
                label={m.kind === "host" ? t("machines.host.stop") : t("machines.remove")}
                labelLines={2}
                danger
                disabled={action.isPending}
                onPress={askRemove}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Confirms, then takes something away on the computer (granting happens only on the computer itself). */
function useAskReduce(machineId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const reduceAccess = useReduceMachineAccess(useOrgId());
  return (reduce: Reduce, done?: () => void) => {
    const r = reduceTexts(t, reduce);
    confirmAction({
      title: r.title,
      text: r.text,
      action: r.action,
      cancel: t("common.cancel"),
      onConfirm: () =>
        reduceAccess.mutate(
          { machineId, ...r.input },
          {
            onSuccess: () => {
              successHaptic();
              toast({ title: r.done, icon: "check" });
              done?.();
            },
            onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
          },
        ),
    });
  };
}

/** An agent's name: from the workspace's agents, else from the computer's list. */
function useAgentName(m: Pick<Machine, "agents"> | undefined) {
  const agents = useAgents(useOrgId());
  return (id: string) => agents.data?.find((a) => a.id === id)?.name ?? m?.agents.find((a) => a.id === id)?.name ?? "";
}

/**
 * Pastas liberadas: each folder and who uses it; for who manages the computer, a folder opens its own screen to take
 * it away (the web's menu, with a row per agent).
 */
function FoldersSection({ machine: m }: { machine: Machine }) {
  const { t, i18n } = useTranslation();
  const nameOf = useAgentName(m);
  const access = m.access;
  const shared = sharedFolderOf(access);
  const folders = allowedFolders(access);
  const reduces = canReduceAccess(m);
  const open = (path: string) =>
    router.push({ pathname: "/settings/computers/folder", params: { machineId: m.id, path } });
  return (
    <>
      <GroupedHeader>{t("machines.access.folders")}</GroupedHeader>
      {!access ? (
        // The server shows the folders only to admins and whoever connected it.
        <GroupedFooter>{m.canManage ? t("machines.access.noReport") : t("machines.access.hidden")}</GroupedFooter>
      ) : (
        <>
          <GroupedList>
            <GroupedRow
              icon="lock"
              label={t("machines.access.ownFolder")}
              sub={t("machines.access.ownFolderText")}
              subLines={2}
              media
            />
            {shared ? (
              <GroupedRow
                icon="members"
                label={t("machines.shared.title")}
                sub={shared}
                subLines={2}
                media
                below={
                  <Text variant="caption" tone="faint" numberOfLines={4}>
                    {`${t("machines.shared.text")} ${sharedFolderFacts(t, i18n.language, m.disk)}`}
                  </Text>
                }
              />
            ) : null}
            {folders.map((f) => (
              <GroupedRow
                key={f.path}
                icon="drive"
                label={folderName(f.path)}
                sub={f.path}
                subLines={2}
                media
                below={
                  <Text variant="caption" tone="faint" numberOfLines={2}>
                    {f.agents.length > 0 ? joinNames(f.agents.map(nameOf), t) : t("machines.access.nobody")}
                  </Text>
                }
                chevron={reduces}
                {...(reduces ? { onPress: () => open(f.path) } : {})}
              />
            ))}
          </GroupedList>
          {folders.length === 0 ? <GroupedFooter>{t("machines.access.noFolders")}</GroupedFooter> : null}
        </>
      )}
    </>
  );
}

/** Ferramentas: on or off; who manages the computer turns one off here (never on), except on the workspace's own. */
function ToolsSection({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t } = useTranslation();
  const access = m.access;
  if (!access) return null;
  const reduces = canReduceAccess(m);
  return (
    <>
      <GroupedHeader>{t("machines.access.tools")}</GroupedHeader>
      <GroupedList>
        {MACHINE_TOOLS.map((tool) => {
          const on = access.tools[tool];
          const sub = [
            t(`machines.access.toolText.${tool}`),
            tool === "commands" && on ? t("machines.access.commandsWarn") : null,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <GroupedRow
              key={tool}
              {...(tool === "commands"
                ? { icon: "code" as const }
                : { leading: <ProviderLogo id={tool} size="sm" off={!on} /> })}
              label={t(`machines.access.tool.${tool}`)}
              sub={sub}
              subLines={3}
              media
              value={on ? t("machines.access.on") : t("machines.access.off")}
              {...(on && reduces ? { onPress: () => onReduce({ kind: "tool", tool }) } : {})}
            />
          );
        })}
      </GroupedList>
      {reduces && MACHINE_TOOLS.some((tool) => access.tools[tool]) ? (
        <GroupedFooter>{t("mobile.settings.machine.toolsHow")}</GroupedFooter>
      ) : null}
    </>
  );
}

/**
 * Perfis do navegador (ADR 0110), read-only: each profile, free or who uses it, and how many agents may. "Fazer
 * login" (for who may drive it) takes control and opens its live view. Creating, choosing agents and deleting stay
 * on the web.
 */
function ProfilesSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const profiles = useBrowserProfiles(orgId);
  const actions = useBrowserProfileMutations(orgId);
  const mine = machineProfiles(profiles.data, m);
  if (mine.length === 0) return null;
  const drive = can(org, "manage_connectors") && can(org, "control_browsers");
  const login = (profileId: string) =>
    actions.takeover.mutate(profileId, {
      onSuccess: () => router.push(`/browser-profile/${profileId}`),
      onError: (err) =>
        toast({
          title:
            (err as { status?: number }).status === 409 ? t("browser.profiles.busy") : t("browser.profiles.failed"),
          icon: "x",
        }),
    });
  return (
    <>
      <GroupedHeader>{t("browser.profiles.title")}</GroupedHeader>
      <GroupedList>
        {mine.map((p) => (
          <GroupedRow
            key={p.id}
            icon="globe"
            label={p.name}
            sub={
              p.holder
                ? t("browser.profiles.inUsePerson", {
                    name:
                      p.holder.type === "agent"
                        ? dir.nameOf({ type: "agent", id: p.holder.agentId })
                        : dir.nameOf({ type: "person", id: p.holder.userId }),
                  })
                : t("browser.profiles.free")
            }
            value={t("browser.profiles.agents", { count: p.agentIds.length })}
            {...(drive
              ? {
                  chevron: true,
                  onPress: () =>
                    chooseAction(
                      p.name,
                      [{ label: t("browser.profiles.login"), onPress: () => login(p.id) }],
                      t("common.cancel"),
                    ),
                }
              : {})}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("browser.profiles.sub")}</GroupedFooter>
    </>
  );
}

/**
 * Navegador (ADR 0040): whether the agents' browser is ready here, which agents are in it with a person now (Ver,
 * Parar), and which agents may use it. Turning it on happens on the computer; here it is only turned off.
 */
function BrowserSection({ machine: m, onTurnOff }: { machine: Machine; onTurnOff: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const orgId = useOrgId();
  const actions = useBrowserHandoffMutations(orgId);
  const agentIds = m.agents.map((a) => a.id);
  const handoffs = useAgentsBrowserHandoffs(orgId, agentIds);
  const scopes = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.scopes(orgId, id),
      queryFn: () => api.scopes.get(orgId, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const settings = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowser(orgId, id),
      queryFn: () => api.browser.settings(orgId, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const access = m.access;
  if (!access && !m.browser) return null;
  const switchedOn = access?.tools.browser === true;
  const ready = switchedOn && m.browser?.available === true;
  const command = commandInReason(m.browser?.reason);
  const status = ready ? "ready" : !switchedOn ? "off" : command ? "needsCommand" : "notReady";
  const uses = m.agents.flatMap((a, i) => {
    const h = handoffs[i];
    return h && isOpenHandoff(h) ? [{ agent: a, open: h }] : [];
  });
  const allowed = m.agents.flatMap((a, i) => {
    const grants = scopes[i]?.data as ScopeGrant[] | undefined;
    if (!grants?.some((g) => g.connectionId === null && g.scope === BROWSER_TOOL_SCOPE)) return [];
    return [{ agent: a, domains: settings[i]?.data?.allowedDomains ?? null }];
  });
  const stop = (agentId: string, name: string) => {
    const g = agentGrammar(name);
    confirmAction({
      title: t("browser.machine.stopConfirm", g),
      action: t("browser.machine.stop"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        actions.stop.mutate(agentId, {
          onSuccess: () => toast({ title: t("browser.machine.stopped", g), icon: "check" }),
          onError: () => toast({ title: t("browser.live.actionFailed"), icon: "x" }),
        }),
    });
  };
  const use = (agentId: string, name: string) =>
    chooseAction(
      name,
      [
        { label: t("browser.machine.see"), onPress: () => router.push(`/computer/${agentId}`) },
        { label: t("browser.machine.stop"), destructive: true, onPress: () => stop(agentId, name) },
      ],
      t("common.cancel"),
    );
  return (
    <>
      <GroupedHeader>{t("browser.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="globe"
          label={t(`browser.machine.${status}`)}
          {...(ready && m.browser?.chrome ? { value: m.browser.chrome } : {})}
        />
        {switchedOn && canReduceAccess(m) ? (
          <GroupedRow icon="x" label={t("browser.machine.turnOffLabel")} labelLines={2} danger onPress={onTurnOff} />
        ) : null}
      </GroupedList>
      {!switchedOn ? (
        allowsInApp(m.os) ? (
          <GroupedFooter>{t("browser.machine.offHelp")}</GroupedFooter>
        ) : (
          // A Linux computer may be a server without the app: the command too.
          <>
            <GroupedFooter>
              {t("common.joinSentences", { a: t("browser.machine.offHelp"), b: t("machines.access.grantTerminal") })}
            </GroupedFooter>
            <Gap />
            <CommandBlock command={toolOnCommand(m, "browser")} />
          </>
        )
      ) : null}
      {switchedOn && !ready && m.browser?.reason ? (
        <>
          <GroupedFooter>{machineReasonText(t, m.browser)}</GroupedFooter>
          {command ? (
            <>
              <Gap />
              <CommandBlock command={command} />
            </>
          ) : null}
        </>
      ) : null}
      {ready ? (
        <>
          <GroupedHeader>{t("browser.machine.inUse")}</GroupedHeader>
          {uses.length === 0 ? (
            <GroupedFooter>{t("browser.machine.nobody")}</GroupedFooter>
          ) : (
            <GroupedList>
              {uses.map(({ agent, open }) => {
                const g = agentGrammar(agent.name);
                const waiting = open.status === "pending";
                return (
                  <GroupedRow
                    key={agent.id}
                    leading={<AgentFace agentId={agent.id} size={30} mode={waiting ? "idle" : "think"} />}
                    label={waiting ? t("browser.machine.waiting", g) : t("browser.machine.helping", g)}
                    labelLines={2}
                    {...(open.kind === "ask" && open.instructions ? { sub: open.instructions } : {})}
                    subLines={2}
                    media
                    {...(waiting ? { value: t("browser.machine.waitingChip") } : {})}
                    chevron
                    onPress={() => use(agent.id, agent.name)}
                  />
                );
              })}
            </GroupedList>
          )}
        </>
      ) : null}
      {m.canManage ? (
        <>
          <GroupedHeader>{t("browser.machine.who")}</GroupedHeader>
          {allowed.length > 0 ? (
            <GroupedList>
              {allowed.map(({ agent, domains }) => (
                <GroupedRow
                  key={agent.id}
                  leading={<AgentFace agentId={agent.id} size={30} live={false} />}
                  label={agent.name}
                  sub={
                    domains?.length
                      ? t("browser.machine.whoOnly", { sites: domains.join(", ") })
                      : t("browser.machine.whoAny")
                  }
                  subLines={2}
                  media
                />
              ))}
            </GroupedList>
          ) : null}
          <GroupedFooter>
            {allowed.length > 0
              ? t("browser.machine.whoHelp")
              : t("common.joinSentences", { a: t("browser.machine.whoNone"), b: t("browser.machine.whoHelp") })}
          </GroupedFooter>
        </>
      ) : null}
    </>
  );
}

/**
 * Apps on the agents' screens (ADR 0062): whether agents can use apps on their own screens here; when not, on Linux
 * the computer's own words on what is missing with the command in them, elsewhere that it takes a Linux computer;
 * or the two switches to turn on. Not on the workspace's own computer.
 */
function DesktopUseSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const use = m.desktopUse;
  if (!use) return null;
  const off = use.available && !(m.access?.tools.desktop && m.access.tools.commands);
  // A Mac or Windows has nothing to install for it: said in the app's words, not the runner's English.
  const linux = m.os === "linux";
  const reason = use.available
    ? null
    : linux
      ? machineReasonText(t, use, "desktop_use_install")
      : t("desktop.use.linuxOnly");
  const command = linux && !use.available ? commandInReason(use.reason) : null;
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("desktop.use.title") }), text: t("desktop.use.description") }}
      >
        {t("desktop.use.title")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="laptop"
          label={!use.available ? t("desktop.use.unavailable") : off ? t("desktop.use.off") : t("desktop.use.ready")}
        />
      </GroupedList>
      {off ? (
        <>
          <GroupedFooter>{t("desktop.use.offHelp")}</GroupedFooter>
          <Gap />
          <CommandBlock command={DESKTOP_TURN_ON} />
        </>
      ) : null}
      {reason ? (
        <>
          <GroupedFooter>{reason}</GroupedFooter>
          {command ? (
            <>
              <Gap />
              <CommandBlock command={command} />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** "Para liberar mais": never a button that grants; granting happens on the computer (its app, or the command). */
function GrantSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  // In system mode the runner's settings are root's (ADR 0057): allowing takes the computer's administrator.
  const system = m.mode === "system";
  const app = allowsInApp(m.os);
  return (
    <>
      <GroupedHeader>{t("machines.access.grantTitle")}</GroupedHeader>
      {m.canManage ? (
        <>
          <GroupedFooter>
            {[
              app
                ? t("machines.access.grantText")
                : system
                  ? t("machines.access.grantTextAdmin")
                  : t("machines.access.grantTextTerminal"),
              app ? t("machines.access.grantTerminal") : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </GroupedFooter>
          <Gap />
          <CommandBlock
            command={grantCommand(m, t("machines.access.pathPlaceholder"), t("machines.access.agentPlaceholder"))}
          />
        </>
      ) : (
        <GroupedFooter>
          {m.pairedBy
            ? t("machines.access.grantOnlyOwner", { name: m.pairedBy.name })
            : t("machines.page.readOnlyNobody")}
        </GroupedFooter>
      )}
    </>
  );
}

/**
 * A folder a computer allows, pushed over its page (the web's folder menu, as a screen): who uses it, each one taken
 * off it on their own, or the folder taken away for everyone. Allowing it again happens only on the computer itself.
 */
export function FolderScreen({ machineId, path }: { machineId: string; path: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const machines = useMachines(useOrgId());
  const m = machines.data?.find((x) => x.id === machineId);
  const nameOf = useAgentName(m);
  const askReduce = useAskReduce(machineId);
  const grant = m?.access?.folders.find((f) => f.path === path);
  const folder = folderName(path);
  return (
    <SettingsPage title={folder}>
      <GroupedFooter>{path}</GroupedFooter>
      {machines.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {grant && m && canReduceAccess(m) ? (
        <>
          <GroupedHeader>{t("machines.access.usedBy", { folder })}</GroupedHeader>
          {grant.agents.length > 0 ? (
            <GroupedList>
              {grant.agents.map((id) => (
                <GroupedRow
                  key={id}
                  leading={<AgentFace agentId={id} size={30} live={false} />}
                  label={nameOf(id)}
                  value={t("machines.access.remove")}
                  onPress={() => askReduce({ kind: "folder", path, agent: { id, name: nameOf(id) } })}
                />
              ))}
            </GroupedList>
          ) : (
            <GroupedFooter>{t("machines.access.nobody")}</GroupedFooter>
          )}
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="x"
              label={t("machines.access.removeAll")}
              danger
              onPress={() => askReduce({ kind: "folder", path }, goBack)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Renomear, pushed over a computer's page: its name (how people and agents see it); "Salvar" saves and goes back. */
export function RenameMachineScreen({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const orgId = useOrgId();
  const machines = useMachines(orgId);
  const action = useMachineAction(orgId);
  const m = machines.data?.find((x) => x.id === machineId);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = name ?? m?.name ?? "";
  const clean = value.trim();
  const ready = Boolean(m) && clean.length > 0 && clean !== m?.name && !action.isPending;
  const save = () => {
    if (!m || !ready) return;
    action.mutate(
      { machineId: m.id, action: "rename", name: clean },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("machines.renamed", { name: clean }), icon: "check" });
          goBack();
        },
        onError: (err) => setError(errorText(t, err)),
      },
    );
  };
  return (
    <SettingsPage
      title={t("machines.renameTitle")}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      locked={action.isPending}
    >
      <GroupedHeader hint={{ name: t("common.about", { label: t("machines.name") }), text: t("machines.nameHelp") }}>
        {t("machines.name")}
      </GroupedHeader>
      <TextArea
        value={value}
        onChangeText={(v) => {
          setName(v);
          setError(null);
        }}
        multiline={false}
        minHeight={50}
        maxLength={80}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={t("machines.name")}
      />
      {error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
  missing: { paddingTop: 40 },
  head: { alignItems: "center", gap: 8, paddingTop: 10, paddingBottom: 6, paddingHorizontal: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, paddingBottom: 2 },
  center: { textAlign: "center" },
  mono: { fontFamily: MONO },
  error: { paddingTop: 8, paddingHorizontal: 16 },
});
