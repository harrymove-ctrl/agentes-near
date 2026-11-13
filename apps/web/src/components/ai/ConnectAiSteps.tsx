import type { BrainScope, Credential, Edition, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useAiAccounts,
  useApi,
  useAuthConfig,
  useComputerSetup,
  useMachines,
  useModels,
} from "@agenteschat/client";
import {
  type AccountChoice,
  accountAbout,
  accountTitle,
  existingAi,
  groupPlans,
  ownSignInLower,
  planWordOf,
  signInPlan,
} from "@agenteschat/client/lib/ai-accounts";
import { answersOthers, audienceOf } from "@agenteschat/client/lib/audience";
import type { BillingHold } from "@agenteschat/client/lib/billing";
import {
  computerEdition,
  computerName,
  etaLine,
  managedNamed,
  setupView,
  statusRestatesChip,
} from "@agenteschat/client/lib/computer";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, holdText, keyRefusal } from "@agenteschat/client/lib/errors";
import { NAMES_SHOWN, namesText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AiChoice,
  ALL_AGENTS,
  behindComputer,
  catchUp,
  dimmedLine,
  type ExistingSignIn,
  freePlanAccount,
  gateDims,
  gateLine,
  kindOf,
  ownSignInFor,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planGateWithoutAgent,
  planHoldOf,
  planLabel,
  planMark,
  planOfAccount,
  planPickText,
  planTitle,
  signsInOnce,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import {
  geminiPersonal,
  isPlanId,
  planOf,
  planReplies,
  providerFitsChoice,
  signInProviderOf,
} from "@agenteschat/client/lib/plans";
import {
  AUTO,
  keyLine,
  keyLooksValid,
  keyRuns,
  keyStepHint,
  type ProviderId,
  providerLabel,
  providerOf,
} from "@agenteschat/client/lib/providers";
import { rightHandOnKey, thinksWithLine } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentAppearance,
  AvatarStack,
  Button,
  Card,
  Icon,
  InfoHint,
  Input,
  Locked,
  OptionCard,
  ProviderLogo,
  Segmented,
  Select,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { matchesWords } from "@agenteschat/ui/search";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useOrg } from "@/components/org-context";
import { KeyMismatch, KeyRefused, ProviderSelect } from "@/components/ProviderKey";
import { managedOf, SetupProgress, useSetupWait, useWaitReader } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { planWord } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { AddAccount, OpenPage, Step, StepTitle } from "./AddAccountFlow";
import { PlanReplies, usePlanRepliesShown } from "./PlanReplies";
import { ToolOffSteps } from "./ToolOffSteps";

/*
 * One picker wherever an AI is connected (the setup's AI step, Connect an AI, Settings › AI accounts): for one agent
 * with no AI what the person already has (`ExistingRows`), then a plan or an API key, and one select of whose, by
 * their makers' marks; the chosen option's panel right under it. A plan
 * signs in on the agent's computer (ADR 0059): while the workspace's computer is on its way, its panel waits in
 * place and turns on by itself, with what needs no computer (a maker's page, a key to paste) on meanwhile.
 */

/**
 * What each plan can do now for one agent (`planGate`), from its brain view, its computer's accounts row and the
 * workspace's setup. `poll`: asked again this often where no event keeps them current (the setup opens no socket).
 */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const api = useApi();
  const { org } = useOrg();
  const asks = agentId !== undefined;
  const brain = useAgentBrain(orgId, agentId ?? "", asks, poll);
  const ai = useAiAccounts(orgId, asks, poll);
  // Codex's own sign-in is known only by a usage read with it: looked up again here (it comes back as
  // `machine.updated`, or with the next poll), so a computer's own ChatGPT sign-in shows before any turn ran.
  useEffect(() => {
    if (asks) void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId, asks]);
  const setupQ = useComputerSetup(orgId);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const view = brain.data;
  const row = ai.data?.computers.find((c) => c.machineId === view?.computer?.machineId);
  // Once ready, the workspace's computer is every agent's: a view from before that still has none is asked again
  // now with the accounts (a coding plan reads that computer's row there), not at their next poll. Until both
  // answers are in (`catchUp`, bounded), every plan reads as ready with its sign-in loading, as the rest of the page
  // says ready. Asked once per agent: still none after it, and nothing is coming (`caughtUp`).
  const behind = behindComputer({ edition, setup, brain: view });
  const [caughtUp, setCaughtUp] = useState<string>();
  const caught = agentId !== undefined && caughtUp === agentId;
  const [asking, setAsking] = useState(false);
  const { refetch: brainAgain } = brain;
  const { refetch: accountsAgain } = ai;
  useEffect(() => {
    if (!behind || caught) return;
    setAsking(true);
    void catchUp([brainAgain(), accountsAgain()]).then(() => {
      setAsking(false);
      setCaughtUp(agentId);
    });
  }, [behind, caught, agentId, brainAgain, accountsAgain]);
  const catching = (behind && !caught) || asking;
  // A panel here waited for that computer: once it's ready, it says so whenever it shows again (another plan, another
  // step and back).
  const [waited, setWaited] = useState(false);
  const markWaited = useCallback(() => setWaited(true), []);
  const gateOf = (choice: PlanChoice): PlanGate =>
    catching
      ? { state: "ready" }
      : planGate({
          choice,
          edition,
          setup,
          // A coding plan also needs to know whether that computer takes a plan's key, and Claude or ChatGPT on a
          // computer the person connected whether its own sign-in is there (`ownSignInFor`).
          brain: view && (ai.data || !(isPlanId(choice) || view.ownSignIn)) ? view : undefined,
          computer: row,
          caughtUp: caught,
          standing: org.standing,
        });
  // A poll that fails once keeps the last view: a sign-in in progress goes on. A read that failed with nothing to show
  // ends the panel's wait with Tentar de novo.
  const failed = (brain.isError && !view) || (ai.isError && !ai.data) || (setupQ.isError && !setupQ.data);
  const { refetch: setupAgain } = setupQ;
  const retry = useCallback(() => {
    for (const again of [brainAgain, accountsAgain, setupAgain]) void again();
  }, [brainAgain, accountsAgain, setupAgain]);
  return { gateOf, view, row, failed, retry, edition, waited, markWaited, catching };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/**
 * Which one the person pays with, a plan or an API key, then one select of whose (a plan that can't sign in dims, and
 * still opens its panel), with the chosen option's `panel` right under it: nothing comes between an option and its
 * steps. `have`: what the person already has (`ExistingRows`), before them; with `choice` null one of its rows is
 * chosen, and it gets the panel. `keySelect`: the key's makers (its draft is the caller's), when one may be chosen.
 */
export function AiPicker({
  choice,
  onPick,
  dims,
  panel,
  have,
  keySelect,
  busy = false,
}: {
  choice: AiChoice | null;
  onPick: (choice: AiChoice) => void;
  dims?: (choice: PlanChoice) => boolean;
  panel: ReactNode;
  have?: (panel: ReactNode) => ReactNode;
  keySelect?: ReactNode;
  /** A key is saving: the choice waits for it. */
  busy?: boolean;
}) {
  const { t } = useTranslation();
  // Back from the key, the plan it left.
  const lastPlan = useRef<PlanChoice>("claude");
  if (choice && choice !== "key") lastPlan.current = choice;
  return (
    // biome-ignore lint/a11y/useSemanticElements: rows and selects, not a native fieldset
    <div className="ai-picker" role="group" aria-label={t("onboarding.keyStep.title")}>
      {have?.(choice === null && panel)}
      <Segmented
        block
        label={t("connectAi.pay.label")}
        disabled={busy}
        value={choice === "key" ? "key" : "plan"}
        onValueChange={(next) => onPick(next === "key" ? "key" : lastPlan.current)}
        options={[
          { value: "plan", label: t("connectAi.pay.plan") },
          { value: "key", label: t("connectAi.pay.key") },
        ]}
      />
      {choice === "key" ? (
        keySelect
      ) : (
        <ProviderSelect<PlanChoice>
          aria-label={t("connectAi.pick.plan")}
          placeholder={t("connectAi.pick.placeholder")}
          value={choice ?? undefined}
          onValueChange={onPick}
          matches={(o, q) => matchesWords(planPickText(t, o.value), q)}
          options={PLAN_CHOICES.map((c) => ({
            value: c,
            label: planLabel(t, c),
            leading: <ProviderLogo id={planMark(c)} size="xs" off={dims?.(c)} />,
          }))}
        />
      )}
      {choice !== null && panel}
    </div>
  );
}

