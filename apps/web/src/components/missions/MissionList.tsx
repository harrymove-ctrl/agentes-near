import type { Mission } from "@agenteschat/client";
import { useChannels, useMissionList } from "@agenteschat/client";
import { formatShortDate, relativeTime } from "@agenteschat/client/lib/format";
import { isOpenMission, missionCells, missionCellTitles, waitingText } from "@agenteschat/client/lib/missions";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, EmptyState, GroupHeading, Icon, Menu } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpinner } from "@/components/AgentAvatar";
import { MenuEntries } from "@/components/DesktopMenus";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import type { MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { ExecutorChip, MachineChip, MissionHead, MissionStatusChip, MissionStrip } from "./MissionBits";
import { CloseMissionDialog } from "./MissionDialogs";

/**
 * The Missões tab: one card per mission with its agent, the
 * home thread, the plan as the pixel strip ("4 de 12 itens"), what waits for
 * you, what runs on the computer (online or offline), when it started, and
 * Abrir thread. Active first, then the ones that ended.
 */
export function MissionsTab({
  filters,
  onNew,
  onClear,
}: {
  filters: { q: string; agentId?: string; channelId?: string };
  onNew: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const q = filters.q.trim();
  // The server filters (conversation, agent, words) and counts with the same filters.
  const where = {
    ...(q ? { q } : {}),
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
  };
  const open = useMissionList(org.id, { status: "open", ...where });
  const closed = useMissionList(org.id, { status: "closed", ...where });
  const active: Mission[] = open.data?.missions ?? [];
  const ended: Mission[] = closed.data?.missions ?? [];
  const counts = open.data?.counts ?? closed.data?.counts;
  if (open.isPending || (active.length === 0 && closed.isPending)) return <LoadingList count={3} />;
  if (open.isError && !open.data) return <ErrorState error={open.error} onRetry={() => void open.refetch()} />;
  if (active.length === 0 && ended.length === 0) {
    if (q || filters.agentId || filters.channelId)
      return (
        <EmptyState
          size="panel"
          title={t("threads.empty.noResults")}
          actions={<Button onClick={onClear}>{t("threads.empty.clear")}</Button>}
        >
          {t("threads.empty.noResultsText")}
        </EmptyState>
      );
    const opens = can(org, "post") && can(org, "assign_work");
    return (
      <EmptyState
        size="page"
        agent={look}
        title={t("missions.empty.title")}
        actions={
          opens && (
            <Button variant="primary" icon="plus" onClick={onNew}>
              {t("missions.new.open")}
            </Button>
          )
        }
      >
        {t(opens ? "threads.empty.missions" : "missions.empty.viewer")}
      </EmptyState>
    );
  }
  return (
    <div className="ac-groups">
      {active.length > 0 && (
        <section>
          <GroupHeading
            title={t("missions.list.active")}
            count={counts?.active ?? active.length}
            note={
              (counts?.waitingYou ?? 0) > 0 && t("missions.list.waitingYouCount", { count: counts?.waitingYou ?? 0 })
            }
          />
          <div className="mi-mcs">
            {active.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}
      {ended.length > 0 && (
        <section>
          <GroupHeading title={t("missions.list.ended")} count={counts?.closed ?? ended.length} />
          <div className="mi-mcs">
            {ended.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MissionCard({ mission: m }: { mission: Mission }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const [closing, setClosing] = useState(false);
  const agent = dir.agentById.get(m.agentId);
  const channel = channels.data?.find((c) => c.id === m.channelId);
  const where = channel
    ? `#${channel.name}`
    : t("missions.list.dmWith", { name: agent?.name ?? t("channel.unknownAgent") });
  const offline = Boolean(m.machine && !m.machine.online);
  const waiting = waitingText(t, m);
  const open = isOpenMission(m);
  const threadLink = { to: "/org/$orgId/threads/$threadId" as const, params: { orgId: org.id, threadId: m.threadId } };
  const more = t("missions.list.more", { title: m.title });
  // Its "…" and its right click.
  const entries: MenuEntry[] = [
    {
      kind: "item",
      id: "thread",
      label: t("missions.list.openThread"),
      icon: "thread",
      run: () => void navigate(threadLink),
    },
    ...(open && m.canManage
      ? ([
          { kind: "item", id: "close", label: t("missions.actions.close"), icon: "check", run: () => setClosing(true) },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    <article
      className="mi-mc"
      aria-label={t("missions.list.card", { title: m.title })}
      {...entityMenu(() => [{ kind: "header", label: m.title }, ...entries])}
    >
      <MissionHead
        agentId={m.agentId}
        agentName={agent?.name ?? ""}
        running={m.runningTasks > 0 && !offline}
        title={<Link {...threadLink}>{m.title}</Link>}
        meta={[
          agent?.name ?? t("channel.unknownAgent"),
          <Link key="where" {...threadLink} className="mi-quiet">
            <Icon name="thread" size={14} />
            {where}
          </Link>,
          t("missions.list.started", { date: formatShortDate(i18n.language, m.startedAt ?? m.createdAt) }),
        ]}
        right={
          <>
            <MissionStatusChip mission={m} />
            <Menu
              align="end"
              label={more}
              trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={more} />}
            >
              <MenuEntries entries={entries} />
            </Menu>
          </>
        }
      />
      <div className="mi-mc__strip">
        <b>
          {m.plan.total > 0
            ? t("missions.items", { done: m.plan.done, count: m.plan.total })
            : t("missions.list.noItems")}
        </b>
        <MissionStrip
          cells={missionCells(m, { offline })}
          titles={missionCellTitles(m)}
          agentId={m.agentId}
          label={t("missions.itemsLabel", { done: m.plan.done, count: m.plan.total })}
        />
      </div>
      {open && (
        <div className="mi-pills mi-mc__pills">
          {waiting && (
            <button type="button" className="mi-pill mi-pill--need" onClick={() => void navigate(threadLink)}>
              <Icon name="waiting" size={14} />
              {t("missions.list.waiting", { what: waiting })}
            </button>
          )}
          {m.runningTasks > 0 && (
            <span className="mi-pill">
              <AgentSpinner agentId={m.agentId} />
              {t("missions.list.running", { count: m.runningTasks })}
            </span>
          )}
          {m.machine ? <ExecutorChip mission={m} agentName={agent?.name ?? ""} /> : <MachineChip machine={m.machine} />}
          {m.status === "paused" && m.pausedAt && (
            <span className="mi-pill">
              <Icon name="clock" size={14} />
              {t("missions.list.pausedSince", { when: relativeTime(t, i18n.language, m.pausedAt) })}
            </span>
          )}
        </div>
      )}
      <div className="mi-mc__foot">
        <Button size="sm" icon="thread" onClick={() => void navigate(threadLink)}>
          {t("missions.list.openThread")}
        </Button>
      </div>
      {closing && <CloseMissionDialog mission={m} open={closing} onOpenChange={setClosing} />}
    </article>
  );
}
