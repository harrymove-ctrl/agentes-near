import type { Agent, AgentAudience, AgentProposal } from "@agenteschat/client";
import {
  ApiError,
  useAgentProposal,
  useAgents,
  useAiAccounts,
  useBrainMachines,
  useChannels,
  useCreateAgent,
  useCredentials,
  useDenyAgentProposal,
  useDms,
  useMailAccounts,
  useMembers,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
  useRoles,
  useSettings,
  useSkills,
} from "@agenteschat/client";
import { LEVELS, type Level, saveLevels, sharedLevel } from "@agenteschat/client/lib/access-levels";
import { draftLevels, draftMailLevels } from "@agenteschat/client/lib/action-cards";
import {
  autonomyName,
  autonomyWords,
  DEFAULT_AUTONOMY,
  type NewAgentStart,
  newAgentStart,
  newAgentStartText,
} from "@agenteschat/client/lib/agent-setup";
import { thinksWith } from "@agenteschat/client/lib/brain";
import {
  type BrainPickOption,
  brainPickInput,
  brainPickOptions,
  brainPickValue,
  needsOwnSignIn,
  newPlanAccountOption,
  planAccountOption,
} from "@agenteschat/client/lib/brain-picker";
import { type ConnectedItem, itemName } from "@agenteschat/client/lib/connected";
import { errorText as failureText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { choiceOf, defaultPolicy, MAIL_ACTIONS, toMailLevel } from "@agenteschat/client/lib/mail";
import { type PlanChoice as AiPlan, planOfKind } from "@agenteschat/client/lib/no-ai";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { keeperKey } from "@agenteschat/client/lib/personal-view";
import { AUTO, apiProviderOf, isAuto, modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { scopeText } from "@agenteschat/client/lib/scopes";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AffixInput,
  type AgentAppearance,
  type AgentColor,
  Button,
  Card,
  CheckboxPill,
  colorKey,
  EmptyState,
  type Expression,
  Field,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Kbd,
  Locked,
  Logo,
  modKey,
  ProviderLogo,
  prefersReducedMotion,
  randomAppearance,
  Segmented,
  SettingNote,
  SettingRow,
  Spinner,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { LevelRow, useConnectedById } from "@/components/AccessLevels";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  BrainPickSelect,
  BudgetField,
  DEFAULT_KEY,
  InstructionTips,
  KeySelect,
  keyOptions,
  LookPicker,
  NO_OWNER,
  OwnerSelect,
  OwnerValue,
  type PlanChoice,
  usd,
} from "@/components/AgentFields";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { ImportFlow, useImportFlow } from "@/components/ImportFlow";
import { MailIcon } from "@/components/MailConnect";
import { useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SkillPicker } from "@/components/Skills";
import { AgentBornSky, AgentPreviewSky, OnboardingHorizon } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { useFlowExit } from "@/hooks/useFlowExit";
import { useKeeperName, usePersonalView } from "@/hooks/usePersonalView";
import {
  BLANK_LOOK,
  cleanHandle,
  type DraftCheck,
  type DraftError,
  firstInvalidStep,
  freeHandle,
  handleForName,
  handleProblem,
  NEW_AGENT_STEPS,
  type NewAgentStep,
  PERSONAL_SKIPPED_STEPS,
  PERSONAL_STARTERS,
  type PersonalStarter,
  presetChannels,
  presetLevels,
  ROLE_GROUPS,
  ROLE_PRESETS,
  type RoleGroupId,
  type RoleId,
  readBudget,
  savePart,
  stepAfter,
  stepErrors,
  takenHandles,
} from "@/lib/new-agent";
import { proposedRoutineWhen } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import "./new-agent.css";

/** The icon next to each group of roles on the first step. */
const GROUP_ICON: Record<RoleGroupId, IconName> = { tech: "code", customers: "members", operations: "layers" };

/** How long the preview keeps writing after a keystroke. */
const TYPING_MS = 700;

/** The preview agent's mood: dash eyes while you type, a passing face when something lands (none with reduced motion). */
function useDraftMood() {
  const [typing, setTyping] = useState(false);
  const [face, setFace] = useState<Expression | undefined>(undefined);
  const timers = useRef<{ typing?: ReturnType<typeof setTimeout>; face?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.typing);
      clearTimeout(t.face);
    };
  }, []);
  return {
    typing,
    face,
    onTyping: () => {
      if (prefersReducedMotion()) return;
      setTyping(true);
      clearTimeout(timers.current.typing);
      timers.current.typing = setTimeout(() => setTyping(false), TYPING_MS);
    },
    react: (expression: Expression, ms = 1200) => {
      if (prefersReducedMotion()) return;
      setTyping(false);
      setFace(expression);
      clearTimeout(timers.current.face);
      timers.current.face = setTimeout(() => setFace(undefined), ms);
    },
  };
}

interface Created {
  agent: Agent;
  look: Required<AgentAppearance>;
  channels: { id: string; name: string }[];
}

/** No step passed over (a team's workspace). */
const NO_SKIP: readonly NewAgentStep[] = [];

/**
 * "Criar agente": the steps on a rail, a live preview of the agent on the right. With `proposalId` (an agent's
 * proposal card, ADR 0081) it opens filled in with the draft, on its last step, while the proposal is open. With
 * `onClose` it is the card's review, in a dialog over the conversation: creating, saying no or leaving closes it.
 */
