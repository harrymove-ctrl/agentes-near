import { type Proposal, useDecideProposals, useProposals } from "@agenteschat/client";
import { isOpen, proposalWhy, sortProposals, staleCount } from "@agenteschat/client/lib/proposals";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { Button, EmptyState, Text, useToast } from "@/ui";
import { ChangeRequestRow } from "../right-hand/SettingsCard";
import { useFailed } from "../routines/hooks";
import { confirmAction } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { InstructionProposalCard } from "./InstructionProposalCard";

/** The open proposals, each with why and its card, decided here. What was decided stays on the web's list. */
export function ProposalsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const proposals = useProposals(orgId);
  const pull = usePullRefresh(proposals.refetch);
  const open = sortProposals((proposals.data ?? []).filter(isOpen));
  return (
    <PushedLargeTitle
      title={t("shell.proposals")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {proposals.isError && !proposals.data ? <LoadFailed onRetry={() => void proposals.refetch()} /> : null}
      {proposals.isSuccess && open.length === 0 ? (
        <EmptyState size="inline" title={t("proposals.emptyTitle")} subtitle={t("proposals.empty")} />
      ) : null}
      <View style={styles.list}>
        <DecideAll open={open} />
        {open.map((p) => (
          <View key={p.id} style={styles.item}>
            <Text variant="subhead" tone="muted">
              {proposalWhy(t, p)}
            </Text>
            {p.target.type === "agent_settings" ? <ChangeRequestRow p={p} /> : <InstructionProposalCard ids={[p.id]} />}
          </View>
        ))}
      </View>
    </PushedLargeTitle>
  );
}

/**
 * The web's "Aceitar todas" / "Recusar todas": two small buttons over the list when two or more proposals wait on
 * this person, each asked once by the system, then decided oldest first, each on its own.
 */
function DecideAll({ open }: { open: Proposal[] }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const decide = useDecideProposals(orgId);
  const toast = useToast();
  const failed = useFailed();
  const mine = open.filter((p) => p.canDecide).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (mine.length < 2) return null;
  const count = mine.length;
  const ask = (decision: "accept" | "refuse") =>
    confirmAction({
      title: t(decision === "accept" ? "proposals.all.acceptAsk" : "proposals.all.refuseAsk", { count }),
      action: t(decision === "accept" ? "proposals.all.acceptGo" : "proposals.all.refuseGo", { count }),
      cancel: t("common.cancel"),
      destructive: decision === "refuse",
      onConfirm: () =>
        decide.mutate(
          { ids: mine.map((p) => p.id), decision },
          {
            onSuccess: ({ failed: lost }) => {
              const stale = staleCount(lost);
              if (stale > 0) toast({ title: t("proposals.staleSome", { count: stale }), icon: "x" });
              const other = lost.find((f) => staleCount([f]) === 0);
              if (other) failed(other.error);
            },
          },
        ),
    });
  return (
    <View style={styles.all}>
      <Button
        variant="secondary"
        size="sm"
        label={t("proposals.all.accept")}
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "accept"}
        onPress={() => ask("accept")}
      />
      <Button
        size="sm"
        variant="ghost"
        label={t("proposals.all.refuse")}
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onPress={() => ask("refuse")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 20, paddingHorizontal: 16 },
  item: { gap: 8 },
  all: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
