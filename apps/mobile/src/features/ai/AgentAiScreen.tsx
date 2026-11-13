import type { AgentBrain, AgentBrainInput, MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useMachines, useModels } from "@agenteschat/client";
import {
  accountChoices,
  offersSignInAgain,
  ownSignInListed,
  ownSignInName,
  signInOf,
} from "@agenteschat/client/lib/ai-accounts";
import { brainLine, thinksWith } from "@agenteschat/client/lib/brain";
import { advancedContents, viewSpeedFits } from "@agenteschat/client/lib/brain-advanced";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiChoiceOf, planOfKind } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { modelLimitText } from "@agenteschat/client/lib/plan-usage";
import { brainPlan, geminiPersonal, isPlanId, planFreeHint, planOf } from "@agenteschat/client/lib/plans";
import { apiProviderOf, isAuto, providerLabel } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { extraUsageOn, limitOffers, planState } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Glass,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  ProviderLogo,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { PlanMeter } from "../usage/parts";
import { advancedOf, openAgentAdvanced } from "./AgentAdvancedScreen";
import { openAgentSetup } from "./AgentSetupScreen";
import { EffortRamp, useEffortChoice } from "./EffortRamp";
import {
  accountInput,
  accountKindOf,
  accountRow,
  accountSaved,
  agentAccounts,
  modelInput,
  modelRows,
  modelSections,
  takenFrom,
  thinkingUsage,
} from "./logic";
import { openConnectAi } from "./NoAiCard";
import { AiRow, Note, PlanHoldNote, usePlanHold } from "./parts";

/*
 * An agent's AI on the phone (the web's "Quem pensa" for a plan, ADR 0059), from "Pensa com" on its profile, under what
 * thinks in one sentence ("DeepSeek V4.1 Flash pelo OpenCode Go"): the account it thinks with on its computer (one of
 * its owner's, or that computer's own sign-in), one row per account, which is the plan choice (another plan's starts
 * on that plan's default model), then the model, that plan's usage with, at its limit, the owner's other accounts that
 * could think instead, and
 * "Configuração avançada" (ADR 0086: effort, context window, "Atende outras pessoas", the API when away, on a screen of
 * its own). Each choice saves at once. Another AI, or one more login of an account other agents think with where it
 * may have one per agent ("Também usada por Theo"), goes through Connect an AI. Its owner and admins open it; only its
 * owner picks an account or lets other people talk to it on the plan (`canUsePlans`).
 */

/** Opens an agent's AI. */
export const openAgentAi = (agentId: string) => router.push(`/agent-ai/${agentId}` as never);

/** Opens an agent's model, from its AI. */
const openAgentModel = (agentId: string) => router.push(`/agent-model/${agentId}` as never);

/** Saves a change to the agent's AI at once and says so (or that it failed). */
function useSaveBrain(agentId: string) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (input: AgentBrainInput, done: string | ((saved: AgentBrain) => string)) => {
    setBusy(true);
    try {
      const saved = await api.agents.setBrain(orgId, agentId, input);
      qc.setQueryData(keys.agentBrain(orgId, agentId), saved);
      toast({ title: typeof done === "string" ? done : done(saved), icon: "check" });
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [
        keys.agentBrain(orgId, agentId),
        keys.agents(orgId),
        keys.aiAccounts(orgId),
        keys.aiStatus(orgId),
      ])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };
  return { busy, save };
}

