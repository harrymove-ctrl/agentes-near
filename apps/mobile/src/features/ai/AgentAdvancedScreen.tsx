import type { AgentBrain, AgentBrainInput, BrainSpeed } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useAiStatus, useApi, useModels } from "@agenteschat/client";
import { signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { EVERYONE_AUDIENCE } from "@agenteschat/client/lib/audience";
import {
  type Advanced,
  advancedDefaults,
  advancedSummary,
  effortLevel,
  isAdvancedDefault,
  SPEEDS,
  viewSpeedFits,
} from "@agenteschat/client/lib/brain-advanced";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { type ContextLimit, contextChoices, contextSize, isContextLimit } from "@agenteschat/client/lib/context-limits";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { planOf } from "@agenteschat/client/lib/plans";
import { isAuto } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useWidenAsk } from "../chat/ReachLines";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { EffortRamp, useBrainChoice, useEffortChoice } from "./EffortRamp";
import { accountKindOf, agentAccounts } from "./logic";
import { Note, PlanReplies } from "./parts";

/*
 * An agent's "Configuração avançada" on the phone (ADR 0086), the web's dialog over "Quem pensa" as a screen of its
 * own, opened from "Pensa com" by its owner or an admin: how it thinks (effort on its computer, a ramp with a fixed
 * model and a row that says "Automático" picks it otherwise; Velocidade where it applies; the context window, any
 * brain) and who it answers
 * ("Atende outras pessoas", answering through the API while its
 * computer is away). Each choice saves at once, like the rest of "Pensa com"; "Voltar ao padrão" puts them all back.
 */

/** Opens an agent's advanced settings. */
export const openAgentAdvanced = (agentId: string) => router.push(`/agent-advanced/${agentId}` as never);

/** What the agent's view says for the advanced settings (a limit past its model's window reads as none). */
export const advancedOf = (view: AgentBrain, options?: readonly ContextLimit[]): Advanced => {
  const tokens = isContextLimit(view.contextTokens) ? view.contextTokens : null;
  return {
    effort: effortLevel(view.effort),
    speed: viewSpeedFits(view) ? view.speed : "standard",
    contextTokens: tokens !== null && (!options || options.includes(tokens)) ? tokens : null,
    onlyOwner: view.onlyOwner,
    fallback: view.fallback,
  };
};

