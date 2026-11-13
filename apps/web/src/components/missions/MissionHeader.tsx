import type { Mission, MissionControl, ThreadInfo } from "@agenteschat/client";
import {
  cacheMission,
  useMachines,
  useMissionAct,
  useMissionControl,
  useMissionParticipants,
  useMissionPlan,
  useRequestJoin,
  useThreadTasks,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  formatSpan,
  isOpenMission,
  missionCells,
  missionCellTitles,
  missionTasks,
  planCells,
  planCellTitles,
} from "@agenteschat/client/lib/missions";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { AvatarStack, Button, Icon, Menu, MenuItem, MenuSeparator } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar, AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { useThreadWhere } from "@/components/threads/ThreadView";
import { useComputerEdition } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import {
  ExecutorChip,
  MachineChip,
  MissionStatusChip,
  MissionStrip,
  useElapsedNow,
  useMissionPanel,
} from "./MissionBits";
import { CloseMissionDialog, ShareMissionDialog } from "./MissionDialogs";
import { SessionsDialog } from "./MissionSessions";
import { MissionSettingsDialog } from "./MissionSettings";

/**
 * A mission's thread: the thread header IS the mission header (ADR 0029 §13).
 * Row 1: back, the agent, the title once, the state, who programs and where,
 * "Missão · DM com Theo" / "Missão · #canal", then who takes part, Arquivos
 * and ⋯ (actions only: Pausar / Retomar, Parar agora, Compartilhar, Fechar
 * missão; then "Configurações da missão…" with the autonomy on the right). Row 2: the plan strip ("4 de 12 itens"), what runs (the
 * pixel orbit; nothing when nothing runs), what waits for you, how long, and
 * "N sessões ›" (the sessions dialog). Reading back through the conversation
 * folds it into one compact row (title, state, strip). It is the column's
 * header, above the messages: it never covers them.
 */
