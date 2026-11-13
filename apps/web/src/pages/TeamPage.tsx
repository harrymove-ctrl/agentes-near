import type { FormerAgent } from "@agenteschat/client";
import {
  useAgentGroups,
  useAiStatus,
  useChannels,
  useFormerAgents,
  useTeam,
  useUnarchiveAgent,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { Button, Card, EmptyState, Icon, PageHeader, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DeleteAgentDialog } from "@/components/DeleteAgentDialog";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { TeamChart } from "@/components/team/TeamChart";
import { TeamList } from "@/components/team/TeamList";
import { TeamMap } from "@/components/team/TeamMap";
import { TeamSectors } from "@/components/team/TeamSectors";
import { TeamUsage } from "@/components/team/TeamUsage";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import "./team.css";
import { CreateAgentButton } from "@/components/new-agent/NewAgentDialog";

const VIEWS = ["list", "chart", "map", "sectors", "usage"] as const;
type TeamView = (typeof VIEWS)[number];
const isView = (v: string | null): v is TeamView => VIEWS.includes(v as TeamView);

/**
 * Equipe (ADR 0148): one page, five views of the same people, agents and setores. Lista, Organograma (who reports to
 * whom), Mapa (one column per channel, as the team works), Setores and Governança e uso. The view is remembered in
 * this browser.
 */
export function TeamPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const team = useTeam(org.id);
  const sectors = useAgentGroups(org.id);
  const channels = useChannels(org.id);
  const groups = sectors.data ?? [];
  const dir = useDirectory(org.id);
  // Asked with the page, so every view says at once whether an agent can work.
  useAiStatus(org.id);
  const [view, setView] = useState<TeamView>(() => {
    const saved = storage.get(STORAGE_KEYS.teamView);
    return isView(saved) ? saved : "list";
  });
  const pick = (v: TeamView) => {
    setView(v);
    storage.set(STORAGE_KEYS.teamView, v);
  };
  const data = team.data;
  const agents = data?.agents.filter((a) => !isRightHand(dir.agentById.get(a.id))) ?? [];
  // Archived agents have no page: admins bring them back, or delete them for good (ADR 0082), here.
  const admin = can(org, "manage_agents");
  const former = useFormerAgents(org.id);
  const archived = (former.data ?? []).filter((a) => !a.deleted);
  const [deleting, setDeleting] = useState<FormerAgent | null>(null);
  const restore = useUnarchiveAgent(org.id);
  const toast = useToast();
  const restoreAgent = (a: FormerAgent) =>
    restore.mutate(a.id, {
      onSuccess: () => toast.show(t("team.restored", agentGrammar(a.name))),
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  // Setores and the map read these two: before they answer, "no setor yet" or "no channel yet" would be a lie.
  const lookups = [sectors, channels];
  const lookupFailed = lookups.find((q) => q.isError && !q.data);
  const shown = view !== "usage" && data && agents.length > 0 && lookups.every((q) => q.data) ? data : null;
  const noAgents = view !== "usage" && !!data && agents.length === 0;
  const look = useRightHandLook();
  // Its words match its button: one who may not make agents now (a workspace being deleted) reads a viewer's.
  const maker = makesAgents(org);
  // The empty state takes over the head's buttons: one way in, in the middle of the page.
  const makes = maker && (
    <>
      <Button asChild icon="archiveBox">
        <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "import" }}>
          {t("shell.importAgents")}
        </Link>
      </Button>
      <CreateAgentButton />
    </>
  );
  return (
    <div className="page team">
      <PageHeader
        title={t("team.title")}
        count={
          !!data &&
          [
            t("team.people", { count: dir.members.length }),
            t("team.agents", { count: agents.length }),
            t("team.sectorsCount", { count: groups.length }),
          ].join(" · ")
        }
        actions={!noAgents && makes}
      >
        <Segmented
          value={view}
          onValueChange={pick}
          label={t("team.viewLabel")}
          options={VIEWS.map((v) => ({ value: v, label: t(`team.view.${v}`) }))}
        />
      </PageHeader>
      {view !== "usage" &&
        (team.isLoading || (data && agents.length > 0 && !lookupFailed && lookups.some((q) => q.isPending))) && (
          <LoadingCards count={2} />
        )}
      {view !== "usage" && team.isError && !data && (
        <ErrorState error={team.error} onRetry={() => void team.refetch()} />
      )}
      {view !== "usage" && data && agents.length > 0 && lookupFailed && (
        <ErrorState error={lookupFailed.error} onRetry={() => void lookupFailed.refetch()} />
      )}
      {noAgents && (
        <EmptyState
          size="page"
          agent={look}
          title={t(maker ? "team.emptyTitle" : "team.emptyViewerTitle")}
          actions={makes}
        >
          {t(maker ? "team.empty" : "team.emptyViewer")}
        </EmptyState>
      )}
      {shown && view === "list" && <TeamList team={shown} groups={groups} />}
      {shown && view === "chart" && <TeamChart team={shown} groups={groups} />}
      {shown && view === "map" && <TeamMap team={shown} />}
      {shown && view === "sectors" && <TeamSectors team={shown} groups={groups} />}
      {view === "usage" && <TeamUsage />}
      {view === "list" && admin && archived.length > 0 && (
        <Card className="team-archived">
          <div className="team-archived__head">
            <Icon name="archive" size={16} />
            <h2>{t("team.archived")}</h2>
          </div>
          {archived.map((a) => (
            <div key={a.id} className="team-archived__row ac-mediarow ac-mediarow--row">
              <span className="ac-mediarow__face">
                <AgentAvatar agentId={a.id} size="sm" name={a.name} />
              </span>
              <span className="ac-mediarow__head">
                <b>{a.name}</b>
                {a.role && <span className="ac-mediarow__meta">{a.role}</span>}
              </span>
              <span className="ac-mediarow__end ac-mediarow__end--wrap ac-acts">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="undo"
                  aria-label={t("team.restoreAction", agentGrammar(a.name))}
                  disabled={restore.isPending}
                  onClick={() => restoreAgent(a)}
                >
                  {t("team.restore")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={t("agentPage.delete.action", agentGrammar(a.name))}
                  onClick={() => setDeleting(a)}
                >
                  {t("agentPage.delete.button")}
                </Button>
              </span>
            </div>
          ))}
        </Card>
      )}
      <DeleteAgentDialog agent={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