/**
 * An account as an agent's account choice shows it (Quem pensa's list, Connect an AI's first rows): its name and plan,
 * the line under it with its plan's state, its maker's mark. Only its owner picks it, unless `usable` says otherwise
 * (someone else's plan for a person who may use other people's plans).
 */
export function accountOption(
  t: TFunction,
  locale: string,
  choice: AccountChoice<MachineAccount>,
  agentName: string,
  usable?: boolean,
) {
  const a = choice.login;
  return {
    label: accountTitle(a),
    description:
      [accountAbout(t, choice, agentName), planWord(t, locale, a.usage)].filter(Boolean).join(" · ") || undefined,
    leading: <ProviderLogo id={a.provider ?? a.kind} size="sm" />,
    disabled: !(usable ?? a.mine),
  };
}

/** What an agent thinks with after a row of what the person already had: an account (`account`), or a key. */
export interface ExistingUsed {
  label: string;
  choice: AiChoice;
  account?: MachineAccount;
  /** On a plan: it answers only its owner (ADR 0059 §5). */
  onlyOwner: boolean;
  /** The team's right hand's own AI for the person (ADR 0137 §11): it serves them alone, so no switch. */
  personal?: boolean;
  /** Which of the team's right hand's AIs moved: the words say whose it is. */
  scope?: BrainScope;
}

/**
 * What the person already has for one agent (`existingAi`) and what using a row does: an account moves the agent onto
 * it, a workspace key puts it on the workspace's model with that key. Shared by the picker's rows (`ExistingRows`) and
 * the conversation's Connect, which picks one and then confirms it.
 */
