import type { AgentBrain, BrainKind, MachineAccount, MachineAccountKind, PlanUsage } from "@agenteschat/client";
import {
  useAiAccounts,
  useAiStatus,
  useComputerSetup,
  useCredentials,
  useModels,
  usePlatformKey,
  useSettings,
} from "@agenteschat/client";
import {
  type AccountChoice,
  accountAbout,
  accountChoices,
  accountTitle,
  lendable,
  offersSignInAgain,
  ownSignInListed,
  ownSignInName,
  ownSignInTitle,
  signInOf,
} from "@agenteschat/client/lib/ai-accounts";
import { advancedContents, effortLevel, viewSpeedFits } from "@agenteschat/client/lib/brain-advanced";
import { computerNameOf, setupView } from "@agenteschat/client/lib/computer";
import { contextChoices, isContextLimit } from "@agenteschat/client/lib/context-limits";
import { holdText } from "@agenteschat/client/lib/errors";
import { firstName, namesText } from "@agenteschat/client/lib/format";
import {
  type AiChoice,
  aiChoiceOf,
  gateLine,
  kindOf,
  planHoldOf,
  planLabel,
  planMark,
  planOfAccount,
  planOfKind,
  unsupportedGate,
} from "@agenteschat/client/lib/no-ai";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import {
  brainModelChoice,
  brainModelChoices,
  isPlanId,
  PLAN_IDS,
  planModel as planModelOf,
  planOf,
} from "@agenteschat/client/lib/plans";
import { apiProviderOf, isAuto, keyLine, modelChoices, providerLabel } from "@agenteschat/client/lib/providers";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Icon, type IconName, ProviderLogo, planState } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { modelOptions as apiModelOptions, DEFAULT_KEY } from "@/components/AgentFields";
import type { HaveItem } from "@/components/arrival/ConnectHave";
import { useOrg } from "@/components/org-context";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { limitOffers } from "@/lib/plan-usage";
import { useAgentEdit } from "../context";
import { type BrainMachine, homeFor, useWork } from "./work";

/*
 * What "Quem pensa" reads of the agent's saved brain (ADR 0032 §5, addendum 2026-11-10): every way it can think as
 * one list of rows (the accounts on its computer, that computer's own sign-ins, the workspace's keys, a plan that
 * would move it to another computer), the one in use, its limits, its model and what its notes say. Nothing here is a
 * draft: every screen of the dialog saves its own change.
 */

/** The CLIs a computer's own sign-in can be, each one row where it can think for the agent. */
const OWN_KINDS: readonly MachineAccountKind[] = ["claude_code", "codex", "cursor", "grok", "antigravity", "opencode"];

/** What picking a row does: it is the one in use, it thinks at once, it is taken from another agent, it signs in. */
export type RowAct = "current" | "use" | "move" | "also" | "again" | "locked";

/** One way the agent can think, as the account lists draw it (`HaveItem`) with what saving it needs. */
export interface BrainRow extends HaveItem {
  kind: "account" | "own" | "key" | "plan";
  choice: AiChoice;
  brain: BrainKind;
  /** An account row's login. */
  account?: MachineAccount;
  /** A key row's credential, or `DEFAULT_KEY`; none: whatever key the agent has. */
  keyId?: string;
  act: RowAct;
  current: boolean;
  /** Someone else's plan: its owner hears of it by email. */
  lends: boolean;
  ownerName?: string;
  /** The plan runs on another computer only: the agent moves there first. */
  moves: BrainMachine | null;
}

