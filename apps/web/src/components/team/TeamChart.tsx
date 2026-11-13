import type { AgentGroup, Team, TeamAgent } from "@agenteschat/client";
import { useRoles } from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { can } from "@agenteschat/client/lib/permissions";
import {
  type ChartNode,
  chartByPerson,
  lineSize,
  mayReportTo,
  reportsTo,
  sectorLineChanges,
  sectorSupervisor,
} from "@agenteschat/client/lib/team-views";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { CountChip, RoleMark, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type DragEvent, Fragment, type HTMLAttributes, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { GroupNameDialog, useAgentDrag } from "@/components/AgentGroups";
import { useOrg } from "@/components/org-context";
import { OrgMark } from "@/components/ProfilePhoto";
import { colorOf } from "@/components/Sky";
import { useSetReportsTo } from "./ReportsTo";
import { NoSectors, SectorMark, sectorStyle, useTeamLookups } from "./shared";

/** Firefox starts a drag only with some data set; a line's drags carry these types. */
const LINE_AGENT = "application/x-agentes-line-agent";
const LINE_SECTOR = "application/x-agentes-line-sector";

/**
 * Equipe › Organograma (ADR 0148): the workspace on top with its right hand beside it (out of the line: it follows
 * everything with each person), then each person with the agents that report to them (a supervisor agent with its
 * reports under it, ADR 0148 addendum; else its owner, else its setor's lead), or each setor with its agents. Who
 * manages agents drags an agent onto another agent to make it report there, onto a person to clear it, or a setor's
 * frame onto an agent; and an agent to another setor.
 */
export function TeamChart({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const [by, setBy] = useState<"person" | "sector">("person");
  const look = useTeamLookups(groups);
  const lodi = look.lodi;
  return (
    <section className="team-chart" aria-label={t("team.view.chart")}>
      <div className="team-chart__bar">
        <Segmented
          size="sm"
          value={by}
          onValueChange={setBy}
          label={t("team.chart.byLabel")}
          options={[
            { value: "person", label: t("team.chart.byPerson") },
            { value: "sector", label: t("team.chart.bySector") },
          ]}
        />
        <span className="muted">
          {by === "person" ? t("team.chart.subPerson") : t("team.chart.subSector", { name: lodi?.name ?? "" })}
        </span>
      </div>
      {by === "person" ? <ByPerson team={team} groups={groups} /> : <BySector team={team} groups={groups} />}
    </section>
  );
}

type NodeDrag = Partial<
  Pick<HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd" | "onDragOver" | "onDragLeave" | "onDrop">
> & { "data-line-drop"?: true };

function AgentNode({
  agent,
  drag,
  line,
}: {
  agent: TeamAgent;
  drag?: ReturnType<ReturnType<typeof useAgentDrag>["row"]>;
  /** Organograma's line: dragged onto another agent, or another agent or setor dropped here. */
  line?: NodeDrag;
}) {
  const { org } = useOrg();
  return (
    <Link
      to="/org/$orgId/agents/$agentId"
      params={{ orgId: org.id, agentId: agent.id }}
      className="team-node team-node--agent"
      data-agent-row={agent.id}
      {...drag}
      {...line}
    >
      <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
      <span className="team-node__text">
        <b className={agent.role ? "ac-captop" : undefined}>{agent.name}</b>
        {agent.role && <span className="muted">{agent.role}</span>}
      </span>
      <span
        className="team-node__dot"
        data-busy={agent.busy || undefined}
        style={agent.busy ? { background: colorOf(agent) } : undefined}
        aria-hidden="true"
      />
    </Link>
  );
}

/**
 * Organograma's drags of a line (who manages agents): an agent onto another agent reports there, onto a person no
 * longer reports to an agent; a setor's frame onto an agent makes its agents report there. At once, with Desfazer.
 */
function useLineDrag(team: readonly TeamAgent[], groups: readonly AgentGroup[], lodiId: string | undefined) {
  const { t } = useTranslation();
  const setReportsTo = useSetReportsTo();
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ agentId: string } | { groupId: string } | null>(null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  const accepts = (target: string | null) => {
    if (!dragging) return false;
    if ("groupId" in dragging) return target !== null;
    if (target === null) return !!team.find((a) => a.id === dragging.agentId)?.reportsToAgentId;
    const agent = team.find((a) => a.id === dragging.agentId);
    return !!agent && agent.reportsToAgentId !== target && mayReportTo(team, dragging.agentId, target);
  };
  const drop = (target: string | null) => {
    const what = dragging;
    end();
    if (!what || !accepts(target)) return;
    if ("agentId" in what) return setReportsTo([{ agentId: what.agentId, reportsToAgentId: target }]);
    const group = groups.find((g) => g.id === what.groupId);
    if (!group || !target) return;
    const changes = sectorLineChanges(group, team, target);
    if (changes.length > 0)
      setReportsTo(
        changes,
        t("team.sectors.supervisorDone", {
          count: changes.length,
          sector: group.name,
          name: team.find((a) => a.id === target)?.name ?? "",
        }),
      );
  };
  /** Where a drag lands: an agent's id, or null for a person (clears it). */
  const target = (id: string | null, key = id ?? "person"): NodeDrag => ({
    ...(over === key ? { "data-line-drop": true as const } : {}),
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts(id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      if (over !== key) setOver(key);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      drop(id);
    },
  });
  const agent = (id: string): NodeDrag =>
    id === lodiId
      ? {}
      : {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            e.dataTransfer.setData(LINE_AGENT, id);
            e.dataTransfer.effectAllowed = "link";
            setDragging({ agentId: id });
          },
          onDragEnd: end,
          ...target(id),
        };
  const sector = (groupId: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.stopPropagation();
      e.dataTransfer.setData(LINE_SECTOR, groupId);
      e.dataTransfer.effectAllowed = "link";
      setDragging({ groupId });
    },
    onDragEnd: end,
  });
  return { agent, target, sector, dragging: dragging !== null };
}

