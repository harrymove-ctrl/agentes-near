import { keys, useAgentBrain, useAiStatus, useApi, useModels, useSetupPreview } from "@agenteschat/client";
import {
  autonomyName,
  changes,
  setupOfBrain,
  setupOutcome,
  setupResultLine,
  sortedResults,
  takers,
} from "@agenteschat/client/lib/agent-setup";
import { setupPlanOpens, setupPlanQuestion } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName } from "@agenteschat/client/lib/format";
import { isAuto } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { confirmQuestion } from "../chat/ReachLines";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { advancedOf } from "./AgentAdvancedScreen";
import { setupWords } from "./logic";
import { Note } from "./parts";

/*
 * "Usar em outros agentes" on the phone (ADR 0094), the web's dialog over "Quem pensa" as a screen of its own, from
 * "Pensa com": every other agent with what the agent's setup would do to it (the server's preview), those that can
 * take it first, "Todos" on top. "Usar" sends them in one call; the server checks each again.
 */

/** Opens "Usar em outros agentes" for an agent's saved setup. */
export const openAgentSetup = (agentId: string) => router.push(`/agent-setup/${agentId}` as never);

export function AgentSetupScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const brain = useAgentBrain(orgId, agentId);
  const apiKey = useAiStatus(orgId).data?.apiKey !== false;
  const models = useModels();
  // "Levar a autonomia" off: the others keep their own.
  const [withAutonomy, setWithAutonomy] = useState(true);
  const view = brain.data && !withAutonomy ? { ...brain.data, autonomy: undefined } : brain.data;
  const setup = view ? setupOfBrain(view) : null;
  const others = dir.agents.filter((a) => a.id !== agentId);
  const preview = useSetupPreview(
    orgId,
    setup,
    others.map((a) => a.id),
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const results = sortedResults(preview.data ?? []);
  const can = takers(results);
  const chosen = can.filter((id) => picked.has(id));
  const setupText = view ? setupWords(t, i18n.language, view, { apiKey, now: advancedOf(view) }) : "";
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const use = async () => {
    if (!setup || !view || chosen.length === 0) return;
    // Letting more people talk to agents on other people's plans asks once, before anything saves.
    const opens = setupPlanOpens(
      results,
      chosen,
      (id) => dir.agentById.get(id),
      (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    );
    const provider = view.accounts.find((a) => a.id === view.account)?.provider ?? null;
    if (!(await confirmQuestion(t, setupPlanQuestion(t, { kind: view.brain, provider }, opens)))) return;
    setBusy(true);
    try {
      const results = await api.agents.applySetup(orgId, { setup, agentIds: chosen });
      const { done, autonomyOnly, missed } = setupOutcome(results, chosen.length);
      if (done > 0)
        toast({ title: t("agentPage.work.brain.copy.done", { count: done, setup: setupText }), icon: "check" });
      if (autonomyOnly > 0)
        toast({ title: t("agentPage.work.brain.copy.autonomyOnly", { count: autonomyOnly }), icon: "check" });
      if (missed > 0) toast({ title: t("agentPage.work.brain.copy.missed", { count: missed }), icon: "x" });
      router.back();
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [
        ...chosen.map((id) => keys.agentBrain(orgId, id)),
        keys.agents(orgId),
        keys.aiStatus(orgId),
        keys.newAgentSetup(orgId),
        // Nova missão starts from each agent's Autonomia.
        [...keys.missions(orgId), "eligible"],
      ])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.copy.title")} solid={false} grouped />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.in, { paddingBottom: 24 }]}>
        {brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !setup || preview.isError ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          <>
            <Text variant="body" tone="muted" style={styles.lead}>
              {t("agentPage.work.brain.copy.sub", { setup: setupText })}
            </Text>
            {brain.data?.autonomy ? (
              <View style={styles.autonomy}>
                <GroupedList>
                  <GroupedRow
                    icon="shield"
                    label={t("agentPage.work.brain.copy.withAutonomy")}
                    sub={t("agentPage.work.brain.copy.withAutonomyLine", {
                      value: autonomyName(t, brain.data.autonomy),
                    })}
                    subLines={2}
                    toggle={withAutonomy}
                    disabled={busy}
                    onPress={() => setWithAutonomy((on) => !on)}
                  />
                </GroupedList>
              </View>
            ) : null}
            {preview.isPending ? (
              <ActivityIndicator color={c.muted} style={styles.loading} />
            ) : (
              <>
                <GroupedList>
                  <GroupedRow
                    icon="members"
                    label={t("agentPage.work.brain.copy.all")}
                    sub={
                      can.length === 0
                        ? t("agentPage.work.brain.copy.none")
                        : t("agentPage.work.brain.copy.allLine", { count: can.length })
                    }
                    checked={can.length > 0 && chosen.length === can.length}
                    disabled={busy || can.length === 0}
                    onPress={() => setPicked(new Set(chosen.length === can.length ? [] : can))}
                  />
                </GroupedList>
                <View style={styles.gap}>
                  <GroupedList>
                    {results.map((r) => {
                      const a = dir.agentById.get(r.agentId);
                      if (!a) return null;
                      const ownerName = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
                      const owner = ownerName ? firstName(ownerName) : undefined;
                      const api = isAuto(a.model)
                        ? t("brain.auto.label")
                        : (models.data?.models.find((m) => m.id === a.model)?.label ?? a.model);
                      const now = brainLine(t, a.brain, api).text;
                      return (
                        <GroupedRow
                          key={a.id}
                          leading={<AgentAvatar agent={{ ...agentLook(a), id: a.id }} size={32} live={false} />}
                          label={a.name}
                          sub={setupResultLine(t, r, { now, owner })}
                          checked={changes(r) && picked.has(a.id)}
                          disabled={busy || !changes(r)}
                          onPress={() => toggle(a.id)}
                        />
                      );
                    })}
                  </GroupedList>
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: c.line, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Button
          variant="primary"
          wide
          label={
            chosen.length === 0
              ? t("agentPage.work.brain.copy.pick")
              : t("agentPage.work.brain.copy.use", { count: chosen.length })
          }
          disabled={busy || chosen.length === 0}
          onPress={() => void use()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { marginTop: 16 },
  lead: { paddingHorizontal: 4, paddingBottom: 14 },
  autonomy: { marginBottom: 20 },
  // A list without a header keeps a header's room above it.
  gap: { marginTop: 20 },
  footer: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