export function useBrainState(view: AgentBrain, opts: { added: readonly MachineAccount[]; signingIn: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, g, saved, can, ownerFirst } = useAgentEdit();
  const work = useWork();
  const dir = useDirectory(org.id);
  const edition = useComputerEdition(org.id);
  const setupQ = useComputerSetup(org.id);
  const computerSetup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const hold = planHoldOf(edition, org.standing);
  const models = useModels();
  const credentials = useCredentials(org.id, canDo(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  // Answering through the API needs a key: the workspace's own, or the server's.
  const apiKey = useAiStatus(org.id).data?.apiKey !== false;
  const ai = useAiAccounts(org.id, view.canUsePlans);
  const kind = view.brain;
  const savedCard = aiChoiceOf(view);
  const machines = view.machines;
  const nameOf = (name: string) => computerNameOf(t, org.name, name, isPersonal(org));
  const computerName = nameOf(view.computer?.name ?? "");

  // A coding plan thinks through Claude Code on the agent's computer, where its key is: it never moves.
  const homeOf = (c: AiChoice) => {
    if (c === "key") return null;
    if (!isPlanId(c)) return homeFor(kindOf(c), work.machineId, machines);
    const here = machines.find((m) => m.machineId === work.machineId);
    return here?.options.some((o) => o.kind === "claude_code" && o.available) ? here : null;
  };
  const movesOf = (c: AiChoice) => {
    const where = homeOf(c);
    return where && where.machineId !== work.machineId ? where : null;
  };
  const runsHere = (c: AiChoice) => homeOf(c)?.machineId === work.machineId;
  // Accounts live on the agent's computer: none for a plan that would move it elsewhere, or where the app is old.
  const accountsOn = (c: AiChoice) => c !== "key" && view.accountsSupported && view.computer !== null && !movesOf(c);
  // While a sign-in is under way on the agent's computer, no brain there reads as offline.
  const away = (c: AiChoice) => {
    const where = homeOf(c);
    return !where?.online && !(opts.signingIn && where?.machineId === view.computer?.machineId);
  };

  // What a sign-in just reported wins over the last fetch (an account signed in again shows active at once).
  const allAccounts = [
    ...view.accounts.map((v) => opts.added.find((a) => a.id === v.id) ?? v),
    ...opts.added.filter((a) => !view.accounts.some((v) => v.id === a.id)),
  ];
  // A plan thinks only for its owner's agents (ADR 0059 §3): the agent's owner's accounts, which its owner or an admin
  // picks; anyone else's shows only while it is this agent's, or to whoever may use other people's plans.
  const ofOwner = (a: MachineAccount) =>
    view.canUseOthersPlans === true || (view.canUsePlans ? a.mine : a.ownerId === agent.ownerUserId);
  const usable = (a: MachineAccount) =>
    a.mine || view.canUseOthersPlans !== true ? undefined : a.ownerId === agent.ownerUserId || lendable(a, agent.name);
  const listed = allAccounts.filter((a) => ofOwner(a) || a.id === view.account);
  const currentAccount = kind === "model" ? undefined : allAccounts.find((a) => a.id === view.account);
  const rowOf = (machineId: string | undefined) => ai.data?.computers.find((c) => c.machineId === machineId);
  const agentRow = rowOf(view.computer?.machineId);

  // The plans it can think with: Claude's and ChatGPT's, the others where a computer here runs them or it thinks with
  // them, each coding plan with an account there (Connect an AI shows every one).
  const cards: AiChoice[] = [
    "claude",
    "chatgpt",
    ...(["cursor", "zen", "grok", "gemini"] as const).filter(
      (c) =>
        savedCard === c ||
        [view.options, ...machines.map((m) => m.options)].flat().some((o) => o.kind === kindOf(c) && o.available),
    ),
    ...PLAN_IDS.filter((p) => p === savedCard || listed.some((a) => a.provider === p)),
  ];

  /** Where a plan would think, when that says something: none there, its computer off, or the agent moving. */
  const side = (c: AiChoice): { icon: IconName; text: string } | null => {
    if (c === "key" || hold) return null;
    const where = homeOf(c);
    if (!where) return isPlanId(c) ? null : { icon: "block", text: t("agentPage.work.brain.none") };
    if (away(c))
      return {
        icon: "alert",
        text:
          edition === "cloud"
            ? t("agentPage.work.brain.offCloud", { computer: nameOf(where.name) })
            : t("agentPage.work.brain.off", { computer: nameOf(where.name) }),
      };
    if (where.machineId === work.machineId) return null;
    return { icon: "computer", text: t("agentPage.work.brain.moves", { computer: nameOf(where.name) }) };
  };
  /** Why a plan can't think on the agent's computer now, in the words of its panel. */
  const reason = (c: AiChoice) => {
    if (c === "key") return null;
    if (hold) return t("connectAi.billing");
    const k = kindOf(c);
    const o = view.options.find((x) => x.kind === k);
    if (!o?.reason) return null;
    if (o.reason === "no_computer" && edition === "cloud")
      return t("brain.reasons.no_computerCloud", {
        computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org.name }),
      });
    return (
      gateLine(t, {
        gate: unsupportedGate(o.reason, edition, computerSetup),
        edition,
        hold: holdText(t, org.standing),
        kind: k,
        computer: computerName,
        machine: work.machines.data?.find((m) => m.id === view.computer?.machineId),
      })?.text ?? null
    );
  };

  // ── the rows ──
  const mine = { key: "mine", label: t("connectAi.chat.mine") };
  const ownersGroup = view.canUsePlans
    ? mine
    : { key: `owner:${agent.ownerUserId}`, label: t("agentPage.work.brain.accountOf", { name: ownerFirst ?? "" }) };
  const ownersWhose = view.canUsePlans ? t("connectAi.chat.yours") : ownersGroup.label;
  const signs = view.canManageAccounts && !hold;
  const accountRow = (c: AccountChoice<MachineAccount>): BrainRow | null => {
    const a = c.login;
    const plan = planOfAccount(a);
    const current = a.id === view.account && kind !== "model";
    const others = [...new Set(a.usedBy)].filter((n) => n !== agent.name);
    const taken = others.length > 0 && a.shared !== true;
    const may = usable(a) ?? a.mine;
    let act: RowAct;
    if (current) act = "current";
    else if (!may) act = "locked";
    else if (c.also) act = signs && a.mine ? "also" : "locked";
    else if (a.status === "signed_out") {
      // A signed-out login another agent thinks with thinks for nobody until its owner signs it in again.
      if (taken) return null;
      act = signs && a.mine ? "again" : "locked";
    } else act = taken ? "move" : "use";
    const whose = a.mine
      ? t("connectAi.chat.yours")
      : t("agentPage.work.brain.accountOf", { name: firstName(a.ownerName ?? "") });
    const alsoUsed =
      others.length > 0 && a.shared === true
        ? t("agentPage.work.brain.accountAlso", { agents: namesText(t, others, 2) })
        : undefined;
    return {
      id: `account:${a.id}`,
      kind: "account",
      choice: plan,
      brain: a.kind,
      account: a,
      act,
      current,
      title: accountTitle(a),
      // Under its owner's name the group says whose it is; the one in use says it on its own line.
      about: !a.mine && !current ? undefined : (alsoUsed ?? accountAbout(t, c, agent.name)),
      whose,
      group: a.mine ? mine : { key: `owner:${a.ownerId}`, label: whose },
      mark: <ProviderLogo id={a.provider ?? a.kind} size="xs" />,
      usage: a.usage,
      // An account lives on the agent's computer: it thinks there only if its plan runs there.
      off: act === "locked" || (!current && !runsHere(plan)),
      signIn: act === "also" || act === "again",
      lends: !a.mine && a.ownerId !== agent.ownerUserId,
      ownerName: firstName(a.ownerName ?? ""),
      moves: null,
    };
  };
  const accountRows = accountChoices(listed, [view.account]).flatMap((c) => {
    const r = accountRow(c);
    return r ? [r] : [];
  });

  // The computer's own sign-ins (Claude's, ChatGPT's…; OpenCode's free models), each where it can think for the agent.
  const ownRows: BrainRow[] = OWN_KINDS.flatMap((k): BrainRow[] => {
    const plan = planOfKind(k);
    if (!accountsOn(plan) || !ownSignInListed(view, agentRow, k)) return [];
    const current = kind === k && view.account === null;
    const ownPlan = agentRow?.own?.[k]?.plan ?? null;
    return [
      {
        id: `own:${k}`,
        kind: "own",
        choice: plan,
        brain: k,
        act: current ? "current" : "use",
        current,
        title: ownSignInName(t, view.ownSignIn && view.canUsePlans, computerName, k),
        about: ownPlan ? ownSignInTitle(t, { kind: k, plan: ownPlan }) : undefined,
        whose: ownersWhose,
        group: ownersGroup,
        mark: <ProviderLogo id={k} size="xs" />,
        usage: view.ownUsage[k] ?? null,
        off: !current && !runsHere(plan),
        lends: false,
        moves: null,
      },
    ];
  });

  // The workspace's keys, for whoever may pick one (admins); anyone else gets the API as the agent has it.
  const all = models.data?.models ?? [];
  const apiProvider = apiProviderOf(saved.model, all);
  const keyMark = (provider: string | undefined) =>
    provider ? <ProviderLogo id={provider} size="xs" /> : <Icon name="key" size={16} className="arrival-have__mark" />;
  const keysGroup = { key: "keys", label: t("connectAi.chat.keys") };
  const keyCurrent = saved.key ?? DEFAULT_KEY;
  const keyRow = (keyId: string | undefined, title: string, about: string | undefined, provider?: string): BrainRow => {
    const current = kind === "model" && (keyId === undefined || keyId === keyCurrent);
    return {
      id: `key:${keyId ?? "agent"}`,
      kind: "key",
      choice: "key",
      brain: "model",
      ...(keyId ? { keyId } : {}),
      act: current ? "current" : "use",
      current,
      title,
      about,
      whose: keysGroup.label,
      group: keysGroup,
      mark: keyMark(provider),
      usage: null,
      isKey: true,
      lends: false,
      moves: null,
    };
  };
  // On a billing hold a key is no way forward; one it already thinks with stays on show.
  const keysShown = can("brain") && (!hold || savedCard === "key");
  const live = (credentials.data ?? []).filter((c) => !c.revokedAt);
  const defaultId = settings.data?.defaultCredentialId ?? null;
  const def = live.find((c) => c.id === defaultId);
  const keyRows: BrainRow[] = !keysShown
    ? []
    : can("model") && credentials.data
      ? [
          keyRow(
            DEFAULT_KEY,
            t("newAgent.defaultKey"),
            def
              ? t("newAgent.defaultKeyDesc", { provider: providerLabel(def.provider), hint: def.keyHint })
              : t("agentPage.work.brain.modelText", g),
            def?.provider ?? apiProvider,
          ),
          ...live.filter((c) => c.id !== defaultId).map((c) => keyRow(c.id, c.label, keyLine(t, c), c.provider)),
        ]
      : [keyRow(undefined, t("agentPage.work.brain.model"), t("agentPage.work.brain.modelText", g), apiProvider)];

  // A plan whose accounts aren't listed here (it would move the agent, or the app there is too old): the plan itself.
  const planRow = (c: AiChoice, about?: string | null): BrainRow => ({
    id: `plan:${c}`,
    kind: "plan",
    choice: c,
    brain: c === "key" ? "model" : kindOf(c),
    act: savedCard === c ? "current" : "use",
    current: savedCard === c,
    title: c === "key" ? t("agentPage.work.brain.model") : planLabel(t, c),
    about:
      about ??
      side(c)?.text ??
      (c === "key"
        ? undefined
        : !view.canUsePlans && ownerFirst
          ? t("agentPage.work.brain.planTextOf", { plan: planLabel(t, c), owner: ownerFirst })
          : t("agentPage.work.brain.planText", { plan: planLabel(t, c) })),
    whose: ownersWhose,
    group: ownersGroup,
    mark: c === "key" ? keyMark(apiProvider) : <ProviderLogo id={planMark(c)} size="xs" />,
    usage: null,
    off: savedCard !== c && !homeOf(c),
    lends: false,
    moves: movesOf(c),
  });
  const planRows = cards.filter((c) => c !== "key" && !accountsOn(c) && homeOf(c)).map((c) => planRow(c));

  const every = [...accountRows, ...ownRows, ...keyRows, ...planRows];
  // What it thinks with now always has its row, even when nothing of that plan is listed (no sign-in there yet).
  const currentRow =
    every.find((r) => r.current) ??
    (savedCard === "key"
      ? keyRow(undefined, t("agentPage.work.brain.model"), t("agentPage.work.brain.modelText", g), apiProvider)
      : planRow(savedCard, reason(savedCard) ?? side(savedCard)?.text ?? null));
  const rows = every.filter((r) => !r.current);

  // ── the account in use ──
  const usage: PlanUsage | null = currentRow?.usage ?? null;
  const limitedNow = usage ? planState(usage).state === "limited" : false;
  // At its limit, its owner's free accounts of the same plan with room, never another agent's (`limitOffers`).
  const offers =
    limitedNow && kind !== "model"
      ? limitOffers(listed, kind, view.account).flatMap(({ account }) => {
          const r = accountRow({ login: account, usedBy: account.usedBy, also: false });
          return r && !r.off && (r.act === "use" || r.act === "move") ? [r] : [];
        })
      : [];
  const signedOut = currentAccount != null && signInOf(currentAccount) === "signed_out" && currentAccount.mine;
  const unknown = currentAccount != null && signInOf(currentAccount) === "unknown";
  const signInAgain = currentAccount != null && offersSignInAgain(currentAccount) && currentAccount.mine && signs;
  // The others of the person's agents on the account in use, when it thinks for all of them ("Todos nesta conta").
  const team =
    currentAccount?.shared === true
      ? (currentAccount.usedByIds ?? []).flatMap((id) => {
          const a = id === agent.id ? undefined : dir.agentById.get(id);
          return a && a.ownerUserId === agent.ownerUserId ? [a] : [];
        })
      : [];
  /** Switching to `row` may take the others on the account in use along: only to one that thinks for all of them. */
  const takesTeam = (row: BrainRow) =>
    team.length > 0 &&
    ((row.kind === "account" && row.account?.shared === true && row.act === "use") || row.kind === "own");

  // ── the model ──
  const option = (homeOf(savedCard)?.options ?? view.options).find((o) => o.kind === kind);
  const plan = isPlanId(savedCard) ? planOf(savedCard) : undefined;
  const planModels = brainModelChoices(plan, option?.models ?? [], currentAccount?.provider);
  const shownModel = brainModelChoice(kind, plan, view.effectiveModel ?? option?.defaultModel ?? "");
  const keyModels = apiModelOptions(
    t,
    i18n.language,
    modelChoices(all, credentials.data ?? [], platform.data ?? false),
  );
  const modelNow = kind === "model" ? saved.model : view.effectiveModel;
  const modelName = isAuto(modelNow)
    ? t("brain.auto.label")
    : kind === "model"
      ? (all.find((m) => m.id === saved.model)?.label ?? saved.model)
      : (planModels.find((m) => m.value === shownModel)?.label ?? view.effectiveModel ?? "");
  const modelMaker =
    kind === "model"
      ? apiProvider
      : (planModels.find((m) => m.value === shownModel)?.maker ??
        (savedCard === "key" ? undefined : planMark(savedCard)));

  // ── how it thinks ──
  const speedOn = viewSpeedFits(view);
  const savedContext = isContextLimit(view.contextTokens) ? view.contextTokens : null;
  // The context limits worth offering with the model chosen: under its window ("Automático": any of its line).
  const contextOptions = contextChoices(
    kind === "model"
      ? isAuto(saved.model)
        ? undefined
        : all.find((m) => m.id === saved.model)
      : isAuto(view.effectiveModel)
        ? undefined
        : plan
          ? { modelId: planModelOf(plan, view.effectiveModel).id }
          : option?.models.find((m) => m.value === (view.effectiveModel ?? option?.defaultModel)),
  );
  const shownContext = savedContext !== null && contextOptions.includes(savedContext) ? savedContext : null;
  const moreLine = advancedContents(t, { kind, autoModel: isAuto(modelNow), speed: speedOn });
  // The computers this brain runs on: a choice of its own only where there are several.
  const runsOn = kind === "model" ? [] : machines.filter((m) => m.options.some((o) => o.kind === kind && o.available));

  return {
    t,
    kind,
    savedCard,
    hold,
    edition,
    apiKey,
    computerName,
    nameOf,
    homeOf,
    side,
    reason,
    agentRow,
    allAccounts,
    listed,
    currentAccount,
    currentRow,
    rows,
    usage,
    limitedNow,
    offers,
    signedOut,
    unknown,
    signInAgain,
    team,
    takesTeam,
    option,
    plan,
    planModels,
    shownModel,
    keyModels,
    modelNow,
    modelName,
    modelMaker,
    apiProvider,
    speedOn,
    savedContext,
    shownContext,
    contextOptions,
    moreLine,
    runsOn,
    effort: effortLevel(view.effort),
    models: all,
    credentials: credentials.data ?? [],
  };
}

export type BrainState = ReturnType<typeof useBrainState>;
