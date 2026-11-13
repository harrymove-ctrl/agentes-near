import { type AgentLineChange, useSetAgentLines, useTeam } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { mayReportTo, reportsOf, supervisorOf } from "@agenteschat/client/lib/team-views";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useDirectory, useOrgId } from "../shared/hooks";

/**
 * Responde a (ADR 0148 addendum), as the web's field: who manages agents picks the agent it reports to, applied at
 * once, with Desfazer right under it; anyone else reads it. A supervisor lists who reports to it. No drag on the phone.
 */
export function ReportsToSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const team = useTeam(orgId).data?.agents ?? [];
  const set = useSetAgentLines(orgId);
  const [open, setOpen] = useState(false);
  const [previous, setPrevious] = useState<AgentLineChange[] | null>(null);
  const lodiId = rightHandOf(dir.agents)?.id;
  const agent = team.find((a) => a.id === agentId);
  if (!agent || agent.id === lodiId) return null;
  const manages = can(org, "manage_agents");
  const current = supervisorOf(agent, team);
  const reports = reportsOf(agentId, team);
  if (!manages && !current && reports.length === 0) return null;
  const choices = team.filter((a) => a.id !== lodiId && a.id !== agentId && mayReportTo(team, agentId, a.id));
  const apply = (changes: AgentLineChange[], undoing = false) =>
    set.mutate(changes, {
      onError: failed,
      onSuccess: ({ previous: before }) => {
        setOpen(false);
        setPrevious(undoing || before.length === 0 ? null : before);
        const to = changes[0]?.reportsToAgentId;
        toast({
          title: to
            ? t("team.reportsTo.done", { agent: agent.name, to: team.find((a) => a.id === to)?.name ?? "" })
            : t("team.reportsTo.cleared", { agent: agent.name }),
          agentId,
        });
      },
    });
  const pick = (to: string | null) => {
    if (to === (agent.reportsToAgentId ?? null)) return setOpen(false);
    apply([{ agentId, reportsToAgentId: to }]);
  };
  return (
    <>
      <GroupedHeader>{t("team.reportsTo.label")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("team.reportsTo.label")}
          hint={{ name: t("common.about", { label: t("team.reportsTo.label") }), text: t("team.reportsTo.help") }}
          value={current?.name ?? t("team.reportsTo.none")}
          {...(manages ? { chevron: true, onPress: () => setOpen((o) => !o) } : {})}
        />
        {open
          ? [null, ...choices].map((a) => (
              <GroupedRow
                key={a?.id ?? "nobody"}
                label={a?.name ?? t("team.reportsTo.none")}
                leading={a ? <AgentFace agentId={a.id} size={24} live={false} /> : undefined}
                checked={(agent.reportsToAgentId ?? null) === (a?.id ?? null)}
                disabled={set.isPending}
                onPress={() => pick(a?.id ?? null)}
              />
            ))
          : null}
        {previous ? (
          <GroupedRow
            icon="undo"
            label={t("agentGroups.undo")}
            disabled={set.isPending}
            onPress={() => apply(previous, true)}
          />
        ) : null}
      </GroupedList>
      {reports.length > 0 ? (
        <GroupedFooter>
          {`${t("team.reportsTo.reports", { name: agent.name })}: ${reports.map((r) => r.name).join(", ")}.`}
        </GroupedFooter>
      ) : null}
    </>
  );
}
