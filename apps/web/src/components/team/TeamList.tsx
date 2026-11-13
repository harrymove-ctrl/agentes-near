import type { AgentGroup, Team, TeamAgent } from "@agenteschat/client";
import { useApprovals, useRoles } from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { can } from "@agenteschat/client/lib/permissions";
import { filterTeam, sortTeam, type TeamFilter, type TeamSort } from "@agenteschat/client/lib/team-views";
import {
  Button,
  Card,
  EmptyState,
  FilterToggle,
  Icon,
  PersonPortrait,
  recipeOfUrl,
  RoleMark,
  SearchField,
  Segmented,
  Select,
  TabPanel,
  Tabs,
  Toolbar,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { AgentGroupMenu, type GroupDialogFor, GroupNameDialog } from "@/components/AgentGroups";
import { useOrg } from "@/components/org-context";
import { ReportsToMenu } from "./ReportsTo";
import { AgentNow, ChannelName, SectorMark, useTeamLookups } from "./shared";
import "@/components/people-usage.css";

const FILTERS: Exclude<TeamFilter, "all">[] = ["mine", "working", "waiting", "noOwner"];
type GroupBy = "sector" | "owner" | "none";
/** Channels shown in a row before "+N". */
const ROW_CHANNELS = 1;

/** Equipe › Lista (ADR 0148): the CommandOSS people roster and autonomous agent staff. */
export function TeamList({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const look = useTeamLookups(groups);
  const agents = team.agents.filter((a) => !look.isLodi(a));
  const [tab, setTab] = useState<"people" | "agents">("people");
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      label={t("team.view.list")}
      items={[
        { value: "people", label: t("team.list.people"), count: look.dir.members.length },
        { value: "agents", label: t("team.list.agents"), count: agents.length },
      ]}
    >
      <TabPanel value="people">
        <PeopleTable agents={agents} groups={groups} />
      </TabPanel>
      <TabPanel value="agents">
        <AgentsTable agents={agents} groups={groups} />
      </TabPanel>
    </Tabs>
  );
}

function AgentsTable({ agents, groups }: { agents: TeamAgent[]; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const look = useTeamLookups(groups);
  const manages = can(org, "manage_agents");
  const approvals = useApprovals(org.id).data ?? [];
  const waiting = new Set(approvals.filter((a) => a.status === "pending" && a.canDecide).map((a) => a.agentId));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<TeamFilter>("all");
  // Until the person picks, by setor once there are any (the setores may arrive after the team).
  const [picked, setGroupBy] = useState<GroupBy | null>(null);
  const groupBy = picked ?? (groups.length > 0 ? "sector" : "owner");
  const [sort, setSort] = useState<{ by: TeamSort; desc: boolean }>({ by: "name", desc: false });
  const [dialog, setDialog] = useState<GroupDialogFor | null>(null);
  const rows = sortTeam(
    filterTeam(agents, {
      filter,
      q,
      meId: me.user.id,
      waitingIds: waiting,
      channelName: (id) => look.channelById.get(id)?.name,
    }),
    sort.by,
    sort.desc,
    { sector: (id) => look.sectorOf(id)?.name ?? "", owner: (id) => look.personName(id) },
  );
  const counts = {
    mine: agents.filter((a) => a.ownerUserId === me.user.id).length,
    working: agents.filter((a) => a.busy).length,
    waiting: agents.filter((a) => waiting.has(a.id)).length,
    noOwner: agents.filter((a) => !a.ownerUserId).length,
  };
  const head = (by: TeamSort, label: string) => (
    <th aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        className="pu-sort"
        onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : false }))}
      >
        {label}
        {sort.by === by && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={14} />}
      </button>
    </th>
  );
  const showSector = groupBy !== "sector" && groups.length > 0;
  const columns = 6 + (showSector ? 1 : 0) + (manages ? 1 : 0);
  // The count joins the title's own words, so a title led by a face or a mark shares their baseline.
  const section = (key: string, title: (count: ReactNode) => ReactNode, list: TeamAgent[]) =>
    list.length === 0 ? null : (
      <Fragment key={key}>
        <tr className="team-table__section">
          <th colSpan={columns} scope="colgroup">
            {title(<span className="muted"> · {list.length}</span>)}
          </th>
        </tr>
        {list.map(row)}
      </Fragment>
    );
  const row = (a: TeamAgent) => {
    const sector = look.sectorOf(a.id);
    const channels = (a.channelIds ?? []).flatMap((id) => look.channelById.get(id) ?? []);
    const directory = look.dir.agentById.get(a.id);
    return (
      <tr key={a.id} className="team-table__row">
        <td>
          <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: a.id }} className="team-who">
            <AgentAvatar agentId={a.id} name={a.name} size="sm" />
            <span className="team-who__text">
              <b>{a.name}</b>
              <span className="muted">@{a.handle}</span>
            </span>
          </Link>
        </td>
        <td className="team-table__role">{a.role || <span className="muted">—</span>}</td>
        {showSector && (
          <td>
            {sector ? (
              <span className="team-sector">
                <SectorMark group={sector} size={14} />
                {sector.name}
              </span>
            ) : (
              <span className="muted">{t("agentGroups.none")}</span>
            )}
          </td>
        )}
        <td>
          {a.ownerUserId ? (
            <span className="team-who">
              <PersonAvatar id={a.ownerUserId} name={look.personName(a.ownerUserId)} size="xs" />
              {look.personName(a.ownerUserId)}
            </span>
          ) : (
            <span className="muted">{t("team.noOwner")}</span>
          )}
        </td>
        <td>
          {channels.length === 0 ? (
            <span className="muted">{t("team.list.noChannel")}</span>
          ) : (
            <span className="team-chips">
              {channels.slice(0, ROW_CHANNELS).map((c) => (
                <Link
                  key={c.id}
                  to="/org/$orgId/c/$channelId"
                  params={{ orgId: org.id, channelId: c.id }}
                  className="team-chip"
                >
                  <ChannelName name={c.name} private={c.visibility === "private"} />
                </Link>
              ))}
              {channels.length > ROW_CHANNELS && (
                <span
                  className="team-chip team-chip--more"
                  title={channels
                    .slice(ROW_CHANNELS)
                    .map((c) => `#${c.name}`)
                    .join(", ")}
                >
                  +{channels.length - ROW_CHANNELS}
                </span>
              )}
            </span>
          )}
        </td>
        <td>
          {waiting.has(a.id) ? (
            <span className="team-now" data-waiting="">
              <Icon name="clock" size={14} />
              {t("team.list.filter.waiting")}
            </span>
          ) : (
            <AgentNow agent={a} />
          )}
        </td>
        {manages && (
          <td className="team-table__menu">
            {directory && (
              <AgentGroupMenu
                agent={directory}
                groups={groups}
                onNewGroup={() => setDialog({ mode: "create", agentIds: [a.id] })}
              >
                <ReportsToMenu agent={a} team={agents} lodiId={look.lodi?.id} />
              </AgentGroupMenu>
            )}
          </td>
        )}
      </tr>
    );
  };
  const body = () => {
    if (groupBy === "sector") {
      const by = agentSections(rows, groups, (a) => a.id);
      return [
        ...by.groups.map(({ group, items }) =>
          section(
            group.id,
            (count) => (
              <span className="team-sector">
                <span className="team-eyebrow">{t("agentGroups.group")}</span>
                <SectorMark group={group} size={14} />
                <span>
                  <b>{group.name}</b>
                  {count}
                </span>
              </span>
            ),
            items,
          ),
        ),
        section(
          "none",
          (count) => (
            <>
              <b>{t("agentGroups.none")}</b>
              {count}
            </>
          ),
          by.ungrouped,
        ),
      ];
    }
    if (groupBy === "owner") {
      const owners = [...new Set(rows.map((a) => a.ownerUserId))];
      return owners.map((id) =>
        section(
          id ?? "none",
          (count) =>
            id ? (
              <span className="team-who">
                <PersonAvatar id={id} name={look.personName(id)} size="xs" />
                <span>
                  <b>{look.personName(id)}</b>
                  {count}
                </span>
              </span>
            ) : (
              <>
                <b>{t("team.noOwner")}</b>
                {count}
              </>
            ),
          rows.filter((a) => a.ownerUserId === id),
        ),
      );
    }
    return rows.map(row);
  };
  return (
    <>
      <Toolbar
        label={t("team.list.filterLabel")}
        search={
          <SearchField
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel={t("filters.clearSearch")}
            placeholder={t("team.list.search")}
            aria-label={t("team.list.search")}
          />
        }
        actions={
          <Select
            size="sm"
            aria-label={t("team.list.groupBy")}
            value={groupBy}
            onValueChange={setGroupBy}
            options={(["sector", "owner", "none"] as const)
              .filter((g) => g !== "sector" || groups.length > 0)
              .map((g) => ({ value: g, label: t(`team.list.by.${g}`) }))}
          />
        }
      >
        {FILTERS.map((f) => (
          <FilterToggle
            key={f}
            pressed={filter === f}
            onPressedChange={(on) => setFilter(on ? f : "all")}
            count={counts[f]}
          >
            {t(`team.list.filter.${f}`)}
          </FilterToggle>
        ))}
      </Toolbar>
      <Card className="pu-table-card team-table-card">
        <table className="pu-table team-table">
          <thead>
            <tr>
              {head("name", t("team.list.col.agent"))}
              {head("role", t("team.list.col.role"))}
              {showSector && head("sector", t("agentGroups.group"))}
              {head("owner", t("team.list.col.owner"))}
              <th>{t("team.list.col.channels")}</th>
              <th>{t("team.list.col.now")}</th>
              {manages && (
                <th>
                  <span className="ac-visually-hidden">{t("team.list.col.menu")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>{body()}</tbody>
        </table>
        {rows.length === 0 && (
          <EmptyState
            size="inline"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                {t("filters.clearAll")}
              </Button>
            }
          >
            {t("team.list.none")}
          </EmptyState>
        )}
      </Card>
      {dialog && <GroupNameDialog purpose={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

const COMMANDOSS_HANDLE_ORDER = [
  "daniel",
  "tyr",
  "harry",
  "nikola",
  "uy",
  "ben",
  "hulk",
  "rowan",
  "ikaris",
  "toan",
  "henry",
  "partner-guest",
] as const;

type PeopleViewMode = "both" | "cards" | "table";

function rosterRank(handle: string | null | undefined): number {
  const idx = COMMANDOSS_HANDLE_ORDER.indexOf((handle ?? "").toLowerCase() as (typeof COMMANDOSS_HANDLE_ORDER)[number]);
  return idx >= 0 ? idx : 999;
}

function PeopleTable({ agents, groups }: { agents: TeamAgent[]; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const roles = useRoles(org.id).data?.roles ?? [];
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PeopleViewMode>("both");

  const sortedPeople = [...look.dir.members].sort((a, b) => {
    const rankDiff = rosterRank(a.handle) - rosterRank(b.handle);
    return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
  });

  const qNorm = query.trim().toLowerCase();
  const people = sortedPeople.filter((m) => {
    if (!qNorm) return true;
    const heldNames = roles
      .filter((r) => m.roleIds?.includes(r.id))
      .map((r) => r.name.toLowerCase())
      .join(" ");
    return (
      m.name.toLowerCase().includes(qNorm) ||
      (m.handle ?? "").toLowerCase().includes(qNorm) ||
      heldNames.includes(qNorm)
    );
  });

  const primaryTitleOf = (m: (typeof people)[number]) => {
    const held = roles
      .filter((r) => r.kind !== "everyone" && m.roleIds?.includes(r.id))
      .sort((a, b) => a.position - b.position);
    return held[0]?.name ?? t(`roles.${m.role}`);
  };

  const isGuestMember = (m: (typeof people)[number]) => primaryTitleOf(m) === "External Guest";
  const commandOssPeople = people.filter((m) => !isGuestMember(m));
  const guestPeople = people.filter((m) => isGuestMember(m));

  return (
    <div className="team-people-stack">
      <Toolbar
        label={t("team.list.people")}
        search={
          <SearchField
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            clearLabel={t("filters.clearSearch")}
            placeholder="Search CommandOSS name, @handle, or title..."
            aria-label="Search CommandOSS roster"
          />
        }
        actions={
          <Segmented
            value={mode}
            onValueChange={setMode}
            label="People view"
            options={[
              { value: "both", label: "Cards + Table" },
              { value: "cards", label: "Cards" },
              { value: "table", label: "Table" },
            ]}
          />
        }
      />

      {mode !== "table" && (
        <section className="team-cmdoss-showcase" data-testid="commandoss-roster-showcase" aria-label="CommandOSS Team Roster">
          <header className="team-cmdoss-showcase__head">
            <div className="team-cmdoss-showcase__prompt">
              <span className="team-cmdoss-showcase__ps1">cmdoss@ergo:~$</span>
              <code className="team-cmdoss-showcase__cmd">./team</code>
              <span className="team-cmdoss-showcase__cursor" aria-hidden="true" />
            </div>
            <div className="team-cmdoss-showcase__sub">
              <span>CommandOSS · Customer Zero (M1)</span>
              <span>·</span>
              <span>{commandOssPeople.length} core staff</span>
              {guestPeople.length > 0 && (
                <>
                  <span>·</span>
                  <span>{guestPeople.length} scoped guest (F2.8)</span>
                </>
              )}
            </div>
          </header>

          {commandOssPeople.length > 0 && (
            <div className="team-cmdoss-grid" data-testid="commandoss-card-grid">
              {commandOssPeople.map((m) => {
                const title = primaryTitleOf(m);
                const portrait = m.image ? recipeOfUrl(m.image) : null;
                const mine = agents.filter((a) => a.ownerUserId === m.userId);
                return (
                  <article key={m.userId} className="team-cmdoss-card" data-handle={m.handle ?? undefined}>
                    <div className="team-cmdoss-card__frame">
                      {portrait ? (
                        <PersonPortrait recipe={portrait} crop="full" className="team-cmdoss-card__canvas" />
                      ) : (
                        <PersonAvatar id={m.userId} name={m.name} size="xl" />
                      )}
                      {m.role === "owner" && <span className="team-cmdoss-card__owner">OWNER</span>}
                    </div>
                    <div className="team-cmdoss-card__caption">
                      <div className="team-cmdoss-card__name">{m.name}</div>
                      <div className="team-cmdoss-card__title">{title}</div>
                      <div className="team-cmdoss-card__meta">
                        {m.handle && <span className="team-cmdoss-card__handle">@{m.handle}</span>}
                        {mine.map((a) => (
                          <Link
                            key={a.id}
                            to="/org/$orgId/agents/$agentId"
                            params={{ orgId: org.id, agentId: a.id }}
                            className="team-cmdoss-card__agent"
                          >
                            <AgentAvatar agentId={a.id} name={a.name} size="xs" />
                            <span>@{a.handle}</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {guestPeople.length > 0 && (
            <footer className="team-cmdoss-guests" data-testid="commandoss-guest-strip">
              <span className="team-cmdoss-guests__label">SCOPED PARTNER ACCESS (ZEN-F2.8)</span>
              <div className="team-cmdoss-guests__list">
                {guestPeople.map((g) => (
                  <span key={g.userId} className="team-cmdoss-guests__chip">
                    <PersonAvatar id={g.userId} name={g.name} size="xs" />
                    <b>{g.name}</b>
                    <span>· {primaryTitleOf(g)}</span>
                    {g.handle && <span className="team-cmdoss-card__handle">@{g.handle}</span>}
                  </span>
                ))}
              </div>
            </footer>
          )}
        </section>
      )}

      {mode !== "cards" && (
        <Card className="pu-table-card team-table-card">
          <table className="pu-table team-table">
            <thead>
              <tr>
                <th>{t("team.list.col.person")}</th>
                <th>{t("team.list.col.roles")}</th>
                <th>{t("team.list.col.caresFor")}</th>
                <th>{t("team.view.sectors")}</th>
              </tr>
            </thead>
            <tbody>
              {people.map((m) => {
                const mine = agents.filter((a) => a.ownerUserId === m.userId);
                const held = roles.filter((r) => m.roleIds?.includes(r.id));
                const leads = groups.filter((g) => g.leadUserId === m.userId || g.backupUserId === m.userId);
                const title = primaryTitleOf(m);
                return (
                  <tr key={m.userId} className="team-table__row">
                    <td>
                      <span className="team-who">
                        <PersonAvatar id={m.userId} name={m.name} size="sm" presence />
                        <span className="team-who__text">
                          <b>{m.name}</b>
                          <span className="muted">
                            {title}
                            {m.role === "owner" ? ` · ${t("roles.owner")}` : ""}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {held.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <span className="team-chips">
                          {held.map((r) => (
                            <span key={r.id} className="team-sector">
                              <RoleMark color={r.color} icon={r.icon} size={14} />
                              {r.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      {mine.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <span className="team-chips">
                          {mine.map((a) => (
                            <Link
                              key={a.id}
                              to="/org/$orgId/agents/$agentId"
                              params={{ orgId: org.id, agentId: a.id }}
                              className="team-who"
                            >
                              <AgentAvatar agentId={a.id} name={a.name} size="xs" />
                              {a.name}
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                    <td>
                      {leads.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <span className="team-chips">
                          {leads.map((g) => (
                            <span key={g.id} className="team-sector">
                              <SectorMark group={g} size={14} />
                              {t(g.leadUserId === m.userId ? "team.sectors.leads" : "team.sectors.covers", {
                                name: g.name,
                              })}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