export function useExistingAi({
  gates,
  agent,
  credentials,
  toEveryone = false,
  withOwn = false,
  onUsed,
}: {
  gates: PlanGates;
  agent: PlanAgent;
  credentials: readonly Credential[];
  toEveryone?: boolean;
  /** The account the agent is set to think with is listed too: it has no AI, so that sign-in ended or never began. */
  withOwn?: boolean;
  onUsed: (agentId: string, used: ExistingUsed) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const models = useModels();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<ReturnType<typeof keyRefusal>>(null);
  const view = gates.view?.agentId === agent.id ? gates.view : undefined;
  const rows = view ? existingAi(withOwn ? { ...view, account: null } : view, credentials) : null;
  const save = async (run: () => Promise<ExistingUsed>) => {
    setBusy(true);
    setRefused(null);
    try {
      const used = await run();
      for (const key of [
        keys.agentBrain(org.id, agent.id),
        keys.agents(org.id),
        keys.aiAccounts(org.id),
        keys.aiStatus(org.id),
      ])
        void qc.invalidateQueries({ queryKey: key });
      onUsed(agent.id, used);
    } catch (error) {
      const refusal = keyRefusal(t, error);
      setRefused(refusal);
      if (!refusal) toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  const pickAccount = (a: MachineAccount, move: boolean) =>
    save(async () => {
      const next = await api.agents.setBrain(org.id, agent.id, {
        brain: a.kind,
        account: a.id,
        ...(move ? { moveAccount: true } : {}),
        ...(toEveryone ? { onlyOwner: false } : {}),
      });
      return {
        label: a.label,
        choice: planOfAccount(a),
        account: a,
        onlyOwner: next.onlyOwner,
        personal: next.scope === "mine",
        ...(next.scope ? { scope: next.scope } : {}),
      };
    });
  // The workspace's model on that key: the agent's model where the key runs it, else Automático, which follows the key.
  // Tried first: a key kept earlier may have run out of credit, and "now thinks with it" has to be true.
  const pickKey = (key: Credential) =>
    save(async () => {
      const { check } = await api.agents.checkCredential(org.id, key.id);
      if (check === "unchecked")
        toast.show(t("connectAi.key.savedUnchecked", { provider: providerLabel(key.provider) }), "info");
      const row = dir.agentById.get(agent.id);
      // The team's right hand: a key is the workspace's AI, so everyone without their own thinks with it.
      if (view?.scope === "mine" && row) {
        await rightHandOnKey(api, org.id, row, key, models.data?.models ?? []);
        return { label: key.label, choice: "key", onlyOwner: false, scope: "workspace" };
      }
      const fits = keyRuns(key, row?.model, models.data?.models ?? []);
      if (view?.brain !== "model") await api.agents.setBrain(org.id, agent.id, { brain: "model" });
      await api.agents.update(org.id, agent.id, { credentialId: key.id, ...(fits ? {} : { model: AUTO }) });
      return { label: key.label, choice: "key", onlyOwner: false };
    });
  return { rows, busy, refused, pickAccount, pickKey };
}

/**
 * What the person already has for one agent with no AI (`existingAi`), as the picker's first rows, under a line that
 * says so: an account on its computer used in one click, no sign-in (taken from the agent on it where it may think
 * for one agent only), or signed in once more for this agent in its plan's panel (`onSignIn`, the panel right under
 * its row); a workspace key in one click on the workspace's model, with the budget line; someone else's account shown,
 * locked. A plan that can't run on that computer dims its rows, as its tile.
 */
export function ExistingRows({
  gates,
  agent,
  credentials,
  named = false,
  signIn,
  panel,
  toEveryone = false,
  onSignIn,
  onUsed,
  onManageKeys,
}: {
  /** The agent's own (`usePlanGates`): its accounts, and what each plan can do there. */
  gates: PlanGates;
  agent: PlanAgent;
  /** The workspace's keys the person may give it (none for someone who may not). */
  credentials: readonly Credential[];
  /** The line says for whom (the title doesn't). */
  named?: boolean;
  signIn?: ExistingSignIn | null;
  /** That sign-in's plan panel, from `AiPicker`. */
  panel?: ReactNode;
  /** A plan picked here lets everyone talk to it ("Responde a todos" on where the caller keeps it). */
  toEveryone?: boolean;
  onSignIn: (signIn: ExistingSignIn) => void;
  onUsed: (agentId: string, used: ExistingUsed) => void;
  /** Where a key shown here is removed: Settings › AI accounts. */
  onManageKeys?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const {
    rows: found,
    busy,
    refused,
    pickAccount,
    pickKey,
  } = useExistingAi({
    gates,
    agent,
    credentials,
    toEveryone,
    onUsed,
  });
  const view = gates.view;
  if (!view || !found) return null;
  const rows = found;
  if (rows.length === 0 && !panel) return null;
  const g = agentGrammar(agent.name);
  // A row a plan's gate dims is off for a reason the panel under the picker may not be showing: said once, under them.
  const dimmed = rows.flatMap((r) => {
    if (r.kind !== "account") return [];
    const gate = gates.gateOf(planOfAccount(r.choice.login));
    return gateDims(gate) ? [{ gate, kind: r.choice.login.kind }] : [];
  })[0];
  const dimmedWhy =
    dimmed &&
    dimmedLine(t, dimmed.gate, {
      ...dimmed,
      edition: gates.edition,
      computer: computerName(t, org.name, managedNamed(view.computer), isPersonal(org)),
    });
  const items = rows.map((r) => {
    if (r.kind === "key") {
      const k = r.key;
      return (
        <OptionCard
          key={k.id}
          pressed={false}
          disabled={busy}
          onClick={() => void pickKey(k)}
          className="ai-picker__key ac-mediarow ac-mediarow--row"
        >
          <span className="ac-mediarow__face">
            <ProviderLogo id={k.provider} size="sm" />
          </span>
          <span className="ac-mediarow__head">
            <span className="ac-option__title">{k.label}</span>
          </span>
          <span className="ac-mediarow__body">
            <span className="ac-option__desc">{keyLine(t, k)}</span>
            <span className="ac-option__desc">{t("agentPage.work.brain.modelText", g)}</span>
          </span>
        </OptionCard>
      );
    }
    const a = r.choice.login;
    const option = accountOption(t, i18n.language, r.choice, agent.name);
    const choice = planOfAccount(a);
    const pick = () => {
      if (r.act === "use" || r.act === "move") void pickAccount(a, r.act === "move");
      else if (r.act === "also") onSignIn({ choice, from: a.id, email: a.email });
      else if (r.act === "again") onSignIn({ choice, from: a.id, again: a.id, email: a.email });
    };
    return (
      <OptionCard
        key={a.id}
        pressed={signIn?.from === a.id}
        disabled={r.act === "locked" || busy || gateDims(gates.gateOf(choice))}
        onClick={pick}
        className="ai-picker__key ac-mediarow ac-mediarow--row"
      >
        <span className="ac-mediarow__face">{option.leading}</span>
        <span className="ac-mediarow__head">
          <span className="ac-option__title">{option.label}</span>
        </span>
        {option.description && (
          <span className="ac-mediarow__body">
            <span className="ac-option__desc">{option.description}</span>
          </span>
        )}
      </OptionCard>
    );
  });
  // The panel under its row, keyed among the rows so it stays mounted as they change: once the sign-in makes that login
  // this agent's, the row leaves the list, and the panel, saying it's done, stays after the others.
  if (panel) {
    const at = rows.findIndex((r) => r.kind === "account" && r.choice.login.id === signIn?.from);
    items.splice(at < 0 ? items.length : at + 1, 0, <Fragment key="panel">{panel}</Fragment>);
  }
  // Someone else's plan, for whoever may use other people's plans: its owner hears it and may take it back.
  const ownerId = dir.agentById.get(agent.id)?.ownerUserId;
  const lends = rows.some(
    (r) => r.kind === "account" && !r.choice.login.mine && r.choice.login.ownerId !== ownerId && r.act === "use",
  );
  return (
    <>
      <p className="ai-picker__or">{named ? t("connectAi.have.titleFor", g) : t("connectAi.have.title")}</p>
      {items}
      {dimmedWhy && <SettingNote icon="alert">{dimmedWhy}</SettingNote>}
      {refused && <KeyRefused refusal={refused} />}
      {lends && <p className="ai-picker__or ai-picker__or--note">{t("agentPage.work.brain.accountOthers")}</p>}
      {onManageKeys && rows.some((r) => r.kind === "key") && (
        <p className="ai-picker__or ai-picker__or--note">
          <button type="button" className="ac-link ac-link--muted" onClick={onManageKeys}>
            {t("connectAi.have.manageKeys")}
          </button>
        </p>
      )}
      <p className="ai-picker__or">{t("connectAi.have.other")}</p>
    </>
  );
}

/** After a row of what the person already had: what the agent thinks with now, and on a plan whom it answers. */
export function ExistingThinks({ agent, used }: { agent: PlanAgent; used: ExistingUsed }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [on, setOn] = useState(!used.onlyOwner);
  const [busy, setBusy] = useState(false);
  const repliesShown = usePlanRepliesShown(on);
  const a = used.account;
  const reply = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    try {
      const saved = await api.agents.setBrain(org.id, agent.id, { onlyOwner: !next });
      // The server keeps "Só algumas pessoas" with nobody picked as it is: the switch shows what it saved.
      setOn(!saved.onlyOwner);
      if (next && saved.onlyOwner) toast.show(t("aiAccounts.share.pickPeople", agentGrammar(agent.name)), "info");
      void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) });
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
    } catch {
      setOn(!next);
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="section" className="ai-panel ai-panel--plan" aria-label={used.label}>
      <SettingNote icon="check" live>
        {thinksWithLine(t, used.scope, agent.name, used.label)}
      </SettingNote>
      {a?.kind === "antigravity" && geminiPersonal(a) && (
        <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>
      )}
      {a && !used.personal && repliesShown && (
        <div className="ac-card__foot ac-iconline ai-panel__replies">
          <Icon name={on ? "audienceEveryone" : "audienceOwner"} size={14} />
          <PlanReplies
            agent={agent.name}
            on={on}
            onChange={(v) => void reply(v)}
            brain={a.kind}
            plan={a.plan}
            coding={planOf(a.provider)}
            disabled={busy}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * A panel's head: the option's mark, its name with what it covers under it (the name's capitals at the mark's top),
 * and (aside) for whom.
 */
function PanelHead({ lead, title, sub, aside }: { lead: ReactNode; title: string; sub: string; aside?: ReactNode }) {
  return (
    <div className="ai-panel__head ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">{lead}</span>
      <span className="ac-mediarow__head">
        <b className="ai-panel__name">{title}</b>
      </span>
      {aside && <span className="ac-mediarow__end ac-mediarow__end--wrap">{aside}</span>}
      <span className="ac-mediarow__body ai-panel__sub">{sub}</span>
    </div>
  );
}

/** An agent a plan may think for, as the "For" select and the who row draw it. */
export interface PlanAgent {
  id: string;
  name: string;
  appearance?: AgentAppearance;
  initials?: string;
}

/** An agent of "All agents"; `done`: it already thinks with this plan. */
export type PlanSetAgent = PlanAgent & { done?: boolean };

export interface PlanPanelProps {
  choice: PlanChoice;
  gates: PlanGates;
  /** The viewer's agents a plan may think for, in the order offered; the select shows with more than one. */
  agents: PlanAgent[];
  /** "All agents" for this plan (`allAgents`): none where it signs in once per account. */
  all: PlanSetAgent[];
  /** An agent's id, or `ALL_AGENTS` (`defaultTarget`). */
  target: string | undefined;
  onTarget: (target: string) => void;
  /** Why this person connects no plan here (an agent of someone else's, no agent of their own): nothing else shows. */
  locked?: ReactNode;
  /**
   * The setup on a computer the person connected: its own sign-in thinks for every agent, chosen or not (saved by
   * the caller). Elsewhere, choosing it saves it for the agent at once.
   */
  own?: { chosen: boolean; onChoose: (own: boolean) => void };
  /** This server's own computer, picked a step before and not connected yet. */
  hostConnecting?: boolean;
  /** The person came because the computer just got ready (its email, its notification): said first, once it is. */
  justReady?: boolean;
  /**
   * The setup's rail beside the panel says where the computer is: a line that would only say it again stays out, as
   * `SetupProgress`'s `said`.
   */
  said?: boolean;
  /**
   * "Atende outras pessoas" kept by the caller, which saves the computer's own sign-in for every agent itself (the
   * setup).
   */
  replies?: { on: boolean; onChange: (on: boolean) => void };
  /** A row of what the person already has signs in here, for the one agent: that sign-in, never the agent's own. */
  login?: ExistingSignIn;
  /**
   * An account of this plan picked before the panel opened (the stage's "Use …" card): whom the panel is for moves
   * onto it as soon as the plan is ready there, with no second click.
   */
  use?: MachineAccount;
  /**
   * Under the conversation's Connect, which already says whom it is for: no list of the agents, and an account the
   * person already has is a button to use it, with another sign-in as the quiet one beside it.
   */
  plain?: boolean;
  /**
   * With `plain`: where the dialog keeps its footer. The account to use and another sign-in go there, as the dialog's
   * main action and the one beside it.
   */
  actionsAt?: HTMLElement | null;
  /** "Usar uma chave de API agora": the API key row. */
  onKey: () => void;
  /**
   * Self-host with no computer for the agent: where one is connected. None on the onboarding, whose workspace pages
   * don't open until it ends (the org route sends them back to it): the panel says a computer comes after, and offers
   * the key.
   */
  onComputer?: () => void;
  /**
   * These agents think with the plan now: the account they signed in (null: the computer's own sign-in). With
   * `onSkip`, none when every agent was passed over.
   */
  onDone: (agentIds: string[], account: MachineAccount | null) => void;
  /**
   * One login per agent in turn (the team's Connect, ADR 0160 addendum): an agent passed over after its login didn't
   * end, with why. Given, any agent may be skipped, the last one too.
   */
  onSkip?: (agentId: string, why: string | null) => void;
  /**
   * One agent thinks with the account it signed in, the others of "All agents" maybe still to go: kept by a caller
   * that knows only what `onDone` says (the setup), so the panel shown again (another tile and back) goes on from the
   * next agent, never signing this one in twice.
   */
  onAssigned?: (agentId: string, account: MachineAccount) => void;
  /**
   * A key or a code went to the computer, or an agent is being moved onto the plan: whom the panel is for, and whose
   * computer it reads, must hold from here, though the agents it moves get an AI meanwhile.
   */
  onStart?: () => void;
}

/** `usePlanGates` for a person who owns no agent yet: each plan's gate on the computer it would sign in on. */
export function useGatesWithoutAgent(orgId: string, on: boolean) {
  const { org } = useOrg();
  const ai = useAiAccounts(orgId, on);
  const machines = useMachines(orgId, on);
  const setupQ = useComputerSetup(orgId);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const at = (choice: PlanChoice) =>
    planGateWithoutAgent({
      choice,
      edition,
      setup,
      computers: ai.data?.computers,
      machines: machines.data,
      standing: org.standing,
    });
  return { at, edition, accounts: ai.data?.accounts };
}

export type GatesWithoutAgent = ReturnType<typeof useGatesWithoutAgent>;

/**
 * A plan's panel for a person who owns no agent yet: it signs in on a computer they may add accounts to, waiting and
 * saying why as `PlanPanel` does, and the account then thinks for the agents they create there.
 */
export function PlanWithoutAgent({
  choice,
  gates,
  mayAddKey,
  onKey,
  onComputer,
  onDone,
}: {
  choice: PlanChoice;
  gates: GatesWithoutAgent;
  /** Only an admin adds an API key: the way on from someone else's computer for them. */
  mayAddKey: boolean;
  onKey: () => void;
  /** None on the onboarding (`PlanPanelProps.onComputer`). */
  onComputer?: () => void;
  onDone: (account: MachineAccount) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id, gates.edition !== null);
  const [signingIn, setSigningIn] = useState(false);
  const [added, setAdded] = useState<MachineAccount | null>(null);
  const { gate, computer } = gates.at(choice);
  // An account of this plan they already have (their agents deleted) thinks for the next one: no second sign-in.
  const has = added ?? freePlanAccount(gates.accounts, choice);
  const title = planTitle(t, choice);
  const cloud = gates.edition === "cloud";
  const name = cloud ? computerName(t, org.name, managedOf(machines.data), isPersonal(org)) : (computer?.name ?? "");
  const steps = gate.state === "ready" || gate.state === "preparing" || (gate.state === "offline" && signingIn);
  // Only whoever connected the computers there signs a plan in on them: a computer of their own is the way on.
  const elsewhere = gate.state === "locked" && !cloud;
  return (
    <Card as="section" className="ai-panel ai-panel--plan" aria-label={title}>
      <PanelHead
        lead={<ProviderLogo id={planMark(choice)} size="sm" />}
        title={title}
        sub={t(`connectAi.plan.${choice}.tiers`)}
      />
      {has ? (
        <>
          <SettingNote icon="check" live>
            {t("connectAi.forNewAgents", { label: has.label })}
          </SettingNote>
          {choice === "gemini" && geminiPersonal(has) && (
            <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>
          )}
        </>
      ) : (
        <>
          <GateWait
            gate={gate}
            kind={kindOf(choice)}
            coding={isPlanId(choice)}
            machineId={computer?.machineId}
            computer={name}
            edition={gates.edition}
            said={false}
            signingIn={signingIn}
            onKey={onKey}
            onComputer={onComputer}
          />
          {elsewhere && onComputer && (
            <span>
              <Button size="sm" variant="primary" onClick={onComputer}>
                {t("aiAccounts.connect.addComputer")}
              </Button>
            </span>
          )}
          {elsewhere && mayAddKey && (
            <span>
              <Button size="sm" onClick={onKey}>
                {t("connectAi.wait.useKey")}
              </Button>
            </span>
          )}
          {steps && (
            <AddAccount
              machineId={computer?.machineId ?? ""}
              kind={kindOf(choice)}
              computer={cloud ? t("connectAi.theComputer") : name}
              {...(isPlanId(choice) ? { provider: choice } : {})}
              local={computer?.mine}
              ready={gate.state === "ready"}
              onAdded={(a) => {
                setAdded(a);
                onDone(a);
              }}
              onSigningIn={setSigningIn}
            />
          )}
          {steps && <p className="small muted">{t("connectAi.forNewAgentsHint")}</p>}
        </>
      )}
    </Card>
  );
}

/** A plan's panel: what it covers and for whom, its steps or what they wait for, then who the agents answer. */
export function PlanPanel(props: PlanPanelProps) {
  const { t } = useTranslation();
  const { choice, gates, agents, all, target, onTarget, own, locked, plain } = props;
  const title = planTitle(t, choice);
  // The computer's own sign-in covers every agent: no agent to choose then.
  const everyAgent =
    own?.chosen === true && ownSignInFor(choice, gates.view, gates.row) && gates.gateOf(choice).state === "ready";
  const forWhom: PlanSetAgent[] = target === ALL_AGENTS ? all : agents.filter((a) => a.id === target);
  const [agent] = forWhom;
  return (
    <Card as="section" className="ai-panel ai-panel--plan" aria-label={title}>
      {/* Under the conversation's Connect the dialog already names the plan and whom it is for. */}
      {!plain && (
        <PanelHead
          lead={<ProviderLogo id={planMark(choice)} size="sm" />}
          title={title}
          sub={t(`connectAi.plan.${choice}.tiers`)}
          aside={
            agents.length > 1 &&
            forWhom.length > 0 &&
            !everyAgent && <ForSelect agents={agents} all={all} target={target} onTarget={onTarget} />
          }
        />
      )}
      {locked ? (
        <SettingNote icon="lock">{locked}</SettingNote>
      ) : agent ? (
        <PlanSteps key={target} {...props} forWhom={forWhom} agent={agent} everyAgent={everyAgent} />
      ) : (
        <Spinner />
      )}
    </Card>
  );
}

/** "For [All agents ▾]": every agent of "All agents" first, with their faces and names, then each agent. */
function ForSelect({ agents, all, target, onTarget }: Pick<PlanPanelProps, "agents" | "all" | "target" | "onTarget">) {
  const { t } = useTranslation();
  const face = (a: PlanAgent, size: "xs" | "sm" = "xs") => (
    <AgentAvatar key={a.id} name={a.name} initials={a.initials} appearance={a.appearance} size={size} />
  );
  return (
    <span className="ai-panel__agent">
      <span aria-hidden="true">{t("connectAi.for")}</span>
      <Select
        size="sm"
        align="end"
        aria-label={t("connectAi.agentAria")}
        value={target}
        onValueChange={onTarget}
        options={[
          ...(all.length > 1
            ? [
                {
                  value: ALL_AGENTS,
                  label: t("connectAi.all"),
                  description: namesText(
                    t,
                    all.map((a) => a.name),
                    NAMES_SHOWN,
                  ),
                  leading: <AvatarStack>{all.slice(0, 3).map((a) => face(a))}</AvatarStack>,
                },
              ]
            : []),
          ...agents.map((a) => ({ value: a.id, label: a.name, leading: face(a, "sm") })),
        ]}
      />
    </span>
  );
}

/** Where an agent is in a sign-in for several, one login each: done, signing in now, still to come, or it didn't end. */
export type FaceState = "done" | "now" | "next" | "failed";

/**
 * The agents of a sign-in for several, one face each in their order (ADR 0160, addendum): a check on those done, a
 * ring on the one signing in now, the ones to come dimmed, a mark on one whose login didn't end. One name at a time is
 * said in the words above it; each face carries its own for a screen reader and on hover.
 */
export function FaceStrip({ agents, stateOf }: { agents: readonly PlanAgent[]; stateOf: (a: PlanAgent) => FaceState }) {
  const { t } = useTranslation();
  const said: Record<FaceState, string> = {
    done: t("connectAi.who.state.done"),
    now: t("connectAi.who.state.now"),
    next: t("connectAi.who.state.next"),
    failed: t("connectAi.team.state.failed"),
  };
  return (
    <ul className="ai-strip" aria-label={t("connectAi.agentAria")}>
      {agents.map((a) => {
        const state = stateOf(a);
        return (
          <li key={a.id} className="ai-strip__face" data-state={state} title={a.name}>
            <AgentAvatar name={a.name} initials={a.initials} appearance={a.appearance} size="sm" />
            {(state === "done" || state === "failed") && (
              <i className="ai-strip__badge" aria-hidden="true">
                <Icon name={state === "done" ? "check" : "alert"} size={14} />
              </i>
            )}
            <span className="ac-visually-hidden">{`${a.name}: ${said[state]}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Whom agents that just started thinking with the person's plan answer, as one line under what they think with (ADR
 * 0160, addendum): only the person, with the way to let the team in ("Answers other people", ADR 0059 §5, with the
 * same terms behind its ⓘ and the same rule when the server keeps "only some people" with nobody picked).
 */
export function PlanAudience({
  agents,
  brain,
  plan,
  coding,
}: {
  agents: readonly PlanAgent[];
  brain: MachineAccountKind;
  plan?: string | null;
  coding?: ReturnType<typeof planOf>;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  // From the rows as they are now: an agent just moved onto the plan starts on its owner alone.
  const [on, setOn] = useState(() =>
    agents.every((a) => {
      const row = dir.agentById.get(a.id);
      return row?.brain?.kind === brain && answersOthers(audienceOf(row), row.ownerUserId);
    }),
  );
  const [busy, setBusy] = useState(false);
  const shown = usePlanRepliesShown(on);
  const [one] = agents;
  if (!shown || !one) return null;
  const says = planReplies(t, { on, agent: agents.length === 1 ? one.name : null, brain, plan, coding });
  const toggle = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    try {
      const saved = [];
      for (const a of agents) saved.push(await api.agents.setBrain(org.id, a.id, { onlyOwner: !next }));
      for (const a of agents) void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, a.id) });
      void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
      // The server keeps "Only some people" with nobody picked as it is: the line says what it saved.
      if (next && saved.every((s) => s.onlyOwner)) {
        setOn(false);
        if (agents.length === 1) toast.show(t("aiAccounts.share.pickPeople", agentGrammar(one.name)), "info");
      }
    } catch {
      setOn(!next);
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  const line =
    agents.length === 1
      ? t(on ? "connectAi.team.audience.on" : "connectAi.team.audience.off", agentGrammar(one.name))
      : t(on ? "connectAi.team.audience.onAll" : "connectAi.team.audience.offAll");
  return (
    <p className="ai-aud ac-iconline">
      <Icon name={on ? "audienceEveryone" : "audienceOwner"} size={16} />
      <span className="ai-aud__text">
        <span>{line}</span>{" "}
        <button type="button" className="ac-link" disabled={busy} onClick={() => void toggle(!on)}>
          {t(on ? "connectAi.team.audience.unshare" : "connectAi.team.audience.share")}
        </button>{" "}
        <InfoHint name={says.about}>{says.text}</InfoHint>
      </span>
    </p>
  );
}

/** The computer's own sign-in as a brain view says it: no account. */
const OWN_SIGN_IN = { account: null, accounts: [] } as const;

function PlanSteps({
  choice,
  gates,
  forWhom,
  agent,
  everyAgent,
  target,
  own,
  hostConnecting,
  justReady,
  said = false,
  replies,
  login,
  use,
  plain = false,
  actionsAt,
  onKey,
  onComputer,
  onDone,
  onSkip,
  onAssigned,
  onStart,
}: PlanPanelProps & {
  forWhom: PlanSetAgent[];
  /** The agent it's for, or the first of "All agents". */
  agent: PlanSetAgent;
  everyAgent: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(org.id, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const everyone = target === ALL_AGENTS;
  // The agents it moved onto the plan (the login each thinks with), one being moved, one whose move failed.
  const [assigned, setAssigned] = useState<Record<string, MachineAccount>>({});
  // Whom it signs in for, in order: of "All agents", those that weren't on this plan before it moved them.
  const todo = everyone ? forWhom.filter((a) => !a.done || assigned[a.id]) : forWhom;
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState<{ agentId: string; account: MachineAccount } | null>(null);
  const [sent, setSent] = useState(false);
  // Of "All agents", those whose login ended without signing in: none runs for them until the key goes again.
  const [missed, setMissed] = useState<string[]>([]);
  // One login per agent in turn: those the person skipped after their login didn't end, and why the one signing in now
  // ended without signing in (`AddAccount`'s `onEnd`), while it shows.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [endWhy, setEndWhy] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [ownSaved, setOwnSaved] = useState(false);
  // A sign-in begun here keeps its steps while its computer is offline: they say Reconnecting, and it goes on.
  const [signingIn, setSigningIn] = useState(false);
  const dir = useDirectory(org.id);
  // "Atende outras pessoas" (ADR 0059 §5) for whom the panel is: an agent already on this brain shows its own and
  // changes it at once, one moved onto it starts on its owner alone unless this is on (the move says so).
  const onBrain = (id: string) => ownSaved || id in assigned || dir.agentById.get(id)?.brain?.kind === kind;
  const repliesNow = (id: string) => {
    const row = dir.agentById.get(id);
    return row !== undefined && answersOthers(audienceOf(row), row.ownerUserId);
  };
  const [ownReplies, setOwnReplies] = useState(() => forWhom.every((a) => onBrain(a.id) && repliesNow(a.id)));
  const replyAll = replies?.on ?? ownReplies;
  const repliesShown = usePlanRepliesShown(replyAll);
  const setReplies = replies?.onChange ?? setOwnReplies;
  const [replying, setReplying] = useState(false);
  const toEveryone = replyAll ? { onlyOwner: false } : {};
  // It turns ready while the person watches, or they came because it did: said in place, and again on a way back.
  const waited = gates.waited || justReady === true;
  const { markWaited } = gates;
  useEffect(() => {
    if (gate.state === "preparing") markWaited();
  }, [gate.state, markWaited]);

  const computer =
    edition === "cloud"
      ? computerName(t, org.name, managedOf(machines.data), isPersonal(org))
      : (view?.computer?.name ?? "");
  const refresh = (agentIds: string[]) => {
    for (const key of [
      ...agentIds.map((id) => keys.agentBrain(org.id, id)),
      keys.agents(org.id),
      keys.machines(org.id),
      keys.aiAccounts(org.id),
      keys.aiStatus(org.id),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // A sign-in ended: its agent thinks with that account right away (no confirming click).
  const assign = async (agentId: string, a: MachineAccount) => {
    onStart?.();
    setFailed(null);
    setSaving((n) => n + 1);
    try {
      await api.agents.setBrain(org.id, agentId, { brain: a.kind, account: a.id, ...toEveryone });
      setAssigned((x) => ({ ...x, [agentId]: a }));
      onAssigned?.(agentId, a);
      refresh([agentId]);
    } catch {
      setFailed({ agentId, account: a });
    } finally {
      setSaving((n) => n - 1);
    }
  };
  // One account for every agent of "All agents" (one sign-in for all, or one already there), each in turn.
  const assignAll = async (a: MachineAccount) => {
    for (const x of todo) if (!assigned[x.id]) await assign(x.id, a);
  };
  const saveOwn = async () => {
    try {
      for (const a of todo) await api.agents.setBrain(org.id, a.id, { brain: kind, account: null, ...toEveryone });
      setOwnSaved(true);
      refresh(todo.map((a) => a.id));
      onDone(
        todo.map((a) => a.id),
        null,
      );
    } catch {
      toast.show(t("agentPage.work.failed"), "error");
    }
  };
  const account = Object.values(assigned)[0];
  // Every agent signed in, or skipped once at least one did: those that think now are told. A caller that hears of
  // each skip (`onSkip`) is told too when every agent was skipped, with nobody.
  const allDone =
    todo.length > 0 &&
    todo.every((a) => assigned[a.id] || skipped.includes(a.id)) &&
    (onSkip !== undefined || todo.some((a) => assigned[a.id]));
  const told = useRef(false);
  useEffect(() => {
    if (!allDone || told.current) return;
    told.current = true;
    onDone(
      todo.filter((a) => assigned[a.id]).map((a) => a.id),
      account ?? null,
    );
  }, [allDone, todo, account, onDone, assigned]);

  const replyToEveryone = async (on: boolean) => {
    setReplies(on);
    const now = forWhom.filter((a) => onBrain(a.id)).map((a) => a.id);
    if (now.length === 0) return;
    setReplying(true);
    try {
      const saved = [];
      for (const id of now) saved.push(await api.agents.setBrain(org.id, id, { onlyOwner: !on }));
      refresh(now);
      // The server keeps "Só algumas pessoas" with nobody picked as it is: the switch shows what it saved.
      if (on && saved.every((s) => s.onlyOwner)) {
        setReplies(false);
        const one = now.length === 1 ? forWhom.find((a) => a.id === now[0]) : undefined;
        if (one) toast.show(t("aiAccounts.share.pickPeople", agentGrammar(one.name)), "info");
      }
    } catch {
      setReplies(!on);
      toast.show(t("agentPage.work.failed"), "error");
    } finally {
      setReplying(false);
    }
  };

  const ready = gate.state === "ready";
  // The account picked before the panel opened: used once, when the plan can run there.
  const usedPick = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the plan turns ready
  useEffect(() => {
    if (!use || !ready || usedPick.current) return;
    usedPick.current = true;
    void (everyone ? assignAll(use) : assign(agent.id, use));
  }, [use, ready]);
  const brand = planLabel(t, choice);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && providerFitsChoice(a.provider, choice, coding),
  );
  // The sign-in in play: one just made, the computer's own chosen here, or what the agent already thinks with.
  const signIn = own?.chosen || ownSaved ? OWN_SIGN_IN : view?.brain === kind ? view : undefined;
  // Who the agents answer, once for the plan, as its foot: its icon says it, its switch changes it. The team's right
  // hand's own AI for the person serves them alone: no switch.
  const foot =
    view?.scope === "mine" || !repliesShown ? null : (
      <div className="ac-card__foot ac-iconline ai-panel__replies">
        <Icon name={replyAll ? "audienceEveryone" : "audienceOwner"} size={14} />
        <PlanReplies
          agent={everyone || everyAgent ? null : agent.name}
          on={replyAll}
          onChange={(on) => void replyToEveryone(on)}
          brain={kind}
          plan={account?.plan ?? (signIn ? signInPlan(signIn, gates.row, kind) : null)}
          coding={planOf(choice)}
          disabled={replying}
        />
      </div>
    );

  if (gates.failed)
    return (
      <div className="ai-panel__row">
        <SettingNote icon="alert" live>
          {t("common.loadFailed")}
        </SettingNote>
        <Button size="sm" icon="refresh" onClick={gates.retry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  // Every agent passed over: the caller says so in place of the panel.
  if (allDone && !todo.some((a) => assigned[a.id])) return null;
  // Done, or nothing to do: every agent of "All agents" already thought with this plan.
  if (allDone || (everyone && todo.length === 0)) {
    return (
      <>
        <SettingNote icon="check" live>
          {everyone
            ? t("connectAi.doneAll", {
                names: namesText(
                  t,
                  // A skipped agent stays out: only those that think now.
                  forWhom.filter((a) => a.done || assigned[a.id]).map((a) => a.name),
                  NAMES_SHOWN,
                ),
                label: account?.label ?? brand,
              })
            : thinksWithLine(t, view?.scope, agent.name, account?.label ?? "")}
        </SettingNote>
        {foot}
      </>
    );
  }
  if (ownSaved) {
    const label = ownSignInLower(t, kind);
    return (
      <>
        <SettingNote icon="check" live>
          {everyone
            ? t("connectAi.doneAll", {
                names: namesText(
                  t,
                  todo.map((a) => a.name),
                  NAMES_SHOWN,
                ),
                label,
              })
            : thinksWithLine(t, view?.scope, agent.name, label)}
        </SettingNote>
        {foot}
      </>
    );
  }
  // The picked account is being given to each agent: nothing to choose meanwhile.
  if (use && ready && !failed) return <Spinner />;
  const retry = failed && (
    <div className="ai-panel__row">
      <SettingNote icon="alert" live>
        {t("connectAi.assignFailed", {
          label: failed.account.label,
          agent: forWhom.find((a) => a.id === failed.agentId)?.name ?? "",
        })}
      </SettingNote>
      <Button size="sm" icon="refresh" onClick={() => void assign(failed.agentId, failed.account)}>
        {t("common.retry")}
      </Button>
    </div>
  );
  // One agent: its sign-in gives way to the move and what came of it.
  if (!everyone && (saving > 0 || failed))
    return saving > 0 ? (
      <Spinner />
    ) : (
      <>
        {retry}
        {foot}
      </>
    );

  const wait = (
    <GateWait
      gate={gate}
      kind={kind}
      machineId={view?.computer?.machineId}
      computer={computer}
      coding={coding}
      edition={edition}
      said={said}
      hostConnecting={hostConnecting}
      signingIn={signingIn}
      onKey={onKey}
      onComputer={onComputer}
    />
  );

  // The steps stay in view while they wait (their computer actions off); a reason alone otherwise.
  const steps = ready || gate.state === "preparing" || (gate.state === "offline" && (hostConnecting || signingIn));
  const ownable = ready && !login && ownSignInFor(choice, view, gates.row);
  // The shared sign-in's plan, where the computer says it ("Claude Max").
  const ownPlan = planWordOf(gates.row?.own?.[kind]?.plan ?? null);
  // One sign-in there thinks for all of the person's agents (ADR 0059 §2): the accounts of this plan they already
  // have there for all of their agents come first, one click each, before another account.
  const once = signsInOnce(choice, gates.row);
  const existing =
    ready && !login
      ? groupPlans(
          (view?.accounts ?? []).filter(
            (a) =>
              a.shared === true &&
              a.mine &&
              a.status === "active" &&
              a.kind === kind &&
              providerFitsChoice(a.provider, choice, coding) &&
              (everyone || a.id !== view?.account),
          ),
        ).flatMap((g) => g.logins.slice(0, 1))
      : [];
  const choosing = ownable || existing.length > 0;
  const otherChosen = ownable && own ? !own.chosen : other;
  const signedOut = !everyone && current?.status === "signed_out" ? current : undefined;
  // One sign-in per agent, in turn: the agent signing in now, and the account the first one signed in as.
  const turn = everyone && !coding && !once ? todo.find((a) => !assigned[a.id] && !skipped.includes(a.id)) : undefined;
  const sameAs = Object.values(assigned).find((a) => a.email)?.email ?? undefined;
  const stateOf = (a: PlanSetAgent) =>
    a.done || assigned[a.id]
      ? "done"
      : !missed.includes(a.id) && (coding || once ? sent : a.id === turn?.id)
        ? "now"
        : "next";
  // Under a dialog that already names the plan (`plain`), one login per agent is one instruction at a time: how far
  // along, whose turn it is, and every agent's face in order; a login that didn't end says so in its place, with the
  // way to skip that agent beside "Try again": always where the caller hears of skips (the team's end lists who
  // stayed, ADR 0160 addendum), else once someone else is left or done.
  const perAgent = plain && turn !== undefined;
  const turnAt = turn ? todo.findIndex((a) => a.id === turn.id) + 1 : 0;
  const maySkip =
    onSkip !== undefined ||
    todo.some((a) => assigned[a.id]) ||
    todo.filter((a) => !assigned[a.id] && !skipped.includes(a.id)).length > 1;
  const faceOf = (a: PlanAgent): FaceState =>
    assigned[a.id] || forWhom.find((x) => x.id === a.id)?.done
      ? "done"
      : skipped.includes(a.id) || (a.id === turn?.id && endWhy)
        ? "failed"
        : a.id === turn?.id
          ? "now"
          : "next";
  const turnHead = perAgent && turn && (
    <div className="ai-turn">
      {/* The words change with each turn and slide in; the faces stay, so the ring moves and a check appears. */}
      <div key={`${turn.id}:${endWhy ? "end" : "on"}`} className="ai-turn__words arrival-swap" data-dir="fwd">
        <small className="ai-turn__count">{t("connectAi.team.progress", { n: turnAt, total: todo.length })}</small>
        <p className="ai-turn__title" role="status">
          {endWhy
            ? t("connectAi.team.failed", agentGrammar(turn.name))
            : t("connectAi.team.turn", { ...agentGrammar(turn.name), plan: brand })}
        </p>
        <span className="ai-turn__help">{endWhy ?? t("connectAi.team.turnHelp", { plan: brand })}</span>
      </div>
      <FaceStrip agents={forWhom} stateOf={faceOf} />
    </div>
  );
  const skip = turn && (
    <Button
      onClick={() => {
        onSkip?.(turn.id, endWhy);
        setSkipped((s) => [...s, turn.id]);
        setEndWhy(null);
      }}
    >
      {t("connectAi.team.skip", agentGrammar(turn.name))}
    </Button>
  );
  return (
    <>
      {wait}
      {ready &&
        waited &&
        (said ? (
          // The rail says it to the eye, and a screen reader still hears the sign-in come on.
          <p className="ac-visually-hidden" role="status">
            {t("connectAi.wait.ready")}
          </p>
        ) : (
          // A group of its own over a hairline, so it never reads as part of the account choice under it.
          <SettingNote icon="check" live className="ai-panel__ready">
            {t("connectAi.wait.ready")}
          </SettingNote>
        ))}
      {everyone && steps && !plain && (
        <ul className="ai-panel__who" aria-label={t("connectAi.agentAria")}>
          {forWhom.map((a) => {
            const state = stateOf(a);
            return (
              <li key={a.id} data-state={state}>
                <AgentAvatar name={a.name} initials={a.initials} appearance={a.appearance} size="xs" />
                <span>{a.name}</span>
                {state === "done" ? (
                  <Icon name="check" size={14} label={t("connectAi.who.state.done")} />
                ) : state === "now" ? (
                  <Icon name="spinner" size={14} label={t("connectAi.who.state.now")} />
                ) : (
                  <span className="ac-visually-hidden">{t("connectAi.who.state.next")}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {steps && turnHead}
      {everyone && !coding && steps && !perAgent && (
        <p className="ai-panel__each">
          <span className="ac-hintline">
            <span>{t(once ? "connectAi.once" : "connectAi.each")}</span>
            <InfoHint name={t("common.about", { label: t(once ? "connectAi.once" : "connectAi.each") })}>
              {t(once ? "connectAi.onceHint" : "connectAi.eachHint")}
            </InfoHint>
          </span>
        </p>
      )}
      {retry}
      {choice === "gemini" && choosing && !otherChosen && existing.some(geminiPersonal) && (
        <SettingNote icon="alert">{t("connectAi.plan.gemini.warning")}</SettingNote>
      )}
      {choosing &&
        plain &&
        !ownable &&
        !otherChosen &&
        actionsAt &&
        createPortal(
          <>
            <Button onClick={() => setOther(true)}>{t("connectAi.another")}</Button>
            {existing.map((a) => (
              <Button key={a.id} variant="primary" onClick={() => void (everyone ? assignAll(a) : assign(agent.id, a))}>
                {t("connectAi.use", { label: accountTitle(a) })}
              </Button>
            ))}
          </>,
          actionsAt,
        )}
      {choosing && !(plain && !ownable) && (
        // Who shares the sign-in: the computer's own, which any of its pairer's agents there thinks with, an account
        // of this plan the person already has there for all of their agents, or another sign-in (ADR 0059 §2). Small
        // columns: indented to the panel's text column, two still fit side by side in the setup's column.
        // biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset
        <div className="grid-options grid-options--sm" role="group" aria-label={planTitle(t, choice)}>
          {ownable && (
            <OptionCard pressed={own?.chosen ?? false} onClick={() => (own ? own.onChoose(true) : void saveOwn())}>
              <span className="ac-option__text">
                <span className="ac-option__title">
                  {kind === "opencode" ? t("connectAi.own.free") : t("connectAi.own.shared")}
                </span>
                {ownPlan && <span className="ac-option__desc">{`${brand} ${ownPlan}`}</span>}
              </span>
            </OptionCard>
          )}
          {existing.map((a) => (
            <OptionCard key={a.id} pressed={false} onClick={() => void (everyone ? assignAll(a) : assign(agent.id, a))}>
              <span className="ac-option__text">
                <span className="ac-option__title">{t("connectAi.use", { label: accountTitle(a) })}</span>
                {a.usedBy.length > 0 && (
                  <span className="ac-option__desc">
                    {t("agentPage.work.brain.accountAlso", { agents: namesText(t, a.usedBy, NAMES_SHOWN) })}
                  </span>
                )}
              </span>
            </OptionCard>
          ))}
          <OptionCard pressed={otherChosen} onClick={() => (ownable && own ? own.onChoose(false) : setOther(true))}>
            <span className="ac-option__text">
              <span className="ac-option__title">
                {!ownable
                  ? t("connectAi.another")
                  : everyone
                    ? t("connectAi.own.each")
                    : t("connectAi.own.one", agentGrammar(agent.name))}
              </span>
            </span>
          </OptionCard>
        </div>
      )}
      {steps && (!choosing || otherChosen) && (
        <AddAccount
          key={turn?.id ?? login?.from}
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          // The Cloud's one computer goes unnamed in the account choice: the sign-in is about the account, not where.
          computer={edition === "cloud" ? t("connectAi.theComputer") : computer}
          {...(coding
            ? { provider: choice }
            : signInProviderOf(signedOut?.provider)
              ? { provider: signInProviderOf(signedOut?.provider) }
              : {})}
          again={login ? login.again : signedOut?.id}
          fresh={existing.length > 0 && otherChosen}
          email={turn && sameAs ? sameAs : login ? login.email : signedOut?.email}
          local={view?.ownSignIn}
          ready={ready}
          loading={gates.catching}
          {...(perAgent
            ? { signInLabel: t("connectAi.team.signIn", { plan: brand }), quiet: true, onEnd: setEndWhy }
            : turn
              ? { signInLabel: t("connectAi.signInFor", agentGrammar(turn.name)) }
              : {})}
          {...(perAgent && maySkip ? { endActions: skip } : {})}
          {...(everyone && coding && !once ? { fanOut: todo.map((a) => ({ id: a.id })) } : {})}
          onSent={() => {
            setSent(true);
            setMissed([]);
            onStart?.();
          }}
          onFailed={(id) => setMissed((m) => [...m, id])}
          onAdded={(a, id) => void (everyone && once ? assignAll(a) : assign(id ?? turn?.id ?? agent.id, a))}
          onUse={(a) => void (everyone && once ? assignAll(a) : assign(turn?.id ?? agent.id, a))}
          onSigningIn={setSigningIn}
          {...(plain && actionsAt ? { actionsAt } : {})}
        />
      )}
      {/* Under the conversation's Connect who the agents answer is said once they think, not at every step. */}
      {(steps || ownable) && !plain && foot}
    </>
  );
}

/** The billing hold on this workspace that stops its plans (`planHoldOf`). */
export function usePlanHold() {
  const { org } = useOrg();
  return planHoldOf(computerEdition(useComputerSetup(org.id).data), org.standing);
}

/**
 * A plan a workspace with no agentes.chat plan in force can't use, in place of its steps: why, and the way to that
 * plan for whoever pays (anyone else reads who can). A hold stops the Model Gateway for keys too, so no key is offered
 * as a way around it.
 */
export function PlanHold({ hold }: { hold: BillingHold }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const billingUrl = useAuthConfig().data?.billingUrl;
  const canPay = can(org, "manage_billing") && Boolean(billingUrl);
  return (
    <>
      <SettingNote icon="alert">{t("connectAi.billing")}</SettingNote>
      {canPay ? (
        <span className="ac-acts">
          <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
            {t(`standing.billing.cta.${hold}`)}
          </BillingLinkButton>
        </span>
      ) : (
        <SettingNote icon="lock">{t("standing.billing.askAdmin")}</SettingNote>
      )}
    </>
  );
}

/**
 * Why a plan's panel waits or can't sign in there (`PlanGate`), with the way on: the computer's wait, a key now, a
 * computer to connect. Nothing once it's ready.
 */
function GateWait({
  gate,
  kind,
  coding,
  machineId,
  computer,
  edition,
  said,
  hostConnecting,
  signingIn,
  onKey,
  onComputer,
}: {
  gate: PlanGate;
  kind: MachineAccountKind;
  coding: boolean;
  /** The computer the gate is about. */
  machineId: string | undefined;
  /** Its name, as the panel says it. */
  computer: string;
  edition: Edition | null;
  said: boolean;
  hostConnecting?: boolean;
  signingIn: boolean;
  onKey: () => void;
  /** None on the onboarding (`PlanPanelProps.onComputer`). */
  onComputer?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const reader = useWaitReader();
  const machines = useMachines(org.id, edition !== null);
  const preparing = gate.state === "preparing" ? gate.view : null;
  const { eta, email } = useSetupWait(preparing, reader.held);
  const useKey = (
    <span>
      <Button size="sm" onClick={onKey}>
        {t("connectAi.wait.useKey")}
      </Button>
    </span>
  );
  const line = (lead: ReactNode, text: string) => (
    <p className="setup-line ac-iconline" role="status">
      {lead}
      <span>{text}</span>
    </p>
  );
  const hold = holdText(t, org.standing);
  // Offline or unsupported: what's going on there and what comes next (on the Cloud, by itself as events arrive).
  const why = gateLine(t, {
    gate,
    edition,
    kind,
    computer,
    hold,
    machine: machines.data?.find((m) => m.id === machineId),
  });
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <Spinner />;
  else if (gate.state === "billing") {
    wait = <PlanHold hold={gate.hold} />;
  } else if (gate.state === "preparing") {
    // The computer's wait in one well: how far it is and the time left, or why it waits (not where the rail beside it
    // already says so), then when the step under it turns on, said once (the owner's email line says it for them). A
    // hold decides when anything runs there: it speaks alone. The well's lines start on the panel's text edge, so none
    // leads with an icon. With no view of it yet the well still says what the disabled step under it waits for.
    wait = (
      <div className="ai-panel__wait">
        {hold ? (
          <p className="setup-line" role="status">
            {hold}
          </p>
        ) : (
          <>
            {preparing?.step ? (
              <SetupProgress view={preparing} />
            ) : (
              preparing &&
              !(said && statusRestatesChip(preparing)) && (
                <p className="setup-line" role="status">
                  {t(preparing.textKey)}
                </p>
              )
            )}
            {eta && (
              <p className="setup-eta" aria-live="polite">
                {etaLine(t, eta)}
              </p>
            )}
            <p className="setup-line">
              {t(
                email && reader.owner
                  ? "connectAi.wait.email"
                  : coding
                    ? "connectAi.wait.key"
                    : "connectAi.wait.signIn",
              )}
            </p>
            {preparing?.phase === "problem" && useKey}
          </>
        )}
      </div>
    );
  } else if (gate.state === "offline" && hostConnecting && !signingIn) {
    wait = line(<Spinner size={14} />, t("connectAi.wait.connecting"));
  } else if (gate.state === "unsupported" && gate.reason === "tool_off" && edition !== "cloud" && !hold) {
    // The computer is connected and its program is there, switched off: said as that, then the way to its switch
    // (`ToolOffSteps`).
    const program = t(`brain.card.${kind}`);
    wait = (
      <>
        <p className="setup-line">{t("connectAi.toolOff.text", { computer, program })}</p>
        <ToolOffSteps
          computer={computer}
          machineId={machineId}
          kind={kind === "claude_code" ? "claude" : kind}
          program={program}
        />
        {useKey}
      </>
    );
  } else if (why && !(gate.state === "offline" && signingIn)) {
    wait = (
      <>
        <SettingNote icon={why.rechecks ? "clock" : "alert"} live={why.rechecks}>
          {why.text}
        </SettingNote>
        {!hold && useKey}
      </>
    );
  } else if (gate.state === "missing") {
    wait = onComputer ? (
      <>
        <SettingNote icon="computer">{t("aiAccounts.connect.noComputer")}</SettingNote>
        <span>
          <Button size="sm" variant="primary" onClick={onComputer}>
            {t("aiAccounts.connect.addComputer")}
          </Button>
        </span>
      </>
    ) : (
      // On the onboarding no page to connect one is open yet: it comes once the workspace opens, the key meanwhile.
      <>
        <SettingNote icon="computer">{t("connectAi.wait.computerLater")}</SettingNote>
        {useKey}
      </>
    );
  } else if (gate.state === "locked") {
    const pairer = machines.data?.find((m) => m.id === machineId)?.pairedBy?.name.split(" ")[0];
    wait = (
      <SettingNote icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedOwner")}
      </SettingNote>
    );
  }

  return wait;
}

/** The API key being added: its maker and the key. */
export interface KeyDraft {
  /** `custom`: a workspace's own endpoint (ADR 0146), which has a form of its own (`endpoint`). */
  provider: ProviderId | typeof CUSTOM_PROVIDER;
  apiKey: string;
}

/**
 * The API key: who charges for it, where its maker's keys are made (the maker comes from the picker's select), then the
 * key, pasted here. `onSave`: saved right here (the dialog); else the caller saves it with its own button (the setup).
 */
export function KeyPanel({
  draft,
  onDraft,
  locked,
  saved,
  savedNote,
  refused,
  saving,
  onSave,
  endpoint,
}: {
  draft: KeyDraft;
  onDraft: (draft: KeyDraft) => void;
  /** The "Outro provedor" form, shown when it is chosen. */
  endpoint?: ReactNode;
  /** Only an admin adds an API key. */
  locked?: boolean;
  saved?: boolean;
  /** Says what the save came to, in place of the usual line (a check that got no answer, the right hand's words). */
  savedNote?: string;
  /** The provider refused the key on its test call: nothing was kept. */
  refused?: ReturnType<typeof keyRefusal>;
  saving?: boolean;
  onSave?: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [touched, setTouched] = useState(false);
  const { provider, apiKey } = draft;
  const keyOf = provider === CUSTOM_PROVIDER ? null : provider;
  const maker = keyOf ? providerOf(keyOf) : undefined;
  const hint = maker && keyStepHint(maker);
  const valid = keyOf === null || keyLooksValid(keyOf, apiKey);
  const wrong = touched && apiKey.trim().length > 0 && !valid;
  const site = maker ? new URL(`https://${maker.site}`) : null;
  const pick = (next: ProviderId) => onDraft({ provider: next, apiKey });
  return (
    <Card as="section" className="ai-panel" aria-label={t("connectAi.key.title")}>
      {keyOf && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("connectAi.key.sub")}
        </p>
      )}
      {locked ? (
        <SettingNote icon="lock">{t("connectAi.keyLocked")}</SettingNote>
      ) : saved ? (
        <SettingNote icon="check" live>
          {savedNote ?? t("connectAi.key.saved")}
        </SettingNote>
      ) : provider === CUSTOM_PROVIDER ? (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            {t("endpoint.optionSub")}
          </p>
          {endpoint}
        </>
      ) : keyOf && maker && site ? (
        <>
          <Step
            n={1}
            side={
              <OpenPage href={site.href} primary={!apiKey}>
                {t("aiAccounts.add.openKeys", { site: site.host })}
              </OpenPage>
            }
          >
            <StepTitle title={t("connectAi.key.create", { provider: providerLabel(keyOf) })} hint={hint && t(hint)} />
          </Step>
          <Step n={2}>
            <label htmlFor={fieldId}>
              <b>{t("connectAi.key.paste")}</b>
            </label>
            <span className="agp-addacct__paste">
              <Locked when={Boolean(saving)}>
                <Input
                  id={fieldId}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={maker.placeholder}
                  value={apiKey}
                  invalid={wrong}
                  onChange={(e) => onDraft({ provider, apiKey: e.target.value })}
                  onBlur={() => setTouched(true)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !onSave) return;
                    e.preventDefault();
                    setTouched(true);
                    if (valid) onSave();
                  }}
                />
              </Locked>
              {onSave && apiKey.trim() && (
                <Button variant="primary" loading={saving} disabled={!valid} onClick={onSave}>
                  {t("settings.saveKey")}
                </Button>
              )}
            </span>
            {wrong && (
              <div className="ac-field__error" role="alert">
                <KeyMismatch provider={keyOf} apiKey={apiKey} onPick={pick} />
              </div>
            )}
            {refused && <KeyRefused refusal={refused} />}
          </Step>
          <SettingNote icon="agent">{t("connectAi.key.forAll")}</SettingNote>
        </>
      ) : null}
    </Card>
  );
}

/** One agent of the team and what it thinks with: an account's name, "API key · Claude", or nothing yet. */
export interface WhoRow {
  id: string;
  name: string;
  appearance?: AgentAppearance;
  initials?: string;
  thinks: { label: string; mark: string } | null;
}