export function AgentAdvancedScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  const ask = useWidenAsk(agent);
  const name = agent?.name ?? "";
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const g = agentGrammar(name);
  const brain = useAgentBrain(orgId, agentId);
  const models = useModels();
  const apiKey = useAiStatus(orgId).data?.apiKey !== false;
  const [busy, setBusy] = useState(false);
  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where the computer's own sign-in's plan is (a seat has its own words).
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (r) => r.machineId === view?.computer?.machineId,
  );
  const current =
    view && kind ? agentAccounts(view, kind, agent?.ownerUserId, name).find((a) => a.id === view.account) : undefined;
  const autoModel = view?.brain === "model" ? isAuto(agent?.model) : isAuto(view?.effectiveModel);
  // The sizes under the window of the model it thinks with ("Automático": any of its line).
  const options = !view
    ? []
    : view.brain === "model"
      ? contextChoices(autoModel ? undefined : models.data?.models.find((m) => m.id === agent?.model))
      : contextChoices(
          autoModel
            ? undefined
            : view.options.find((o) => o.kind === view.brain)?.models.find((m) => m.value === view.effectiveModel),
        );
  const now = view ? advancedOf(view, options) : null;
  const may = !busy && view?.canEdit === true;
  const effort = useEffortChoice(agentId, now?.effort);
  const speed = useBrainChoice<BrainSpeed>(agentId, now?.speed ?? "standard", (value) => ({ speed: value }));
  const fallbackLabel = t("agentPage.work.brain.fallbackTitle", {
    computer: computerNameOf(t, org?.name ?? "", view?.computer?.name ?? "", isPersonal(org)),
  });

  /** Saves at once and says what the row on "Pensa com" will say now (or `done`). */
  const save = async (input: AgentBrainInput, done?: string) => {
    setBusy(true);
    try {
      const next = await api.agents.setBrain(orgId, agentId, input);
      qc.setQueryData(keys.agentBrain(orgId, agentId), next);
      const line = advancedSummary(t, i18n.language, {
        kind: next.brain,
        autoModel,
        apiKey,
        now: advancedOf(next, options),
      });
      toast({ title: done ?? line, icon: "check" });
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [keys.agentBrain(orgId, agentId), keys.agents(orgId)])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };
  const putBack = () => {
    if (!view || !now) return;
    const to = advancedDefaults(view.brain, now);
    void save({
      contextTokens: to.contextTokens,
      ...(view.brain === "model"
        ? {}
        : {
            ...(autoModel ? {} : { effort: to.effort }),
            ...(to.speed !== now.speed ? { speed: to.speed } : {}),
            ...(to.onlyOwner !== view.onlyOwner ? { onlyOwner: to.onlyOwner } : {}),
            fallback: to.fallback,
          }),
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.advanced.title")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !view || !now ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          <>
            {kind ? (
              <View style={styles.gap}>
                <GroupedList>
                  {autoModel ? (
                    // "Automático" picks the effort too: the row says so and leads to a model, which brings the ramp.
                    <GroupedRow
                      label={t("agentPage.work.brain.effort")}
                      sub={t("agentPage.work.brain.effortText.auto")}
                      chevron
                      onPress={() => router.push(`/agent-model/${agentId}` as never)}
                    />
                  ) : (
                    <View style={styles.ramp}>
                      <EffortRamp
                        value={effort.value}
                        onChange={effort.change}
                        color={agentLook(agent).color}
                        disabled={!view.canEdit}
                      />
                    </View>
                  )}
                </GroupedList>
              </View>
            ) : null}
            {viewSpeedFits(view) ? (
              <>
                <GroupedHeader
                  hint={{
                    name: t("common.about", { label: t("agentPage.work.brain.speed") }),
                    text: t("agentPage.work.brain.speedText"),
                  }}
                >
                  {t("agentPage.work.brain.speed")}
                </GroupedHeader>
                <GroupedList>
                  {SPEEDS.map((s) => (
                    <GroupedRow
                      key={s}
                      label={t(`agentPage.work.brain.speeds.${s}`)}
                      checked={speed.value === s}
                      disabled={!view.canEdit}
                      onPress={() => s !== speed.value && speed.change(s)}
                    />
                  ))}
                </GroupedList>
              </>
            ) : null}
            <GroupedHeader>{t("agentPage.work.brain.context")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={t("brain.auto.label")}
                sub={t("agentPage.work.brain.contextText.auto")}
                checked={now.contextTokens === null}
                disabled={!may}
                onPress={() => now.contextTokens !== null && void save({ contextTokens: null })}
              />
              {options.map((n) => (
                <GroupedRow
                  key={n}
                  label={contextSize(n)}
                  sub={t(`agentPage.work.brain.contextText.${n}`)}
                  subLines={2}
                  checked={now.contextTokens === n}
                  disabled={!may}
                  onPress={() => n !== now.contextTokens && void save({ contextTokens: n })}
                />
              ))}
            </GroupedList>
            {kind ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.advanced.answers")}</GroupedHeader>
                {agent?.ownerUserId ? (
                  <PlanReplies
                    agent={name}
                    owner={view.canUsePlans ? undefined : ownerFirst}
                    on={!view.onlyOwner}
                    onChange={async (on) => {
                      if (busy) return;
                      // Letting more people in on someone else's plan asks first: it spends their plan.
                      if (on && view.onlyOwner && !(await ask(EVERYONE_AUDIENCE)([]))) return;
                      void save(
                        { onlyOwner: !on },
                        on
                          ? t("aiAccounts.share.savedEveryone", g)
                          : view.canUsePlans
                            ? t("aiAccounts.share.savedOwner", g)
                            : t("aiAccounts.share.savedOwnerOf", { ...g, owner: ownerFirst ?? "" }),
                      );
                    }}
                    brain={kind}
                    plan={signInPlan(view, row, kind)}
                    coding={planOf(current?.provider)}
                    disabled={busy}
                    keep
                  />
                ) : null}
                {apiKey ? (
                  <View style={styles.gap}>
                    <GroupedList>
                      <GroupedRow
                        label={fallbackLabel}
                        labelLines={2}
                        hint={{
                          name: t("common.about", { label: fallbackLabel }),
                          text: t("agentPage.work.brain.fallbackHint", g),
                        }}
                        toggle={view.fallback}
                        disabled={!may}
                        onPress={() => void save({ fallback: !view.fallback })}
                      />
                    </GroupedList>
                  </View>
                ) : null}
              </>
            ) : null}
            <View style={styles.gap}>
              <GroupedList>
                <GroupedRow
                  label={t("agentPage.work.brain.advanced.defaults")}
                  disabled={!may || isAdvancedDefault(view.brain, now)}
                  onPress={putBack}
                />
              </GroupedList>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { marginTop: 16 },
  // A list without a header keeps a header's room above it.
  gap: { marginTop: 20 },
  // On the rows' 14 pt edge.
  ramp: { paddingHorizontal: 14, paddingVertical: 12 },
});