export function NewAgentPage({
  proposalId = null,
  channelId = null,
  onClose,
}: {
  proposalId?: string | null;
  /** A channel's "Criar agente" (its Adicionar dialog): the agent starts in that channel. */
  channelId?: string | null;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const proposal = useAgentProposal(org.id, proposalId);
  const exit = useFlowExit(org.id);
  // The draft as it was when it opened: once created here the proposal is closed, and the flow stays on.
  const opened = useRef<AgentProposal | null>(null);
  if (proposal.data?.canDecide && opened.current?.messageId !== proposal.data.messageId) opened.current = proposal.data;
  const from = opened.current?.messageId === proposalId ? opened.current : null;
  const allowed = can(org, "create_agents");
  const closed = proposalId !== null && !from;
  const keeper = useKeeperName();
  if (!allowed || closed) {
    return (
      <main className="shell__main">
        <div className="page page--narrow">
          <header className="page__header">
            <h1 className="page-title">{t("newAgent.title")}</h1>
          </header>
          {!allowed ? (
            <EmptyState icon="agent">
              {t(keeperKey(org, keeper, "newAgent.adminsOnly"), { org: org.name, keeper })}
            </EmptyState>
          ) : proposal.isPending ? (
            <Spinner />
          ) : (
            <EmptyState
              icon="agent"
              actions={
                onClose ? (
                  <Button onClick={onClose}>{t("newAgent.backToChat")}</Button>
                ) : (
                  <Button asChild>
                    {proposal.data ? (
                      <Link
                        to="/org/$orgId/c/$channelId"
                        params={{ orgId: org.id, channelId: proposal.data.channelId }}
                      >
                        {t("newAgent.backToChat")}
                      </Link>
                    ) : (
                      <a {...exit}>{t("newAgent.backToChat")}</a>
                    )}
                  </Button>
                )
              }
            >
              {proposal.error instanceof ApiError && proposal.error.status === 403
                ? t("newAgent.proposalNoAccess")
                : t("newAgent.proposalClosed")}
            </EmptyState>
          )}
        </div>
      </main>
    );
  }
  return from ? (
    <NewAgentFlow key={from.messageId} from={from} onClose={onClose} />
  ) : (
    <NewAgentFlow channelId={channelId} />
  );
}

function NewAgentFlow({
  from,
  channelId = null,
  onClose,
}: {
  from?: AgentProposal;
  channelId?: string | null;
  onClose?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const api = useApi();
  const members = useMembers(org.id);
  const roleList = useRoles(org.id);
  const agents = useAgents(org.id);
  const models = useModels();
  const credentials = useCredentials(org.id);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const platform = usePlatformKey(org.id);
  const brainMachines = useBrainMachines(org.id);
  const lastSetup = useNewAgentSetup(org.id);
  const aiAccounts = useAiAccounts(org.id);
  const connect = useConnectAi();
  const toast = useToast();
  const settings = useSettings(org.id);
  const library = useSkills(org.id);
  const create = useCreateAgent(org.id);
  const deny = useDenyAgentProposal(org.id);
  const connected = useConnectedById();
  const connectedList = useMemo(() => [...connected.values()], [connected]);
  const mail = useMailAccounts(org.id);
  // Mailboxes (ADR 0038) start without access: email is always granted on purpose.
  // Only my own: only who connected a mailbox gives an agent access to it (ADR 0038).
  const mailboxes = useMemo(
    () => (mail.data ?? []).filter((a) => a.status === "active" && a.ownerUserId === me.user.id),
    [mail.data, me.user.id],
  );
  const navigate = useNavigate();
  const exit = useFlowExit(org.id);
  const mood = useDraftMood();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery("(max-width: 820px)");
  // Who edits any agent picks its owner and gives it apps and mailboxes. Anyone else makes their own agent, which
  // starts without access (the server's rule, ADR 0085 §5).
  const managesAgents = can(org, "manage_agents");

  // An agent's proposal starts on the last step, filled in: its role as written, its look, levels and channels.
  const draft = from?.params.draft;
  const review = NEW_AGENT_STEPS.length - 1;
  // Navigation
  const [index, setIndex] = useState(draft ? review : 0);
  const [reached, setReached] = useState(draft ? review : 0);
  const [tried, setTried] = useState<Set<NewAgentStep>>(new Set());
  const [created, setCreated] = useState<Created | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Bringing agents from another app, in place of the role cards (the same flow as Configurações → Importar).
  const [importing, setImporting] = useState(false);
  const importFlow = useImportFlow(org.id);
  // The draft
  const [role, setRole] = useState<RoleId | null>(draft ? "custom" : null);
  // A personal workspace's starting point (one of its template agents), on top of "custom" (ADR 0159 §3).
  const [starter, setStarter] = useState<PersonalStarter["id"] | null>(null);
  const [roleText, setRoleText] = useState(draft?.role ?? "");
  const [name, setName] = useState(draft?.name ?? "");
  const [handle, setHandle] = useState(draft?.handle ?? "");
  const [handleTouched, setHandleTouched] = useState(Boolean(draft));
  const [look, setLook] = useState<Required<AgentAppearance>>(
    (draft?.appearance as Required<AgentAppearance> | null) ?? BLANK_LOOK,
  );
  const [instructions, setInstructions] = useState(draft?.instructions ?? "");
  const [levels, setLevels] = useState<Record<string, Level>>(draft && managesAgents ? draftLevels(draft) : {});
  // A proposal's own mailboxes of mine come at its level: only a mailbox's owner gives an agent access to it.
  const [mailLevels, setMailLevels] = useState<Record<string, Level>>(draft ? draftMailLevels(draft, me.user.id) : {});
  // The routine a proposal came with: made once the agent is where it reports.
  const [withRoutine, setWithRoutine] = useState(Boolean(draft?.routine));
  const [skillIds, setSkillIds] = useState<Set<string> | null>(null);
  // The channel it was asked for stays picked whatever role is chosen (the roles' presets add theirs).
  const asked = channelId ? [channelId] : [];
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set(draft?.channelIds ?? asked));
  const [owner, setOwner] = useState(me.user.id);
  // A personal workspace's new agent answers only its owner until they say otherwise (ADR 0159), as the server makes
  // its agents; a team's answers everyone.
  // A personal workspace's agent starts with every app at write, custom ones too (ADR 0159 §3a).
  const personal = isPersonal(org);
  const audienceAtFirst = (): AgentAudience => ({ mode: personal ? "owner" : "everyone", userIds: [] });
  const [audience, setAudience] = useState<AgentAudience>(audienceAtFirst);
  // Alone in a personal workspace there is nobody else to own it or talk to it: its owner and who talks to it leave
  // the screen while they hold that default (ADR 0159). Its page's Settings still has both.
  const { solo } = usePersonalView();
  const keeper = useKeeperName();
  // "Automático" for every new agent: each task gets its model and effort; a fixed model is one click away.
  const [model, setModel] = useState<string>(AUTO);
  // Or a plan (Claude Code, Codex) on a computer: saved as its "Quem pensa" once the agent exists. A proposal
  // starts on the account the server suggests for this person, if any.
  const [plan, setPlan] = useState<PlanChoice | null>(
    draft?.ai.kind === "account"
      ? { kind: draft.ai.brain, machineId: draft.ai.machineId, accountId: draft.ai.accountId, label: draft.ai.label }
      : null,
  );
  // Or a plan with nothing to think with yet (a coding plan's key): made on Automático, Connect opens on it after.
  const [connectPlan, setConnectPlan] = useState<AiPlan | null>(null);
  const [key, setKey] = useState(DEFAULT_KEY);
  // Empty = the workspace default budget (every agent has one).
  const [budget, setBudget] = useState("");

  const step = NEW_AGENT_STEPS[index] ?? "role";
  const total = NEW_AGENT_STEPS.length;
  // A personal workspace passes over the technical steps, filled in; Revisar still opens them (ADR 0159 §3).
  const skipped = personal ? PERSONAL_SKIPPED_STEPS : NO_SKIP;
  const walked = NEW_AGENT_STEPS.filter((s) => !skipped.includes(s));
  const dmChannels = useMemo(() => new Set((dms.data ?? []).map((d) => d.channelId)), [dms.data]);
  // Mine, and the ones a proposal names: only where I may put an agent (in it and posting, or managing it).
  const myChannels = useMemo(
    () =>
      (channels.data ?? []).filter(
        (c) =>
          (c.isMember || draft?.channelIds.includes(c.id)) && !dmChannels.has(c.id) && addsAgentsTo(c, me.user.id, org),
      ),
    [channels.data, dmChannels, draft, me.user.id, org],
  );
  const choices = useMemo(
    () => modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
    [models.data, credentials.data, platform.data],
  );
  const usable = useMemo(() => usableModels(choices), [choices]);
  const held = usePlanHold() !== null;
  // "Quem pensa": what the agent's page offers, every plan on every computer that runs it, in one list.
  const brainOptions = useMemo(
    () =>
      brainPickOptions(t, locale, {
        api: choices,
        machines: brainMachines.data ?? [],
        accounts: aiAccounts.data?.accounts ?? [],
        ownerIsMe: owner === me.user.id,
        held,
      }),
    [t, locale, choices, brainMachines.data, aiAccounts.data, owner, me.user.id, held],
  );
  const taken = useMemo(() => takenHandles(agents.data ?? [], members.data ?? []), [agents.data, members.data]);

  // What it starts thinking with (ADR 0094): the last setup saved or used on other agents, where it can think for it.
  const startOf = (ownerId: string | null): NewAgentStart | null =>
    from
      ? null
      : newAgentStart(lastSetup.data, {
          ownerIsMe: ownerId === me.user.id,
          admin: can(org, "manage_agents"),
          usable,
          keys: credentials.data ?? [],
        });
  const startWith = (start: NewAgentStart | null) => {
    const api = start?.brain === "model" ? start : null;
    setModel(api?.model ?? AUTO);
    setKey(api?.key ?? DEFAULT_KEY);
    setConnectPlan(null);
    setPlan(
      start && start.brain !== "model"
        ? {
            kind: start.brain,
            machineId: start.machineId,
            ...(start.account ? { accountId: start.account.id, label: start.account.label } : {}),
            model: start.input.model ?? AUTO,
          }
        : null,
    );
  };
  // Until the person picks what it thinks with, it follows whose it is.
  const [aiPicked, setAiPicked] = useState(Boolean(from));
  // "Levar a autonomia" off: the last setup's AI with the default Autonomia.
  const [withAutonomy, setWithAutonomy] = useState(true);
  const startsReady = lastSetup.isFetched && models.isFetched && credentials.isFetched && platform.isFetched;
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when what it starts with is known
  useEffect(() => {
    if (started.current || !startsReady || aiPicked) return;
    started.current = true;
    startWith(startOf(me.user.id));
  }, [startsReady]);

  // Defaults once the data arrives: the skills on for new agents, the levels.
  useEffect(() => {
    if (library.data && skillIds === null)
      setSkillIds(new Set(library.data.filter((s) => s.defaultForNewAgents).map((s) => s.id)));
  }, [library.data, skillIds]);
  useEffect(() => {
    if (!managesAgents) return;
    setLevels((prev) => {
      const missing = connectedList.filter((i) => prev[i.id] === undefined);
      if (missing.length === 0) return prev;
      return { ...prev, ...presetLevels(role ?? "custom", missing, personal) };
    });
  }, [connectedList, role, managesAgents, personal]);

  const ownerId = owner === NO_OWNER ? null : owner;
  // Alone, both are the person's and leave the screen while they hold that: mine, answering only me.
  const ownerHidden = solo && ownerId === me.user.id;
  const audienceHidden = ownerHidden && audience.mode === "owner";
  const ownerMember = (members.data ?? []).find((m) => m.userId === ownerId);
  const ownerFirst = ownerMember?.name.split(/\s+/)[0] ?? null;
  const displayName = name.trim() || t("newAgent.defaultName");
  const previewName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(displayName);
  const rolePreset = role ? ROLE_PRESETS[role] : null;
  const roleName = role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText || null;
  // With nothing to think with yet, the agent is created all the same (ADR 0061 §6), and Connect opens for it after.
  const connectAfter = plan === null && connectPlan === null && usable.size === 0;
  // "Conectar uma IA" from the model step: the same dialog as Settings › Contas de IA, for the agent being made when
  // it is mine (a plan signs in for the agents I create), else the workspace's key (admins). A plan account that
  // wasn't in "Quem pensa" when it opened is what the agent thinks with; closing it with nothing new keeps the pick.
  const [optionsBefore, setOptionsBefore] = useState<ReadonlySet<string> | null>(null);
  const connectsHere = connect && !held && (ownerId === me.user.id || can(org, "manage_credentials"));
  const connectHere = () => {
    if (!connect) return;
    setOptionsBefore(ownerId === me.user.id ? new Set(brainOptions.map((o) => o.value)) : null);
    connect.open(ownerId === me.user.id ? { forNewAgent: true } : { intent: "api_key" });
  };
  const connectedHere = optionsBefore ? newPlanAccountOption(brainOptions, optionsBefore) : undefined;
  // A plan account of mine that can think for it (one connected in place from the model step, or before I had any
  // agent), with nothing else to think with or no last setup to start from: the agent thinks with it. A default, not
  // a pick: another owner drops it.
  const ownPlan =
    connectedHere ??
    (connectAfter || (!aiPicked && plan === null && connectPlan === null && startOf(me.user.id) === null)
      ? planAccountOption(brainOptions)
      : undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once an account shows up, after what it starts with
  useEffect(() => {
    const p = ownPlan?.pick;
    if (!startsReady || !started.current || !p || !("accountId" in p) || !p.accountId) return;
    setModel(AUTO);
    setPlan({ kind: p.kind, machineId: p.machineId, accountId: p.accountId, label: p.account, model: AUTO });
  }, [ownPlan?.value, startsReady]);
  const check: DraftCheck = {
    role,
    name,
    handle,
    taken,
    ownerUserId: ownerId,
    audience,
    budget,
    modelOk:
      plan !== null || connectPlan !== null || connectAfter || (isAuto(model) ? usable.size > 0 : usable.has(model)),
  };
  const errors = tried.has(step) ? stepErrors(step, check) : [];
  const errorOf = (field: DraftError["field"]) => errors.find((e) => e.field === field);
  // A taken or malformed @ shows while typing; a missing one only after trying to go on.
  const liveHandle = handle ? handleProblem(handle, taken) : null;
  const handleError = errorOf("handle") ?? (liveHandle ? { field: "handle" as const, code: liveHandle } : undefined);
  const errorText = (e: DraftError): string => {
    if (e.field === "role") return t("newAgent.errors.roleRequired");
    if (e.field === "name") return t("newAgent.errors.nameRequired");
    if (e.field === "handle") {
      if (e.code === "taken")
        return t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) });
      return e.code === "empty" ? t("newAgent.errors.handleEmpty") : t("newAgent.errors.handleFormat");
    }
    if (e.field === "audience")
      return e.code === "noOwner" ? t("audience.modeText.noOwner") : t("audience.pickSomeone");
    if (e.field === "budget") return t("newAgent.budgetInvalid");
    return t("newAgent.errors.modelUnavailable");
  };
  const { amount, invalid: budgetInvalid } = readBudget(budget);
  const defaultBudget = settings.data?.defaultAgentBudgetUsd;
  const budgetShown = amount ?? defaultBudget;
  const start = startOf(ownerId);
  // Still on what it started with: said on the model step, saved with all of it.
  const onStart = start
    ? start.brain === "model"
      ? !plan && model === start.model
      : plan?.kind === start.brain &&
        plan.machineId === start.machineId &&
        plan.accountId === start.account?.id &&
        (plan.model ?? AUTO) === (start.input.model ?? AUTO)
    : false;
  const autonomy = onStart && withAutonomy ? start?.autonomy : undefined;
  // Its Autonomia has a switch of its own under it.
  const startLine =
    start && onStart
      ? newAgentStartText(
          t,
          locale,
          { ...start, autonomy: undefined },
          {
            models: models.data?.models ?? [],
            machines: brainMachines.data ?? [],
            provider: lastSetup.data?.account?.provider,
          },
        )
      : null;
  const modelInfo = (models.data?.models ?? []).find((m) => m.id === model);
  const brainValue = brainPickValue(
    brainOptions,
    connectPlan ? { kind: "connect", choice: connectPlan } : (plan ?? { kind: "model", model }),
  );
  const brainChosen = brainOptions.find((o) => o.value === brainValue);
  const modelLabel = connectPlan
    ? thinksWith(t, connectPlan, null)
    : plan
      ? (brainChosen?.title ?? [t(`brain.card.${plan.kind}`), plan.label].filter(Boolean).join(" · "))
      : connectAfter
        ? t("actionCard.agentProposal.aiNone")
        : isAuto(model)
          ? t("brain.auto.label")
          : (modelInfo?.label ?? model);
  const apiProvider = apiProviderOf(model, models.data?.models ?? []);
  const keys = keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null, apiProvider);
  // The key's maker: the one picked, else the workspace's default key, else the model's.
  const keyProvider =
    (credentials.data ?? []).find((c) => c.id === (key === DEFAULT_KEY ? settings.data?.defaultCredentialId : key))
      ?.provider ?? apiProvider;
  const keyLabel = keys.find((k) => k.value === key)?.label ?? t("newAgent.defaultKey");
  const granted = connectedList.filter((i) => (levels[i.id] ?? "none") !== "none");
  const grantedMail = mailboxes.filter((a) => (mailLevels[a.id] ?? "none") !== "none");
  const mailAsks = MAIL_ACTIONS.approval.map((a) => t(`mail.action.${a}.name`));
  const skills = (library.data ?? []).filter((s) => skillIds?.has(s.id));
  const joined = myChannels.filter((c) => channelIds.has(c.id));
  const asksOf = (item: ConnectedItem) =>
    (item.def?.scopes ?? []).filter((s) => s.sensitive).map((s) => scopeText(t, s).label);

  const scrollTop = () => {
    try {
      root.current?.scrollTo?.({ top: 0 });
    } catch {
      // happy-dom without scrolling.
    }
  };
  const goTo = (i: number) => {
    const next = Math.max(0, Math.min(total - 1, i));
    setIndex(next);
    setReached((r) => Math.max(r, next));
    setPreviewOpen(false);
    setImporting(false);
    scrollTop();
  };
  // Moving between steps puts the focus on the new step's title (not on the first render).
  const moved = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on step change only
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [index, created, importing]);

  const fail = (s: NewAgentStep) => {
    setTried((prev) => new Set(prev).add(s));
    mood.react("surprised", 1100);
  };
  const submit = async () => {
    const bad = firstInvalidStep(check);
    if (bad >= 0) {
      const s = NEW_AGENT_STEPS[bad] ?? "role";
      fail(s);
      goTo(bad);
      return;
    }
    const agent = await create.mutateAsync({
      name: name.trim(),
      handle,
      role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim(),
      instructions,
      model,
      // Its setup checklist suggests from the ready-made role it started from (ADR 0155 §2).
      setup: { role: role && role !== "custom" ? role : null },
      ownerUserId: ownerId,
      audience: {
        mode: audience.mode,
        userIds: audience.mode === "people" ? audience.userIds : [],
        roleIds: audience.mode === "people" ? (audience.roleIds ?? []) : [],
        consultable: audience.consultable ?? true,
      },
      credentialId: key !== DEFAULT_KEY ? key : null,
      monthlyBudgetUsd: amount,
      appearance: look,
      ...(from ? { proposal: from.messageId } : {}),
      ...(autonomy ? { autonomy } : {}),
    });
    // A plan thinks on its computer: the agent goes there, then thinks with it (an automatic model stays automatic).
    // The agent exists either way: if the plan can't be saved now it stays on the API, and its page says so.
    let signIn = false;
    if (plan) {
      try {
        await api.sandbox.setTarget(org.id, agent.id, plan.machineId);
        await api.agents.setBrain(
          org.id,
          agent.id,
          start && start.brain !== "model" && onStart ? start.input : brainPickInput(plan),
        );
        // Saved with no account, it thinks with that computer's own sign-in, which thinks only for agents of whoever
        // connected it, where that CLI is signed in (never on the workspace's computer). Else, for an agent of the
        // person's own, its plan's sign-in opens once it's created: only the owner signs a plan in for it.
        signIn = ownerId === me.user.id && needsOwnSignIn(aiAccounts.data?.computers, plan);
      } catch {
        toast.show(t("newAgent.planNotSaved", { ...g, brain: t(`brain.card.${plan.kind}`) }), "error");
      }
    } else if (start?.brain === "model" && onStart && start.contextTokens !== null) {
      await api.agents.setBrain(org.id, agent.id, { brain: "model", contextTokens: start.contextTokens });
    }
    // The rest is saved one part at a time. What fails is said, and the flow still ends on the new agent: its @ is
    // taken now, so "Criar" again would only be refused.
    const failures: unknown[] = [];
    const inChannels =
      joined.length > 0 &&
      (await savePart(failures, () =>
        api.agents.setChannels(
          org.id,
          agent.id,
          joined.map((c) => ({ channelId: c.id })),
        ),
      ))
        ? joined
        : [];
    // New agents start with the built-in defaults; the chosen connector levels go on top, in one
    // write that reads the agent's grants first (nothing written afterwards replaces them).
    const chosen = Object.fromEntries(
      connectedList
        .filter((item) => (levels[item.id] ?? "none") !== "none")
        .map((item) => [`connector:${item.id}`, levels[item.id] as Level]),
    );
    if (Object.keys(chosen).length > 0) await savePart(failures, () => saveLevels(api, org.id, agent.id, chosen));
    // Mailboxes: the chosen level with the default rules (every send asks); rules are set on the agent page.
    for (const account of grantedMail) {
      await savePart(failures, () =>
        api.mail.setAgent(org.id, agent.id, account.id, {
          level: toMailLevel(mailLevels[account.id] ?? "none"),
          canDelete: false,
          policy: defaultPolicy(),
        }),
      );
    }
    const libraryList = library.data ?? [];
    if (libraryList.length > 0) {
      await savePart(failures, () =>
        api.skills.setForAgent(
          org.id,
          agent.id,
          libraryList.map((s) => ({ skillId: s.id, enabled: skillIds?.has(s.id) ?? s.defaultForNewAgents })),
        ),
      );
    }
    if (failures.length > 0) toast.show(t("newAgent.partly", { ...g, reason: failureText(t, failures[0]) }), "error");
    setCreated({
      agent,
      look,
      channels: inChannels.map((c) => ({ id: c.id, name: c.name })),
    });
    mood.react("happy", 2200);
    scrollTop();
    // The routine it came with, now that the agent is where it reports; the card says when it is made.
    if (from?.params.draft.routine && withRoutine) {
      void api.agents
        .proposalRoutine(org.id, from.messageId)
        .catch((error) => toast.show(t("newAgent.routineNotMade", { reason: failureText(t, error) }), "error"));
    }
    // Reviewed over the conversation: it closes on it, as it was.
    onClose?.();
    // On a billing hold nothing connects before the plan.
    if (held) return;
    if (plan && signIn) connect?.open({ agentId: agent.id, plan: planOfKind(plan.kind) });
    if (connectPlan) connect?.open({ agentId: agent.id, plan: connectPlan });
    if (connectAfter) connect?.open({ agentId: agent.id, agentIds: [agent.id] });
  };
  const next = () => {
    if (created || create.isPending || importing) return;
    if (stepErrors(step, check).length > 0) {
      fail(step);
      setTimeout(() => root.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    if (index === total - 1) {
      void submit().catch(() => {});
      return;
    }
    mood.react("happy", 900);
    goTo(stepAfter(index, 1, skipped));
  };
  const back = () => {
    if (importing) {
      setImporting(false);
      return;
    }
    if (created || index === 0) return;
    goTo(stepAfter(index, -1, skipped));
  };
  const reset = () => {
    setCreated(null);
    setIndex(0);
    setReached(0);
    setTried(new Set());
    setRole(null);
    setName("");
    setHandle("");
    setHandleTouched(false);
    setLook(BLANK_LOOK);
    setInstructions("");
    setLevels(presetLevels("custom", connectedList, personal));
    setSkillIds(library.data ? new Set(library.data.filter((s) => s.defaultForNewAgents).map((s) => s.id)) : null);
    setChannelIds(new Set(asked));
    setOwner(me.user.id);
    setAudience(audienceAtFirst());
    startWith(startOf(me.user.id));
    setAiPicked(false);
    setWithAutonomy(true);
    setBudget("");
    scrollTop();
  };

  // Keyboard: Enter goes on (⌘/Ctrl+Enter inside the instructions), Esc goes back (or leaves a field).
  const keyboard = useRef({ next, back, dialog: Boolean(onClose) });
  keyboard.current = { next, back, dialog: Boolean(onClose) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inside = !target || target === document.body || Boolean(root.current?.contains(target));
      if (!inside) return;
      const tag = target?.tagName;
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        if (tag === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
        // Buttons and links act on their own (Continuar too); so do radios, checkboxes and pickers.
        if (tag === "BUTTON" || tag === "A") return;
        if (tag === "INPUT" && (target as HTMLInputElement).type === "search") return;
        if (target?.getAttribute("role") && tag !== "INPUT" && tag !== "TEXTAREA") return;
        e.preventDefault();
        keyboard.current.next();
      } else if (e.key === "Escape") {
        if (keyboard.current.dialog) return;
        if (tag === "INPUT" || tag === "TEXTAREA") {
          target?.blur();
          return;
        }
        keyboard.current.back();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Changes that also move the preview ---------- */

  const pickRole = (id: RoleId) => {
    // The role it already has: filling it in again would drop what was typed.
    if (id === role && !starter) return;
    setStarter(null);
    setRole(id);
    setTried((prev) => {
      const nextTried = new Set(prev);
      nextTried.delete("role");
      return nextTried;
    });
    mood.react(id === "custom" ? "wink" : "happy", 1400);
    if (id === "custom") setTimeout(() => document.getElementById("ag-role")?.focus());
    // A proposal keeps its draft: only the role changes.
    if (from) return;
    const preset = ROLE_PRESETS[id];
    const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
    setRoleText("");
    setName(agentName);
    setHandle(handleForName(agentName));
    setHandleTouched(false);
    setLook({ ...preset.look });
    setInstructions(t(`newAgent.roles.${id}.instructions`));
    if (managesAgents) setLevels(presetLevels(id, connectedList, personal));
    setChannelIds(new Set([...asked, ...presetChannels(id, myChannels)]));
    startWith(startOf(ownerId));
    setAiPicked(false);
  };
  /** A personal workspace's starting point: from scratch, with its template agent's name, look, role and line. */
  const pickStarter = (s: PersonalStarter) => {
    if (starter === s.id) return;
    setStarter(s.id);
    setRole("custom");
    setTried((prev) => {
      const nextTried = new Set(prev);
      nextTried.delete("role");
      return nextTried;
    });
    mood.react("happy", 1400);
    setRoleText(t(`teamTemplates.agents.${s.id}.role`));
    setName(s.name);
    setHandle(handleForName(s.name));
    setHandleTouched(false);
    setLook({ ...s.look });
    setInstructions(t(`teamTemplates.agents.${s.id}.line`));
    if (managesAgents) setLevels(presetLevels("custom", connectedList, personal));
    setChannelIds(new Set(asked));
    startWith(startOf(ownerId));
    setAiPicked(false);
  };
  const changeName = (value: string) => {
    const had = Boolean(name.trim());
    setName(value);
    if (!handleTouched) setHandle(handleForName(value));
    if (!had && value.trim()) mood.react("happy", 1200);
    else mood.onTyping();
  };
  const setLevel = (id: string, level: Level) => {
    setLevels((prev) => ({ ...prev, [id]: level }));
    if (level === "write") mood.react("star", 900);
  };
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const nextSet = new Set(set);
    if (on) nextSet.add(id);
    else nextSet.delete(id);
    return nextSet;
  };

  /* ---------- The step's content ---------- */

  const head = (title: string, lead?: string, hint?: string, after?: ReactNode) => {
    const h1 = (
      <h1 className="onb__title newag__title" ref={heading} tabIndex={-1}>
        {title}
      </h1>
    );
    return (
      <header className="onb__head">
        <p className="onb__eyebrow">
          {t("newAgent.stepOf", {
            n: NEW_AGENT_STEPS.filter((s, i) => i <= index && !skipped.includes(s)).length,
            total: walked.length,
          })}
        </p>
        {hint ? (
          <div className="ac-hintline">
            {h1}
            <InfoHint name={t("common.about", { label: title })}>{hint}</InfoHint>
          </div>
        ) : (
          h1
        )}
        {lead && <p className="onb__lead">{lead}</p>}
        {after}
      </header>
    );
  };
  const errorLine = (e: DraftError | undefined) =>
    e ? (
      <span className="newag__err" role="alert">
        <Icon name="info" size={14} />
        {errorText(e)}
      </span>
    ) : null;
  const mailChip = (account: (typeof mailboxes)[number]) => (
    <span key={account.id} className="ac-chip">
      <MailIcon choice={choiceOf(account)} />
      {t(mailLevels[account.id] === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", {
        name: account.address,
      })}
    </span>
  );
  const connectorChip = (item: ConnectedItem) => {
    const n = itemName(t, item);
    return (
      <span key={item.id} className="ac-chip">
        <ConnectorIcon def={item.def} image={item.image} label={n} />
        {t(levels[item.id] === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name: n })}
      </span>
    );
  };
  const chip = (icon: IconName, text: string, k?: string) => (
    <span key={k ?? text} className="ac-chip">
      <Icon name={icon} />
      {text}
    </span>
  );
  const audienceText = () => {
    if (audience.mode === "everyone") return t(modeKey(org, "audience.summary.everyone"));
    if (audience.mode === "owner")
      return ownerFirst ? t("audience.summary.owner", { name: ownerFirst }) : t("audience.summary.nobody");
    if (audience.userIds.length === 0 && ownerFirst)
      return ownerId === me.user.id ? t("audience.onlyYouForNow") : t("audience.onlyOwnerForNow", { name: ownerFirst });
    const names = (members.data ?? [])
      .filter((m) => m.userId === ownerId || audience.userIds.includes(m.userId))
      .map((m) => m.name.split(/\s+/)[0] ?? m.name);
    const roles = (roleList.data?.roles ?? []).filter((r) => audience.roleIds?.includes(r.id)).map((r) => r.name);
    return names.length + roles.length ? joinNames([...roles, ...names], t) : t("audience.summary.nobody");
  };
  const ownerTitle = (
    <h2>
      <Icon name="person" />
      {t("newAgent.owner")}
    </h2>
  );

  const views: Record<NewAgentStep, () => ReactNode> = {
    role: () => {
      if (importing) {
        return (
          <>
            {head(t("shell.importAgents"))}
            <ImportFlow flow={importFlow} orgId={org.id} standalone />
          </>
        );
      }
      const roleHead = (tile: ReactNode, title: string, sub: string) => (
        <span className="newag__role-head">
          {tile}
          <span className="newag__role-name">
            <b>{title}</b>
            <span>{sub}</span>
          </span>
        </span>
      );
      return (
        <>
          {head(
            t("newAgent.steps.role.title"),
            t("newAgent.steps.role.lead"),
            undefined,
            !from && (
              <p className="ac-iconline newag__import">
                <Icon name="archiveBox" size={16} />
                <button type="button" className="ac-link" onClick={() => setImporting(true)}>
                  {t("shell.importAgents")}
                </button>
              </p>
            ),
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
          <div className="newag__role-groups" role="group" aria-label={t("newAgent.steps.role.name")}>
            <div className="newag__scratch">
              <button
                type="button"
                className="newag__role newag__role--blank"
                aria-pressed={role === "custom" && !starter}
                onClick={() => pickRole("custom")}
              >
                <span className="newag__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                {roleHead(
                  <span className="newag__blank-icon" aria-hidden="true">
                    <Icon name="plus" />
                  </span>,
                  t("newAgent.roles.custom.name"),
                  t("newAgent.roles.custom.desc"),
                )}
              </button>
              {role === "custom" && !starter && (
                <Card as="div" className="newag__card">
                  <Field label={t("agent.roleLabel")} id="ag-role" example={t(modeKey(org, "agent.roleHelp"))}>
                    <Input
                      value={roleText}
                      maxLength={200}
                      autoComplete="off"
                      onChange={(e) => {
                        setRoleText(e.target.value);
                        mood.onTyping();
                      }}
                    />
                  </Field>
                </Card>
              )}
            </div>
            {personal && (
              // One person's agents (ADR 0159 §3): the right hand's personal ones, not a company's roles.
              <section className="newag__section" aria-labelledby="ag-roles-personal">
                <div className="newag__sect">
                  <h2 id="ag-roles-personal">
                    <Icon name="person" />
                    {t("newAgent.roleGroups.personal")}
                  </h2>
                </div>
                <div className="newag__roles">
                  {PERSONAL_STARTERS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="newag__role"
                      aria-pressed={starter === s.id}
                      onClick={() => pickStarter(s)}
                    >
                      <span className="newag__check" aria-hidden="true">
                        <Icon name="check" size={14} />
                      </span>
                      {/* Its name on top and what it does under it, as an agent shows everywhere: a role in a
                          sentence ("Agenda e lembretes") is too long for the cards' big title. */}
                      {roleHead(
                        <AgentAvatar name={s.name} appearance={s.look} size="lg" className="newag__role-agent" />,
                        s.name,
                        t(`teamTemplates.agents.${s.id}.role`),
                      )}
                      <span className="newag__role-desc">{t(`teamTemplates.agents.${s.id}.line`)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {(personal ? [] : ROLE_GROUPS).map((group) => (
              <section key={group.id} className="newag__section" aria-labelledby={`ag-roles-${group.id}`}>
                <div className="newag__sect">
                  <h2 id={`ag-roles-${group.id}`}>
                    <Icon name={GROUP_ICON[group.id]} />
                    {t(`newAgent.roleGroups.${group.id}`)}
                  </h2>
                </div>
                <div className="newag__roles">
                  {group.roles.map((id) => {
                    const preset = ROLE_PRESETS[id];
                    const kit = managesAgents
                      ? connectedList.filter((i) => i.def && (preset.levels[i.def.id] ?? "none") !== "none")
                      : [];
                    const room = presetChannels(id, myChannels)
                      .map((cid) => myChannels.find((c) => c.id === cid)?.name)
                      .filter(Boolean)[0];
                    return (
                      <button
                        key={id}
                        type="button"
                        className="newag__role"
                        aria-pressed={role === id}
                        onClick={() => pickRole(id)}
                      >
                        <span className="newag__check" aria-hidden="true">
                          <Icon name="check" size={14} />
                        </span>
                        {roleHead(
                          <AgentAvatar
                            name={t(`newAgent.roles.${id}.agent`)}
                            appearance={preset.look}
                            size="lg"
                            className="newag__role-agent"
                          />,
                          t(`newAgent.roles.${id}.name`),
                          t("newAgent.startsAs", { name: t(`newAgent.roles.${id}.agent`) }),
                        )}
                        <span className="newag__role-desc">{t(`newAgent.roles.${id}.desc`)}</span>
                        {(kit.length > 0 || room) && (
                          <span className="newag__chips">
                            {kit.slice(0, 3).map((i) => (
                              <span key={i.id} className="ac-chip">
                                <ConnectorIcon def={i.def} image={i.image} label={itemName(t, i)} />
                                {itemName(t, i)}
                              </span>
                            ))}
                            {room && chip("channel", room)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          {errorLine(errorOf("role"))}
        </>
      );
    },
    identity: () => (
      <>
        {head(t("newAgent.steps.identity.title"), t(modeKey(org, "newAgent.steps.identity.lead")))}
        <Card as="div" className="newag__card">
          <div className="newag__grid2">
            <Field
              label={t("newAgent.name")}
              id="ag-name"
              error={errorOf("name") ? errorText(errorOf("name") as DraftError) : undefined}
            >
              <Input
                className="newag__big"
                value={name}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("newAgent.namePlaceholder")}
                onChange={(e) => changeName(e.target.value)}
              />
            </Field>
            <Field
              label={t("newAgent.handle")}
              id="ag-handle"
              error={handleError ? errorText(handleError) : undefined}
              hint={{
                name: t("common.about", { label: t("newAgent.handle") }),
                text: handle ? t("newAgent.handleHelp", { handle }) : t("newAgent.handleEmpty"),
              }}
            >
              <AffixInput
                className="newag__big"
                prefix="@"
                value={handle}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("newAgent.handlePlaceholder")}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(cleanHandle(e.target.value));
                  mood.onTyping();
                }}
              />
            </Field>
          </div>
        </Card>
        <div className="newag__sect">
          <h2>{t("newAgent.look")}</h2>
          <Button
            size="sm"
            icon="shuffle"
            onClick={() => {
              setLook((l) => ({ ...BLANK_LOOK, ...randomAppearance(l) }) as Required<AgentAppearance>);
              mood.react("dizzy", 1000);
            }}
          >
            {t("newAgent.shuffle")}
          </Button>
        </div>
        <Card as="div" className="newag__card newag__look">
          <LookPicker
            look={look}
            onPick={(patch) => {
              setLook((l) => ({ ...l, ...patch }));
              if (patch.color) mood.react("happy", 1100);
              else if (patch.eyes) mood.react("wink", 700);
              else if (patch.accessory && patch.accessory !== "none") mood.react("happy", 900);
            }}
          />
        </Card>
      </>
    ),
    instructions: () => {
      const original = role ? t(`newAgent.roles.${role}.instructions`) : "";
      const changed = role !== null && role !== "custom" && instructions !== original;
      return (
        <>
          {head(
            t("newAgent.steps.instructions.title", g),
            t("newAgent.steps.instructions.lead"),
            t(modeKey(org, "agent.instructionsHelp"), { ...g, org: org.name }),
          )}
          <Textarea
            className="newag__textarea"
            rows={9}
            maxLength={50_000}
            aria-label={t("newAgent.instructions")}
            placeholder={t("newAgent.instructionsPlaceholder")}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              mood.onTyping();
            }}
          />
          <div className="newag__ta-meta">
            <span className="newag__origin">
              {role && role !== "custom" ? (
                <>
                  <Icon name={ROLE_PRESETS[role].icon} size={14} />
                  {t("newAgent.startedFrom", { role: roleName })}
                </>
              ) : (
                <>
                  <Icon name="edit" size={14} />
                  {t("newAgent.roles.custom.name")}
                </>
              )}
              {changed && (
                <Button size="sm" variant="ghost" icon="undo" onClick={() => setInstructions(original)}>
                  {t("newAgent.restore")}
                </Button>
              )}
            </span>
            <span className="newag__count ac-num">
              <span aria-hidden="true">{instructions.length}</span>
              <span className="ac-visually-hidden">{t("newAgent.characters", { count: instructions.length })}</span>
            </span>
          </div>
          <InstructionTips
            helper={me.user.name.split(/\s+/)[0] ?? me.user.name}
            onAdd={(add) => {
              setInstructions((v) => (v.trim() ? `${v.replace(/\s+$/, "")}\n` : "") + add);
              setTimeout(() => {
                const ta = root.current?.querySelector<HTMLTextAreaElement>("textarea");
                ta?.focus();
                ta?.setSelectionRange?.(ta.value.length, ta.value.length);
              });
            }}
          />
          {!instructions.trim() && <p className="small muted">{t("newAgent.noInstructions", g)}</p>}
        </>
      );
    },
    tools: () => (
      <>
        {head(
          t("newAgent.steps.tools.title"),
          managesAgents
            ? t("newAgent.steps.tools.lead", { ...g, org: org.name })
            : t("newAgent.steps.tools.leadNoAccess", g),
          managesAgents ? undefined : t(keeperKey(org, keeper, "newAgent.accessAdmins"), { keeper }),
        )}
        <Card as="div" className="newag__card">
          {connectedList.length + mailboxes.length > 0 ? (
            <>
              <div className="newag__list-head">
                <span className="small muted">
                  {t("newAgent.connectedCount", { count: connectedList.length + mailboxes.length })}
                </span>
                {managesAgents && (
                  <span className="newag__quick">
                    {t("newAgent.all")}
                    <Segmented
                      size="sm"
                      label={t("newAgent.connectorsLabel")}
                      value={
                        sharedLevel([
                          ...connectedList.map((i) => levels[i.id] ?? "none"),
                          ...mailboxes.map((a) => mailLevels[a.id] ?? "none"),
                        ]) ?? "custom"
                      }
                      onValueChange={(l) => {
                        if (l === "none") {
                          setLevels(presetLevels("custom", connectedList, personal));
                          setMailLevels({});
                        } else if (l === "read") {
                          setLevels(Object.fromEntries(connectedList.map((i) => [i.id, "read" as Level])));
                          setMailLevels(Object.fromEntries(mailboxes.map((a) => [a.id, "read" as Level])));
                        }
                      }}
                      options={[
                        { value: "none", label: t("access.level.none") },
                        { value: "read", label: t("access.level.read") },
                      ]}
                    />
                  </span>
                )}
              </div>
              <ul className="level-list" aria-label={t("newAgent.connectorsLabel")}>
                {connectedList.map((item) => {
                  const n = itemName(t, item);
                  const level = levels[item.id] ?? "none";
                  return (
                    <LevelRow
                      key={item.id}
                      icon={<ConnectorIcon def={item.def} image={item.image} label={n} />}
                      name={n}
                      description={item.account}
                      asks={level === "write" ? asksOf(item) : []}
                      levels={LEVELS}
                      value={level}
                      onChange={managesAgents ? (l) => setLevel(item.id, l) : undefined}
                    />
                  );
                })}
                {mailboxes.map((account) => {
                  const level = mailLevels[account.id] ?? "none";
                  return (
                    <LevelRow
                      key={account.id}
                      icon={<MailIcon choice={choiceOf(account)} />}
                      name={account.address}
                      description={account.label || null}
                      asks={level === "write" ? mailAsks : []}
                      levels={LEVELS}
                      value={level}
                      onChange={
                        managesAgents
                          ? (l) => {
                              setMailLevels((prev) => ({ ...prev, [account.id]: l }));
                              if (l === "write") mood.react("star", 900);
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="small muted">{t(managesAgents ? "access.noConnectors" : "access.noConnectorsViewer")}</p>
          )}
          {managesAgents && (
            <Link
              className="newag__addrow"
              to="/org/$orgId/settings/$section"
              params={{ orgId: org.id, section: "connectors" }}
            >
              <Icon name="plug" />
              {t("newAgent.connectOther")}
              <span className="newag__addrow-aside">{t("newAgent.opensConnectors")}</span>
            </Link>
          )}
        </Card>
        <p className="newag__note ac-iconline">
          <Icon name="shield" size={16} />
          <span>
            <b>{t("newAgent.approvalsNote")}</b>{" "}
            {ownerFirst ? t("newAgent.approverOwner", { name: ownerFirst }) : t("newAgent.approverAdmins")}
          </span>
        </p>
        {(library.data ?? []).length > 0 && (
          <section className="newag__section" aria-labelledby="ag-skills">
            <div className="newag__sect">
              <h2 id="ag-skills">
                <Icon name="book" />
                {t("skills.step")} <span className="newag__opt-label">{t("newAgent.optional")}</span>
              </h2>
              <span className="small muted">{t("newAgent.skillsHelp", g)}</span>
            </div>
            <SkillPicker
              skills={library.data ?? []}
              selected={skillIds ?? new Set()}
              onChange={setSkillIds}
              idPrefix="ag-skill"
            />
          </section>
        )}
      </>
    ),
    where: () => (
      <>
        {head(t("newAgent.steps.where.title"), t(modeKey(org, "newAgent.steps.where.lead"), g))}
        <div className="newag__sect newag__sect--first">
          <h2>
            <Icon name="channel" />
            {t("newAgent.channels")}
          </h2>
          <span className="small muted">{t("newAgent.channelsHelp")}</span>
        </div>
        {myChannels.length > 0 ? (
          <div className="newag__pills">
            {myChannels.map((c) => (
              <CheckboxPill
                key={c.id}
                id={`ag-ch-${c.id}`}
                checked={channelIds.has(c.id)}
                onCheckedChange={(on) => {
                  setChannelIds((prev) => toggle(prev, c.id, on));
                  if (on) mood.react("happy", 700);
                }}
              >
                {`#${c.name}`}
              </CheckboxPill>
            ))}
          </div>
        ) : (
          <p className="small muted">{t("newAgent.noChannels")}</p>
        )}
        {!ownerHidden && (
          <>
            <div className="newag__sect">
              {managesAgents ? (
                ownerTitle
              ) : (
                <div className="ac-hintline">
                  {ownerTitle}
                  <InfoHint name={t("common.about", { label: t("newAgent.owner") })}>
                    {t("newAgent.ownerYours")}
                  </InfoHint>
                </div>
              )}
            </div>
            <Card as="div" className="newag__card">
              {managesAgents ? (
                <OwnerSelect
                  value={owner}
                  members={members.data ?? []}
                  meId={me.user.id}
                  onChange={(v) => {
                    setOwner(v);
                    if (!aiPicked) startWith(startOf(v === NO_OWNER ? null : v));
                    if (v !== NO_OWNER) setAudience((a) => ({ ...a, userIds: a.userIds.filter((id) => id !== v) }));
                  }}
                />
              ) : (
                <OwnerValue member={ownerMember} meId={me.user.id} />
              )}
              <span className="small muted">{ownerId ? t("newAgent.ownerHelp") : t("newAgent.noOwnerHelp")}</span>
            </Card>
          </>
        )}
        {!audienceHidden && (
          <>
            <div className="newag__sect">
              <h2>
                <Icon name="message" />
                {t("audience.title", g)}
              </h2>
            </div>
            <Card as="div" className="newag__card">
              <AudienceChoice
                compact
                value={audience}
                onChange={setAudience}
                ownerUserId={ownerId}
                agentName={displayName}
                idPrefix="ag-audience"
              />
              {errorLine(errorOf("audience"))}
            </Card>
          </>
        )}
      </>
    ),
    model: () => {
      return (
        <>
          {head(t("newAgent.steps.model.title"), t("newAgent.steps.model.lead"))}
          {startLine && <SettingNote icon="repeat">{t("newAgent.lastSetup", { setup: startLine })}</SettingNote>}
          {onStart && start?.autonomy && (
            <SettingRow
              title={t("agentPage.work.brain.copy.withAutonomy")}
              status={t("newAgent.lastAutonomy", {
                value: autonomyName(t, start.autonomy),
                fallback: autonomyName(t, DEFAULT_AUTONOMY),
              })}
              htmlFor="ag-autonomy"
            >
              <Switch id="ag-autonomy" checked={withAutonomy} onCheckedChange={setWithAutonomy} />
            </SettingRow>
          )}
          <BrainPickSelect
            options={brainOptions}
            value={brainValue}
            fallback={modelLabel}
            onChange={(o: BrainPickOption) => {
              const p = o.pick;
              setAiPicked(true);
              mood.react(o.value.toLowerCase().includes("opus") ? "star" : "happy", 800);
              if (p.kind === "model") {
                setModel(p.model);
                setPlan(null);
                setConnectPlan(null);
                return;
              }
              // A plan thinks on its computer: the agent's own model there, Automático carried onto it.
              setModel(AUTO);
              if (p.kind === "connect") {
                setPlan(null);
                setConnectPlan(p.choice);
                return;
              }
              setConnectPlan(null);
              setPlan({
                kind: p.kind,
                machineId: p.machineId,
                ...(p.accountId ? { accountId: p.accountId, label: p.account } : {}),
                model: p.model,
              });
            }}
          />
          {connectPlan && <SettingNote icon="key">{brainChosen?.description}</SettingNote>}
          {brainChosen?.needs && <SettingNote icon="info">{t(`brain.modelHow.${brainChosen.needs}`)}</SettingNote>}
          {plan && (
            <span className="small muted">
              {t("newAgent.planOnlyOwner", {
                ...g,
                owner: ownerId === me.user.id ? t("common.you") : (ownerFirst ?? t("common.you")),
              })}
            </span>
          )}
          {connectAfter && !held && <SettingNote icon="info">{t("newAgent.noAi")}</SettingNote>}
          {connectsHere && (
            <span className="newag__connect">
              <Button size="sm" variant={connectAfter ? "primary" : "default"} icon="plus" onClick={connectHere}>
                {t("aiAccounts.page.connect")}
              </Button>
            </span>
          )}
          {errorLine(errorOf("model"))}
          <div className="newag__sect">
            <h2>
              {keyProvider ? <ProviderLogo id={keyProvider} size="xs" /> : <Icon name="key" />}
              {t("newAgent.key")}
            </h2>
          </div>
          <KeySelect
            value={key}
            onChange={(v) => {
              setKey(v);
              setAiPicked(true);
            }}
            options={keys}
          />
          <div className="newag__sect">
            <div className="ac-hintline">
              <h2>
                <Icon name="wallet" />
                {t("newAgent.budgetTitle")}
              </h2>
              <InfoHint name={t("common.about", { label: t("newAgent.budgetTitle") })}>
                {`${t("newAgent.budgetHelp", g)} ${ownerFirst ? t("newAgent.warnsOwner", { name: ownerFirst }) : t("newAgent.warnsAdmins")}`}
              </InfoHint>
            </div>
          </div>
          <Card as="div" className="newag__card">
            <BudgetField
              id="ag-budget"
              value={budget}
              onChange={setBudget}
              defaultBudget={defaultBudget}
              error={errorOf("budget") ? errorText(errorOf("budget") as DraftError) : undefined}
            />
            {!errorOf("budget") && (
              <span className="small muted">
                {defaultBudget === undefined
                  ? t("agent.budgetDefaultHelp")
                  : t("agent.budgetDefaultHelpAmount", { amount: usd(t, locale, defaultBudget) })}
              </span>
            )}
          </Card>
        </>
      );
    },
    review: () => {
      const row = (to: NewAgentStep, icon: IconName, label: string, value: ReactNode) => (
        <div className="newag__rv" key={label}>
          <span className="newag__rv-k">
            <Icon name={icon} size={16} />
            {label}
          </span>
          <div className="newag__rv-v">{value}</div>
          <Button
            size="sm"
            variant="ghost"
            icon="edit"
            aria-label={t("newAgent.editSection", { section: label })}
            onClick={() => goTo(NEW_AGENT_STEPS.indexOf(to))}
          >
            {t("agent.edit")}
          </Button>
        </div>
      );
      const chips = (list: ReactNode[], empty: string) =>
        list.length ? <span className="newag__chips">{list}</span> : <span className="muted">{empty}</span>;
      return (
        <>
          {head(t("newAgent.steps.review.title", g))}
          <Card as="div" className="newag__card newag__review">
            {row(
              "role",
              rolePreset?.icon ?? "agent",
              t("newAgent.steps.role.name"),
              <span>
                {role && role !== "custom"
                  ? `${roleName} · ${t(`newAgent.roles.${role}.desc`)}`
                  : roleText || t("newAgent.roles.custom.name")}
              </span>,
            )}
            {row(
              "identity",
              "person",
              t("newAgent.name"),
              <>
                <span>
                  <b>{displayName}</b> <span className="muted">@{handle}</span>
                </span>
                <span className="small muted">
                  {[
                    t(`look.colors.${colorKey(look.color)}`),
                    t(`look.eyesNames.${look.eyes}`),
                    ...(look.accessory !== "none" ? [t(`look.accessories.${look.accessory}`)] : []),
                  ].join(" · ")}
                </span>
              </>,
            )}
            {row(
              "instructions",
              "document",
              t("newAgent.instructions"),
              instructions.trim() ? (
                <span className="newag__quote">{instructions.trim()}</span>
              ) : (
                <span className="muted">{t("newAgent.onlyContext")}</span>
              ),
            )}
            {row(
              "tools",
              "plug",
              t("newAgent.tools"),
              chips(
                [
                  ...granted.map(connectorChip),
                  ...grantedMail.map(mailChip),
                  ...skills.map((s) => chip("book", s.name, s.id)),
                ],
                t("newAgent.noTools"),
              ),
            )}
            {row(
              "where",
              "channel",
              t("newAgent.channels"),
              chips(
                joined.map((c) => chip("channel", c.name, c.id)),
                t("newAgent.noChannelsReview"),
              ),
            )}
            {!ownerHidden &&
              row(
                "where",
                "members",
                t("newAgent.owner"),
                <span>{ownerMember?.name ?? t("newAgent.noOwnerAdmins")}</span>,
              )}
            {!audienceHidden && row("where", "message", t("audience.section"), <span>{audienceText()}</span>)}
            {draft?.routine && (
              <div className="newag__rv">
                <span className="newag__rv-k">
                  <Icon name="routines" size={16} />
                  {t("newAgent.routine")}
                </span>
                <div className="newag__rv-v">
                  <span>
                    {draft.routine.name}{" "}
                    <span className="muted">· {proposedRoutineWhen(t, locale, draft.routine)}</span>
                  </span>
                  <span className="newag__quote">{draft.routine.prompt}</span>
                </div>
                <Switch
                  checked={withRoutine}
                  onCheckedChange={setWithRoutine}
                  aria-label={t("newAgent.routineKeep", { name: draft.routine.name })}
                />
              </div>
            )}
            {row(
              "model",
              "bolt",
              t("newAgent.modelAndCost"),
              <span>
                {modelLabel}
                {autonomy && ` · ${autonomyWords(t, autonomy)}`}{" "}
                <span className="muted">
                  · {keyLabel}
                  {budgetShown !== undefined && ` · ${t("newAgent.upTo", { amount: usd(t, locale, budgetShown) })}`}
                </span>
              </span>,
            )}
          </Card>
        </>
      );
    },
  };

  /* ---------- The created moment ---------- */

  if (created) {
    return (
      <div className="onb newag newag--done" ref={root}>
        <NewAgentRail index={total} reached={total} total={total} onGo={() => {}} done />
        <main className="newag__main">
          <div className="newag__content newag__content--done">
            <CreatedMoment
              created={created}
              phone={phone}
              face={mood.face}
              // Another one starts empty, without the proposal (it is decided).
              onAgain={
                from
                  ? () => void navigate({ to: "/org/$orgId/agents/new", params: { orgId: org.id }, search: {} })
                  : reset
              }
              heading={heading}
            />
          </div>
        </main>
      </div>
    );
  }

  /* ---------- The preview ---------- */

  const last = index === total - 1;
  // Never an all-empty preview: it comes with a role's template or the first thing typed.
  const showPreview =
    !importing &&
    ((role !== null && role !== "custom") || Boolean(roleText.trim() || name.trim() || instructions.trim()));
  const footErrors = errors.map(errorText);
  const hint: Record<NewAgentStep, ReactNode> = {
    role: role
      ? role === "custom"
        ? t("newAgent.roles.custom.name")
        : t("newAgent.startsAs", { name: t(`newAgent.roles.${role}.agent`) })
      : t("newAgent.hints.role"),
    identity: handle ? t("newAgent.hints.identity", { handle }) : "",
    instructions: (
      <>
        <Kbd>{modKey()}</Kbd>
        <Kbd>↵</Kbd>
        {t("newAgent.hints.instructions")}
      </>
    ),
    tools:
      granted.length + grantedMail.length
        ? t("newAgent.hints.tools", { count: granted.length + grantedMail.length })
        : t("newAgent.hints.noTools"),
    where: joined.length ? t("newAgent.hints.where", { count: joined.length }) : t("newAgent.noChannelsYet"),
    model: modelLabel,
    review: t("newAgent.hints.review"),
  };

  return (
    <div className="onb newag" ref={root}>
      <NewAgentRail
        index={index}
        reached={reached}
        total={total}
        onGo={goTo}
        done={false}
        onLeave={onClose}
        skipped={skipped}
      />
      <div className="newag__work">
        <main className="newag__main">
          <Locked when={create.isPending || deny.isPending}>
            <div className="newag__content" key={step}>
              {views[step]()}
            </div>
          </Locked>
          <div className="newag__foot">
            <span className="newag__hint" data-bad={footErrors.length > 0 || undefined}>
              {importing ? null : footErrors.length > 0 ? (
                <>
                  <Icon name="info" size={14} />
                  {footErrors[0]}
                </>
              ) : (
                hint[step]
              )}
            </span>
            {index > 0 || importing ? (
              <Button
                variant="ghost"
                size="lg"
                icon="chevronLeft"
                disabled={create.isPending || deny.isPending}
                onClick={back}
              >
                {t("common.back")}
              </Button>
            ) : onClose ? (
              <Button variant="ghost" size="lg" onClick={onClose}>
                {t("common.cancel")}
              </Button>
            ) : (
              <Button asChild variant="ghost" size="lg">
                <a {...exit}>{t("common.cancel")}</a>
              </Button>
            )}
            {from && last && (
              <Button
                variant="ghost"
                size="lg"
                loading={deny.isPending}
                onClick={() =>
                  deny.mutate(from.messageId, {
                    onSuccess: () =>
                      onClose
                        ? onClose()
                        : void navigate({
                            to: "/org/$orgId/c/$channelId",
                            params: { orgId: org.id, channelId: from.channelId },
                          }),
                  })
                }
              >
                {t("approval.refuse")}
              </Button>
            )}
            {!importing && (
              <Button
                variant="primary"
                size="lg"
                kbd={["↵"]}
                loading={create.isPending}
                aria-disabled={footErrors.length > 0 || undefined}
                onClick={next}
              >
                {last ? t("newAgent.create", { name: displayName }) : t("common.continue")}
              </Button>
            )}
          </div>
        </main>
        {showPreview && (
          <aside className="newag__aside" data-step={step} aria-label={t("newAgent.preview.label")}>
            <div className="newag__cap">
              <span className="onb__eyebrow">{t("newAgent.preview.title")}</span>
            </div>
            <div className="newag__pv" data-big={step === "identity" || undefined} data-open={previewOpen || undefined}>
              <div className="newag__pv-cover" ref={preview}>
                <AgentPreviewSky
                  color={look.color as AgentColor}
                  clear={() => [...(preview.current?.querySelectorAll(".newag__pv-state, .newag__pv-agent") ?? [])]}
                />
                <span className="newag__pv-state">
                  <Icon name="edit" size={14} />
                  {t("newAgent.preview.draft")}
                </span>
                <AgentAvatar
                  name={previewName}
                  appearance={look}
                  size="xl"
                  className="newag__pv-agent"
                  state={mood.typing ? "writing" : undefined}
                  expression={mood.face}
                />
              </div>
              <div className="newag__pv-body">
                <div className="newag__pv-head">
                  <div className="newag__pv-name">
                    <b data-placeholder={!name.trim() || undefined}>{previewName}</b>
                    <span>
                      {handle ? `@${handle}` : "@…"}
                      {roleName && <span className="newag__pv-role"> · {roleName}</span>}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={previewOpen ? "close" : "chevronDown"}
                    className="newag__pv-toggle"
                    aria-expanded={previewOpen}
                    aria-label={previewOpen ? t("newAgent.preview.hide") : t("newAgent.preview.show")}
                    onClick={() => setPreviewOpen((o) => !o)}
                  />
                </div>
                {roleName && rolePreset && (
                  <span className="newag__chips newag__pv-wide">{chip(rolePreset.icon, roleName)}</span>
                )}
                {instructions.trim() && <p className="newag__pv-instr">{instructions.trim().split("\n")[0]}</p>}
                <PreviewSection label={t("newAgent.preview.uses")}>
                  {granted.length || grantedMail.length || skills.length ? (
                    <>
                      <span className="newag__chips">
                        {granted.map(connectorChip)}
                        {grantedMail.map(mailChip)}
                        {skills.map((s) => chip("book", s.name, s.id))}
                      </span>
                      {(() => {
                        const asks = [
                          ...granted.filter((i) => levels[i.id] === "write").flatMap(asksOf),
                          ...(grantedMail.some((a) => mailLevels[a.id] === "write") ? mailAsks : []),
                        ];
                        return asks.length ? (
                          <span className="newag__asks">
                            <Icon name="lock" size={14} />
                            {t("toolReview.asks", { count: new Set(asks).size })}
                          </span>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    <span className="newag__empty">{t("newAgent.preview.onlyTalks")}</span>
                  )}
                </PreviewSection>
                <PreviewSection label={t("newAgent.preview.worksIn")}>
                  {joined.length ? (
                    <span className="newag__chips">{joined.map((c) => chip("channel", c.name, c.id))}</span>
                  ) : (
                    <span className="newag__empty">{t("newAgent.noChannelsYet")}</span>
                  )}
                </PreviewSection>
                {!ownerHidden && (
                  <PreviewSection label={t("newAgent.owner")}>
                    <span className="newag__chips">{chip("person", ownerFirst ?? t("newAgent.noOwnerOption"))}</span>
                  </PreviewSection>
                )}
                {!audienceHidden && (
                  <PreviewSection label={t("audience.section")}>
                    <span className="newag__chips">{chip("message", audienceText())}</span>
                  </PreviewSection>
                )}
                <PreviewSection label={t("newAgent.modelAndCost")}>
                  <span className="newag__chips">
                    {modelLabel && chip("bolt", modelLabel, "model")}
                    {autonomy && chip("shield", autonomyWords(t, autonomy), "autonomy")}
                    {budgetShown !== undefined &&
                      !budgetInvalid &&
                      chip("wallet", t("newAgent.upTo", { amount: usd(t, locale, budgetShown) }), "budget")}
                  </span>
                </PreviewSection>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function PreviewSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="newag__pv-sec">
      <span className="newag__pv-label">{label}</span>
      {children}
    </div>
  );
}

/** The rail: brand, title, the steps (visited ones clickable), leaving, and the horizon rising with progress. */
function NewAgentRail({
  index,
  reached,
  total,
  onGo,
  done,
  onLeave,
  skipped = NO_SKIP,
}: {
  index: number;
  reached: number;
  total: number;
  onGo: (i: number) => void;
  done: boolean;
  /** Over the conversation: × closes the review there. */
  onLeave?: () => void;
  /** Steps passed over (a personal workspace's technical ones): not in the rail. */
  skipped?: readonly NewAgentStep[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const exit = useFlowExit(org.id);
  const rail = NEW_AGENT_STEPS.map((s, i) => ({ s, i })).filter(({ s }) => !skipped.includes(s));
  return (
    <aside className="onb__rail newag__rail">
      <div className="newag__rail-head">
        <span className="onb__brand">
          <Logo size={22} />
        </span>
        {onLeave ? (
          <Button variant="ghost" size="sm" iconOnly icon="close" aria-label={t("newAgent.leave")} onClick={onLeave} />
        ) : (
          <Button asChild variant="ghost" size="sm" iconOnly aria-label={t("newAgent.leave")}>
            <a {...exit} title={t("newAgent.leave")}>
              <Icon name="close" />
            </a>
          </Button>
        )}
      </div>
      <div className="newag__rail-title">
        <b>{t("newAgent.title")}</b>
        <span>{t("newAgent.railOrg", { org: org.name, role: t(`roles.${org.role}Lower`) })}</span>
      </div>
      <StepRail
        label={t("newAgent.stepsLabel")}
        current={done ? -1 : rail.findIndex((r) => r.i === index)}
        onGo={(n) => onGo(rail[n]?.i ?? 0)}
        doneLabel={t("onboarding.stepDone")}
        steps={rail.map(({ s, i }) => ({
          id: s,
          name: t(`newAgent.steps.${s}.name`),
          done: done || i < reached,
          disabled: done || i > reached,
        }))}
      />
      <OnboardingHorizon progress={done ? 1 : reached / (total - 1)} />
    </aside>
  );
}

/** The new agent on its own sky: where it is, and what to do next. */
function CreatedMoment({
  created,
  phone,
  face,
  onAgain,
  heading,
}: {
  created: Created;
  phone: boolean;
  face: Expression | undefined;
  onAgain: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const text = useRef<HTMLDivElement>(null);
  const born = useRef<HTMLSpanElement>(null);
  const { agent, channels } = created;
  const first = channels[0];
  const names = joinNames(
    channels.map((c) => `#${c.name}`),
    t,
  );
  return (
    <section className="newag__born" aria-labelledby="ag-born">
      <AgentBornSky
        color={created.look.color}
        at={phone ? [0.5, 0.26] : [0.8, 0.45]}
        calm={() => [text.current]}
        clear={() => [born.current]}
      />
      <span className="newag__born-agent" ref={born}>
        <AgentAvatar name={agent.name} appearance={created.look} size="xl" expression={face} />
      </span>
      <div className="newag__born-text" ref={text}>
        <p className="onb__eyebrow onb__eyebrow--sky">{t(modeKey(org, "newAgent.newOnTeam"))}</p>
        <h1 id="ag-born" className="newag__born-title" ref={heading} tabIndex={-1}>
          {t(modeKey(org, "newAgent.createdTitle"), { name: agent.name })}
        </h1>
        <p className="newag__born-lead">
          {channels.length > 0
            ? t("newAgent.createdText", { channels: names, handle: agent.handle })
            : t(modeKey(org, "newAgent.createdTextNoChannels"), { name: agent.name, handle: agent.handle })}
        </p>
        <div className="newag__born-actions">
          {first && (
            <Button asChild variant="primary" className="newag__on-sky">
              <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: first.id }}>
                {t("newAgent.goTo", { channel: first.name })}
                <Icon name="arrowRight" size={16} />
              </Link>
            </Button>
          )}
          <Button asChild variant={first ? "default" : "primary"} className="newag__on-sky">
            <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
              {t("newAgent.openProfile")}
            </Link>
          </Button>
          <Button icon="plus" className="newag__on-sky" onClick={onAgain}>
            {t("newAgent.createAnother")}
          </Button>
        </div>
      </div>
    </section>
  );
}
