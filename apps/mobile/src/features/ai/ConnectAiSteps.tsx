import type { BrainScope, Edition, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useAgents,
  useAiAccounts,
  useApi,
  useComputerSetup,
  useCredentials,
  useMachines,
  useModels,
} from "@agenteschat/client";
import {
  accountTitle,
  type ExistingAi,
  groupPlans,
  listsExisting,
  planWordOf,
  signInPlan,
} from "@agenteschat/client/lib/ai-accounts";
import { computerEdition, computerName, managedNamed, setupView } from "@agenteschat/client/lib/computer";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, holdText, keyRefusal } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AiChoice,
  behindComputer,
  catchUp,
  dimmedLine,
  type ExistingSignIn,
  firstAgent,
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
  planHoldPhoneLine,
  planLabel,
  planMark,
  planOfAccount,
  planPickText,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { geminiPersonal, isPlanId, planOf, providerFitsChoice, signInProviderOf } from "@agenteschat/client/lib/plans";
import {
  AUTO,
  keyLooksValid,
  keyRuns,
  keyStepHint,
  PROVIDERS,
  providerLabel,
  providerOf,
  providersForKey,
} from "@agenteschat/client/lib/providers";
import { rightHandOnKey, thinksWithLine } from "@agenteschat/client/lib/right-hand";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  Locked,
  ProviderLogo,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { SetupWait } from "../computer/SetupWait";
import { SheetHeader } from "../new/parts";
import { AgentFace } from "../shared/Face";
import { pickOne } from "../shared/PickerSheet";
import { PickList } from "../shared/PickList";
import { AddAccount } from "./AddAccount";
import type { ConnectKey } from "./ConnectAi";
import { EndpointForm } from "./EndpointForm";
import { existingRows, type FlowView, flowBack, offersKeyNow, PLAN_POLL_MS, pollsPlan, takenFrom } from "./logic";
import { useAiOrg } from "./org";
import {
  AiRow,
  alertKeyRefused,
  Note,
  OpenPage,
  PasteField,
  PlanHoldNote,
  PlanReplies,
  Step,
  StepsCard,
  usePlanHold,
} from "./parts";

/*
 * "Conectar uma IA" on the phone: the web's content and rules
 * (ADR 0059, ADR 0061) in the app's own line. The first page is grouped lists like iOS Settings: what the person
 * already has (for an agent with no AI), your AI plan and pay as you go (the API key), one row each. Each pushes its
 * page inside the sheet: the plans with a search, then a plan's mark, for which agent, and its numbered steps on the
 * agent's computer (or why they wait); the key's maker, chosen the same way, where its keys are made, and the key. A
 * plan signs in on the agent's computer: with
 * none, "Conectar um computador", and the key stays one tap away.
 */

/**
 * What each plan can do now for one agent (`planGate`), from its brain view, its computer's row and the setup.
 * `poll`: asked again this often while a plan waits (the first run opens no socket, so nothing else keeps them
 * current there).
 */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const api = useApi();
  const { org } = useAiOrg();
  const asks = agentId !== undefined;
  const brain = useAgentBrain(orgId, agentId ?? "", asks, poll);
  const ai = useAiAccounts(orgId, asks, poll);
  // Codex's own sign-in is known only by a usage read with it: looked up again here (it comes back as
  // `machine.updated`, or with the next poll), so a computer's own ChatGPT sign-in shows before any turn ran.
  useEffect(() => {
    if (asks) void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId, asks]);
  const setupQ = useComputerSetup(orgId, true, poll);
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
  // A plan's page waited for that computer: once it's ready, it says so whenever a plan's page shows again
  // (another plan, the key's page and back). Kept here, above the pages.
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
          standing: org?.standing,
        });
  // A poll that fails once keeps the last view: a sign-in in progress goes on. A read that failed with nothing to show
  // ends the page's wait with Tentar de novo.
  const failed = (brain.isError && !view) || (ai.isError && !ai.data) || (setupQ.isError && !setupQ.data);
  const { refetch: setupAgain } = setupQ;
  const retry = useCallback(() => {
    for (const again of [brainAgain, accountsAgain, setupAgain]) void again();
  }, [brainAgain, accountsAgain, setupAgain]);
  return { gateOf, view, row, failed, retry, edition, waited, markWaited, catching };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/** `usePlanGates` for a person who owns no agent yet: each plan's gate on the computer it would sign in on. */
export function useGatesWithoutAgent(orgId: string, on: boolean) {
  const { org } = useAiOrg();
  const ai = useAiAccounts(orgId, on);
  const machines = useMachines(orgId, on);
  const setupQ = useComputerSetup(orgId, on);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const at = (choice: PlanChoice) =>
    planGateWithoutAgent({
      choice,
      edition,
      setup,
      computers: ai.data?.computers,
      machines: machines.data,
      standing: org?.standing,
    });
  return { at, edition, accounts: ai.data?.accounts };
}

type GatesWithoutAgent = ReturnType<typeof useGatesWithoutAgent>;

/** The page an intent opens on (a message that asked for a plan or a key). */
export const viewOf = (choice: AiChoice | null): FlowView =>
  !choice ? { page: "home" } : choice === "key" ? { page: "key" } : { page: "plan", choice };

