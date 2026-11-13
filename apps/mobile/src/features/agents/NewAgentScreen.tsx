import {
  type AgentProposal,
  ApiError,
  useAgentProposal,
  useAiAccounts,
  useApi,
  useBrainMachines,
  useCatalog,
  useChannels,
  useConnections,
  useCreateAgent,
  useCredentials,
  useCustomServers,
  useDenyAgentProposal,
  useDms,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
  useSkills,
} from "@agenteschat/client";
import { type Level, saveLevels } from "@agenteschat/client/lib/access-levels";
import { draftLevels, draftMailLevels, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { newAgentStart, newAgentStartText } from "@agenteschat/client/lib/agent-setup";
import {
  type BrainPickOption,
  brainPickOptions,
  newPlanAccountOption,
  planAccountOption,
} from "@agenteschat/client/lib/brain-picker";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { defaultPolicy, toMailLevel } from "@agenteschat/client/lib/mail";
import {
  cleanHandle,
  freeHandle,
  handleForName,
  handleProblem,
  PERSONAL_STARTERS,
  type PersonalStarter,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_GROUPS,
  type RoleId,
  savePart,
  takenHandles,
} from "@agenteschat/client/lib/new-agent";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { AUTO, modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { usePreventRemove } from "expo-router";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, ScrollView, type ScrollViewInstance, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  ACT_LINE,
  AgentAvatar,
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  Locked,
  ProviderLogo,
  Sky,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { newAgentAi, pickedAi } from "../ai/logic";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { pickLevel } from "../connectors/pick-level";
import { suggestAgentName } from "../new/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { chooseAction } from "../settings/parts";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic, Tile, tapHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { markArrived } from "./arrival";
import { BrainPickSheet } from "./BrainPickSheet";
import { type FullLook, fullLook } from "./edit";
import { ErrorLine, HandleInput } from "./HandleInput";
import { ImportAgents } from "./ImportAgents";
import { arrivedAgents, landingOf, reportCounts } from "./import";
import { LookList } from "./LookPicker";
import { firstBlockedStep, NEW_AGENT_PHONE_STEPS, type PhoneStep, roleLine, stepBlocked } from "./new-agent";
import { RoleInput } from "./RoleInput";
import { useAgentImport } from "./useAgentImport";

/**
 * "Criar agente" on the phone, the web's steps for a thumb: Papel (the presets, grouped), Quem é
 * (name, @ and look), O que faz (the instructions, prefilled by the role) and Revisar (what it can use
 * and the channels it joins, from the role, and who thinks: the workspace's last setup or Automático,
 * ADR 0094). Budget and who it answers start at the workspace's defaults and change on its page.
 * Created, it opens the direct conversation with it. `initialWhat`
 * (an example in the empty Conversas) starts from scratch with that text. `proposalId` (an agent's
 * proposal card, ADR 0081) starts on Revisar, filled in with the draft, while the proposal is open.
 */
export function NewAgentScreen({
  initialWhat = "",
  proposalId = null,
  channelId = null,
  startImport = false,
}: {
  initialWhat?: string;
  proposalId?: string | null;
  /** A channel's "Criar agente" (its Adicionar sheet): the agent starts in that channel. */
  channelId?: string | null;
  /** Opens on bringing agents from another app (Configurações › Importar e exportar). */
  startImport?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const proposal = useAgentProposal(orgId, proposalId);
  // The draft as it was when it opened: once created here the proposal is closed, and the form stays on.
  const opened = useRef<AgentProposal | null>(null);
  if (proposal.data?.canDecide && opened.current?.messageId !== proposal.data.messageId) opened.current = proposal.data;
  if (proposalId && !opened.current) {
    return (
      <View style={[styles.fill, { backgroundColor: c.grouped }]}>
        <PushedHeader title={t("newAgent.title")} solid={false} grouped />
        <View style={styles.closed}>
          {proposal.isPending ? null : (
            <>
              <Text variant="body" tone="muted">
                {proposal.error instanceof ApiError && proposal.error.status === 403
                  ? t("newAgent.proposalNoAccess")
                  : t("newAgent.proposalClosed")}
              </Text>
              <Button variant="secondary" label={t("newAgent.backToChat")} onPress={() => goBack()} />
            </>
          )}
        </View>
      </View>
    );
  }
  return (
    <NewAgentForm
      initialWhat={initialWhat}
      from={opened.current ?? undefined}
      channelId={channelId}
      startImport={startImport}
    />
  );
}

function NewAgentForm({
  initialWhat,
  from,
  channelId,
  startImport,
}: {
  initialWhat: string;
  from?: AgentProposal;
  channelId: string | null;
  startImport: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const surface = useSurface();
  const orgId = useOrgId();
  const { org } = useOrg();
  const mayImport = can(org, "create_agents");
  // Giving a new agent apps is for who edits any agent: anyone else's starts without them (ADR 0085 §5).
  const managesAgents = can(org, "manage_agents");
  const meId = useMeId();
  const dir = useDirectory();
  const create = useCreateAgent(orgId);
  const openDm = useOpenDm();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const library = useSkills(orgId);
  const scroll = useRef<ScrollViewInstance>(null);
  const lastSetup = useNewAgentSetup(orgId, mayImport);
  const brainMachines = useBrainMachines(orgId);
  const models = useModels();
  const credentials = useCredentials(orgId, can(org, "manage_credentials"));
  const platform = usePlatformKey(orgId);

  const suggested = suggestAgentName(dir.agents.map((a) => a.name));
  const proposed = from?.params.draft;
  const [index, setIndex] = useState(proposed ? NEW_AGENT_PHONE_STEPS.length - 1 : initialWhat ? 1 : 0);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<RoleId | null>(proposed || initialWhat ? "custom" : null);
  // A personal workspace's starting point (one of the right hand's personal agents), on top of "custom" (ADR 0159 §3).
  const [starter, setStarter] = useState<PersonalStarter["id"] | null>(null);
  const personal = isPersonal(org);
  const [roleText, setRoleText] = useState(proposed?.role ?? "");
  const [name, setName] = useState(proposed?.name ?? (initialWhat ? suggested : ""));
  const [handle, setHandle] = useState(proposed?.handle ?? (initialWhat ? handleForName(suggested) : ""));
  const [handleTouched, setHandleTouched] = useState(Boolean(proposed));
  const [look, setLook] = useState<FullLook>(fullLook(proposed?.appearance ?? ROLE_DEFAULTS.custom.look));
  const [instructions, setInstructions] = useState(proposed?.instructions ?? initialWhat);
  // The channel it was asked for stays picked whatever role is chosen (the roles' presets add theirs).
  const asked = channelId ? [channelId] : [];
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set(proposed?.channelIds ?? asked));
  // A proposal's levels are the reviewer's to change in Revisar; otherwise they come with the role.
  const [proposedLevels, setProposedLevels] = useState<Record<string, Level>>(() =>
    proposed && managesAgents ? draftLevels(proposed) : {},
  );
  // My own mailboxes it asked for, at its level (only a mailbox's owner gives an agent access to it), and its routine.
  const [mailLevels, setMailLevels] = useState<Record<string, Level>>(() =>
    proposed && meId ? draftMailLevels(proposed, meId) : {},
  );
  const [withRoutine, setWithRoutine] = useState(Boolean(proposed?.routine));
  // Who thinks (ADR 0094): the workspace's last setup where it can think for an agent of mine, unless a proposal says.
  const keys = credentials.data ?? [];
  const choices = modelChoices(models.data?.models ?? [], keys, platform.data ?? false);
  const usable = usableModels(choices);
  const start = proposed ? null : newAgentStart(lastSetup.data, { ownerIsMe: true, usable, keys });
  const [useLast, setUseLast] = useState(true);
  // Or anything else the agent's page offers ("Quem pensa", the web's model step), from its sheet.
  const aiAccounts = useAiAccounts(orgId, !proposed);
  const held = usePlanHold(orgId, org) !== null;
  const brainOptions = brainPickOptions(t, i18n.language, {
    api: choices,
    machines: brainMachines.data ?? [],
    accounts: aiAccounts.data?.accounts ?? [],
    ownerIsMe: true,
    held,
  });
  const [picked, setPicked] = useState<BrainPickOption | null>(null);
  const [picking, setPicking] = useState(false);
  // "Conectar uma IA" from this step (the same sheet as Settings, for the agents I create): a plan account that wasn't
  // among the choices when it opened is what the agent thinks with, over a pick made before; nothing new keeps the pick.
  const [optionsBefore, setOptionsBefore] = useState<ReadonlySet<string> | null>(null);
  const ownPlan = planAccountOption(brainOptions);
  const connectedHere = optionsBefore ? newPlanAccountOption(brainOptions, optionsBefore) : undefined;
  // No last setup to start from: a plan account of mine that can think for it (one connected before I had an agent).
  const chosen = connectedHere ?? picked ?? (proposed || start ? null : (ownPlan ?? null));
  const thinks = chosen
    ? pickedAi(chosen.pick, aiAccounts.data?.computers)
    : newAgentAi(start && useLast ? start : null);
  const startText = start
    ? newAgentStartText(t, i18n.language, start, {
        models: models.data?.models ?? [],
        machines: brainMachines.data ?? [],
        provider: lastSetup.data?.account?.provider,
      })
    : "";
  const created = useRef(false);
  const denied = useRef(false);
  // Bringing agents from another app, in place of the role cards (the web's create-agent import step).
  const imp = useAgentImport(orgId);
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);
  const [importing, setImporting] = useState(startImport && mayImport && !proposed);
  const deny = useDenyAgentProposal(orgId);
  // The face answers the name (a first-time moment): it looks down at the field while the name is typed and, when the
  // field is left (the keyboard's Next), smiles and hops 4 points on a spring. Transform only, on the UI thread.
  const [naming, setNaming] = useState(false);
  const [cheer, setCheer] = useState(false);
  const reduced = useReducedMotion();
  const hop = useSharedValue(0);
  const hopStyle = useAnimatedStyle(() => ({ transform: [{ translateY: hop.get() }] }));
  const nameDone = () => {
    setNaming(false);
    if (!name.trim()) return;
    setCheer(true);
    if (!reduced) {
      const up = withSpring(-4, { duration: 220, dampingRatio: 0.6 });
      const down = withSpring(0, { duration: 300, dampingRatio: 0.8 });
      hop.set(withSequence(up, down));
    }
    setTimeout(() => setCheer(false), 900);
  };

  const step: PhoneStep = NEW_AGENT_PHONE_STEPS[index] ?? "role";
  const total = NEW_AGENT_PHONE_STEPS.length;
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const levels = useMemo(
    // A proposal's levels (the reviewer's, in Revisar) over the role's; the apps it doesn't name open as any role's.
    () => (managesAgents ? { ...presetLevels(role ?? "custom", items, isPersonal(org)), ...proposedLevels } : {}),
    [proposedLevels, role, items, managesAgents, org],
  );
  const granted = items.filter((i) => (levels[i.id] ?? "none") !== "none");
  const myMail = (proposed?.mail ?? []).filter((m) => m.accountId in mailLevels);
  // Revisar lists what a proposal asked for at any level, so a change can be taken back.
  const listedApps = proposed ? items.filter((i) => i.id in proposedLevels || granted.includes(i)) : granted;
  // Mine, and the ones a proposal names: only where I may put an agent (in it and posting, or managing it).
  const myChannels = useMemo(() => {
    const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
    return (channels.data ?? []).filter(
      (ch) => (ch.isMember || proposed?.channelIds.includes(ch.id)) && !dmIds.has(ch.id) && addsAgentsTo(ch, meId, org),
    );
  }, [channels.data, dms.data, proposed, meId, org]);
  const taken = useMemo(() => takenHandles(dir.agents, [...dir.memberById.values()]), [dir.agents, dir.memberById]);
  const draft = { role, name, handle, taken };
  const shownName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(name.trim() || t("newAgent.defaultName"));
  const handleIssue = handle || tried ? handleProblem(handle, taken) : null;
  const handleText =
    handleIssue === "taken"
      ? t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) })
      : handleIssue === "format"
        ? t("newAgent.errors.handleFormat")
        : handleIssue === "empty"
          ? t("newAgent.errors.handleEmpty")
          : handle
            ? t("newAgent.handleHelp", { handle })
            : t("newAgent.handleEmpty");

  // Leaving with a draft asks first; the header's back leaves the whole flow.
  const dirty = role !== null || name.trim() !== "" || instructions.trim() !== "";
  usePreventRemove(dirty, ({ repeat }) => {
    if (created.current || denied.current) return repeat();
    Alert.alert(t("mobile.newAgent.leaveTitle"), t("mobile.newAgent.leaveText"), [
      { text: t("mobile.newAgent.keepGoing"), style: "cancel" },
      { text: t("newAgent.leave"), style: "destructive", onPress: repeat },
    ]);
  });

  const goTo = (i: number) => {
    setTried(false);
    setIndex(Math.max(0, Math.min(total - 1, i)));
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const pickRole = (id: RoleId) => {
    tapHaptic();
    setRole(id);
    setStarter(null);
    // A new role fills in the rest. The role it already has keeps what was typed, and a proposal keeps its draft.
    if ((id !== role || starter) && !proposed) {
      const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
      setRoleText("");
      setName(agentName);
      setHandle(handleForName(agentName));
      setHandleTouched(false);
      setLook(fullLook(ROLE_DEFAULTS[id].look));
      setInstructions(t(`newAgent.roles.${id}.instructions`));
      setChannelIds(new Set([...asked, ...presetChannels(id, myChannels)]));
    }
    // A tap is the answer: on to the next step, or back to Revisar on a proposal.
    setTimeout(() => goTo(proposed ? total - 1 : 1), 180);
  };
  /** A personal workspace's starting point: from scratch, with its agent's name, look, role and line filled in. */
  const pickStarter = (s: PersonalStarter) => {
    tapHaptic();
    setRole("custom");
    setStarter(s.id);
    if (starter !== s.id && !proposed) {
      setRoleText(t(`teamTemplates.agents.${s.id}.role`));
      setName(s.name);
      setHandle(handleForName(s.name));
      setHandleTouched(false);
      setLook(fullLook(s.look));
      setInstructions(t(`teamTemplates.agents.${s.id}.line`));
      setChannelIds(new Set(asked));
    }
    setTimeout(() => goTo(proposed ? total - 1 : 1), 180);
  };
  const refuse = () => {
    if (!from) return;
    deny.mutate(from.messageId, {
      onSuccess: () => {
        denied.current = true;
        router.back();
      },
      onError: failed,
    });
  };
  const changeName = (value: string) => {
    setName(value);
    if (!handleTouched) setHandle(handleForName(value));
  };

  const submit = async () => {
    const bad = firstBlockedStep(draft);
    if (bad >= 0) {
      goTo(bad);
      setTried(true);
      return;
    }
    setBusy(true);
    try {
      const agent = await create.mutateAsync({
        name: name.trim(),
        handle,
        role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim(),
        instructions,
        model: thinks.model,
        // Its setup checklist suggests from the ready-made role it started from (ADR 0155 §2).
        setup: { role: role && role !== "custom" ? role : null },
        ownerUserId: meId ?? null,
        // A personal workspace's new agent answers its owner only (ADR 0159 §3a): someone who joins later is not
        // answered by every agent made while the person was alone.
        audience: { mode: isPersonal(org) ? "owner" : "everyone", userIds: [] },
        credentialId: thinks.credentialId,
        monthlyBudgetUsd: null,
        appearance: look,
        ...(from ? { proposal: from.messageId } : {}),
        ...(thinks.autonomy ? { autonomy: thinks.autonomy } : {}),
      });
      created.current = true;
      // What the role brings, as the web's last step: its channels, its apps' levels, the default skills. One part
      // at a time, so a refused one doesn't keep the rest (the AI below too) from saving.
      const failures: unknown[] = [];
      const joined = myChannels.filter((ch) => channelIds.has(ch.id));
      if (joined.length > 0)
        await savePart(failures, () =>
          api.agents.setChannels(
            orgId,
            agent.id,
            joined.map((ch) => ({ channelId: ch.id })),
          ),
        );
      const chosen = Object.fromEntries(granted.map((i) => [`connector:${i.id}`, levels[i.id] as Level]));
      if (Object.keys(chosen).length > 0) await savePart(failures, () => saveLevels(api, orgId, agent.id, chosen));
      const list = library.data ?? [];
      if (list.length > 0)
        await savePart(failures, () =>
          api.skills.setForAgent(
            orgId,
            agent.id,
            list.map((s) => ({ skillId: s.id, enabled: s.defaultForNewAgents })),
          ),
        );
      // The AI the server suggests for me: an account of mine on its computer; the workspace's model needs nothing.
      const ai = proposed?.ai;
      if (ai?.kind === "account") {
        await savePart(failures, async () => {
          await api.sandbox.setTarget(orgId, agent.id, ai.machineId);
          await api.agents.setBrain(orgId, agent.id, { brain: ai.brain, account: ai.accountId });
        });
      }
      // Or the last setup's plan, with its model, effort and the rest; on the API, its context window.
      const plan = thinks.plan;
      if (plan) {
        await savePart(failures, async () => {
          await api.sandbox.setTarget(orgId, agent.id, plan.machineId);
          await api.agents.setBrain(orgId, agent.id, plan.input);
        });
      } else if (thinks.contextTokens !== null) {
        await savePart(failures, () =>
          api.agents.setBrain(orgId, agent.id, { brain: "model", contextTokens: thinks.contextTokens }),
        );
      }
      // My own mailboxes at the level chosen here (every send asks), then its routine, now that it is where it reports.
      for (const [accountId, level] of Object.entries(mailLevels)) {
        if (level === "none") continue;
        await savePart(failures, () =>
          api.mail.setAgent(orgId, agent.id, accountId, {
            level: toMailLevel(level),
            canDelete: false,
            policy: defaultPolicy(),
          }),
        );
      }
      if (from && proposed?.routine && withRoutine)
        await savePart(failures, () => api.agents.proposalRoutine(orgId, from.messageId));
      if (failures.length > 0) toast({ title: t("mobile.newAgent.partly"), icon: "x" });
      else {
        successHaptic();
        // Agentes greets it once when it is next on screen (its row comes in, the others look at it).
        markArrived(agent.id);
        // It joined (a personal workspace has no team to join: it is here, ADR 0159), and what it thinks with, under
        // its face: the one note before its conversation opens.
        const thinksLabel = chosen?.title ?? (start && useLast ? startText : t("brain.auto.label"));
        toast({
          title: isPersonal(org)
            ? t("newAgent.createdTitlePersonal", { name: agent.name })
            : t("mobile.agents.created", { name: agent.name }),
          subtitle: t("mobile.agents.thinksWith", { label: thinksLabel }),
          agentId: agent.id,
          // Its profile one tap away while its conversation opens under the toast.
          action: { label: t("mobile.chat.profile"), onPress: () => router.push(`/agent/${agent.id}`) },
        });
      }
      if (from) {
        // From its card: back to that conversation as it was, Connect over it when it has nothing to think with.
        router.back();
        if (ai?.kind === "none" && !held) openConnectAi({ agentId: agent.id });
        return;
      }
      // It exists either way (Criar again would only find its @ taken): on to its conversation. Only a plan the person
      // chose to connect here opens over it; with nothing to think with yet, the conversation's own line says so and
      // connects from there (ADR 0061 §6), so nothing jumps in front of its first message.
      void openDm({ agentId: agent.id }).then(() => {
        // On a billing hold nothing connects before the plan.
        if (held) return;
        if (thinks.connect) openConnectAi({ agentId: agent.id, plan: thinks.connect });
      });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const runImport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const report = await imp.apply();
      if (!report) return;
      const ids = arrivedAgents(report);
      const counts = reportCounts(report, imp.picks.length);
      created.current = true;
      successHaptic();
      const first = report.find((i) => i.kind === "agent" && i.targetId === ids[0]);
      toast({
        title: counts.partial
          ? t("mobile.newAgent.import.partial", counts)
          : ids.length > 0
            ? t("mobile.newAgent.import.arrived", { count: ids.length, name: first?.label ?? "" })
            : t("onboarding.import.report.title"),
        ...(counts.capped > 0 ? { subtitle: t("onboarding.import.report.capped", { count: counts.capped }) } : {}),
        ...(ids.length === 1 ? { agentId: ids[0] } : {}),
      });
      const land = landingOf(ids, { left: left.current });
      if (land?.how === "replace") router.replace(land.href as never);
      else if (land) router.dismissTo(land.href as never);
    } finally {
      setBusy(false);
    }
  };
  const closeImport = () => {
    if (imp.planned) imp.reset();
    else setImporting(false);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const next = () => {
    if (busy) return;
    if (stepBlocked(step, draft)) {
      setTried(true);
      return;
    }
    if (index === total - 1) void submit();
    else goTo(index + 1);
  };

  const head = (title: string, lead?: string) => (
    <View style={styles.head}>
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
      {lead ? (
        <Text variant="small" tone="muted">
          {lead}
        </Text>
      ) : null}
    </View>
  );
  const field = [styles.field, fieldText("body"), { color: c.ink }];
  // The step, said once under the bar ("2 of 4 · Who it is").
  const stepNames: Record<PhoneStep, string> = {
    role: t("newAgent.steps.role.name"),
    identity: t("newAgent.steps.identity.title"),
    instructions: t("mobile.agent.does"),
    review: t("actionCard.agentProposal.review"),
  };
  const roleName = role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim();
  // A level is chosen among the three in the app's picker, as everywhere else on the phone, never cycled by taps.
  const chooseLevel = (title: string, current: string, choose: (level: Level) => void) =>
    void pickLevel(t, title, current).then((level) => {
      if (level) choose(level);
    });

  const views: Record<PhoneStep, () => ReactNode> = {
    role: () => (
      <>
        {head(t("newAgent.steps.role.title"), t("newAgent.steps.role.lead"))}
        <GroupedList>
          <GroupedRow
            leading={<RowTile icon="plus" />}
            label={t("newAgent.roles.custom.name")}
            sub={t("newAgent.roles.custom.desc")}
            subLines={2}
            checked={role === "custom" && !starter}
            onPress={() => pickRole("custom")}
          />
        </GroupedList>
        {role === "custom" && !starter ? (
          <RoleInput value={roleText} onChangeText={setRoleText} placeholder={t("agent.roleHelp")} grouped />
        ) : null}
        {personal ? (
          // One person's agents (ADR 0159 §3): the right hand's personal ones, not a company's roles.
          <>
            <GroupedHeader>{t("newAgent.roleGroups.personal")}</GroupedHeader>
            <GroupedList>
              {PERSONAL_STARTERS.map((s) => (
                <GroupedRow
                  key={s.id}
                  leading={<AgentAvatar agent={fullLook(s.look)} size={36} live={false} />}
                  label={t(`teamTemplates.agents.${s.id}.role`)}
                  sub={roleLine(
                    t(`teamTemplates.agents.${s.id}.line`),
                    t("newAgent.startsAs", { name: s.name }),
                    s.name,
                    i18n.language,
                  )}
                  subLines={2}
                  checked={starter === s.id}
                  onPress={() => pickStarter(s)}
                />
              ))}
            </GroupedList>
          </>
        ) : null}
        {(personal ? [] : ROLE_GROUPS).map((group) => (
          <Fragment key={group.id}>
            <GroupedHeader>{t(`newAgent.roleGroups.${group.id}`)}</GroupedHeader>
            <GroupedList>
              {group.roles.map((id) => {
                const agent = t(`newAgent.roles.${id}.agent`);
                return (
                  <GroupedRow
                    key={id}
                    leading={<AgentAvatar agent={fullLook(ROLE_DEFAULTS[id].look)} size={36} live={false} />}
                    label={t(`newAgent.roles.${id}.name`)}
                    sub={roleLine(
                      t(`newAgent.roles.${id}.desc`),
                      t("newAgent.startsAs", { name: agent }),
                      agent,
                      i18n.language,
                    )}
                    subLines={2}
                    checked={role === id}
                    onPress={() => pickRole(id)}
                  />
                );
              })}
            </GroupedList>
          </Fragment>
        ))}
        {tried && !role ? (
          <View style={styles.foot}>
            <ErrorLine text={t("newAgent.errors.roleRequired")} />
          </View>
        ) : null}
        {mayImport && !proposed ? (
          <>
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow
                leading={<RowTile icon="archive" />}
                label={t("shell.importAgents")}
                sub={t("onboarding.import.lead")}
                subLines={2}
                chevron
                onPress={() => {
                  setImporting(true);
                  scroll.current?.scrollTo({ y: 0, animated: false });
                }}
              />
            </GroupedList>
          </>
        ) : null}
      </>
    ),
    identity: () => (
      <>
        {head(t("mobile.newAgent.identityQuestion"), t("mobile.newAgent.identityLead"))}
        {/* The agent standing in its own sky, as on its page: what the fields below change. Its sky is the step's
            one color; the face is the one on its profile (96, unframed). */}
        <View style={[styles.stage, surface]}>
          <Sky color={look.color} surface="raised" style={StyleSheet.absoluteFill} />
          <Animated.View style={hopStyle}>
            <AgentAvatar
              agent={look}
              size={96}
              name={shownName}
              framed={false}
              {...(naming ? { gaze: "down" as const } : {})}
              {...(cheer ? { expression: "happy" as const } : {})}
            />
          </Animated.View>
        </View>
        <GroupedHeader>{t("newAgent.name")}</GroupedHeader>
        <GroupedList>
          <TextInput
            value={name}
            onChangeText={changeName}
            maxLength={32}
            autoCorrect={false}
            placeholder={t("newAgent.namePlaceholder")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("newAgent.name")}
            style={field}
            onFocus={() => setNaming(true)}
            onBlur={nameDone}
            returnKeyType="next"
          />
        </GroupedList>
        {tried && !name.trim() ? (
          <View style={styles.foot}>
            <ErrorLine text={t("newAgent.errors.nameRequired")} />
          </View>
        ) : naming ? (
          // While the name is typed: only the stage, the name and where its @ comes from. The rest comes back with Next.
          <GroupedFooter>
            {handle ? t("mobile.newAgent.handleFromName", { handle }) : t("mobile.newAgent.handleFromNameEmpty")}
          </GroupedFooter>
        ) : null}
        {naming ? null : (
          <Animated.View entering={reduced ? undefined : REST_IN}>
            <GroupedHeader>{t("newAgent.handle")}</GroupedHeader>
            <GroupedList>
              <HandleInput
                value={handle}
                onChangeText={(v) => {
                  setHandleTouched(true);
                  setHandle(cleanHandle(v));
                }}
                label={t("newAgent.handle")}
                placeholder={t("newAgent.handlePlaceholder")}
                grouped
                ok={Boolean(handle) && !handleIssue}
              />
            </GroupedList>
            {handleIssue ? (
              <View style={styles.foot}>
                <ErrorLine text={handleText} />
              </View>
            ) : (
              // What the @ is for, in one line: how to call it in the chat.
              <GroupedFooter>{handle ? t("mobile.newAgent.handleMention", { handle }) : handleText}</GroupedFooter>
            )}
            <LookList look={look} onChange={setLook} />
          </Animated.View>
        )}
      </>
    ),
    instructions: () => (
      <>
        {head(t("newAgent.steps.instructions.title", g), t("newAgent.steps.instructions.lead"))}
        {/* The list draws the field's surface (radius 14, raised), like the fields around it. */}
        <GroupedList>
          <TextArea
            value={instructions}
            maxLength={50_000}
            onChangeText={setInstructions}
            placeholder={t("newAgent.instructionsPlaceholder")}
            accessibilityLabel={t("newAgent.instructions")}
            minHeight={220}
            scrollEnabled={false}
            style={styles.bare}
          />
        </GroupedList>
        {role && role !== "custom" && instructions !== t(`newAgent.roles.${role}.instructions`) ? (
          <View style={[ACT_LINE.row, styles.restore]}>
            <Text variant="footnote" tone="faint" style={ACT_LINE.text}>
              {t("newAgent.startedFrom", { role: t(`newAgent.roles.${role}.name`) })}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("newAgent.restore")}
              onPress={() => setInstructions(t(`newAgent.roles.${role}.instructions`))}
            />
          </View>
        ) : null}
        {!instructions.trim() ? <GroupedFooter>{t("newAgent.noInstructions", g)}</GroupedFooter> : null}
      </>
    ),
    review: () => (
      <>
        {head(t("actionCard.agentProposal.review"), t("mobile.newAgent.reviewLead"))}
        {/* Who it is, first row: a tap goes back to its name, @ and look. */}
        <GroupedList>
          <GroupedRow
            leading={<AgentAvatar agent={look} size={36} name={shownName} live={false} />}
            label={shownName}
            sub={[`@${handle}`, roleName].filter(Boolean).join(" · ")}
            chevron
            onPress={() => goTo(1)}
          />
        </GroupedList>

        <GroupedHeader>{t("mobile.agent.does")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            label={instructions.trim().split("\n")[0] || t("newAgent.onlyContext")}
            chevron
            onPress={() => goTo(2)}
          />
        </GroupedList>

        {/* A proposal's AI reads "Thinks with …" itself: no header over it. */}
        {proposed ? (
          <>
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow icon="brain" label={suggestedAiText(t, proposed.ai)} labelLines={2} />
            </GroupedList>
          </>
        ) : (
          <>
            <GroupedHeader>{t("mobile.intentAgents.thinks")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                {...(chosen?.mark
                  ? { leading: <ProviderLogo id={chosen.mark} size="sm" /> }
                  : { icon: "key" as const })}
                label={
                  chosen
                    ? chosen.title
                    : start && useLast
                      ? t("newAgent.lastSetup", { setup: startText })
                      : t("brain.auto.label")
                }
                labelLines={2}
                chevron
                onPress={() =>
                  start
                    ? chooseAction(
                        t("brain.title"),
                        [
                          {
                            label: startText,
                            onPress: () => {
                              setPicked(null);
                              setUseLast(true);
                            },
                          },
                          { label: t("newAgent.brainPick.other"), onPress: () => setPicking(true) },
                        ],
                        t("common.cancel"),
                      )
                    : setPicking(true)
                }
              />
              {held ? null : (
                <GroupedRow
                  icon="plus"
                  label={t("aiAccounts.page.connect")}
                  onPress={() => {
                    setOptionsBefore(new Set(brainOptions.map((o) => o.value)));
                    openConnectAi({ forNew: "1" });
                  }}
                />
              )}
            </GroupedList>
            {picked?.pick.kind === "connect" && picked.description ? (
              <GroupedFooter>{picked.description}</GroupedFooter>
            ) : !held && !thinks.plan ? (
              // On a key or the workspace's model: the plan is the other way, said once.
              <GroupedFooter>{t("mobile.newAgent.planHint", g)}</GroupedFooter>
            ) : null}
          </>
        )}
        <BrainPickSheet
          open={picking}
          onClose={() => setPicking(false)}
          options={brainOptions}
          value={chosen?.value ?? (start && useLast ? undefined : AUTO)}
          onPick={(o) => {
            setPicked(o);
            setUseLast(false);
            setOptionsBefore(null);
          }}
        />

        <GroupedHeader>{t("newAgent.preview.uses")}</GroupedHeader>
        <GroupedList>
          {listedApps.map((i) => {
            const level = levels[i.id] ?? "none";
            const app = itemName(t, i);
            return (
              <GroupedRow
                key={i.id}
                leading={<ConnectorIcon def={i.def} image={i.image} label={app} size={32} />}
                label={app}
                value={
                  proposed
                    ? t(`access.level.${level}`)
                    : t(`mobile.intentAgents.uses.level.${level === "write" ? "write" : "read"}`)
                }
                {...(proposed
                  ? {
                      // Chosen in place (the app's picker), not on a screen: the value's up-down mark.
                      menu: true,
                      onPress: () => chooseLevel(app, level, (l) => setProposedLevels((p) => ({ ...p, [i.id]: l }))),
                    }
                  : {})}
              />
            );
          })}
          {myMail.map((box) => (
            <GroupedRow
              key={box.accountId}
              icon="mail"
              label={box.address}
              value={t(`access.level.${mailLevels[box.accountId] ?? "none"}`)}
              menu
              onPress={() =>
                chooseLevel(box.address, mailLevels[box.accountId] ?? "none", (l) =>
                  setMailLevels((p) => ({ ...p, [box.accountId]: l })),
                )
              }
            />
          ))}
          {listedApps.length + myMail.length === 0 ? (
            <GroupedRow
              label={t("newAgent.preview.onlyTalks")}
              faint
              {...(managesAgents
                ? {}
                : {
                    hint: {
                      name: t("common.about", { label: t("newAgent.preview.uses") }),
                      text: t("newAgent.accessAdmins"),
                    },
                  })}
            />
          ) : null}
        </GroupedList>
        <GroupedFooter>
          {proposed && listedApps.length + myMail.length > 0
            ? t("common.joinSentences", { a: t("mobile.settings.access.how"), b: t("newAgent.approvalsNote") })
            : t("newAgent.approvalsNote")}
        </GroupedFooter>

        {proposed?.routine ? (
          <>
            <GroupedHeader>{t("newAgent.routine")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={`${proposed.routine.name} · ${proposedRoutineWhen(t, i18n.language, proposed.routine)}`}
                labelLines={2}
                toggle={withRoutine}
                onPress={() => setWithRoutine((on) => !on)}
              />
            </GroupedList>
            <GroupedFooter>{proposed.routine.prompt}</GroupedFooter>
          </>
        ) : null}

        <GroupedHeader>{t("newAgent.channels")}</GroupedHeader>
        <GroupedList>
          {myChannels.map((ch) => (
            <GroupedRow
              key={ch.id}
              label={`#${ch.name}`}
              toggle={channelIds.has(ch.id)}
              onPress={() =>
                setChannelIds((prev) => {
                  const nextSet = new Set(prev);
                  if (nextSet.has(ch.id)) nextSet.delete(ch.id);
                  else nextSet.add(ch.id);
                  return nextSet;
                })
              }
            />
          ))}
        </GroupedList>
        <GroupedFooter>{myChannels.length > 0 ? t("newAgent.channelsHelp") : t("newAgent.noChannels")}</GroupedFooter>
        {from ? (
          <View style={styles.refuse}>
            <Button
              variant="secondary"
              label={t("approval.refuse")}
              disabled={busy || deny.isPending}
              onPress={refuse}
            />
          </View>
        ) : null}
      </>
    ),
  };

  const backs = !importing && index > 0;
  const goes = !importing && (step !== "role" || role !== null);
  // Nothing to press yet on the first step (a tap on a role goes on by itself): no bar at all.
  const footer = importing || backs || goes;

  return (
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("newAgent.title")} solid={false} grouped />
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.body, footer ? null : { paddingBottom: 32 + insets.bottom }]}
        >
          {importing ? (
            <>
              {head(t("shell.importAgents"), t("onboarding.import.lead"))}
              <View style={styles.stack}>
                <ImportAgents imp={imp} orgId={orgId} />
              </View>
            </>
          ) : (
            <>
              <StepBar index={index} total={total} name={stepNames[step]} />
              <Locked when={busy}>{views[step]()}</Locked>
            </>
          )}
        </ScrollView>
        {footer ? (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            {importing ? (
              <>
                <Button variant="text" label={t("common.back")} disabled={busy} onPress={closeImport} />
                {imp.planned && imp.picks.length > 0 ? (
                  <View style={styles.fill}>
                    <Button
                      variant="primary"
                      wide
                      label={t("onboarding.import.go", { count: imp.picks.length })}
                      loading={busy}
                      disabled={busy}
                      onPress={() => void runImport()}
                    />
                  </View>
                ) : null}
              </>
            ) : null}
            {backs ? (
              // Back is a word; Continue is the step's one primary.
              <Button variant="text" label={t("common.back")} disabled={busy} onPress={() => goTo(index - 1)} />
            ) : null}
            {goes ? (
              <View style={styles.fill}>
                <Button
                  variant="primary"
                  wide
                  label={
                    index === total - 1
                      ? t("newAgent.create", { name: name.trim() || shownName })
                      : t("common.continue")
                  }
                  loading={busy}
                  onPress={next}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

/** Where the person is, said once under the bar: a thin bar per step, then "2 of 4 · Who it is". */
function StepBar({ index, total, name }: { index: number; total: number; name: string }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.steps}>
      <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {Array.from({ length: total }, (_, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: one bar per step, in order
            key={i}
            style={[styles.bar, { backgroundColor: i <= index ? c.ink : c.line2 }]}
          />
        ))}
      </View>
      <Text variant="label" style={styles.stepName}>
        {`${t("mobile.choices.step", { step: index + 1, total })} · ${name}`}
      </Text>
    </View>
  );
}

/**
 * A row's tile as big as the roles' faces, so the text of every list on the step starts at the same place: the app's
 * own `Tile` (its corners a third of its side).
 */
function RowTile({ icon }: { icon: IconName }) {
  return <Tile icon={icon} size={36} />;
}

/** The @ field and the look list come back under the name once it is done. */
const REST_IN = FadeIn.duration(200);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  closed: { paddingHorizontal: 16, gap: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  steps: { paddingTop: 4 },
  bars: { flexDirection: "row", gap: 6 },
  bar: { flex: 1, height: 3, borderRadius: 999 },
  stepName: { paddingTop: 8, paddingHorizontal: 4 },
  head: { gap: 2, paddingHorizontal: 4, paddingTop: 10, paddingBottom: 16 },
  stack: { gap: 8 },
  gap: { height: 24 },
  foot: { paddingTop: 7, paddingHorizontal: 16 },
  stage: {
    height: 150,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 12,
  },
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
  bare: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  restore: { alignItems: "center", columnGap: 16, rowGap: 8, paddingTop: 7, paddingLeft: 16 },
  refuse: { marginTop: 24 },
  // Back as a word at the left, 16 from the primary that takes the rest.
  footer: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingTop: 12 },
});