export function AgentAiScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org);
  const api = useApi();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const meId = useMeId();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(name);
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  // As on the web: its owner and admins load it, members don't.
  const allowed = (meId !== null && agent?.ownerUserId === meId) || can(org, "manage_agents");
  const brain = useAgentBrain(orgId, agentId, allowed);
  const { busy, save } = useSaveBrain(agentId);
  // Looking at the plan: its usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);

  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where that computer's own sign-in shows once its CLI is signed in.
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (c) => c.machineId === view?.computer?.machineId,
  );
  const thinks = brainLine(t, agent?.brain, t("brain.model"), { agents: dir.agents });
  // Through the API: its maker's mark.
  const models = useModels().data?.models;
  const thinksMark = thinks.mark ?? apiProviderOf(agent?.model, models ?? []);
  const model = view && kind ? modelRows(t, view, brainPlan(view)).find((r) => r.checked) : undefined;
  const accounts = view && kind ? agentAccounts(view, kind, agent?.ownerUserId, name) : [];
  const current = view ? accounts.find((a) => a.id === view.account) : undefined;
  // Another account, or one more login of `a` other agents use (`also`, its email Claude's hint): Connect an AI on that
  // plan's page (a coding plan's key, on its first page).
  const connect = (a: MachineAccount | undefined, also = false) =>
    openConnectAi({
      agentId,
      ...(kind && !planOf(a?.provider) ? { intent: planOfKind(kind) } : {}),
      ...(also && a?.email ? { email: a.email } : {}),
    });
  const computer = computerNameOf(t, org?.name ?? "", view?.computer?.name ?? "", isPersonal(org));
  const mayPick = view !== undefined && !busy;
  const choose = (a: MachineAccount | null) => {
    if (!view || !mayPick || (a?.id ?? null) === view.account) return;
    const input = accountInput(view, a);
    const done = (saved: AgentBrain) => accountSaved(t, i18n.language, name, a, input, saved);
    const others = a ? takenFrom(a, name) : [];
    if (!a || others.length === 0) return void save(input, done);
    // A login made for one agent thinks for one: picking another agent's takes it from that one.
    Alert.alert(a.label, t("agentPage.work.brain.accountMove", { agents: others.join(", ") }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("mobile.ai.moveHere"), onPress: () => void save({ ...input, moveAccount: true }, done) },
    ]);
  };

  const usage = view && kind ? thinkingUsage(view, kind) : undefined;
  const limited = usage ? planState(usage).state === "limited" : false;
  const modelLimit = modelLimitText(t, i18n.language, usage, current?.provider, model?.value);
  const offers = limited && kind && view ? limitOffers(accounts, kind, view.account).slice(0, 2) : [];
  const signedOut = current != null && signInOf(current) === "signed_out" && current.mine;
  const signInAgain = current != null && offersSignInAgain(current) && current.mine;
  // A coding plan's key that its endpoint refused: a new key, on that plan's page.
  const refused = signInAgain && current && isPlanId(current.provider) ? current.provider : null;
  // Someone else's plans listed for whoever may use them: whose they are, and that their owner hears it.
  const lends = view?.canUseOthersPlans === true && accounts.some((a) => !a.mine && a.ownerId !== agent?.ownerUserId);
  const accountNote = signedOut
    ? t(refused ? "aiAccounts.page.keyRefused" : "agentPage.work.brain.accountSignedOut")
    : current != null && signInOf(current) === "unknown"
      ? t("aiAccounts.page.statusUnknown")
      : lends
        ? t("agentPage.work.brain.accountOthers")
        : view && !view.canUsePlans && ownerFirst
          ? t("agentPage.work.brain.accountWho", { ...g, owner: ownerFirst })
          : null;
  const ownRow = view !== undefined && kind !== null && ownSignInListed(view, row, kind);
  const choices = view ? accountChoices(accounts, [view.account]) : [];
  const adds = view?.canUsePlans === true && view.canManageAccounts;
  // On someone else's computer only whoever connected it adds a sign-in: with nothing of the owner's there, why, in
  // place of the list.
  const lockedHere = view !== undefined && kind !== null && !ownRow && choices.length === 0 && !adds;
  const pairer = useMachines(orgId, lockedHere).data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy;

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.intentAgents.thinks")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.hero}>
          {thinksMark ? <ProviderLogo id={thinksMark} size="hero" /> : null}
          <Text variant="title2" tone="ink" style={styles.center}>
            {thinks.text}
          </Text>
        </View>
        {hold ? <PlanHoldNote org={org} /> : null}
        {!allowed ? (
          <Note icon="lock">{t("agentPage.lock.admins")}</Note>
        ) : brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !view ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          <>
            {/* The account first: on the phone the account list is the plan choice, which the model then follows. */}
            {kind && view.accountsSupported && view.computer ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.account")}</GroupedHeader>
                <GroupedList>
                  {ownRow ? (
                    <GroupedRow
                      leading={<ProviderLogo id={kind} size="sm" />}
                      label={ownSignInName(t, view.ownSignIn && view.canUsePlans, computer, kind)}
                      checked={view.account === null}
                      disabled={!mayPick}
                      onPress={() => choose(null)}
                    />
                  ) : null}
                  {choices.map((c) => (
                    <AiRow
                      key={c.login.id}
                      row={accountRow(t, c, name)}
                      checked={c.login.id === view.account}
                      disabled={!mayPick}
                      onPress={() => (c.also ? connect(c.login, true) : choose(c.login))}
                    />
                  ))}
                  {adds ? (
                    <GroupedRow
                      icon="plus"
                      label={
                        refused
                          ? t("aiAccounts.page.newKey")
                          : signInAgain
                            ? t("agentPage.work.brain.signInAgain")
                            : t("agentPage.work.brain.addAccount")
                      }
                      onPress={() => (refused ? openConnectAi({ agentId, plan: refused }) : connect(current))}
                    />
                  ) : null}
                </GroupedList>
                {kind === "antigravity" && geminiPersonal(current) ? (
                  <Note icon="info">{t("connectAi.plan.gemini.warning")}</Note>
                ) : null}
                {lockedHere ? (
                  <Note icon="lock">
                    {t("connectAi.accountsLocked", { name: pairer?.name.split(" ")[0] ?? "", computer })}
                  </Note>
                ) : null}
                {accountNote ? <GroupedFooter>{accountNote}</GroupedFooter> : null}
              </>
            ) : null}
            {kind ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.planModel")}</GroupedHeader>
                <GroupedList>
                  <GroupedRow
                    label={model?.label ?? view.effectiveModel ?? ""}
                    {...(model?.sub ? { sub: model.sub } : {})}
                    {...(model?.needs ? { belowText: t(`brain.modelHow.${model.needs}`) } : {})}
                    chevron
                    onPress={() => openAgentModel(agentId)}
                  />
                </GroupedList>
              </>
            ) : null}
            {usage ? (
              <>
                <GroupedHeader>{t("agentPage.tabs.usage")}</GroupedHeader>
                <GroupedList>
                  <View style={styles.meter}>
                    <PlanMeter usage={usage} />
                  </View>
                  {offers.map(({ account: a, used }) => (
                    <GroupedRow
                      key={a.id}
                      leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" />}
                      label={
                        used === null
                          ? t("aiAccounts.usage.offer.useUnknown", { label: a.label })
                          : t("aiAccounts.usage.offer.use", { label: a.label, pct: used })
                      }
                      disabled={busy}
                      onPress={() => choose(a)}
                    />
                  ))}
                  {extraUsageOn(usage) ? (
                    <GroupedRow
                      label={t("usageCard.extraTitle")}
                      labelLines={2}
                      toggle={view.extraUsage}
                      disabled={busy || !(current ? current.mine : view.canUsePlans)}
                      onPress={() => void save({ extraUsage: !view.extraUsage }, t("usageCard.extraTitle"))}
                    />
                  ) : null}
                  {limited && view.canUsePlans && view.canManageAccounts ? (
                    <GroupedRow
                      icon="plus"
                      label={t("aiAccounts.usage.offer.connect")}
                      onPress={() => connect(current)}
                    />
                  ) : null}
                </GroupedList>
                {modelLimit ? <GroupedFooter>{modelLimit}</GroupedFooter> : null}
              </>
            ) : null}
            <View style={styles.advanced}>
              <GroupedList>
                <GroupedRow
                  label={t("agentPage.work.brain.advanced.title")}
                  sub={advancedContents(t, {
                    kind: view.brain,
                    autoModel: isAuto(view.effectiveModel),
                    speed: viewSpeedFits(view),
                  })}
                  chevron
                  onPress={() => openAgentAdvanced(agentId)}
                />
                {kind &&
                view.canEdit &&
                (view.account !== null || ownRow) &&
                dir.agents.some((a) => a.id !== agentId) ? (
                  <GroupedRow
                    label={t("agentPage.work.brain.copy.row")}
                    sub={t("agentPage.work.brain.copy.rowLine")}
                    chevron
                    onPress={() => openAgentSetup(agentId)}
                  />
                ) : null}
              </GroupedList>
            </View>
            {view.canUsePlans ? (
              <>
                <GroupedHeader>{t("mobile.ai.another")}</GroupedHeader>
                <GroupedList>
                  <GroupedRow
                    icon="brain"
                    label={t("connectAi.titleFor", g)}
                    chevron
                    onPress={() => openConnectAi({ agentId })}
                  />
                </GroupedList>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** How far the dock travels to leave the screen, past its own height. */
const DOCK_OUT = 28;
const DOCK_SPRING = { stiffness: 240, damping: 26, mass: 1 };

/**
 * The effort, floating over the model list in the thumb's reach, whatever is scrolled under it. It slides away with
 * "Automático", which picks the effort too.
 */
function EffortDock({ agentId, shown, onHeight }: { agentId: string; shown: boolean; onHeight: (h: number) => void }) {
  const { colors, shadows } = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const { orgId } = useOrg();
  const view = useAgentBrain(orgId, agentId).data;
  const effort = useEffortChoice(agentId, view ? advancedOf(view).effort : undefined);
  const out = useSharedValue(shown ? 0 : 1);
  const height = useSharedValue(0);
  useEffect(() => {
    out.value = reduced ? (shown ? 0 : 1) : withSpring(shown ? 0 : 1, DOCK_SPRING);
  }, [shown, reduced, out]);
  const slid = useAnimatedStyle(() => ({
    transform: [{ translateY: out.value * (height.value + insets.bottom + DOCK_OUT) }],
  }));
  return (
    <Animated.View
      pointerEvents={shown ? "auto" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      onLayout={(e) => {
        height.value = e.nativeEvent.layout.height;
        onHeight(e.nativeEvent.layout.height);
      }}
      style={[styles.dock, { bottom: insets.bottom + 8, boxShadow: shadows.e2 }, slid]}
    >
      <Glass liquid intensity={70} style={[styles.dockGlass, { borderColor: colors.line2 }]}>
        <EffortRamp
          value={effort.value}
          onChange={effort.change}
          color={agentLook(dir.agentById.get(agentId)).color}
          disabled={view?.canEdit !== true}
        />
      </Glass>
    </Animated.View>
  );
}

/**
 * The agent's model, pushed from its AI ("Modelo"): Automático, or one of its brain's models (every model of its
 * coding plan, with what each is sold as), and with a fixed model how hard it thinks. A tap saves at once.
 */
export function AgentModelScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const g = agentGrammar(dir.agentById.get(agentId)?.name ?? "");
  const brain = useAgentBrain(orgId, agentId);
  const { busy, save } = useSaveBrain(agentId);
  // Opened straight from a link too: the plans' lists come with it.
  useModels();
  const view = brain.data;
  const plan = view ? brainPlan(view) : undefined;
  const rows = view ? modelRows(t, view, plan) : [];
  const freeHint = planFreeHint(t, plan);
  // A model without a maker of its own wears its plan's mark, else its brain's.
  const mark = (plan && view?.accounts.find((a) => a.id === view.account)?.provider) || (view?.brain ?? "");
  const hasModels = view !== undefined && view.brain !== "model";
  const fixed = hasModels && !isAuto(view.effectiveModel);
  const [dock, setDock] = useState(0);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.planModel")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 + (fixed ? dock : 0) }]}
      >
        {brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !view || view.brain === "model" ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          modelSections(rows).map((s) => (
            <Fragment key={s.maker ?? ""}>
              {s.maker ? <GroupedHeader>{providerLabel(s.maker)}</GroupedHeader> : null}
              <GroupedList>
                {s.rows.map((r) => (
                  <GroupedRow
                    key={r.value}
                    label={r.label}
                    {...(r.sub ? { sub: r.sub } : {})}
                    {...(r.note ? { hint: { name: t("common.about", { label: r.label }), text: r.note } } : {})}
                    {...(isAuto(r.value)
                      ? { icon: "sparkle" as const }
                      : { leading: <ProviderLogo id={r.maker ?? mark} size="sm" /> })}
                    checked={r.checked}
                    disabled={busy || !view.canEdit}
                    onPress={() => {
                      if (r.checked) return;
                      const ai = aiChoiceOf(view);
                      const done = t("agentPage.work.saved.brain", {
                        ...g,
                        brain: ai === "key" ? r.label : thinksWith(t, ai, r.label),
                      });
                      void save(modelInput(r.value, view), done);
                    }}
                  />
                ))}
              </GroupedList>
            </Fragment>
          ))
        )}
        {view && freeHint ? <Note icon="info">{freeHint}</Note> : null}
      </ScrollView>
      {hasModels ? <EffortDock agentId={agentId} shown={fixed} onHeight={setDock} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  hero: { alignItems: "center", gap: 10, paddingTop: 6, paddingBottom: 4 },
  center: { textAlign: "center" },
  loading: { marginTop: 16 },
  meter: { paddingHorizontal: 14, paddingVertical: 12 },
  // A list without a header keeps a header's room above it.
  advanced: { marginTop: 20 },
  dock: { position: "absolute", left: 10, right: 10, borderRadius: 28 },
  dockGlass: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
