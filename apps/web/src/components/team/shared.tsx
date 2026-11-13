import type { AgentGroup, TeamAgent } from "@agenteschat/client";
import { useAiStatus, useChannels } from "@agenteschat/client";
import { groupOf } from "@agenteschat/client/lib/agent-groups";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { noSectorsCopy } from "@agenteschat/client/lib/team-views";
import { Button, EmptyState, Icon, PixelSpinner, RoleMark, spriteTone } from "@agenteschat/ui";
import { type CSSProperties, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NoAiChip } from "@/components/NoAi";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

/** What every Equipe view looks up: people's names, an agent's setor, the channels I see, the right hand. */
export function useTeamLookups(groups: readonly AgentGroup[]) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id).data;
  return useMemo(() => {
    const channelById = new Map((channels ?? []).map((c) => [c.id, c]));
    const lodi = rightHandOf(dir.agents);
    return {
      dir,
      members: new Set(dir.members.map((m) => m.userId)),
      personName: (id: string | null | undefined) => (id ? (dir.memberById.get(id)?.name ?? "") : ""),
      sectorOf: (agentId: string) => groupOf(groups, agentId),
      channelById,
      channelOrder: (channels ?? []).map((c) => c.id),
      lodi,
      isLodi: (a: Pick<TeamAgent, "id">) => a.id === lodi?.id,
    };
  }, [dir, channels, groups]);
}

/** A setor's mark: its color and icon. */
export function SectorMark({ group, size = 16 }: { group: AgentGroup; size?: number }) {
  return <RoleMark color={group.color ?? "graphite"} icon={group.icon ?? "person"} size={size} />;
}

/** No setor yet, on both views of them: the right hand waving over what they give, and the first one's button. */
export function NoSectors({
  lodi,
  onCreate,
}: {
  lodi: ReturnType<typeof useTeamLookups>["lodi"];
  onCreate?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const copy = noSectorsCopy(Boolean(onCreate));
  return (
    <EmptyState
      size="page"
      agent={lookOf(lodi) ?? true}
      title={t(copy.title)}
      actions={
        onCreate && (
          <Button variant="primary" icon="plus" onClick={onCreate}>
            {t("agentGroups.create")}
          </Button>
        )
      }
    >
      {t(copy.text)}
    </EmptyState>
  );
}

/** `--sector`: a setor's color, for its frame and card. */
export const sectorStyle = (group: AgentGroup | null | undefined) =>
  group
    ? ({ "--sector": spriteTone((group.color ?? "graphite") as Parameters<typeof spriteTone>[0]) } as CSSProperties)
    : undefined;

/** What an agent is up to: working, no AI yet, or available (nothing while it waits for its computer or plan). */
export function AgentNow({ agent }: { agent: TeamAgent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const ai = aiStateOf(useAiStatus(org.id).data, agent.id);
  if (agent.busy)
    return (
      <span className="team-now" data-busy="">
        <PixelSpinner size={14} color={colorOf(agent)} />
        {t("team.workingNow")}
      </span>
    );
  if (ai === "no_ai") return <NoAiChip agentId={agent.id} />;
  if (ai !== "ready") return null;
  return (
    <span className="team-now">
      <span className="team-now__dot" aria-hidden="true" />
      {t("team.available")}
    </span>
  );
}

/** "# vendas" (a lock for a private one). */
export function ChannelName({ name, private: closed }: { name: string; private?: boolean }) {
  return (
    <span className="team-channel">
      <Icon name={closed ? "lock" : "channel"} size={14} />
      {name}
    </span>
  );
}