export interface ConnectAiFlowProps {
  view: FlowView;
  onView: (view: FlowView) => void;
  /** The person's agents a plan may think for, in the order offered. */
  agents: { id: string; name: string }[];
  /** Whether an agent already thinks with something (a plan starts on the first one without). */
  hasAi: (agentId: string) => boolean;
  /** The agent to start on (a card that names one). */
  startAgentId?: string;
  /**
   * Claude's sign-in is one more login of the account with this email, one other agents use ("Também usada por"): its
   * hint, checked when it comes back, never the agent's own signed-out login again.
   */
  email?: string;
  /** Why this person connects no plan here (someone else's agent, or none of their own among those named). */
  locked?: ReactNode;
  /**
   * The person owns no agent yet and the sheet isn't for anyone's: a plan signs in on a computer they may add accounts
   * to, for the agents they create (`onAccount` once it's in).
   */
  bare?: boolean;
  onAccount?: () => void;
  /** Someone else's agent the sheet is for, to an admin: its owner's accounts shown locked, and the workspace's keys. */
  theirs?: { id: string; name: string };
  /** Only an admin adds an API key. */
  mayAddKey: boolean;
  /** The key being typed and its save (`useConnectKey`). */
  keyForm: ConnectKey;
  /** The key page saves with its own button; without it the caller does (the first run's button). */
  keyButton?: boolean;
  keySaved?: boolean;
  onSaveKey?: () => void;
  /** The person came because the computer just got ready: said first, once it is. */
  justReady?: boolean;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** The agent thinks with what was connected here now: a plan, or a row of what the person already had. */
  onPlanDone: (agentId: string) => void;
  /** A sheet: its own head (close on the first page, back on the others). Inline (the first run): a back row. */
  sheetTitle?: string;
  /**
   * A pushed screen (Connect an AI on its own route): the flow draws no head of its own and hands the screen its
   * title and, past the first page, the way back inside the flow, which the screen puts on the native bar.
   */
  onChrome?: (chrome: { title: string; back: (() => void) | null }) => void;
}

/**
 * The whole flow: its head and the page it is on. The agent a plan is for and what each plan can do for it live
 * here, above the pages: the first page dims a plan that can't sign in there, and a plan's page that waited for the
 * computer says it's ready when it shows again. For an agent with no AI, the first page starts with what the person
 * already has (`existingRows`): an account used or moved in one tap, signed in once more on its plan's page, a key.
 */