export function MissionThreadHeader({ thread, mission: m }: { thread: ThreadInfo; mission: Mission }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const panel = useMissionPanel();
  const where = useThreadWhere(thread);
  const plan = useMissionPlan(org.id, m.id);
  const tasks = useThreadTasks(org.id, m.threadId);
  const people = useMissionParticipants(org.id, m.id);
  const control = useMissionControl(org.id);
  const api = useApi();
  const approveAll = useMissionAct(org.id, m.id, () => api.missions.approveProvisional(org.id, m.id));
  const [dialog, setDialog] = useState<"share" | "close" | "sessions" | "settings" | null>(null);
  const compact = useCompactOnScroll();
  const open = isOpenMission(m);
  const offline = Boolean(m.machine && !m.machine.online);
  const since = m.startedAt ?? m.createdAt;
  const now = useElapsedNow(since, open);
  const items = plan.data?.current?.items;
  const cells = items ? planCells(items, { offline }) : missionCells(m, { offline });
  const titles = items ? planCellTitles(items) : missionCellTitles(m);
  const sessions = missionTasks(tasks.data ?? [], m.id);
  const interrupted = sessions.filter((x) => x.status === "interrupted" && !x.endedAt).length;
  const waiting =
    m.pending.decisions + m.pending.reviews + m.pending.provisional + m.pending.commands + (m.pending.deliveries ?? 0);
  // Running: the live session rows when loaded (`machine.task` updates them at once), else the mission's count.
  const running = tasks.data ? sessions.filter((x) => x.status === "running").length : m.runningTasks;
  // ADR 0044: the mission's own copy of the project is prepared first ("Preparando o projeto…").
  const preparing = open && m.worktreeState === "preparing";
  const setupFailed = open && m.worktreeState === "failed";
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const act = (action: MissionControl) =>
    control.mutate(
      { missionId: m.id, action },
      {
        onSuccess: (out) => {
          if (action === "stop") {
            toast.show(t("missions.toast.stopped", { count: out.canceledTasks ?? 0 }), "info", {
              label: t("missions.actions.resume"),
              run: () => act("resume"),
            });
          } else toast.show(t(`missions.toast.${action}`));
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  const who = [...(people.data?.owner ? [people.data.owner] : []), ...(people.data?.participants ?? [])];
  const menu = open && (m.canAct || m.canManage);
  const itemsLabel = t("missions.itemsLabel", { done: m.plan.done, count: m.plan.total });
  const strip = (
    <span className="mh__items">
      <b>
        {m.plan.total > 0
          ? t("missions.items", { done: m.plan.done, count: m.plan.total })
          : t("missions.list.noItems")}
      </b>
      <MissionStrip cells={cells} titles={titles} agentId={m.agentId} label={itemsLabel} />
    </span>
  );
  const back = () =>
    void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: thread.channelId } });
  return (
    <header className="channel__header thread-head mh" data-compact={compact || undefined} data-mission={m.id}>
      <div className="mh__row">
        <div className="mh__lead">
          <NavToggle />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t("threads.view.backTo", { where })}
            title={t("threads.view.backTo", { where })}
            onClick={back}
          />
          <AgentAvatar agentId={m.agentId} name={agentName} size="sm" running={running > 0 && !offline} />
        </div>
        {/* The title and the header's buttons: the buttons go under a title that can't keep its line beside them. */}
        <div className="mh__main ac-actline">
          <div className="mh__text">
            <div className="mh__line">
              <h1 className="channel__title mh__title">{m.title}</h1>
              <MissionStatusChip mission={m} />
              {m.machine && (
                <span className="mh__exec">
                  <ExecutorChip mission={m} agentName={agentName} />
                </span>
              )}
            </div>
            <span className="channel__topic mh__meta">
              {t("missions.header.meta", { where })}
              {m.branch && (
                <span className="mh__branch">
                  {" · "}
                  <code>{m.branch}</code>
                  {m.baseBranch && ` ${t("missions.header.base", { base: m.baseBranch })}`}
                </span>
              )}
            </span>
          </div>
          <span className="mh__mini">{strip}</span>
          <div className="mh__end">
            {who.length > 0 && (
              <button
                type="button"
                className="mi-pill mh__people"
                onClick={() => setDialog("share")}
                aria-label={t("missions.pinned.people", { count: who.length })}
                title={who.map((p) => p.name).join(", ")}
              >
                <AvatarStack aria-label={who.map((p) => p.name).join(", ")}>
                  {who.slice(0, 3).map((p) => (
                    <ActorAvatar key={p.userId} actor={{ type: "person", id: p.userId }} name={p.name} size="xs" />
                  ))}
                </AvatarStack>
                {who.length > 3 && <small>+{who.length - 3}</small>}
              </button>
            )}
            {open && m.canAct && m.pending.joinRequests > 0 && (
              <button type="button" className="mi-pill mi-pill--need" onClick={() => setDialog("share")}>
                <Icon name="members" size={14} />
                {t("missions.join.pendingCount", { count: m.pending.joinRequests })}
              </button>
            )}
            {panel && (
              <Button
                size="sm"
                icon="document"
                className="mh__files"
                aria-label={t("missions.pinned.files")}
                onClick={() => panel.openFiles(m.id, "mission.md")}
              >
                <span className="mh__files-label">{t("missions.pinned.files")}</span>
              </Button>
            )}
            <Menu
              align="end"
              label={t("missions.menu.label")}
              trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("missions.pinned.more")} />}
            >
              {/* Actions only, each saying what it does; the settings are in their own dialog. */}
              {menu && m.canAct && (m.status === "active" || m.status === "awaiting_close") && (
                <MenuItem icon="pause" description={t("missions.menu.pauseHint")} onSelect={() => act("pause")}>
                  {t("missions.menu.pause")}
                </MenuItem>
              )}
              {menu && m.canAct && m.status === "paused" && (
                <MenuItem icon="play" description={t("missions.menu.resumeHint")} onSelect={() => act("resume")}>
                  {t("missions.menu.resume")}
                </MenuItem>
              )}
              {menu && m.canAct && m.status !== "proposed" && (
                <MenuItem icon="stop" description={t("missions.menu.stopHint")} onSelect={() => act("stop")}>
                  {t("missions.menu.stop")}
                </MenuItem>
              )}
              <MenuItem icon="members" description={t("missions.menu.shareHint")} onSelect={() => setDialog("share")}>
                {t("missions.menu.share")}
              </MenuItem>
              {open && m.canManage && (
                <MenuItem
                  icon="archive"
                  danger
                  description={t("missions.menu.closeHint")}
                  onSelect={() => setDialog("close")}
                >
                  {t("missions.menu.close")}
                </MenuItem>
              )}
              {open && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon="settings"
                    hint={t(`missions.commandApproval.${m.commandApproval}` as const)}
                    onSelect={() => setDialog("settings")}
                  >
                    {t("missions.menu.settings")}
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
      </div>
      <div className="mh__strip">
        {strip}
        {offline && interrupted > 0 && (
          <span className="mi-pill">
            <Icon name="pause" size={14} />
            {t("missions.pinned.interrupted", { count: interrupted })}
          </span>
        )}
        {!offline && preparing && (
          <span className="mi-pill">
            <AgentSpinner agentId={m.agentId} />
            {t("missions.setup.preparing")}
          </span>
        )}
        {setupFailed && (
          <span className={m.canAct ? "mi-pill mi-pill--need" : "mi-pill"} title={m.worktreeError ?? undefined}>
            <Icon name="alert" size={14} />
            {t("missions.setup.failedShort")}
          </span>
        )}
        {!offline && !preparing && running > 0 && (
          <span className="mi-pill">
            <AgentSpinner agentId={m.agentId} />
            {t("missions.pinned.running", { count: running })}
          </span>
        )}
        {waiting > 0 && (
          <span className={m.canAct ? "mi-pill mi-pill--need" : "mi-pill"}>
            <Icon name="waiting" size={14} />
            {t("missions.pinned.waiting", { count: waiting })}
          </span>
        )}
        {open && (
          <span className="mi-pill">
            <Icon name="clock" size={14} />
            {t("missions.pinned.since", { span: formatSpan(t, (now - Date.parse(since)) / 1000) })}
          </span>
        )}
        {/* The computer is in the executor chip; only a missing one gets its own. */}
        {!m.machine && <MachineChip machine={m.machine} />}
        {open && m.canAct && m.pending.provisional > 0 && (
          <Button
            size="sm"
            icon="check"
            loading={approveAll.isPending}
            onClick={() =>
              approveAll.mutate(undefined, {
                onSuccess: (out) => toast.show(t("missions.decision.approvedAll", { count: out.length })),
                onError: (error) => toast.show(errorText(t, error), "error"),
              })
            }
          >
            {t("missions.decision.approveAll", { count: m.pending.provisional })}
          </Button>
        )}
        {sessions.length > 0 && (
          <button
            type="button"
            className="mi-pill mh__sessions"
            aria-haspopup="dialog"
            onClick={() => setDialog("sessions")}
          >
            {t("missions.sessions.count", { count: sessions.length })}
            <Icon name="chevronRight" size={14} />
          </button>
        )}
      </div>
      {m.needsComputer && (
        <div className="mh__note">
          <span className="ac-iconline">
            <Icon name="computer" size={14} />
            <span>{m.role === "owner" ? t("missions.pinned.pickComputer") : t("missions.pinned.waitsComputer")}</span>
          </span>
          {m.role === "owner" && <PickComputer mission={m} />}
        </div>
      )}
      <ShareMissionDialog mission={m} open={dialog === "share"} onOpenChange={(o) => setDialog(o ? "share" : null)} />
      {m.canManage && (
        <CloseMissionDialog mission={m} open={dialog === "close"} onOpenChange={(o) => setDialog(o ? "close" : null)} />
      )}
      {dialog === "sessions" && <SessionsDialog mission={m} tasks={sessions} onClose={() => setDialog(null)} />}
      <MissionSettingsDialog
        mission={m}
        open={dialog === "settings"}
        onOpenChange={(o) => setDialog(o ? "settings" : null)}
      />
    </header>
  );
}