/** A supervisor and its reports under it, joined by a line, with how many report to it; agents with none alone. */
function ChartLine({ node, line }: { node: ChartNode; line?: ReturnType<typeof useLineDrag> }) {
  const { t } = useTranslation();
  const size = lineSize(node);
  return (
    <div className="team-line">
      <AgentNode agent={node.agent} line={line?.agent(node.agent.id)} />
      {size > 0 && (
        <div className="team-line__reports">
          <CountChip size="sm" className="team-line__count">
            {t("team.agents", { count: size })}
          </CountChip>
          {node.reports.map((r) => (
            <ChartLine key={r.agent.id} node={r} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Lodi beside the workspace, out of the line: its face, its name and that it follows everything with you. */
function LodiChip({ lodi }: { lodi: NonNullable<ReturnType<typeof useTeamLookups>["lodi"]> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: lodi.id }} className="team-lodi-chip">
      <AgentAvatar agentId={lodi.id} name={lodi.name} size="xs" />
      <b>{lodi.name}</b>
      <span className="muted">{t("team.chart.lodi")}</span>
    </Link>
  );
}

function ByPerson({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const roles = useRoles(org.id).data?.roles ?? [];
  const columns = chartByPerson(team.agents, groups, look.members, look.isLodi);
  const lodi = look.lodi;
  const line = useLineDrag(team.agents, groups, lodi?.id);
  const arranges = can(org, "manage_agents");
  return (
    <div className="team-tree">
      <div className="team-tree__top">
        <span className="team-tree__org">
          {/* The workspace on top; a personal workspace names none (ADR 0159), its right hand alone there. */}
          {!isPersonal(org) && (
            <span className="team-node team-node--org">
              <OrgMark logo={org.logo} size={32} />
              <span className="team-node__text">
                <b className="ac-captop">{org.name}</b>
                <span className="muted">{t("team.chart.workspace")}</span>
              </span>
            </span>
          )}
          {lodi && <LodiChip lodi={lodi} />}
        </span>
      </div>
      <div className="team-tree__row">
        {columns.map((c) => {
          const m = c.personId ? look.dir.memberById.get(c.personId) : undefined;
          const role = roles.find((r) => m?.roleIds?.includes(r.id));
          return (
            <div key={c.personId ?? "none"} className="team-tree__col">
              <div
                className="team-node team-node--person"
                data-none={c.personId ? undefined : ""}
                {...(arranges ? line.target(null, `person:${c.personId ?? "none"}`) : {})}
              >
                {c.personId && m ? (
                  <>
                    <PersonAvatar id={c.personId} name={m.name} size="sm" presence />
                    <span className="team-node__text">
                      <b className="ac-captop">{m.name}</b>
                      <span className="muted team-sector">
                        {role ? (
                          <>
                            <RoleMark color={role.color} icon={role.icon} size={14} />
                            {role.name}
                          </>
                        ) : (
                          t(`roles.${m.role}`)
                        )}
                      </span>
                    </span>
                  </>
                ) : (
                  <span className="team-node__text">
                    <b>{t("team.noOwner")}</b>
                  </span>
                )}
              </div>
              <div className="team-tree__agents">
                {c.nodes.map((n) => (
                  <ChartLine key={n.agent.id} node={n} line={arranges ? line : undefined} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BySector({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const arranges = can(org, "manage_agents");
  const drag = useAgentDrag(groups);
  const line = useLineDrag(team.agents, groups, look.lodi?.id);
  const [creating, setCreating] = useState(false);
  const by = agentSections(
    team.agents.filter((a) => !look.isLodi(a)),
    groups,
    (a) => a.id,
  );
  const column = (key: string, group: AgentGroup | null, agents: TeamAgent[]) => {
    const leads = [...new Set(agents.map((a) => reportsTo(a, groups, look.members, team.agents)).filter(Boolean))];
    const supervised = group ? sectorSupervisor(group, team.agents) : null;
    const others = agents.filter((a) => a.id !== drag.dragging);
    const lineAt = drag.over?.groupId === (group?.id ?? null) && group ? drag.over.index : null;
    const dropLine = <span className="sidebar__drop-line" aria-hidden="true" />;
    return (
      <section
        key={key}
        className="team-frame"
        data-none={group ? undefined : ""}
        style={sectorStyle(group)}
        aria-label={group?.name ?? t("agentGroups.none")}
        {...(arranges ? drag.zone(group?.id ?? null) : {})}
      >
        <header
          className="team-frame__head"
          {...(arranges && group ? line.sector(group.id) : {})}
          title={arranges && group ? t("team.chart.dragSector") : undefined}
        >
          {group && <span className="team-eyebrow">{t("agentGroups.group")}</span>}
          <span className="team-frame__title">
            {group && <SectorMark group={group} size={18} />}
            <b>{group?.name ?? t("agentGroups.none")}</b>
          </span>
          <span className="muted small">{t("team.agents", { count: agents.length })}</span>
          {leads.length > 0 && (
            <span className="muted small">
              {t("team.chart.responsible", { names: leads.map((id) => look.personName(id)).join(", ") })}
            </span>
          )}
          {supervised && (
            <span className="muted small team-frame__sup">
              <AgentAvatar agentId={supervised.supervisor.id} name={supervised.supervisor.name} size="xs" />
              {t("team.chart.supervisor", { name: supervised.supervisor.name })}
            </span>
          )}
        </header>
        {agents.map((a) => (
          <Fragment key={a.id}>
            {lineAt === others.indexOf(a) && dropLine}
            <AgentNode
              agent={a}
              drag={arranges ? drag.row(a.id) : undefined}
              line={arranges && line.dragging ? line.target(a.id) : undefined}
            />
          </Fragment>
        ))}
        {lineAt !== null && lineAt >= others.length && dropLine}
        {arranges && group && agents.length === 0 && (
          <span className="sidebar__drop-hint">{t("agentGroups.dropHere")}</span>
        )}
      </section>
    );
  };
  return (
    <>
      {groups.length === 0 ? (
        <NoSectors lodi={look.lodi} onCreate={arranges ? () => setCreating(true) : undefined} />
      ) : (
        <div className="team-frames">
          {by.groups.map(({ group, items }) => column(group.id, group, items))}
          {by.ungrouped.length > 0 && column("none", null, by.ungrouped)}
        </div>
      )}
      {creating && <GroupNameDialog purpose={{ mode: "create" }} onClose={() => setCreating(false)} />}
    </>
  );
}