export function ConnectAiFlow(props: ConnectAiFlowProps) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { orgId, org } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { view, onView, sheetTitle, agents, hasAi, startAgentId, locked, theirs, mayAddKey } = props;
  // Only a pick is kept; else the first agent is worked out on each render (the agents may load after this opens).
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentId = locked ? undefined : (pickedAgent ?? firstAgent(agents, hasAi, startAgentId)?.id);
  const forAgent = agents.find((a) => a.id === agentId) ?? theirs;
  const [polls, setPolls] = useState(false);
  const gates = usePlanGates(orgId, forAgent?.id, polls ? PLAN_POLL_MS : false);
  const bareGates = useGatesWithoutAgent(orgId, props.bare === true);
  // The workspace's keys are offered in Connect an AI (a sheet) only, as on the web: in the first run (inline) the key
  // saved there already serves every agent with no plan.
  const credentials = useCredentials(orgId, mayAddKey && forAgent !== undefined && sheetTitle !== undefined);
  const agentRows = useAgents(orgId);
  const models = useModels();
  const [login, setLogin] = useState<ExistingSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const have =
    forAgent &&
    gates.view?.agentId === forAgent.id &&
    listsExisting(
      agentRows.data?.find((a) => a.id === forAgent.id),
      !hasAi(forAgent.id),
    )
      ? existingRows(t, gates.view, credentials.data ?? [], forAgent.name)
      : [];
  const shownGate = gates.gateOf(view.page === "plan" ? view.choice : "claude");
  const shown = shownGate.state;
  const asksAgain = agentId !== undefined && pollsPlan(shownGate, gates.edition);
  useEffect(() => setPolls(asksAgain), [asksAgain]);
  const { markWaited } = gates;
  const onPlan = view.page === "plan";
  useEffect(() => {
    if (onPlan && shown === "preparing") markWaited();
  }, [onPlan, shown, markWaited]);
  const dims = (choice: PlanChoice) =>
    agentId !== undefined ? gateDims(gates.gateOf(choice)) : props.bare === true && gateDims(bareGates.at(choice).gate);
  const go = (next: FlowView) => {
    // Another plan moves on to the next agent with no AI once this one thinks with a plan from here.
    if (next.page === "plan" && pickedAgent !== undefined && hasAi(pickedAgent)) setPickedAgent(undefined);
    onView(next);
  };
  // A row of what the person already has, used in one tap: the agent thinks with it, said in a toast.
  const save = async (
    to: { id: string; name: string },
    label: string,
    run: () => Promise<unknown>,
    scope?: BrainScope,
  ) => {
    setBusy(true);
    try {
      await run();
      for (const key of [
        keys.agentBrain(orgId, to.id),
        keys.agents(orgId),
        keys.aiAccounts(orgId),
        keys.aiStatus(orgId),
      ])
        void qc.invalidateQueries({ queryKey: key });
      toast({ title: thinksWithLine(t, scope, to.name, label), icon: "check" });
      props.onPlanDone(to.id);
    } catch (error) {
      const refusal = keyRefusal(t, error);
      if (refusal) alertKeyRefused(t, refusal);
      else toast({ title: errorText(t, error), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  const pickHave = (row: ExistingAi) => {
    if (!forAgent || !gates.view) return;
    const brain = gates.view.brain;
    if (row.kind === "key") {
      const k = row.key;
      // The workspace's model on that key: the agent's model where the key runs it, else Automático.
      // Tried first: a key kept earlier may have run out of credit, and "now thinks with it" has to be true.
      const agentRow = agentRows.data?.find((a) => a.id === forAgent.id);
      const fits = keyRuns(k, agentRow?.model, models.data?.models ?? []);
      const rightHand = gates.view?.scope === "mine" && agentRow;
      return void save(
        forAgent,
        k.label,
        async () => {
          const { check } = await api.agents.checkCredential(orgId, k.id);
          if (check === "unchecked")
            toast({ title: t("connectAi.key.savedUnchecked", { provider: providerLabel(k.provider) }), icon: "check" });
          // The team's right hand: a key is the workspace's AI, so everyone without their own thinks with it.
          if (rightHand) return rightHandOnKey(api, orgId, rightHand, k, models.data?.models ?? []);
          if (brain !== "model") await api.agents.setBrain(orgId, forAgent.id, { brain: "model" });
          await api.agents.update(orgId, forAgent.id, { credentialId: k.id, ...(fits ? {} : { model: AUTO }) });
        },
        rightHand ? "workspace" : undefined,
      );
    }
    const a = row.choice.login;
    const choice = planOfAccount(a);
    const take = (moveAccount: boolean) =>
      void save(
        forAgent,
        a.label,
        () =>
          api.agents.setBrain(orgId, forAgent.id, {
            brain: a.kind,
            account: a.id,
            ...(moveAccount ? { moveAccount } : {}),
          }),
        gates.view?.scope,
      );
    if (row.act === "use") return take(false);
    if (row.act === "move") {
      // One account thinks for one agent: picking another agent's takes it from that one.
      return Alert.alert(
        a.label,
        t("agentPage.work.brain.accountMove", { agents: takenFrom(a, forAgent.name).join(", ") }),
        [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("mobile.ai.moveHere"), onPress: () => take(true) },
        ],
      );
    }
    if (row.act === "also" || row.act === "again") {
      setLogin({ choice, from: a.id, email: a.email, ...(row.act === "again" ? { again: a.id } : {}) });
      setPickedAgent(forAgent.id);
      go({ page: "plan", choice });
    }
  };
  const to = flowBack(view, login !== null);
  const title =
    view.page === "home"
      ? (sheetTitle ?? t("connectAi.title.any"))
      : view.page === "plans"
        ? t("connectAi.pick.placeholder")
        : view.page === "key"
          ? t("connectAi.key.title")
          : view.page === "makers"
            ? t("mobile.ai.whose")
            : planLabel(t, view.choice);
  // On its own screen the bar is the screen's: it gets the title and the way back whenever the page changes.
  const { onChrome } = props;
  const goRef = useRef(go);
  goRef.current = go;
  // `to` is a new object each render: the effect follows what it points at.
  const toKey = to ? (to.page === "plan" ? `plan:${to.choice}` : to.page) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `to` is read through `toKey`, its identity changes each render
  useEffect(() => {
    if (!onChrome) return;
    onChrome({ title, back: to ? () => goRef.current(to) : null });
  }, [onChrome, title, toKey]);
  return (
    <>
      {onChrome ? null : sheetTitle !== undefined ? (
        <SheetHeader title={title} icon={to ? "back" : "x"} {...(to ? { onPress: () => go(to) } : {})} />
      ) : to ? (
        <Pressable
          onPress={() => go(to)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.backRow, pressed ? styles.pressed : null]}
          hitSlop={12}
        >
          <Icon name="back" size={15} color={c.muted} />
          <Text variant="subhead" tone="muted" style={styles.bold}>
            {t("mobile.common.back")}
          </Text>
        </Pressable>
      ) : null}
      {view.page === "home" ? (
        <Home
          onView={(next) => {
            setLogin(null);
            go(next);
          }}
          dims={dims}
          dimmedWhy={(choice) =>
            dimmedLine(t, agentId !== undefined ? gates.gateOf(choice) : bareGates.at(choice).gate, {
              edition: gates.edition ?? bareGates.edition,
              kind: kindOf(choice),
              computer: computerName(
                t,
                org?.name ?? "",
                managedNamed(gates.view?.computer ?? bareGates.at(choice).computer),
                isPersonal(org),
              ),
            })
          }
          have={have}
          haveFor={startAgentId || theirs ? undefined : forAgent?.name}
          busy={busy}
          onHave={pickHave}
        />
      ) : view.page === "plans" ? (
        <Plans onView={go} dims={dims} />
      ) : view.page === "makers" ? (
        <Makers form={props.keyForm} withEndpoint={props.keyButton !== false} onDone={() => go({ page: "key" })} />
      ) : view.page === "plan" ? (
        <PlanPage
          key={view.choice}
          {...props}
          onView={go}
          choice={view.choice}
          gates={gates}
          bareGates={bareGates}
          agentId={agentId}
          onAgent={setPickedAgent}
          {...(login?.choice === view.choice ? { login } : {})}
        />
      ) : (
        <KeyPage {...props} onMakers={() => go({ page: "makers" })} />
      )}
    </>
  );
}

/**
 * The first page: the two ways, one list ("Meu plano de IA", "Uma chave"), then what the workspace already has
 * (`have`), used in one tap. Neutral tiles: the makers' marks come on the pages that pick one. A plan that can't sign
 * in on the agent's computer says why under the rows, its rows of what they have dimmed too.
 */
function Home({
  onView,
  dims,
  dimmedWhy,
  have,
  haveFor,
  busy,
  onHave,
}: {
  onView: (v: FlowView) => void;
  dims: (choice: PlanChoice) => boolean;
  /** Why a plan is dimmed, said once under the rows it dims. */
  dimmedWhy: (choice: PlanChoice) => string;
  have: ReturnType<typeof existingRows>;
  /** The agent they are for, where the screen's title doesn't say it. */
  haveFor?: string;
  busy: boolean;
  onHave: (row: ExistingAi) => void;
}) {
  const { t } = useTranslation();
  const { org } = useAiOrg();
  const dimmed = have.flatMap((r) =>
    r.row.kind === "account" && dims(planOfAccount(r.row.choice.login)) ? [planOfAccount(r.row.choice.login)] : [],
  )[0];
  const noPlan = PLAN_CHOICES.every(dims);
  return (
    <View>
      {have.length > 0 ? (
        <>
          <GroupedHeader>
            {haveFor
              ? t("connectAi.have.titleFor", agentGrammar(haveFor))
              : org?.name
                ? t("mobile.ai.already", { org: org.name })
                : t("connectAi.have.title")}
          </GroupedHeader>
          <GroupedList>
            {have.map((r) => (
              <AiRow
                key={r.key}
                row={r}
                disabled={
                  busy ||
                  (r.row.kind === "account" && (r.row.act === "locked" || dims(planOfAccount(r.row.choice.login))))
                }
                onPress={() => onHave(r.row)}
              />
            ))}
            {have.some((r) => r.row.kind === "key") ? (
              <GroupedRow
                icon="key"
                label={t("connectAi.have.manageKeys")}
                chevron
                onPress={() => router.push("/ai-accounts" as never)}
              />
            ) : null}
          </GroupedList>
          {dimmed && !noPlan ? <GroupedFooter>{dimmedWhy(dimmed)}</GroupedFooter> : null}
          <GroupedHeader>{t("connectAi.have.other")}</GroupedHeader>
        </>
      ) : null}
      <GroupedList>
        <GroupedRow
          icon="sparkle"
          label={t("mobile.ai.planRow")}
          sub={t("mobile.ai.planRowSub")}
          faint={noPlan}
          chevron
          onPress={() => onView({ page: "plans" })}
        />
        <GroupedRow
          icon="key"
          label={t("mobile.ai.keyRow")}
          sub={t("mobile.ai.keyRowSub")}
          chevron
          onPress={() => onView({ page: "key" })}
        />
      </GroupedList>
      {noPlan ? <GroupedFooter>{dimmedWhy("claude")}</GroupedFooter> : null}
    </View>
  );
}

/** The plans, the most used first, with a search: what each is sold as under its name. */
function Plans({ onView, dims }: { onView: (v: FlowView) => void; dims: (choice: PlanChoice) => boolean }) {
  const { t } = useTranslation();
  return (
    <PickList
      options={PLAN_CHOICES.map((c) => ({
        value: c,
        label: planLabel(t, c),
        description: t(`connectAi.plan.${c}.tiers`),
        mark: planMark(c),
        off: dims(c),
        keywords: planPickText(t, c),
      }))}
      value={undefined}
      onPick={(o) => onView({ page: "plan", choice: o.value })}
      placeholder={t("connectAi.pick.searchPlaceholder")}
      searchLabel={t("connectAi.pick.search")}
      noResults={t("connectAi.pick.noResults")}
    />
  );
}

/** Whose API key: the makers, the most used first, with a search, then "Outro provedor" (a sheet only: `withEndpoint`). */
function Makers({ form, withEndpoint, onDone }: { form: ConnectKey; withEndpoint: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <PickList
      options={[
        ...PROVIDERS.map((p) => ({ value: p.id as string, label: p.label, mark: p.id as string, keywords: "" })),
        ...(withEndpoint
          ? [
              {
                value: CUSTOM_PROVIDER as string,
                label: t("endpoint.option"),
                description: t("endpoint.optionSub"),
                mark: CUSTOM_PROVIDER as string,
                keywords: "",
              },
            ]
          : []),
      ]}
      value={form.custom ? CUSTOM_PROVIDER : form.provider}
      onPick={(o) => {
        const maker = PROVIDERS.find((p) => p.id === o.value);
        form.setCustom(!maker);
        if (maker) form.setProvider(maker.id);
        onDone();
      }}
      placeholder={t("connectAi.pick.searchPlaceholder")}
      searchLabel={t("connectAi.pick.search")}
      noResults={t("connectAi.pick.noResults")}
    />
  );
}

/** A page's head: the option's mark, big, its name and what it covers. */
function Hero({ mark, title, sub }: { mark: ReactNode; title: string; sub: string }) {
  return (
    <View style={styles.hero}>
      {mark}
      <Text variant="title2" tone="ink" style={styles.center} accessibilityRole="header">
        {title}
      </Text>
      <Text variant="subhead" tone="muted" style={styles.center}>
        {sub}
      </Text>
    </View>
  );
}

/** A line in a white card (why the steps wait), with its action. `live`: announced when it comes. */
function InfoCard({
  icon,
  children,
  action,
  live = false,
}: {
  icon: IconName;
  children: ReactNode;
  action?: ReactNode;
  live?: boolean;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View
      style={[styles.info, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      accessibilityLiveRegion={live ? "polite" : undefined}
    >
      <Icon name={icon} size={18} color={c.ink2} />
      <Text variant="subhead" tone="muted">
        {children}
      </Text>
      {action ? <View style={styles.start}>{action}</View> : null}
    </View>
  );
}

/**
 * "Atende outras pessoas" for the agent a plan's page is for (ADR 0059 §5): on this plan's brain it is the agent's
 * own, changed at once; before the move it waits, and the move carries it (`move`), else the agent starts on its
 * owner alone. `plan`: the plan of the sign-in it thinks with there, an account's or the computer's own.
 */
function useReplies(gates: PlanGates, agentId: string | undefined, kind: MachineAccountKind) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  // The agent it was switched on for, before its move.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { view } = gates;
  const live = view !== undefined && view.agentId === agentId && view.brain === kind;
  const on = live ? !view.onlyOwner : waiting !== null && waiting === agentId;
  const change = async (next: boolean) => {
    if (!agentId) return;
    if (!live) return setWaiting(next ? agentId : null);
    setBusy(true);
    try {
      qc.setQueryData(keys.agentBrain(orgId, agentId), await api.agents.setBrain(orgId, agentId, { onlyOwner: !next }));
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  const plan = live ? signInPlan(view, gates.row, kind) : null;
  return { on, change, busy, move: on ? { onlyOwner: false } : {}, plan };
}

/** One plan's page: its mark, for which agent, then its steps on the agent's computer. */
function PlanPage(
  props: ConnectAiFlowProps & {
    choice: PlanChoice;
    gates: PlanGates;
    bareGates: GatesWithoutAgent;
    agentId: string | undefined;
    onAgent: (id: string) => void;
    /** A row of what the person already has asked for this sign-in. */
    login?: ExistingSignIn;
  },
) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { choice, agents, locked, onView, gates, agentId, onAgent } = props;
  const agent = agents.find((a) => a.id === agentId);
  const [done, setDone] = useState<{ agentId: string; agent: string; label: string } | null>(null);
  const kind = kindOf(choice);
  const replies = useReplies(gates, agentId, kind);
  // The team's right hand's own AI for the person serves them alone: no switch.
  const repliesRow =
    gates.view?.scope === "mine" ? null : (
      <PlanReplies
        agent={done?.agent ?? agent?.name ?? ""}
        on={replies.on}
        onChange={(on) => void replies.change(on)}
        brain={kind}
        plan={replies.plan}
        coding={planOf(choice)}
        disabled={replies.busy}
      />
    );
  // Which agent the account is for, in the app's picker: each agent with its face.
  const pick = () =>
    void pickOne({
      title: t("connectAi.agent"),
      value: agentId ?? null,
      options: agents.map((a) => ({ key: a.id, label: a.name, leading: { kind: "agent" as const, agentId: a.id } })),
    }).then((key) => {
      if (key) onAgent(key);
    });
  if (done) {
    return (
      <View style={styles.done}>
        {/* Alive, and glad: the agent can think now (a rare moment). */}
        <AgentFace agentId={done.agentId} size={64} expression="happy" />
        <Text variant="title2" tone="ink" style={styles.center}>
          {t("aiAccounts.done.savedAgent", { agent: done.agent, label: done.label })}
        </Text>
        <View style={styles.doneReplies}>{repliesRow}</View>
      </View>
    );
  }
  return (
    <View>
      <Hero
        mark={<ProviderLogo id={planMark(choice)} size="hero" />}
        title={planTitle(t, choice)}
        sub={t(`connectAi.plan.${choice}.tiers`)}
      />
      {locked ? (
        <Note icon="lock">{locked}</Note>
      ) : props.bare ? (
        <PlanWithoutAgent
          choice={choice}
          gates={props.bareGates}
          mayAddKey={props.mayAddKey}
          onKey={() => onView({ page: "key" })}
          onComputer={props.onComputer}
          onDone={() => props.onAccount?.()}
        />
      ) : agent ? (
        <>
          <GroupedHeader>{t("connectAi.agent")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              leading={<AgentFace agentId={agent.id} size={30} live={false} />}
              label={agent.name}
              {...(agents.length > 1 ? { value: t("mobile.ai.change"), chevron: true, onPress: pick } : {})}
            />
          </GroupedList>
          <GroupedHeader>{t("mobile.ai.how")}</GroupedHeader>
          <PlanSteps
            key={agent.id}
            choice={choice}
            gates={gates}
            agentId={agent.id}
            agentName={agent.name}
            justReady={props.justReady}
            onComputer={props.onComputer}
            onKey={() => onView({ page: "key" })}
            move={replies.move}
            repliesRow={repliesRow}
            {...(choice === "claude" && props.email ? { email: props.email } : {})}
            {...(props.login ? { login: props.login } : {})}
            onDone={(account) => {
              // The flow stays on that agent; another plan moves on to the next one with no AI.
              onAgent(agent.id);
              setDone({ agentId: agent.id, agent: agent.name, label: account?.label ?? planLabel(t, choice) });
              props.onPlanDone(agent.id);
            }}
          />
        </>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </View>
  );
}

/**
 * A plan's steps for a person who owns no agent yet: it signs in on a computer they may add accounts to, waiting and
 * saying why as `PlanSteps` does, and the account then thinks for the agents they create there.
 */
function PlanWithoutAgent({
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
  onComputer: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const machines = useMachines(orgId, gates.edition !== null);
  const [signingIn, setSigningIn] = useState(false);
  const [added, setAdded] = useState<MachineAccount | null>(null);
  const { gate, computer } = gates.at(choice);
  // An account of this plan they already have (their agents deleted) thinks for the next one: no second sign-in.
  const has = added ?? freePlanAccount(gates.accounts, choice);
  const cloud = gates.edition === "cloud";
  const managed = machines.data?.find((m) => m.kind === "managed");
  const name = cloud ? computerName(t, org?.name ?? "", managed, isPersonal(org)) : (computer?.name ?? "");
  const steps = gate.state === "ready" || gate.state === "preparing" || (gate.state === "offline" && signingIn);
  // Only whoever connected the computers there signs a plan in on them: a computer of their own is the way on.
  const elsewhere = gate.state === "locked" && !cloud;
  if (has) {
    return (
      <View style={styles.gap}>
        <InfoCard icon="check" live>
          {t("connectAi.forNewAgents", { label: has.label })}
        </InfoCard>
        {choice === "gemini" && geminiPersonal(has) ? (
          <Note icon="info">{t("connectAi.plan.gemini.warning")}</Note>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.gap}>
      <GateWait
        gate={gate}
        kind={kindOf(choice)}
        coding={isPlanId(choice)}
        machineId={computer?.machineId}
        computer={name}
        edition={gates.edition}
        signingIn={signingIn}
        onComputer={onComputer}
      />
      {elsewhere ? (
        <Button variant="primary" wide label={t("aiAccounts.connect.addComputer")} onPress={onComputer} />
      ) : null}
      {(offersKeyNow(gate, holdText(t, org?.standing) !== null) || (elsewhere && mayAddKey)) && !signingIn ? (
        <Button variant="ghost" wide label={t("connectAi.wait.useKey")} onPress={onKey} />
      ) : null}
      {steps ? (
        <AddAccount
          machineId={computer?.machineId ?? ""}
          kind={kindOf(choice)}
          computer={cloud ? t("connectAi.theComputer") : name}
          {...(isPlanId(choice) ? { provider: choice } : {})}
          local={computer?.mine}
          ready={gate.state === "ready"}
          onAdded={(a) => {
            setAdded(a);
            onDone();
          }}
          onSigningIn={setSigningIn}
        />
      ) : null}
      {steps ? <Note icon="info">{t("connectAi.forNewAgentsHint")}</Note> : null}
    </View>
  );
}

function PlanSteps({
  choice,
  gates,
  agentId,
  agentName,
  justReady,
  move,
  repliesRow,
  email,
  login,
  onKey,
  onComputer,
  onDone,
}: {
  choice: PlanChoice;
  gates: PlanGates;
  agentId: string;
  agentName: string;
  justReady?: boolean;
  /** "Atende outras pessoas" switched on before the move: the move says so. */
  move: { onlyOwner?: boolean };
  /** Who the agent answers, under its steps (`PlanReplies`). */
  repliesRow: ReactNode;
  /** One more login of the account with this email (`ConnectAiFlowProps.email`). */
  email?: string;
  /** A row of what the person already has: one more login of that account, or a free login of it signed back in. */
  login?: ExistingSignIn;
  onKey: () => void;
  onComputer: () => void;
  onDone: (account: MachineAccount | null) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors: c } = useTheme();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(orgId, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const [failedAccount, setFailedAccount] = useState<MachineAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState(false);
  // A sign-in begun here keeps its steps while its computer is offline: they say Reconectando, and it goes on.
  const [signingIn, setSigningIn] = useState(false);
  // It turned ready while the person watched (here or on another plan's page), or they came because it did.
  const waited = gates.waited || justReady === true;

  const managed = machines.data?.find((m) => m.kind === "managed");
  const computer =
    edition === "cloud" ? computerName(t, org?.name ?? "", managed, isPersonal(org)) : (view?.computer?.name ?? "");
  const refresh = () => {
    for (const key of [
      keys.agentBrain(orgId, agentId),
      keys.agents(orgId),
      keys.machines(orgId),
      keys.aiAccounts(orgId),
      keys.aiStatus(orgId),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // The sign-in ended: the agent thinks with that account right away (no confirming tap).
  const assign = async (a: MachineAccount) => {
    setSaving(true);
    setFailedAccount(null);
    try {
      qc.setQueryData(
        keys.agentBrain(orgId, agentId),
        await api.agents.setBrain(orgId, agentId, { brain: a.kind, account: a.id, ...move }),
      );
      refresh();
      onDone(a);
    } catch {
      setFailedAccount(a);
    } finally {
      setSaving(false);
    }
  };
  const saveOwn = async () => {
    try {
      qc.setQueryData(
        keys.agentBrain(orgId, agentId),
        await api.agents.setBrain(orgId, agentId, { brain: kind, account: null, ...move }),
      );
      refresh();
      onDone(null);
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    }
  };

  if (gates.failed)
    return (
      <InfoCard
        icon="x"
        action={<Button size="sm" variant="secondary" label={t("common.retry")} onPress={gates.retry} />}
      >
        {t("common.loadFailed")}
      </InfoCard>
    );
  if (saving) return <ActivityIndicator color={c.muted} style={styles.loading} />;
  if (failedAccount) {
    return (
      <InfoCard
        icon="x"
        action={
          <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void assign(failedAccount)} />
        }
      >
        {t("connectAi.assignFailed", { label: failedAccount.label, agent: agentName })}
      </InfoCard>
    );
  }

  const ready = gate.state === "ready";
  const useKey = <Button variant="ghost" wide label={t("connectAi.wait.useKey")} onPress={onKey} />;
  const hold = holdText(t, org?.standing);
  const wait = (
    <GateWait
      gate={gate}
      kind={kind}
      coding={coding}
      machineId={view?.computer?.machineId}
      computer={computer}
      edition={edition}
      signingIn={signingIn}
      onComputer={onComputer}
    />
  );

  // The steps stay in view while they wait (their computer actions off); a reason alone otherwise.
  const steps = ready || gate.state === "preparing" || (gate.state === "offline" && signingIn);
  // The sign-in asked for: a row's, or one more login of the account with `email`; never the agent's own then.
  const hint: Pick<ExistingSignIn, "again" | "email"> | undefined = login ?? (email ? { email } : undefined);
  const ownable = ready && !hint && ownSignInFor(choice, view, gates.row);
  // The shared sign-in's plan, where the computer says it ("Claude Max").
  const ownPlan = planWordOf(gates.row?.own?.[kind]?.plan ?? null);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && providerFitsChoice(a.provider, choice, coding),
  );
  // Signed in again: the agent's own login, unless this sign-in is another account's (`hint`).
  const signedOut = !hint && current?.status === "signed_out" ? current : undefined;
  // The accounts of this plan the person already has there for all of their agents (ADR 0059 §2): one tap each,
  // before another account.
  const existing =
    ready && !hint
      ? groupPlans(
          (view?.accounts ?? []).filter(
            (a) =>
              a.shared === true &&
              a.mine &&
              a.status === "active" &&
              a.kind === kind &&
              providerFitsChoice(a.provider, choice, coding) &&
              a.id !== view?.account,
          ),
        ).flatMap((g) => g.logins.slice(0, 1))
      : [];
  const choosing = ownable || existing.length > 0;
  return (
    <View style={styles.gap}>
      {wait}
      {offersKeyNow(gate, hold !== null) && !signingIn ? useKey : null}
      {ready && waited ? (
        // A card of its own, where the wait's was: never read as the head of the account choice under it.
        <InfoCard icon="check" live>
          {t("connectAi.wait.ready")}
        </InfoCard>
      ) : null}
      {choice === "gemini" && choosing && !other && existing.some(geminiPersonal) ? (
        <Note icon="info">{t("connectAi.plan.gemini.warning")}</Note>
      ) : null}
      {choosing ? (
        <GroupedList>
          {ownable ? (
            <GroupedRow
              label={kind === "opencode" ? t("connectAi.own.free") : t("connectAi.own.shared")}
              {...(ownPlan ? { sub: `${planLabel(t, choice)} ${ownPlan}` } : {})}
              onPress={() => void saveOwn()}
            />
          ) : null}
          {existing.map((a) => (
            <GroupedRow
              key={a.id}
              label={t("connectAi.use", { label: accountTitle(a) })}
              {...(a.usedBy.length > 0
                ? { sub: t("agentPage.work.brain.accountAlso", { agents: joinNames(a.usedBy, t) }) }
                : {})}
              onPress={() => void assign(a)}
            />
          ))}
          <GroupedRow
            label={ownable ? t("connectAi.own.one", agentGrammar(agentName)) : t("connectAi.another")}
            checked={other}
            onPress={() => setOther(true)}
          />
        </GroupedList>
      ) : null}
      {steps && (!choosing || other) ? (
        <AddAccount
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          // The Cloud's one computer goes unnamed in the account choice: the sign-in is about the account, not where.
          computer={edition === "cloud" ? t("connectAi.theComputer") : computer}
          {...(isPlanId(choice)
            ? { provider: choice }
            : signInProviderOf(signedOut?.provider)
              ? { provider: signInProviderOf(signedOut?.provider) }
              : {})}
          fresh={existing.length > 0 && other}
          again={hint ? hint.again : signedOut?.id}
          email={hint ? hint.email : signedOut?.email}
          local={view?.ownSignIn}
          ready={ready}
          loading={gates.catching}
          onAdded={(a) => void assign(a)}
          onUse={(a) => void assign(a)}
          onSigningIn={setSigningIn}
        />
      ) : null}
      {steps || ownable ? repliesRow : null}
    </View>
  );
}

/**
 * Why a plan's page waits or can't sign in there (`PlanGate`), with the way on: the computer's wait, a computer to
 * connect. Nothing once it's ready.
 */
function GateWait({
  gate,
  kind,
  coding,
  machineId,
  computer,
  edition,
  signingIn,
  onComputer,
}: {
  gate: PlanGate;
  kind: MachineAccountKind;
  coding: boolean;
  /** The computer the gate is about. */
  machineId: string | undefined;
  /** Its name, as the page says it. */
  computer: string;
  edition: Edition | null;
  signingIn: boolean;
  onComputer: () => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const { colors: c } = useTheme();
  const machines = useMachines(orgId, edition !== null);
  const hold = holdText(t, org?.standing);
  // Offline or unsupported: what's going on there and what comes next (on the Cloud, by itself: the page asks again).
  const why = gateLine(t, {
    gate,
    edition,
    kind,
    computer,
    hold,
    machine: machines.data?.find((m) => m.id === machineId),
  });
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <ActivityIndicator color={c.muted} style={styles.loading} />;
  else if (gate.state === "billing") {
    // A hold stops the Model Gateway for keys too, and paying happens on the web.
    wait = <InfoCard icon="pause">{planHoldPhoneLine(t, org ? can(org, "manage_billing") : false)}</InfoCard>;
  } else if (gate.state === "preparing") {
    const setup = gate.view;
    // A hold decides when anything runs there: it speaks alone. The wait is the app's own (its steps, the time left,
    // who hears when it's ready), for the workspace these pages connect for: the first run's too.
    wait = hold ? (
      <InfoCard icon="pause">{hold}</InfoCard>
    ) : (
      <View style={styles.gap}>
        {setup ? <SetupWait view={setup} workspace={{ orgId, name: org?.name ?? "" }} /> : null}
        <InfoCard icon="clock">{t(coding ? "connectAi.wait.key" : "connectAi.wait.signIn")}</InfoCard>
      </View>
    );
  } else if (why && !(gate.state === "offline" && signingIn)) {
    wait = <InfoCard icon={why.rechecks ? "clock" : "laptop"}>{why.text}</InfoCard>;
  } else if (gate.state === "missing") {
    wait = (
      <>
        <InfoCard
          icon="laptop"
          action={
            <Button size="sm" variant="primary" label={t("aiAccounts.connect.addComputer")} onPress={onComputer} />
          }
        >
          {t("aiAccounts.connect.noComputer")}
        </InfoCard>
        <Note icon="lock">{t("mobile.ai.meanwhile")}</Note>
      </>
    );
  } else if (gate.state === "locked") {
    const pairer = machines.data?.find((m) => m.id === machineId)?.pairedBy?.name.split(" ")[0];
    wait = (
      <InfoCard icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedOwner")}
      </InfoCard>
    );
  }

  return wait;
}

/**
 * The API key's page: whose key (one row that opens the makers; paid per use, straight to its maker), then the web's
 * two numbered steps: create the key on the maker's page, paste it here. Saved by its button.
 */
function KeyPage({
  mayAddKey,
  keyForm: form,
  keyButton = true,
  keySaved,
  onSaveKey,
  onMakers,
}: ConnectAiFlowProps & { onMakers: () => void }) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const hold = usePlanHold(orgId, org);
  const [touched, setTouched] = useState(false);
  const [opened, setOpened] = useState(false);
  const { custom } = form;
  const [endpointSaved, setEndpointSaved] = useState(false);
  const maker = providerOf(form.provider);
  const hint = maker && keyStepHint(maker);
  const clean = form.key.trim();
  const valid = keyLooksValid(form.provider, clean);
  const wrong = touched && clean.length > 0 && !valid;
  const others = wrong ? providersForKey(clean) : [];
  if (hold) return <PlanHoldNote org={org} keys />;
  if (!mayAddKey) return <InfoCard icon="lock">{t("connectAi.keyLocked")}</InfoCard>;
  if (keySaved || endpointSaved) {
    return (
      <View style={styles.done}>
        <ProviderLogo id={endpointSaved ? CUSTOM_PROVIDER : form.provider} size="hero" />
        <Text variant="title2" tone="ink" style={styles.center}>
          {(!endpointSaved && form.savedNote) || t("connectAi.key.saved")}
        </Text>
      </View>
    );
  }
  const site = maker ? new URL(`https://${maker.site}`) : null;
  return (
    <View>
      <GroupedHeader>{t("mobile.ai.whose")}</GroupedHeader>
      <Locked when={form.saving}>
        <GroupedList>
          <GroupedRow
            leading={<ProviderLogo id={custom ? CUSTOM_PROVIDER : form.provider} size="sm" />}
            label={custom ? t("endpoint.option") : providerLabel(form.provider)}
            chevron
            onPress={onMakers}
          />
        </GroupedList>
      </Locked>
      <GroupedFooter>{t("connectAi.key.sub")}</GroupedFooter>
      {custom ? (
        <View style={styles.keySteps}>
          <EndpointForm orgId={orgId} onDone={() => setEndpointSaved(true)} />
        </View>
      ) : maker && site ? (
        <View style={styles.keySteps}>
          <StepsCard>
            <Step
              n={1}
              state={opened || clean ? "done" : "now"}
              title={t("connectAi.key.create", { provider: providerLabel(form.provider) })}
              hint={hint && t(hint)}
              side={
                <OpenPage
                  href={site.href}
                  primary={!clean}
                  label={t("aiAccounts.add.openKeys", { site: site.host })}
                  onOpened={() => setOpened(true)}
                />
              }
            />
            <Step n={2} divider title={t("connectAi.key.paste")}>
              <Locked when={form.saving}>
                <PasteField
                  value={form.key}
                  onChangeText={form.setKey}
                  onPasted={form.setKey}
                  onBlur={() => setTouched(true)}
                  label={t("connectAi.key.paste")}
                  placeholder={maker.placeholder}
                  secret
                  onSubmit={() => {
                    setTouched(true);
                    if (valid && keyButton) onSaveKey?.();
                  }}
                />
              </Locked>
              {wrong ? (
                <View style={styles.others}>
                  <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
                    {t(`onboarding.keyInvalid.${form.provider}`)}
                  </Text>
                  {others.length > 0 ? (
                    <>
                      <Text variant="small" tone="faint">
                        {t("onboarding.keyFromOther")}
                      </Text>
                      {/* Buttons, not tag pills: each one switches the key's provider. */}
                      {others.map((p) => (
                        <Button
                          key={p.id}
                          variant="secondary"
                          size="sm"
                          leading={() => <ProviderLogo id={p.id} size="xs" />}
                          label={p.label}
                          onPress={() => form.setProvider(p.id)}
                        />
                      ))}
                    </>
                  ) : null}
                </View>
              ) : null}
            </Step>
          </StepsCard>
          {form.refused ? (
            <>
              <Note icon="x" live>
                {form.refused.text}
              </Note>
              {form.refused.href ? <OpenPage href={form.refused.href} label={form.refused.site} /> : null}
            </>
          ) : form.failed ? (
            <Note icon="x" live>
              {t("mobile.ai.failed")}
            </Note>
          ) : (
            <Note icon="info">{t("connectAi.key.forAll")}</Note>
          )}
          {keyButton ? (
            <View style={styles.save}>
              <Button
                variant="primary"
                wide
                label={form.saving ? t("mobile.ai.saving") : t("mobile.ai.save")}
                loading={form.saving}
                disabled={!valid}
                onPress={() => onSaveKey?.()}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  center: { textAlign: "center" },
  start: { alignSelf: "flex-start" },
  gap: { gap: 10 },
  loading: { marginTop: 16 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginBottom: 4 },
  pressed: { opacity: 0.6 },
  hero: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 4 },
  done: { alignItems: "center", gap: 12, paddingVertical: 24, paddingHorizontal: 10 },
  // The page's lists' width, under the centered words.
  doneReplies: { alignSelf: "stretch", marginHorizontal: -10, marginTop: 8 },
  info: { borderRadius: 14, padding: 14, gap: 10 },
  keySteps: { marginTop: 16, gap: 10 },
  others: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
  save: { marginTop: 6 },
});
