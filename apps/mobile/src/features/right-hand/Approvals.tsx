import type { RightHandApprovals, RightHandApprovalsInput } from "@agenteschat/client";
import { useRightHandApprovals, useSetRightHandApprovals } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { TextArea } from "../shared/TextArea";

const USD = 1_000_000_000;
/** The budgets offered per agent (the web takes any amount up to US$ 50). */
const BUDGETS = [5, 10, 20, 50];

/** What the right hand creates and adjusts for the person without asking, on its own screen; nothing while it loads. */
export function RightHandApprovalsGroup() {
  const { orgId } = useOrg();
  const view = useRightHandApprovals(orgId).data;
  return view?.rightHand ? <RightHandGroup view={view} name={view.rightHand.name} /> : null;
}

/**
 * What the right hand does for the person without asking (ADR 0139 §2), under the workspace's name for it: the switch,
 * the two kinds (greyed when the person can't decide them), the budget per agent and their own guidance, saved as they
 * change.
 */
function RightHandGroup({ view, name }: { view: RightHandApprovals; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const set = useSetRightHandApprovals(orgId);
  const [guidance, setGuidance] = useState<string | null>(null);
  const save = (patch: RightHandApprovalsInput) =>
    set.mutate(patch, { onError: () => toast({ title: t("approvalCover.failed"), icon: "x" }) });
  const on = view.enabled && !view.pausedAt;
  const budget = Math.round(view.budgetCapNanoUsd / USD);
  return (
    <>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("rightHandApprovals.title", { name })}
          labelLines={2}
          sub={t(view.pausedAt ? "rightHandApprovals.paused" : "rightHandApprovals.subtitle")}
          subLines={3}
          toggle={on}
          disabled={set.isPending}
          onPress={() => save({ enabled: !on })}
        />
        {on ? (
          <>
            <GroupedRow
              label={t("rightHandApprovals.newAgents")}
              labelLines={2}
              sub={t(view.mayDecide.newAgents ? "rightHandApprovals.newAgentsHelp" : "rightHandApprovals.cantDecide")}
              subLines={2}
              toggle={view.newAgents && view.mayDecide.newAgents}
              disabled={!view.mayDecide.newAgents}
              onPress={() => save({ newAgents: !view.newAgents })}
            />
            <GroupedRow
              label={t("rightHandApprovals.agentChanges")}
              labelLines={2}
              sub={t(
                view.mayDecide.agentChanges ? "rightHandApprovals.agentChangesHelp" : "rightHandApprovals.cantDecide",
              )}
              subLines={2}
              toggle={view.agentChanges && view.mayDecide.agentChanges}
              disabled={!view.mayDecide.agentChanges}
              onPress={() => save({ agentChanges: !view.agentChanges })}
            />
          </>
        ) : null}
      </GroupedList>
      {on ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHandApprovals.budget") }),
              text: t("rightHandApprovals.budgetHelp"),
            }}
          >
            {t("rightHandApprovals.budget")}
          </GroupedHeader>
          <GroupedList>
            {[...new Set([...BUDGETS, budget])]
              .sort((a, b) => a - b)
              .map((usd) => (
                <GroupedRow
                  key={usd}
                  label={`US$ ${usd}${t("rightHandApprovals.perMonth")}`}
                  checked={usd === budget}
                  onPress={() => save({ budgetCapNanoUsd: usd * USD })}
                />
              ))}
          </GroupedList>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHandApprovals.guidanceLabel", { name }) }),
              text: t("rightHandApprovals.guidanceHelp", { name }),
            }}
          >
            {t("rightHandApprovals.guidanceLabel", { name })}
          </GroupedHeader>
          <TextArea
            value={guidance ?? view.guidance}
            onChangeText={setGuidance}
            onBlur={() => {
              if (guidance !== null && guidance.trim() !== view.guidance) save({ guidance: guidance.trim() });
              setGuidance(null);
            }}
            maxLength={2000}
            minHeight={64}
            placeholder={t("rightHandApprovals.guidancePlaceholder")}
            accessibilityLabel={t("rightHandApprovals.guidanceLabel", { name })}
          />
          <View style={styles.gap} />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  gap: { height: 16 },
});