/**
 * Folds the header while the person reads back through the conversation
 * (away from the live end, where chats sit) and opens it again at the end.
 * Two thresholds so the header's own change of height can't flip it back.
 */
export function useCompactOnScroll(fold = 240, unfold = 48) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".channel__messages");
    if (!scroller) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const fromEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      setCompact((c) => (c ? fromEnd > unfold : fromEnd > fold));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fold, unfold]);
  return compact;
}

/** Handed over without a computer: its new owner points it at one they paired. */
function PickComputer({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const cloud = useComputerEdition(org.id) === "cloud";
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const machines = useMachines(org.id);
  const mine = (machines.data ?? []).filter((x) => x.pairedBy?.id === me.user.id && x.execAllowed);
  return (
    <Menu
      align="end"
      label={t("missions.pinned.chooseComputer")}
      trigger={
        <Button size="sm" icon="computer">
          {t("missions.pinned.chooseComputer")}
        </Button>
      }
    >
      {mine.length === 0 && (
        <MenuItem icon="info" disabled onSelect={() => {}}>
          {cloud
            ? t("missions.waitingCloud", {
                computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org.name }),
              })
            : t("missions.pinned.noComputers")}
        </MenuItem>
      )}
      {mine.map((x) => (
        <MenuItem
          key={x.id}
          icon="computer"
          description={x.online ? t("missions.online") : t("missions.offline")}
          onSelect={() =>
            void api.missions
              .setMachine(org.id, mission.id, x.id)
              .then((out) => {
                cacheMission(qc, org.id, out);
                toast.show(t("missions.toast.computer", { name: x.name }));
              })
              .catch((error) => toast.show(errorText(t, error), "error"))
          }
        >
          {x.name}
        </MenuItem>
      ))}
    </Menu>
  );
}

/**
 * The composer's note for someone who sees a mission and takes no part: they
 * can read, and ask its owner to join ("Pedir para participar"; then
 * "Pedido enviado" until someone answers). Nothing is posted in the thread.
 */
export function MissionJoinNote({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const ask = useRequestJoin(org.id, mission.id);
  const sent = mission.joinRequested || ask.isSuccess;
  return (
    <span className="mi-join">
      <span>{t("missions.readOnlyNote")}</span>
      {sent ? (
        <span className="mi-pill">
          <Icon name="check" size={14} />
          {t("missions.join.sent")}
        </span>
      ) : (
        <Button
          size="sm"
          icon="members"
          loading={ask.isPending}
          onClick={() =>
            ask.mutate(undefined, {
              onSuccess: () => toast.show(t("missions.join.sentToast")),
              onError: (error) => toast.show(errorText(t, error), "error"),
            })
          }
        >
          {t("missions.join.ask")}
        </Button>
      )}
    </span>
  );
}
