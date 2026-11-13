import type {
  Routine,
  RoutineEvent,
  RoutineHookCall,
  RoutineHookMethod,
  RoutineInput,
  RoutinePatch,
  RoutineReport,
  RoutineRun,
  RoutineTarget,
  RoutineTargetInput,
} from "@agenteschat/client";
import {
  ROUTINE_HOOK_METHODS,
  useCalendar,
  useChannels,
  useDms,
  useMachineOutages,
  useMailAccounts,
  useRoutineAction,
  useRoutineHook,
  useRoutineHookAction,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
  useRuleParse,
} from "@agenteschat/client";
import { approvalTitle, ownActionName } from "@agenteschat/client/lib/approval-words";
import type { RunStatus } from "@agenteschat/client/lib/calendar";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatBytes } from "@agenteschat/client/lib/files";
import {
  capitalize,
  clockHour,
  formatShortDate,
  formatTime,
  formatTokensShort,
  formatUsd,
  nextLabel,
  relativeTime,
  toYmd,
  whenAt,
} from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  blankLeft,
  ownWords,
  type RoutineTemplateOption,
  templateRule,
} from "@agenteschat/client/lib/routine-templates";
import {
  busyOnComputer,
  eventWebhook,
  healthWords,
  isRunAtWork,
  isStoppable,
  pausedFix,
  type RoutineFix,
  routineChannelOf,
  routineStateTime,
  routineStateWords,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runPixels,
  runsPerDay,
  stopWordsKey,
  usageContinueBlock,
  usageContinueOffered,
  usageParts,
  type Words,
  whereItRuns,
} from "@agenteschat/client/lib/routine-view";
import {
  browserTimezone,
  hookCurl,
  isRefusedHookCall,
  onceParts,
  routineHookUrl,
  timezoneName,
} from "@agenteschat/client/lib/routines";
import {
  Button,
  CheckboxPill,
  Chip,
  cx,
  DetailsDialog,
  DetailsSection,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FilterBar,
  FilterChip,
  GroupHeading,
  Icon,
  type IconName,
  InfoHint,
  Input,
  Locked,
  Menu,
  PageHeader,
  RecurrencePicker,
  type RecurrenceRule,
  RunKey,
  RunLane,
  RunMark,
  RunStrip,
  SavedNote,
  SearchField,
  Segmented,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  Tip,
  Toolbar,
  useAutoGrow,
  zonedInstant,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FoldedBody } from "@/chat/FoldedBody";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { CancelAhead } from "@/components/ApprovalItem";
import { AskAgentButton } from "@/components/AskAgentButton";
import { useActors } from "@/components/actors";
import {
  type ConnectorTriggerDraft,
  ConnectorTriggerFields,
  cleanConnectorFilter,
  connectorWhen,
  MILLIONSEND_EMAIL,
  useEmailEventConnections,
} from "@/components/ConnectorTrigger";
import { MenuEntries } from "@/components/DesktopMenus";
import { DetailsLink } from "@/components/details-link";
import { EditInPlace, useFocusAtEnd, useSavedFlash, useSent } from "@/components/EditInPlace";
import { cleanFilter, type EmailTriggerDraft, EmailTriggerFields, emailWhen, INBOX } from "@/components/EmailTrigger";
import { EventWebhookSetup } from "@/components/EventWebhookSetup";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { SwitchComputerDialog } from "@/components/MachineOutages";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { RoutineReachWarnings } from "@/components/RoutineReachWarnings";
import { RoutineTemplateSelect } from "@/components/RoutineTemplates";
import { useComputerEdition, useNamesComputers } from "@/components/WorkspaceComputer";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useDirectory } from "@/hooks/useDirectory";
import { useEdited } from "@/hooks/useEdited";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { copyText, type MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { defaultRule, fromApiRule, recurrenceLabels, ruleSentence, toApiRule, upcomingLabels } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import "./issues.css";
import "./routines.css";

export const ROUTINE_EVENTS: RoutineEvent[] = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
];

/** Started by something happening (an event, an email, a webhook call), not by the clock. */
const isEventDriven = (r: Routine) => r.trigger.type !== "schedule" && r.trigger.type !== "once";
/** An email routine whose mailbox needs reconnecting (or whose watch fails, or that MillionSend refused). */
const mailTrouble = (r: Routine) =>
  (r.trigger.type === "email" || r.trigger.type === "connector") && r.trigger.status && r.trigger.status !== "active"
    ? r.trigger.status
    : null;

/** A run of it is working now (Parar stops it). */
const isRunning = (r: Routine) => r.state === "running";
/** A run of it is at work: working, waiting for a person or its computer, or paused near its plan's limit. */
const isAtWork = (r: Routine) =>
  isRunning(r) || r.state === "waiting_person" || r.state === "waiting_computer" || r.state === "usage_paused";
/** A one-off that already fired (or was cancelled): no switch, no "Rodar agora", nothing left to run. */
export const hasFired = (r: Routine) => r.trigger.type === "once" && !r.active;
/** A one-off that fired and whose run ended: shown muted, under "Concluídos" (while its run works, it is live). */
export const isDoneOnce = (r: Routine) => hasFired(r) && !isAtWork(r);
/** Paused: inactive and not a one-off (a fired one-off is done, or live while its run works). */
const isPaused = (r: Routine) => !r.active && r.trigger.type !== "once";

/** Says the routine's words (`lib/routine-view`): its key and values, else its fallback key. */
function useSay() {
  const { t } = useTranslation();
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (w: Words) => tt(w.key, { ...w.values, ...(w.fallback ? { defaultValue: tt(w.fallback) } : {}) });
}

/** The horizon: the last 4 hours and the next 20. */
const HORIZON_BACK = 4 * 3_600_000;
const HORIZON_AHEAD = 20 * 3_600_000;
const RUN_SLOTS = 14;

/** "now", ticking every minute ("próxima em 10 min" stays true). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useTargetLabel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  // A widget's routine (ADR 0135) is named by its widget's title when the caller has it.
  return (target: RoutineTarget, widgetTitle?: string) => {
    if (target.type === "channel") {
      const c = channels.data?.find((x) => x.id === target.channelId);
      return c ? `#${c.name}` : "#";
    }
    // From the chat: "na DM com o Jorge", "no #general (thread)".
    if (target.type === "conversation") {
      const dm = dms.data?.find((d) => d.channelId === target.channelId);
      if (dm) return t("routines.inDm", agentGrammar(dm.with.name));
      const c = channels.data?.find((x) => x.id === target.channelId);
      if (!c) return t("routines.inConversation");
      return t(target.threadId ? "routines.inThread" : "routines.inChannel", { channel: c.name });
    }
    if (target.type === "widget")
      return widgetTitle ? t("routines.target.widgetNamed", { title: widgetTitle }) : t("routines.target.widget");
    return t(target.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
}

/** Opens a widget's panel on its board (a home board's opens on Home). */
function useOpenWidget() {
  const { org } = useOrg();
  const navigate = useNavigate();
  return (widget: { id: string; dashboardId: string }) =>
    void navigate({
      to: "/org/$orgId/dashboards/$dashboardId",
      params: { orgId: org.id, dashboardId: widget.dashboardId },
      search: { widget: widget.id },
    });
}

const targetIcon = (target: RoutineTarget): IconName =>
  target.type === "dm"
    ? "message"
    : target.type === "conversation"
      ? target.threadId
        ? "reply"
        : "channel"
      : target.type === "artifact"
        ? "file"
        : target.type === "widget"
          ? "grid"
          : "channel";

/** The agent's look for the pixel pieces (color and eyes). */
function useLook() {
  const actors = useActors();
  return (agentId: string) => {
    const look = lookOf(actors.dir.agentById.get(agentId));
    return { color: look?.color ?? "sky", eyes: look?.eyes ?? "round" };
  };
}

/** "Quando" in words, in the routine's zone (the zone shows only when it isn't mine). */
export function useWhen() {
  const { t, i18n } = useTranslation();
  const { me, org } = useOrg();
  const actors = useActors();
  const mailboxes = useMailAccounts(org.id);
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "UTC";
  return (r: Routine) => {
    if (r.trigger.type === "email") return emailWhen(t, r, mailboxes.data);
    if (r.trigger.type === "connector") return connectorWhen(t, r);
    if (r.trigger.type === "webhook") return t("routines.webhook.when");
    const zone = r.trigger.type === "event" ? "" : r.trigger.timezone || "UTC";
    const zoneNote = zone && zone !== myZone ? ` (${timezoneName(zone, i18n.language)})` : "";
    if (r.trigger.type === "schedule")
      return `${
        r.trigger.rule
          ? ruleSentence(t, i18n.language, fromApiRule(r.trigger.rule, toYmd(new Date())), new Date(), false)
          : everyMinutes(t, r.trigger.cron) || r.trigger.description
      }${zoneNote}`;
    if (r.trigger.type === "once")
      return t("routines.once", { ...onceParts(i18n.language, r.trigger.at, zone), zone: zoneNote });
    return t(`routines.event.${r.trigger.event}`);
  };
}

/** Rotinas: scheduled and event-driven agent tasks. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const routines = useRoutines(org.id);
  const now = useNow();
  const [creating, setCreating] = useState(false);
  // The routine whose details are open, in the URL (`?open=…`).
  const [openId, setOpenId] = useOpenParam();
  const [showDone, setShowDone] = useState(false);
  const [status, setStatus] = useState<"all" | "active" | "paused" | "event">("all");
  const [q, setQ] = useState("");
  const list = routines.data ?? [];
  // After the directory: who may create hangs on the agents they own.
  const noRoutines = routines.isSuccess && list.length === 0 && !dir.loading;
  const look = useRightHandLook();
  // The server's rule: who manages routines, or an agent's owner for that agent.
  const mayCreate = can(org, "manage_routines") || dir.agents.some((a) => a.ownerUserId === me.user.id);
  const [agents, setAgents] = useState<string[]>([]);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const when = useWhen();
  const query = q.trim().toLowerCase();
  const matches = (r: Routine) =>
    (agents.length === 0 || agents.includes(`agent:${r.agentId}`)) &&
    (!query || `${r.name} ${r.prompt ?? ""} ${when(r)}`.toLowerCase().includes(query));
  const shown = list.filter(matches);
  const current = shown.filter((r) => !isDoneOnce(r));
  const done = shown.filter(isDoneOnce);
  const counts = {
    all: current.length,
    active: current.filter((r) => r.active).length,
    paused: current.filter(isPaused).length,
    event: current.filter(isEventDriven).length,
  };
  const byStatus = (r: Routine) =>
    status === "all" ||
    (status === "active" && r.active) ||
    (status === "paused" && isPaused(r)) ||
    (status === "event" && isEventDriven(r));
  const live = current.filter((r) => byStatus(r) && !isPaused(r));
  const paused = current.filter((r) => byStatus(r) && isPaused(r));
  const open = list.find((r) => r.id === openId) ?? null;
  const toggleOpen = (id: string) => setOpenId(openId === id ? null : id);
  const filtered = agents.length > 0 || query.length > 0 || status !== "all";
  // "N" opens "Nova rotina" (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "n") return;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const group = (title: string, rows: Routine[]) =>
    rows.length > 0 && (
      <section className="routines-group" aria-label={title}>
        <GroupHeading title={title} count={rows.length} />
        <div className="routines-list">
          {rows.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              now={now}
              selected={r.id === openId}
              onOpen={() => toggleOpen(r.id)}
              onEdit={() => setOpenId(r.id)}
            />
          ))}
        </div>
      </section>
    );
  return (
    <div className="page routines">
      <div className="routines__main">
        <PageHeader
          title={t("routines.title")}
          meta={t("routines.subtitle")}
          actions={
            // The empty state takes over this button: one way in, in the middle of the page.
            mayCreate &&
            !noRoutines && (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t("routines.new")}
              </Button>
            )
          }
        />
        {routines.isLoading && <LoadingCards count={3} />}
        {routines.isError && !routines.data && (
          <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />
        )}
        {noRoutines && (
          <EmptyState
            size="page"
            agent={look}
            title={t(mayCreate ? "routines.emptyTitle" : "routines.emptyViewerTitle")}
            actions={
              mayCreate && (
                <>
                  <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                    {t("routines.new")}
                  </Button>
                  <AskAgentButton draft={t("routines.askText")} />
                </>
              )
            }
          >
            {t(mayCreate ? "routines.empty" : "routines.emptyViewer")}
          </EmptyState>
        )}
        {list.length > 0 && (
          <>
            <RoutineHorizon routines={list} now={now} onOpen={toggleOpen} />
            <Toolbar
              search={
                <SearchField
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={copy.clearSearch}
                  placeholder={t("routines.search")}
                  aria-label={t("routines.search")}
                />
              }
            >
              <Segmented
                label={t("routines.statusLabel")}
                value={status}
                onValueChange={setStatus}
                options={(["all", "active", "paused", "event"] as const).map((v) => ({
                  value: v,
                  label: t(`routines.status.${v}`),
                  count: counts[v],
                }))}
              />
              <FilterBar
                label={t("routines.filters")}
                clearText={copy.clearAll}
                onClear={() => {
                  setAgents([]);
                  setQ("");
                  setStatus("all");
                }}
                filters={[
                  {
                    key: "agents",
                    active: agents.length > 0,
                    node: (
                      <FilterChip
                        label={t("routines.agentFilter")}
                        icon="agent"
                        multiple
                        options={agentOptions}
                        value={agents}
                        onChange={setAgents}
                        valueText={(o) => o.label}
                        countText={copy.people}
                        clearLabel={copy.clearOf(t("routines.agentFilter"))}
                      />
                    ),
                  },
                ]}
              />
            </Toolbar>
            <div className="ac-groups">
              {group(status === "paused" ? t("routines.groupPaused") : t("routines.groupLive"), live)}
              {group(t("routines.groupPaused"), paused)}
              {live.length === 0 && paused.length === 0 && filtered && (
                <EmptyState
                  size="panel"
                  actions={
                    <Button
                      onClick={() => {
                        setAgents([]);
                        setQ("");
                        setStatus("all");
                      }}
                    >
                      {copy.clearAll}
                    </Button>
                  }
                >
                  {t("routines.noResults")}
                </EmptyState>
              )}
              {done.length > 0 && status === "all" && (
                <section className="routines-group" aria-label={t("routines.done")}>
                  <GroupHeading
                    title={
                      <button
                        type="button"
                        aria-expanded={showDone}
                        aria-controls="routines-done-list"
                        onClick={() => setShowDone((v) => !v)}
                      >
                        <Icon name={showDone ? "chevronDown" : "chevronRight"} size={14} />
                        {t("routines.doneToggle", { count: done.length })}
                      </button>
                    }
                  />
                  {showDone && (
                    <div id="routines-done-list" className="routines-list">
                      {done.map((r) => (
                        <RoutineRow
                          key={r.id}
                          routine={r}
                          now={now}
                          selected={r.id === openId}
                          onOpen={() => toggleOpen(r.id)}
                          onEdit={() => setOpenId(r.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </>
        )}
      </div>
      {open && <RoutineDetails routine={open} now={now} onClose={() => setOpenId(null)} />}
      <RoutineDialog open={creating} onClose={() => setCreating(false)} onWebhook={(r) => setOpenId(r.id)} />
    </div>
  );
}

/**
 * A widget's own routine (ADR 0135 §4): it redoes its widget in place, so its agent, schedule, instructions and
 * target change from the widget; here it can be paused, resumed, run, stopped or deleted.
 */
const isWidgetRoutine = (r: Pick<Routine, "target">) => r.target.type === "widget";

/** A title for the card: a routine made from a chat message may be named with its whole prompt. */
export function routineTitle(r: Pick<Routine, "name" | "prompt">) {
  const name = r.name.trim();
  if (name !== (r.prompt ?? "").trim() && name.length <= 80) return name;
  const first = (name.split("\n")[0] ?? name).trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** "A cada 30 minutos" for a routine every N minutes (kept as cron `*\/N * * * *`, no rule); "" otherwise. */
function everyMinutes(t: TFunction, cron: string) {
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim())?.[1] ?? (cron.trim() === "* * * * *" ? "1" : null);
  return every ? t("recurrence.s.minutely", { count: Number(every) }) : "";
}

/** The runs as words, for the strip's label and the horizon's tooltips. */
function useRunWords() {
  const { t, i18n } = useTranslation();
  return {
    status: (s: RunStatus) => t(`routines.statusWord.${s}`),
    caption: (r: Routine, now: Date) => {
      if (isRunning(r)) return t("routines.runningNow");
      // The finished runs (one at work is the strip's own "running").
      const runs = runPixels(r.recentRuns.length > 0 ? r.recentRuns : r.lastRun ? [r.lastRun] : []);
      const last = runs[0];
      if (!last) return t("routines.neverRan");
      const silent = runs.filter((x) => x.status === "silent").length;
      if (last.status === "silent" && silent > 1) return t("routines.silentOf", { count: silent, total: runs.length });
      const when = relativeTime(t, i18n.language, last.at, now);
      // A person stopped it: that's no skipped slot (the strip draws both gray).
      if (r.recentRuns[0]?.status === "canceled" && r.recentRuns[0].at === last.at)
        return t("routines.lastRun.stopped", { when });
      return t(`routines.lastRun.${last.status}`, { when });
    },
    label: (r: Routine) => {
      const runs = runPixels(r.recentRuns).slice(0, RUN_SLOTS);
      if (runs.length === 0) return t("routines.stripNone");
      // A sentence per run. The first follows the label's colon, so only the others start with a capital.
      const list = runs.map((x, i) => {
        const when = whenAt(t, i18n.language, x.at);
        return `${i > 0 ? capitalize(when, i18n.language) : when}: ${t(`routines.statusWord.${x.status}`)}`;
      });
      return t("routines.stripLabel", { list: list.join(". ") });
    },
  };
}

/** "Próxima em 10 min" (within a day), else "Próxima sex 16 out, 10:00". */
function useNextText() {
  const { t, i18n } = useTranslation();
  return (r: Routine, now: Date) => {
    if (isRunning(r)) return t("routines.runningNow");
    if (hasFired(r))
      return r.lastRun
        ? t("routines.firedAt", { when: whenAt(t, i18n.language, r.lastRun.at) })
        : t("routines.canceled");
    if (!r.active) return t("routines.paused");
    if (isEventDriven(r)) {
      const week = r.recentRuns.filter((x) => now.getTime() - new Date(x.at).getTime() < 7 * 86_400_000).length;
      if (r.trigger.type === "email" || r.trigger.type === "connector")
        return week > 0 ? t("mail.routine.thisWeek", { count: week }) : t("mail.routine.waiting");
      if (week > 0) return t("routines.eventThisWeek", { count: week });
      return t(r.trigger.type === "webhook" ? "routines.webhook.waiting" : "routines.waitingEvent");
    }
    if (!r.nextRunAt) return "";
    const ms = new Date(r.nextRunAt).getTime() - now.getTime();
    if (ms <= 60_000) return t("routines.nextSoon");
    if (ms < 3_600_000)
      return t("routines.nextIn", { when: t("format.inMinutes", { count: Math.floor(ms / 60_000) }) });
    if (ms < 20 * 3_600_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return t("routines.nextIn", {
        when: m ? t("routines.hoursMinutes", { h, m }) : t("format.inHours", { count: h }),
      });
    }
    return t("routines.next", { when: nextLabel(i18n.language, r.nextRunAt) });
  };
}

/** Pause, resume, run, stop, the one-tap fixes and delete: one place for the toasts they say. */
export function useRoutineControls(r: Routine) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const running = isRunning(r);
  return {
    action,
    setActive: (active: boolean, onDone?: () => void) =>
      action.mutate(
        { type: "active", id: r.id, active },
        {
          onSuccess: () => {
            toast.show(
              t(active ? "routines.resumedToast" : running ? "routines.pausedRunningToast" : "routines.pausedToast"),
            );
            onDone?.();
          },
        },
      ),
    run: () => action.mutate({ type: "run", id: r.id }),
    stop: () =>
      action.mutate(
        { type: "stop", id: r.id },
        {
          onSuccess: () =>
            toast.show(t(r.state === "usage_paused" ? "routines.usagePause.canceledToast" : "routines.stoppedToast")),
        },
      ),
    continueUsage: () =>
      action.mutate(
        { type: "continueUsage", id: r.id },
        {
          onSuccess: (saved) =>
            (saved as Routine).state !== "usage_paused" && toast.show(t("routines.usagePause.continuedToast")),
          onError: (error) => toast.show(errorText(t, error), "error"),
        },
      ),
    fix: (fix: RoutineFix) => {
      const channelId = routineChannelOf(r.target);
      if (fix === "add_agent" && channelId)
        action.mutate(
          { type: "addAgent", id: r.id, agentId: r.agentId, channelId },
          {
            onSuccess: () =>
              toast.show(t("routines.fix.addedToast", { name: actors.name({ type: "agent", id: r.agentId }) })),
          },
        );
      else if (fix === "take_over")
        action.mutate({ type: "takeOver", id: r.id }, { onSuccess: () => toast.show(t("routines.fix.takenToast")) });
      else
        action.mutate(
          { type: "active", id: r.id, active: true },
          { onSuccess: () => toast.show(t("routines.resumedToast")) },
        );
    },
  };
}

/** The state as a chip ("Pausada: o agente não está mais no canal", "Falhando (3 seguidas)"…). */
function RoutineStateChip({ routine: r, className }: { routine: Routine; className?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const say = useSay();
  const names = useNamesComputers(org.id);
  const state = routineStateWords(r, routineStateTime(t, i18n.language, r), names);
  return (
    <Chip
      icon={state.icon}
      tone={state.tone}
      className={className}
      lead={r.state === "running" ? <AgentSpinner agentId={r.agentId} /> : undefined}
    >
      {say(state)}
    </Chip>
  );
}

/**
 * A run waiting on its plan's or budget's limit: it picks up by itself. Paused near the limit, Continuar agora lets it
 * go on now for its creator, the agent's owner and admins (everyone else sees the button greyed with the reason); at
 * the limit itself there is nothing to continue. Not running it is Parar's "Don't run it".
 */
function UsagePausedNote({ routine: r }: { routine: Routine }) {
  const { t } = useTranslation();
  const controls = useRoutineControls(r);
  const blocked = usageContinueBlock(r);
  const reason = blocked ? t(`routines.usagePause.${blocked}`) : null;
  if (!usageContinueOffered(r))
    return (
      <div className="routine-details__usage-pause">
        <p className="small muted">{t("routines.usagePause.lineLimit")}</p>
      </div>
    );
  return (
    <div className="routine-details__usage-pause">
      <p className="small muted">{t("routines.usagePause.line")}</p>
      <span className="routine-details__usage-pause-acts">
        <Button
          size="sm"
          variant="primary"
          icon="play"
          disabled={blocked !== null}
          loading={controls.action.isPending}
          title={reason ?? t(r.usagePause?.source === "budget" ? "usageCard.hintBudget" : "usageCard.hint")}
          onClick={controls.continueUsage}
        >
          {t("usageCard.continue")}
        </Button>
        {reason && <span className="small muted">{reason}</span>}
      </span>
    </div>
  );
}

/** The one-tap fix of a paused routine ("Adicionar agente ao canal", "Assumir rotina", "Retomar"). */
function FixButton({ routine: r, fix, size = "sm" }: { routine: Routine; fix: RoutineFix; size?: "sm" }) {
  const { t } = useTranslation();
  const controls = useRoutineControls(r);
  return (
    <Button
      size={size}
      variant={fix === "resume" ? "default" : "primary"}
      icon={fix === "add_agent" ? "plus" : fix === "take_over" ? "person" : "play"}
      loading={controls.action.isPending}
      onClick={() => controls.fix(fix)}
    >
      {t(`routines.fix.${fix}`)}
    </Button>
  );
}

function RoutineRow({
  routine: r,
  now,
  selected,
  onOpen,
  onEdit,
}: {
  routine: Routine;
  now: Date;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const toast = useToast();
  const controls = useRoutineControls(r);
  const action = controls.action;
  const [deleting, setDeleting] = useState(false);
  const target = useTargetLabel();
  const openWidget = useOpenWidget();
  const when = useWhen();
  const nextText = useNextText();
  const words = useRunWords();
  const look = useLook()(r.agentId);
  const agent = { type: "agent" as const, id: r.agentId };
  const widget = isWidgetRoutine(r) ? r.widget : null;
  // A widget's routine reads as its widget (ADR 0135 §4).
  const title = widget?.title || routineTitle(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const paused = isPaused(r);
  const running = isRunning(r);
  const stoppable = isStoppable(r);
  const more = t("routines.more", { name: title });
  // Something needs a look (a reason it paused, failures, waiting for a computer or a person): a chip says it.
  const needsLook = !done && routineStateWords(r).tone === "waiting";
  const fix = r.canManage && needsLook ? pausedFix(r) : null;
  // Paused near its plan's limit: said quietly (it picks up by itself), with no fix.
  const showState = needsLook || r.state === "usage_paused";
  // Its "…" and its right click: run or stop, pause or resume, then what the "…" always had.
  const entries = (): MenuEntry[] => [
    ...(r.canManage && !reminder && (stoppable || !fired)
      ? ([
          stoppable
            ? { kind: "item", id: "stop", label: t(stopWordsKey(r)), icon: "stop", run: controls.stop }
            : { kind: "item", id: "run", label: t("routines.runNow"), icon: "play", run: controls.run },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage && !fired
      ? ([
          r.active
            ? {
                kind: "item",
                id: "pause",
                label: t("routines.pause"),
                icon: "pause",
                run: () => controls.setActive(false),
              }
            : {
                kind: "item",
                id: "resume",
                label: t("routines.resume"),
                icon: "play",
                run: () => controls.setActive(true),
              },
          { kind: "separator" },
        ] satisfies MenuEntry[])
      : []),
    // A widget's routine changes from its widget: "Open widget" in place of Edit, and no copy of it.
    ...(widget
      ? ([
          {
            kind: "item",
            id: "widget",
            label: t("widgets.notice.openWidget"),
            icon: "grid",
            run: () => openWidget(widget),
          },
        ] satisfies MenuEntry[])
      : r.canManage
        ? ([{ kind: "item", id: "edit", label: t("routines.edit"), icon: "edit", run: onEdit }] satisfies MenuEntry[])
        : []),
    { kind: "item", id: "runs", label: t("routines.runs"), icon: "waiting", run: () => !selected && onOpen() },
    ...(r.canManage && !widget
      ? ([
          {
            kind: "item",
            id: "duplicate",
            label: t("routines.duplicate"),
            icon: "copy",
            run: () =>
              action.mutate(
                { type: "duplicate", id: r.id, name: t("routines.copyName", { name: r.name }) },
                {
                  onSuccess: (copy) =>
                    toast.show(t("routines.duplicated", { name: (copy as Routine | undefined)?.name ?? r.name })),
                },
              ),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage && routineHookUrl(r)
      ? ([
          {
            kind: "item",
            id: "webhook",
            label: t("routines.copyWebhook"),
            icon: "link",
            run: () => void copyText(routineHookUrl(r) ?? "", () => toast.show(t("routines.webhookCopied"))),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(r.canManage
      ? ([
          { kind: "item", id: "delete", label: t("routines.delete"), icon: "trash", run: () => setDeleting(true) },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a mouse shortcut; the title is the keyboard way to the details
    <article
      className={cx("routine-row", selected && "routine-row--on")}
      aria-label={title}
      data-active={r.active || undefined}
      data-paused={paused || undefined}
      data-done={done || undefined}
      data-running={running || undefined}
      data-state={r.state}
      {...entityMenu(() => [{ kind: "header", label: title }, ...entries()])}
      onClick={(e) => {
        // The row opens the details; its own controls don't.
        if ((e.target as HTMLElement).closest("button, a, [role=switch], [role=menu]")) return;
        onOpen();
      }}
    >
      <span className="routine-row__who">{actors.avatar(agent, "sm")}</span>
      <div className="routine-row__main">
        <button type="button" className="routine-row__title" title={r.name} aria-expanded={selected} onClick={onOpen}>
          {title}
        </button>
        <span className="routine-row__sub">
          <span className="routine-row__to ac-iconline">
            <Icon name={targetIcon(r.target)} size={14} />
            <span>
              {widget
                ? t("routines.widgetLine", { agent: actors.name(agent) })
                : r.target.type === "conversation"
                  ? t("routines.deliversIn", { agent: actors.name(agent), place: target(r.target) })
                  : t("routines.deliversTo", { agent: actors.name(agent), target: target(r.target) })}
            </span>
          </span>
          {widget && (
            <Chip icon="grid" className="routine-row__chip">
              {t("routines.widgetChip")}
            </Chip>
          )}
          {reminder && (
            <Chip icon="bell" className="routine-row__chip">
              {t("routines.reminder")}
            </Chip>
          )}
          {mailTrouble(r) && (
            <Chip icon="alert" tone="waiting" className="routine-row__chip">
              {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
            </Chip>
          )}
          {showState && <RoutineStateChip routine={r} className="routine-row__chip" />}
          {fix && fix !== "resume" && <FixButton routine={r} fix={fix} />}
        </span>
      </div>
      <div className="routine-row__when ac-mediarow ac-mediarow--row">
        <span className="ac-mediarow__face routine-row__when-icon" aria-hidden="true">
          <Icon
            name={
              r.trigger.type === "event"
                ? "bolt"
                : r.trigger.type === "email" || r.trigger.type === "connector"
                  ? "mail"
                  : r.trigger.type === "webhook"
                    ? "link"
                    : r.trigger.type === "once"
                      ? reminder
                        ? "bell"
                        : "calendar"
                      : "repeat"
            }
            size={16}
          />
        </span>
        <span className="ac-mediarow__head routine-row__when-text">
          <b>{when(r)}</b>
        </span>
        <span className="ac-mediarow__body routine-row__when-text">
          <small className={cx(running && "is-live")}>{nextText(r, now)}</small>
        </span>
      </div>
      <div className="routine-row__runs" role="img" aria-label={words.label(r)}>
        <RunStrip runs={runPixels(r.recentRuns)} color={look.color} slots={RUN_SLOTS} running={running} />
        <small>{words.caption(r, now)}</small>
      </div>
      <div className="routine-row__actions">
        {fired || !r.canManage ? (
          <span className="routine-row__ph routine-row__ph--switch" aria-hidden="true" />
        ) : (
          <Switch
            checked={r.active}
            onCheckedChange={controls.setActive}
            aria-label={t("routines.activeLabel", { name: title })}
          />
        )}
        {/* Parar for a run at work, also a paused routine's or a fired one-off's; "Rodar agora" while it may run. */}
        {(stoppable || !fired) && !reminder && r.canManage ? (
          stoppable ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="stop"
              title={t(stopWordsKey(r))}
              aria-label={t(r.state === "usage_paused" ? "routines.usagePause.dontRunName" : "routines.stopName", {
                name: title,
              })}
              disabled={action.isPending}
              onClick={controls.stop}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="play"
              title={t("routines.runNow")}
              aria-label={t("routines.runNow")}
              disabled={action.isPending}
              onClick={controls.run}
            />
          )
        ) : (
          <span className="routine-row__ph" aria-hidden="true" />
        )}
        <Menu
          align="end"
          label={more}
          trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={more} />}
        >
          <MenuEntries entries={entries()} />
        </Menu>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={t("routines.deleteTitle", { name: title })}
        description={t("common.joinSentences", {
          a: running ? t("routines.deleteBodyRunning") : t("routines.deleteBody"),
          b: t("common.cantUndo"),
        })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={action.isPending && action.variables?.type === "delete"}
            onClick={() =>
              action.mutate(
                { type: "delete", id: r.id },
                {
                  onSuccess: () => {
                    setDeleting(false);
                    toast.show(t("routines.deleted"));
                  },
                },
              )
            }
          >
            {t("routines.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </article>
  );
}

/**
 * The next hours as a horizon: one lane per scheduled routine, its recent runs
 * as pixel columns, the next run as the agent's sprite on the line, "agora" as
 * a dotted pixel line. Future slots come from the calendar range (the server's
 * schedule math).
 */
function RoutineHorizon({ routines, now, onOpen }: { routines: Routine[]; now: Date; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const look = useLook();
  const words = useRunWords();
  // The window moves with the minute; the slots are asked once per hour (the calendar caches by start).
  const hour = Math.floor(now.getTime() / 3_600_000);
  const range = useMemo(() => {
    const start = new Date(hour * 3_600_000);
    return { from: start.toISOString(), to: new Date(start.getTime() + HORIZON_AHEAD + 3_600_000).toISOString() };
  }, [hour]);
  const slots = useCalendar(org.id, range.from, range.to);
  const from = new Date(now.getTime() - HORIZON_BACK);
  const to = new Date(now.getTime() + HORIZON_AHEAD);
  const lanes = routines.filter((r) => r.active && !isDoneOnce(r) && !isEventDriven(r));
  if (lanes.length === 0) return null;
  const futureOf = (r: Routine) => {
    const at = (slots.data?.routines ?? [])
      .filter((s) => s.routineId === r.id && new Date(s.at) > now && new Date(s.at) <= to)
      .map((s) => s.at);
    // Before the calendar answers, the next run alone.
    if (at.length === 0 && r.nextRunAt && new Date(r.nextRunAt) <= to) return [r.nextRunAt];
    return at.sort();
  };
  const pos = (d: Date) => ((d.getTime() - from.getTime()) / (to.getTime() - from.getTime())) * 100;
  const scale: { at: Date; label: string; day: boolean }[] = [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  first.setHours(Math.ceil(first.getHours() / 3) * 3);
  for (let d = new Date(first); d <= to; d = new Date(d.getTime() + 3 * 3_600_000)) {
    const p = pos(d);
    if (p < 3 || p > 97 || Math.abs(d.getTime() - now.getTime()) < 1.2 * 3_600_000) continue;
    const midnight = d.getHours() === 0;
    scale.push({
      at: d,
      day: midnight,
      label: midnight
        ? new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\./g, "")
        : formatTime(i18n.language, d.toISOString()),
    });
  }
  const timeOf = (iso: string) => formatTime(i18n.language, iso);
  const later = lanes.filter((r) => futureOf(r).length === 0).length;
  const nowAt = pos(now);
  return (
    <section className="routines-horizon" aria-label={t("routines.horizon.label")}>
      <div className="routines-horizon__head">
        <h2>{t("routines.horizon.title", { count: HORIZON_AHEAD / 3_600_000 })}</h2>
        <span className="routines-horizon__sub">
          {t("routines.horizon.lanes", { count: lanes.length })}
          {later > 0 && ` · ${t("routines.horizon.later", { count: later })}`}
        </span>
        <span className="routines-horizon__legend" aria-hidden="true">
          {(["ok", "silent", "failed", "next"] as const).map((k) => (
            <span key={k}>
              <RunKey status={k} />
              {t(`routines.horizon.legend.${k}`)}
            </span>
          ))}
        </span>
      </div>
      <div className="routines-horizon__body" style={{ "--now-k": nowAt / 100 } as CSSProperties}>
        <span />
        <div className="routines-horizon__scale" aria-hidden="true">
          {scale.map((s) => (
            <span key={s.at.getTime()} style={{ left: `${pos(s.at)}%` }} className={cx(s.day && "is-day")}>
              {s.label}
            </span>
          ))}
        </div>
        {lanes.map((r) => {
          const future = futureOf(r);
          const next = future[0];
          const soon = next && new Date(next).getTime() - now.getTime() < 3_600_000;
          const hourly = r.trigger.type === "schedule" && r.trigger.rule?.freq === "hourly";
          const { color, eyes } = look(r.agentId);
          const title = routineTitle(r);
          return (
            <div className="routines-horizon__lane" key={r.id}>
              <button
                type="button"
                className="routines-horizon__label ac-iconline"
                title={title}
                onClick={() => onOpen(r.id)}
              >
                <AgentFace agentId={r.agentId} />
                <b>{title}</b>
              </button>
              <div
                className="routines-horizon__track"
                role="img"
                aria-label={
                  next
                    ? t("routines.horizon.lane", { name: title, when: whenAt(t, i18n.language, next) })
                    : t("routines.horizon.laneNone", { name: title })
                }
                title={words.label(r)}
              >
                <RunLane
                  from={from}
                  to={to}
                  now={now}
                  color={color}
                  eyes={eyes}
                  running={isRunning(r)}
                  past={runPixels(r.recentRuns).filter((x) => new Date(x.at) >= from && new Date(x.at) <= now)}
                  future={future}
                />
                {next && !isRunning(r) && (!hourly || soon) && (
                  <span
                    className={cx("routines-horizon__next", soon && "is-soon")}
                    style={{ left: `max(${pos(new Date(next))}%, calc(${nowAt}% + 12px))` }}
                  >
                    {soon
                      ? t("format.inMinutes", {
                          count: Math.max(1, Math.floor((new Date(next).getTime() - now.getTime()) / 60_000)),
                        })
                      : timeOf(next)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span className="routines-horizon__past" aria-hidden="true" />
        <span className="routines-horizon__now" aria-hidden="true">
          <span>{t("routines.horizon.now")}</span>
        </span>
      </div>
    </section>
  );
}

function AgentFace({ agentId }: { agentId: string }) {
  const actors = useActors();
  return actors.avatar({ type: "agent", id: agentId }, "xs");
}

/**
 * A routine's details over whatever page is open (`DetailsHost`): the chat's routine tag, an agent's receipts,
 * the calendar. It is edited where it is, as on Rotinas.
 */
export function RoutineDetailsDialog({ routineId, onClose }: { routineId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const routines = useRoutines(org.id);
  const now = useNow();
  const routine = routines.data?.find((r) => r.id === routineId);
  // Gone, or not one the viewer may see: says so and closes.
  const gone = routines.isError || (routines.isSuccess && !routine);
  useEffect(() => {
    if (!gone) return;
    toast.show(t("routines.notFound"), "error");
    onClose();
  }, [gone, toast, t, onClose]);
  if (!routine) return null;
  return <RoutineDetails routine={routine} now={now} onClose={onClose} />;
}

/** Who sees what it delivers: a conversation in a DM is the person's alone, not everyone in a channel. */
function useWhereHint() {
  const { org } = useOrg();
  const dms = useDms(org.id);
  return (target: RoutineTarget): "thread" | "channel" | "dm" | "artifact" | "widget" => {
    if (target.type !== "conversation") return target.type;
    if (dms.data?.some((d) => d.channelId === target.channelId)) return "dm";
    return target.threadId ? "thread" : "channel";
  };
}

/**
 * The routine's own page in the details dialog, always full height (as a task's): who made it, its name (edited in
 * place), its agent, state and when, this week in pixels, then "Detalhes" (what it does, edited in place; the next
 * runs; the webhook; what was prepared for later) and "Execuções"; the aside holds "No ar" and the fields that change
 * at once. "Rodar agora" (or Parar) and the one-tap fix are on the bar. Who can't change it sees the values.
 */
function RoutineDetails({ routine: r, now, onClose }: { routine: Routine; now: Date; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const controls = useRoutineControls(r);
  const action = controls.action;
  const runs = useRoutineRuns(org.id, r.id);
  const when = useWhen();
  const say = useSay();
  const outages = useMachineOutages(org.id, r.state === "waiting_computer");
  const [switching, setSwitching] = useState(false);
  const [tab, setTab] = useState<"details" | "runs">("details");
  const [saved, flashSaved] = useSavedFlash();
  const agent = { type: "agent" as const, id: r.agentId };
  const name = actors.name(agent);
  const title = routineTitle(r);
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const stoppable = isStoppable(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const described = useRuleDescribe(
    org.id,
    r.active && r.trigger.type === "schedule" && r.trigger.rule ? r.trigger.rule : null,
  );
  const nexts = described.data?.ok ? described.data.nextRuns.slice(0, 4) : r.nextRunAt ? [r.nextRunAt] : [];
  const fix = r.canManage ? pausedFix(r) : null;
  // "Trocar computador": the outage its run waits on, for whoever can move agents, where people connect their own
  // computers (a Cloud workspace has one).
  const selfHost = useComputerEdition(org.id) === "selfhost";
  const outage =
    selfHost && r.state === "waiting_computer" && r.waitingFor && can(org, "manage_agents")
      ? outages.data?.outages.find((o) => o.machineId === r.waitingFor?.machineId)
      : undefined;
  const usage = usageParts(r.usage, can(org, "view_usage"));
  const usageText = usage
    ? [
        t("routines.usage.runs", { count: usage.runs }),
        usage.tokens !== null
          ? t("routines.usage.tokens", { tokens: formatTokensShort(t, i18n.language, usage.tokens) })
          : null,
        usage.costUsd !== null ? t("routines.usage.cost", { cost: formatUsd(i18n.language, usage.costUsd) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const namesComputer = useNamesComputers(org.id);
  const runsOn = whereItRuns(r.brain, namesComputer);
  const perDay = r.trigger.type === "schedule" ? runsPerDay(r.trigger.rule ?? null, r.trigger.cron) : 0;
  const busy = r.active ? busyOnComputer(r.brain, perDay, { selfHost, namesComputer }) : null;
  const list = runs.data ?? r.recentRuns;
  const creator = r.createdByUserId ? actors.name({ type: "person", id: r.createdByUserId }) : null;
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("routines.panel.close")}
      className="routine-details"
      size="lg"
      fill
      titleHidden
      eyebrow={
        <>
          {t("routines.panel.eyebrow")}
          <SavedNote shown={saved} label={t("common.saved")} className="issue-details__saved" />
        </>
      }
      title={title}
      // Esc in a text being edited in place saves it and stays: the dialog closes on the next Esc.
      onEscapeKeyDown={(e) => {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el.closest("[data-inplace]")) {
          e.preventDefault();
          el.blur();
        }
      }}
      actions={
        r.canManage && (
          <>
            {fix && fix !== "resume" && <FixButton routine={r} fix={fix} />}
            {outage && outages.data && (
              <Button size="sm" variant="primary" icon="computer" onClick={() => setSwitching(true)}>
                {t("outage.switch")}
              </Button>
            )}
            {(stoppable || !fired) &&
              !reminder &&
              (stoppable ? (
                <Button size="sm" icon="stop" disabled={action.isPending} onClick={controls.stop}>
                  {t(stopWordsKey(r))}
                </Button>
              ) : (
                <Button size="sm" icon="play" disabled={action.isPending} onClick={controls.run}>
                  {t("routines.runNow")}
                </Button>
              ))}
          </>
        )
      }
    >
      <div className="issue-details">
        <header className="issue-details__head">
          {creator && (
            <span className="small muted">
              {t("routines.panel.createdBy", { name: creator, date: formatShortDate(i18n.language, r.createdAt) })}
            </span>
          )}
          <RoutineName routine={r} onSaved={flashSaved} />
          <span className="routine-page__line">
            <AgentAvatar agentId={r.agentId} name={name} size="xs" running={isRunning(r)} />
            <b>{name}</b>
            <span className="routine-page__dot" aria-hidden="true">
              ·
            </span>
            {done ? <Chip icon="check">{t("routines.panel.state.done")}</Chip> : <RoutineStateChip routine={r} />}
            <span className="routine-page__dot" aria-hidden="true">
              ·
            </span>
            <span className="muted">{when(r)}</span>
          </span>
          <RoutineWeek routine={r} runs={list} now={now} />
        </header>
        <RoutineStrip routine={r} now={now} runsOn={runsOn} usageText={usageText} onSaved={flashSaved} />
        {r.state === "usage_paused" && <UsagePausedNote routine={r} />}
        {outage && outages.data && (
          <SwitchComputerDialog open={switching} onOpenChange={setSwitching} outage={outage} data={outages.data} />
        )}
        <Tabs
          value={tab}
          onValueChange={setTab}
          label={t("routines.panel.tabs.label")}
          items={[
            { value: "details", label: t("routines.panel.tabs.details") },
            { value: "runs", label: t("routines.panel.tabs.runs"), count: list.length || undefined },
          ]}
        >
          <TabPanel value="details">
            <DetailsSection title={t("routines.panel.what", agentGrammar(name))}>
              <RoutinePrompt routine={r} onSaved={flashSaved} />
            </DetailsSection>
            {r.canSeeDetails && (
              <DetailsSection title={t("routines.panel.ownActions")}>
                <OwnActions routine={r} />
              </DetailsSection>
            )}
            <DetailsSection title={t("routines.panel.nexts")}>
              {mailTrouble(r) && (
                <Chip icon="alert" tone="waiting">
                  {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
                </Chip>
              )}
              {r.trigger.type === "email" || r.trigger.type === "connector" ? (
                <p className="small muted">{t("mail.routine.every")}</p>
              ) : r.trigger.type === "webhook" ? (
                <p className="small muted">
                  {t("common.joinSentences", {
                    a: t("routines.webhook.every"),
                    b: t("routines.webhook.methodsLine", { methods: (r.trigger.methods ?? ["POST"]).join(", ") }),
                  })}
                </p>
              ) : r.trigger.type === "event" ? (
                <p className="small muted">{t("routines.panel.eventEvery")}</p>
              ) : (
                nexts.length > 0 &&
                !done && (
                  <div className="routine-details__nexts">
                    {nexts.map((iso) => (
                      <span key={iso}>{nextLabel(i18n.language, iso)}</span>
                    ))}
                  </div>
                )
              )}
              {busy && (
                <p className="routine-note small ac-iconline">
                  <Icon name="computer" size={14} />
                  <span>{say(busy)}</span>
                </p>
              )}
            </DetailsSection>
            {r.trigger.type === "event" && eventWebhook(r.trigger.event) && !done && (
              <DetailsSection title={t("routines.form.event")}>
                <EventWebhookSetup provider={eventWebhook(r.trigger.event) ?? "github"} />
              </DetailsSection>
            )}
            {r.trigger.type === "webhook" && (
              <DetailsSection title={t("routines.form.kind.webhook")}>
                {r.canManage ? (
                  <WebhookPanel routine={r} runs={list} />
                ) : (
                  <p className="small muted">{t("routines.webhook.hidden")}</p>
                )}
              </DetailsSection>
            )}
            {r.ahead && r.ahead.length > 0 && (
              <DetailsSection title={t("routines.panel.ahead")}>
                <ul className="routine-ahead">
                  {r.ahead.map((a) => (
                    <li key={a.id} className="routine-details__where routine-ahead__item">
                      <span className="routine-details__where-icon">
                        <Icon name={a.status === "approved" ? "calendar" : "waiting"} size={16} />
                      </span>
                      <span className="routine-ahead__text">
                        <Link
                          to="/org/$orgId/approvals"
                          params={{ orgId: org.id }}
                          search={{ open: a.id }}
                          className="routine-ahead__title ac-captop"
                        >
                          {approvalTitle(t, { ...a, email: null })}
                        </Link>
                        <small>
                          {t(a.status === "approved" ? "routines.ahead.approved" : "routines.ahead.pending", {
                            when: nextLabel(i18n.language, a.runAt),
                          })}
                        </small>
                      </span>
                      {a.canCancel && (
                        <span className="ac-acts ac-captop">
                          <CancelAhead id={a.id} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="small muted">{t("routines.ahead.hint")}</p>
              </DetailsSection>
            )}
          </TabPanel>
          <TabPanel value="runs">
            <DetailsSection title={t("routines.panel.runs")}>
              {runs.isLoading && list.length === 0 && <LoadingList count={3} avatar={false} />}
              {list.length > 0 && (
                <ol className="routine-runs">
                  {list.slice(0, 30).map((x) => (
                    <RunItem key={x.id} run={x} routine={r} />
                  ))}
                </ol>
              )}
              {runs.isSuccess && list.length === 0 && (
                <p className="small muted">
                  {t("routines.noRuns")}
                  {nexts[0] &&
                    !done &&
                    ` ${t("routines.panel.firstRun", { when: nextLabel(i18n.language, nexts[0]) })}`}
                </p>
              )}
            </DetailsSection>
          </TabPanel>
        </Tabs>
      </div>
    </DetailsDialog>
  );
}

/** The name, edited in place: Enter, Esc or leaving the field saves it (an empty one keeps the old name). */
function RoutineName({ routine: r, onSaved }: { routine: Routine; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(r.name);
  const name = sent.pending ?? r.name;
  const ref = useFocusAtEnd<HTMLInputElement>(draft !== null);
  const shown = (isWidgetRoutine(r) && r.widget?.title) || routineTitle({ name, prompt: r.prompt });
  if (!r.canManage || isWidgetRoutine(r)) return <h1 className="issue-details__title">{shown}</h1>;
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (!next || next === name) return;
    sent.send(next);
    action.mutate(
      { type: "update", id: r.id, patch: { name: next } },
      {
        onSuccess: onSaved,
        onError: (error) => {
          sent.clear();
          toast.show(errorText(t, error), "error");
        },
      },
    );
  };
  if (draft !== null)
    return (
      <input
        ref={ref}
        className="issue-inplace__title"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        aria-label={t("routines.panel.nameLabel")}
        data-inplace=""
      />
    );
  return (
    <EditInPlace label={t("routines.panel.editName")} onEdit={() => setDraft(name)}>
      <h1 className="issue-details__title">{shown}</h1>
    </EditInPlace>
  );
}

/**
 * What it does, edited in place in the task description's box: leaving it, Esc or ⌘↵ saves it (an empty one keeps
 * the old text); the agents it names that it can't call are said under the box. Who may see only its outcomes reads
 * that the details are hidden.
 */
function RoutinePrompt({ routine: r, onSaved }: { routine: Routine; onSaved: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useSent<string>(r.prompt ?? "");
  const prompt = sent.pending ?? r.prompt ?? "";
  const ref = useFocusAtEnd<HTMLTextAreaElement>(draft !== null);
  // As tall as its text where the engine can't size it from CSS (`field-sizing`, which the Mac app's WebKit lacks).
  useAutoGrow(ref, draft ?? "", draft !== null);
  if (!r.canSeeDetails || r.prompt === null) return <p className="small muted">{t("routines.detailsHidden")}</p>;
  if (isWidgetRoutine(r))
    return (
      <>
        <p className="routine-details__prompt">{prompt}</p>
        <p className="small muted">{t("routines.widgetFixed")}</p>
      </>
    );
  if (!r.canManage) return <p className="routine-details__prompt">{prompt}</p>;
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (!next || next === prompt.trim()) return;
    sent.send(next);
    action.mutate(
      { type: "update", id: r.id, patch: { prompt: next } },
      {
        onSuccess: onSaved,
        onError: (error) => {
          sent.clear();
          toast.show(errorText(t, error), "error");
        },
      },
    );
  };
  if (draft !== null)
    return (
      <>
        <div className="issue-new__editor" data-inplace="">
          <textarea
            ref={ref}
            className="issue-new__text routine-prompt__text"
            rows={8}
            value={draft}
            maxLength={10_000}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key !== "Escape" && !(e.key === "Enter" && (e.metaKey || e.ctrlKey))) return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
            placeholder={t("routines.form.whatPlaceholder")}
            aria-label={t("routines.form.what")}
          />
        </div>
        <p className="issue-new__hint small muted">{t("issues.edit.hint")}</p>
        <RoutineReachWarnings prompt={draft} agentId={r.agentId} creatorUserId={r.createdByUserId} />
      </>
    );
  return (
    <EditInPlace label={t("routines.panel.editWhat")} onEdit={() => setDraft(prompt)}>
      <p className="routine-details__prompt">{prompt}</p>
    </EditInPlace>
  );
}

/** At most this many of a day's runs in the week's pixels (an hourly routine would make a tower). */
const WEEK_CELLS = 4;

/**
 * This week in a well: how many runs went right ("12 de 14 OK esta semana") and what else happened, beside the last
 * seven days in pixels, one cell per run in its color (a few at most a day), today last.
 */
function RoutineWeek({ routine: r, runs, now }: { routine: Routine; runs: RoutineRun[]; now: Date }) {
  const { t, i18n } = useTranslation();
  const say = useSay();
  const words = useRunWords();
  const { color } = useLook()(r.agentId);
  const [first, ...rest] = healthWords(r.health) ?? [];
  const days = Array.from({ length: 7 }, (_, k) => {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + k);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const cells = runs.flatMap((x) => {
      const at = new Date(x.at);
      const status = at >= start && at < end ? runPixelStatus(x.status) : null;
      return status ? [status] : [];
    });
    return {
      key: toYmd(start),
      label: new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(start).replace(/\./g, ""),
      cells: cells.slice(0, WEEK_CELLS),
    };
  });
  return (
    <div className="routine-week">
      <span className="routine-week__text">
        <b>{first ? say(first) : t("routines.health.none")}</b>
        {rest.length > 0 && <span className="small muted">{rest.map(say).join(" · ")}</span>}
      </span>
      <span className="routine-week__days" role="img" aria-label={words.label(r)}>
        {days.map((d) => (
          <span key={d.key} className="routine-week__day">
            <span className="routine-week__cells">
              {d.cells.length > 0 ? (
                d.cells.map((status, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a day's runs in order, never reordered
                  <RunMark key={i} color={color} status={status} />
                ))
              ) : (
                <i className="routine-week__none" />
              )}
            </span>
            <small aria-hidden="true">{d.label}</small>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The routine's fields as one strip under its head, as a task's (`.ac-props`): "No ar", who does it, when (the creation
 * form's schedule and triggers, in a dialog of their own), where it delivers, when it posts and where it runs, each
 * changing at once and saying what it means in its tip. Under it, its next run and this week's use. Who can't change
 * it sees the same values, read only.
 */
function RoutineStrip({
  routine: r,
  now,
  runsOn,
  usageText,
  onSaved,
}: {
  routine: Routine;
  now: Date;
  runsOn: string | null;
  usageText: string | null;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const channels = useChannels(org.id);
  const controls = useRoutineControls(r);
  const targetLabel = useTargetLabel();
  const whereHint = useWhereHint();
  const when = useWhen();
  const nextText = useNextText();
  const [part, setPart] = useState<RoutinePart | null>(null);
  const manage = r.canManage;
  // A widget's routine is paused or resumed here; its agent, schedule and target change from its widget.
  const edits = manage && !isWidgetRoutine(r);
  const fired = hasFired(r);
  const agent = { type: "agent" as const, id: r.agentId };
  const update = (patch: RoutinePatch) =>
    controls.action.mutate(
      { type: "update", id: r.id, patch },
      { onSuccess: onSaved, onError: (error) => toast.show(errorText(t, error), "error") },
    );
  const hint = (kind: ReturnType<typeof whereHint>) => t(`routines.panel.whereHint.${kind}`);
  const agentOptions = [
    ...actors.dir.agents.map((a) => ({
      value: a.id,
      label: a.name,
      description: a.role || undefined,
      leading: actors.avatar({ type: "agent", id: a.id }, "sm"),
    })),
    ...(actors.dir.agentById.has(r.agentId)
      ? []
      : [{ value: r.agentId, label: actors.name(agent), description: undefined, leading: actors.avatar(agent, "sm") }]),
  ];
  const choice = targetChoice(r.target);
  const channelList = channels.data ?? [];
  const where = capitalize(targetLabel(r.target, r.widget?.title), i18n.language);
  const targetOptions = [
    ...(choice === TARGET_KEEP || (r.target.type === "channel" && !channelList.some((c) => c.id === choice))
      ? [{ value: choice, label: where }]
      : []),
    ...channelList.map((c) => ({ value: c.id, label: `#${c.name}` })),
    { value: TARGET_DM, label: t("routines.target.dm"), description: hint("dm") },
    { value: TARGET_ARTIFACT, label: t("routines.target.artifact"), description: hint("artifact") },
  ];
  const pickTarget = (v: string) => {
    if (v === choice || v === TARGET_KEEP) return;
    update({ target: targetInputOf(v) });
  };
  const reportLine = (v: RoutineReport) => t(`routines.panel.reportHint.${v}`);
  const role = actors.dir.agentById.get(r.agentId)?.role || undefined;
  const onAir = t(r.active ? "routines.panel.state.live" : "routines.panel.state.paused");
  const onAirLine = t(r.active ? "routines.panel.onAirLine" : "routines.panel.offAirLine");
  // A control's name and what it means ("Todo mundo do canal vê") in its tip, for the eye; a screen reader hears the
  // name as the control's and the meaning as its description.
  const tip = (label: string, meaning: string | undefined, control: ReactNode) => (
    <Tip
      tip={
        <>
          <b>{label}</b>
          {meaning && (
            <>
              <br />
              {meaning}
            </>
          )}
        </>
      }
      look="ac-hint__bubble ac-glass"
    >
      {control}
    </Tip>
  );
  // What nobody here may change: the value in the strip's field look, its name and meaning for a screen reader.
  const value = (label: string, lead: ReactNode, text: string, meaning?: string) =>
    tip(
      label,
      meaning,
      <span className="ac-props__value">
        {lead}
        <span className="ac-visually-hidden">{label}: </span>
        {text}
        {meaning && <span className="ac-visually-hidden">. {meaning}</span>}
      </span>,
    );
  // A control's meaning, as its description to a screen reader (the tip shows it to the eye).
  const meaningId = (part: string) => `rt-${part}-${r.id}`;
  const meaningOf = (part: string, meaning: string | undefined) =>
    meaning && (
      <span id={meaningId(part)} hidden>
        {meaning}
      </span>
    );
  const onAirId = `rt-onair-${r.id}`;
  return (
    <div className="routine-strip">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled row of controls that change at once, not a form's fieldset */}
      <div
        className="ac-props routine-props"
        role="group"
        aria-label={t("routines.panel.label", { name: routineTitle(r) })}
      >
        {!fired &&
          (manage
            ? tip(
                t("routines.panel.state.live"),
                onAirLine,
                // The word is the switch's label: a press on it toggles it.
                <label className="ac-props__switch" htmlFor={onAirId}>
                  <Switch
                    id={onAirId}
                    checked={r.active}
                    onCheckedChange={(on) => controls.setActive(on, onSaved)}
                    aria-label={t("routines.panel.state.live")}
                    aria-describedby={meaningId("onair-line")}
                  />
                  {onAir}
                  {meaningOf("onair-line", onAirLine)}
                </label>,
              )
            : tip(
                onAir,
                onAirLine,
                <span className="ac-props__value">
                  {onAir}
                  <span className="ac-visually-hidden">. {onAirLine}</span>
                </span>,
              ))}
        {edits
          ? tip(
              t("routines.panel.who"),
              role,
              <>
                <Select
                  size="sm"
                  aria-label={t("routines.panel.who")}
                  aria-describedby={role ? meaningId("who") : undefined}
                  value={r.agentId}
                  onValueChange={(v) => {
                    if (v !== r.agentId) update({ agentId: v });
                  }}
                  options={agentOptions}
                />
                {meaningOf("who", role)}
              </>,
            )
          : value(t("routines.panel.who"), actors.avatar(agent), actors.name(agent), role)}
        {edits
          ? tip(
              t("routines.panel.when"),
              undefined,
              <div className="ac-select ac-select--sm">
                <button
                  type="button"
                  className="ac-select__trigger"
                  aria-haspopup="dialog"
                  aria-label={`${t("routines.panel.when")}: ${when(r)}`}
                  onClick={() => setPart("when")}
                >
                  <span className="ac-select__value">
                    <span className="ac-select__text">{when(r)}</span>
                  </span>
                  <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m6 8 4 4 4-4" />
                  </svg>
                </button>
              </div>,
            )
          : value(t("routines.panel.when"), null, when(r))}
        {edits
          ? tip(
              t("routines.panel.where"),
              hint(whereHint(r.target)),
              <>
                <Select
                  size="sm"
                  aria-label={t("routines.panel.where")}
                  aria-describedby={meaningId("where")}
                  value={choice}
                  onValueChange={pickTarget}
                  options={targetOptions}
                />
                {meaningOf("where", hint(whereHint(r.target)))}
              </>,
            )
          : value(
              t("routines.panel.where"),
              null,
              targetOptions.find((o) => o.value === choice)?.label ?? where,
              hint(whereHint(r.target)),
            )}
        {/* A widget's update never posts, so what it reports doesn't apply (ADR 0135 §5). */}
        {!isWidgetRoutine(r) && (
          <span className="routine-props__report">
            {edits ? (
              <Select
                size="sm"
                aria-label={t("routines.panel.report")}
                aria-describedby={meaningId("report")}
                value={r.report}
                onValueChange={(v) => {
                  if (v !== r.report) update({ report: v as RoutineReport });
                }}
                options={(["always", "when_new"] as const).map((v) => ({
                  value: v,
                  label: t(`routines.report.${v}`),
                  description: reportLine(v),
                }))}
              />
            ) : (
              value(t("routines.panel.report"), null, t(`routines.report.${r.report}`), reportLine(r.report))
            )}
            {edits && meaningOf("report", reportLine(r.report))}
            <InfoHint name={t("common.about", { label: t("routines.panel.report") })}>
              {t("routines.report.hint")}
            </InfoHint>
          </span>
        )}
        {runsOn && value(t("routines.panel.runsOn"), <Icon name="computer" size={16} />, runsOn)}
        {r.widget && isWidgetRoutine(r) && (
          <Link
            to="/org/$orgId/dashboards/$dashboardId"
            params={{ orgId: org.id, dashboardId: r.widget.dashboardId }}
            search={{ widget: r.widget.id }}
            className="routine-runs__open"
          >
            {t("widgets.notice.openWidget")}
          </Link>
        )}
      </div>
      {(!isDoneOnce(r) || usageText) && (
        <p className="routine-props__line">
          {!isDoneOnce(r) && <span>{nextText(r, now)}</span>}
          {usageText && (
            <span>
              {t("routines.panel.usage")}: {usageText}
            </span>
          )}
        </p>
      )}
      {edits && part && <RoutineDialog open routine={r} part={part} onSaved={onSaved} onClose={() => setPart(null)} />}
    </div>
  );
}

const RUN_NODE_ICON: Record<RunStatus, IconName> = { ok: "check", silent: "dash", failed: "close", skipped: "pause" };

/**
 * One run: its outcome in plain words ("Contou o que achou", "Pulada: a anterior ainda estava rodando",
 * "Parada por Walter"), the agent's words when the viewer may read them, and where to go: the agent's
 * message ("Abrir na conversa") or the approval it waits for.
 */
function RunItem({ run: x, routine: r }: { run: RoutineRun; routine: Routine }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const say = useSay();
  const pixel = runPixelStatus(x.status);
  const outcome = say(runOutcome(x, (id) => actors.dir.memberById.get(id)?.name ?? null));
  const words = r.canSeeDetails && (x.status === "reported" || x.status === "silent") ? x.summary.trim() : "";
  return (
    <li className="routine-runs__item">
      <span className={`routine-runs__node routine-runs__node--${pixel ?? "running"}`}>
        <Icon name={pixel ? RUN_NODE_ICON[pixel] : isRunAtWork(x.status) ? "play" : "dash"} size={14} />
      </span>
      <div>
        {x.status === "waiting" && x.approvalId ? (
          <DetailsLink item={{ kind: "approval", id: x.approvalId }} className="routine-runs__link">
            {outcome}
          </DetailsLink>
        ) : (
          <b>{outcome}</b>
        )}
        {words && (
          <div className="routine-runs__words">
            <FoldedBody body={words} />
          </div>
        )}
        <RunChatLink run={x} />
      </div>
      <time dateTime={x.at}>{whenAt(t, i18n.language, x.at)}</time>
    </li>
  );
}

/** "Abrir na conversa": the agent's message a run left (its report), when it left one. */
function RunChatLink({ run }: { run: RoutineRun }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const link = runMessageLink(run);
  if (!link) return null;
  return link.threadId ? (
    <Link
      to="/org/$orgId/threads/$threadId"
      params={{ orgId: org.id, threadId: link.threadId }}
      className="routine-runs__open"
    >
      {t("routines.openInChat")}
    </Link>
  ) : (
    <Link
      to="/org/$orgId/c/$channelId"
      params={{ orgId: org.id, channelId: link.channelId }}
      search={{ m: link.messageId }}
      className="routine-runs__open"
    >
      {t("routines.openInChat")}
    </Link>
  );
}

/**
 * A webhook routine's address (ADR 0106), for who manages it: the address to copy and a new one (the old stops at
 * once), the signing secret (shown once, replaced or turned off), an example call, Testar, and the latest calls with
 * the run each went into.
 */
function WebhookPanel({ routine: r, runs }: { routine: Routine; runs: RoutineRun[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const hook = useRoutineHook(org.id, r.id);
  const action = useRoutineHookAction(org.id, r.id);
  const [secret, setSecret] = useState<string | null>(null);
  const [asking, setAsking] = useState<"address" | "secret" | "unsign" | null>(null);
  const data = hook.data;
  if (!data) {
    return hook.isError ? (
      <ErrorState error={hook.error} onRetry={() => void hook.refetch()} />
    ) : (
      <LoadingList count={1} avatar={false} />
    );
  }
  const busy = (what: "address" | "secret" | "unsign" | "test") => action.isPending && action.variables === what;
  const change = (what: "address" | "secret" | "unsign") =>
    action.mutate(what, {
      onSuccess: (done) => {
        setAsking(null);
        if (what === "address") toast.show(t("routines.webhook.replaced"));
        else setSecret(done.secret ?? null);
      },
    });
  return (
    <div className="routine-hook">
      <div className="routine-hook__part">
        <span className="ac-hintline">
          <span className="ac-field__label">{t("routines.webhook.address")}</span>
          <InfoHint name={t("common.about", { label: t("routines.webhook.address") })}>
            {t("routines.webhook.addressHelp")}
          </InfoHint>
        </span>
        <CommandBlock command={data.url} copied={t("routines.webhook.copied")} />
        {asking === "address" ? (
          <HookQuestion
            text={t("routines.webhook.replaceBody")}
            action={t("routines.webhook.replace")}
            loading={busy("address")}
            onCancel={() => setAsking(null)}
            onConfirm={() => change("address")}
          />
        ) : (
          <div className="routine-hook__actions">
            <Button type="button" size="sm" icon="refresh" onClick={() => setAsking("address")}>
              {t("routines.webhook.replace")}
            </Button>
          </div>
        )}
      </div>
      <div className="routine-hook__part">
        <span className="ac-hintline">
          <span className="ac-field__label">{t("routines.webhook.signature")}</span>
          <InfoHint name={t("common.about", { label: t("routines.webhook.signature") })}>
            {t("routines.webhook.signedHelp")}
          </InfoHint>
        </span>
        <p className="small">{t(data.signed ? "routines.webhook.signedOn" : "routines.webhook.signedOff")}</p>
        {secret && data.signed && (
          <>
            <p className="routine-note small ac-iconline" role="status">
              <Icon name="key" size={14} />
              <span>{t("routines.webhook.secretOnce")}</span>
            </p>
            <CommandBlock command={secret} copied={t("routines.webhook.secretCopied")} />
          </>
        )}
        {asking === "secret" || asking === "unsign" ? (
          <HookQuestion
            text={t(asking === "secret" ? "routines.webhook.newSecretBody" : "routines.webhook.removeSecretBody")}
            action={t(asking === "secret" ? "routines.webhook.newSecret" : "routines.webhook.removeSecret")}
            loading={busy(asking)}
            onCancel={() => setAsking(null)}
            onConfirm={() => change(asking)}
          />
        ) : (
          <div className="routine-hook__actions">
            <Button
              type="button"
              size="sm"
              icon="key"
              loading={busy("secret")}
              onClick={() => (data.signed ? setAsking("secret") : change("secret"))}
            >
              {t(data.signed ? "routines.webhook.newSecret" : "routines.webhook.addSecret")}
            </Button>
            {data.signed && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setAsking("unsign")}>
                {t("routines.webhook.removeSecret")}
              </Button>
            )}
          </div>
        )}
      </div>
      <HookMethods routine={r} methods={data.methods} />
      <div className="routine-hook__part">
        <span className="ac-field__label">{t("routines.webhook.example")}</span>
        <CommandBlock
          command={hookCurl(
            data.url,
            data.signed ? (secret ?? t("routines.webhook.secretPlaceholder")) : null,
            data.methods,
          )}
          copied={t("routines.webhook.exampleCopied")}
        />
        <div className="routine-hook__actions">
          <Button
            type="button"
            size="sm"
            icon="send"
            loading={busy("test")}
            onClick={() => action.mutate("test", { onSuccess: () => toast.show(t("routines.webhook.tested")) })}
          >
            {t("routines.webhook.test")}
          </Button>
        </div>
      </div>
      <div className="routine-hook__part">
        <span className="ac-field__label">{t("routines.webhook.calls")}</span>
        {data.calls.length === 0 ? (
          <p className="small muted">{t("routines.webhook.noCalls")}</p>
        ) : (
          <ol className="routine-runs" aria-label={t("routines.webhook.calls")}>
            {data.calls.map((c) => (
              <HookCallItem key={c.id} call={c} run={runs.find((x) => x.id === c.runId)} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * The HTTP methods the address answers (POST by default), one pill each; at least one stays on. GET passes its query
 * string as the run's data.
 */
function HookMethods({ routine: r, methods }: { routine: Routine; methods: RoutineHookMethod[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useRoutineAction(org.id);
  const toggle = (m: RoutineHookMethod, on: boolean) => {
    const next = ROUTINE_HOOK_METHODS.filter((x) => (x === m ? on : methods.includes(x)));
    if (next.length === 0) return;
    // Its address's view (under the routines' key) is read again once it's saved.
    save.mutate({ type: "update", id: r.id, patch: { trigger: { type: "webhook", methods: next } } });
  };
  return (
    <div className="routine-hook__part">
      <span className="ac-hintline">
        <span className="ac-field__label">{t("routines.webhook.methods")}</span>
        <InfoHint name={t("common.about", { label: t("routines.webhook.methods") })}>
          {t("routines.webhook.methodsHelp")}
        </InfoHint>
      </span>
      <div className="routine-hook__methods">
        {ROUTINE_HOOK_METHODS.map((m) => (
          <CheckboxPill
            key={m}
            id={`hook-method-${r.id}-${m}`}
            checked={methods.includes(m)}
            disabled={save.isPending || (methods.length === 1 && methods.includes(m))}
            onCheckedChange={(on) => toggle(m, on)}
          >
            {m}
          </CheckboxPill>
        ))}
      </div>
    </div>
  );
}

/** A change that breaks the services calling the address, asked in place of its buttons: what stops working. */
function HookQuestion(props: {
  text: string;
  action: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="routine-hook__confirm" role="alert">
      <p className="small">{props.text}</p>
      <div className="routine-hook__actions">
        <Button type="button" size="sm" onClick={props.onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" variant="danger" loading={props.loading} onClick={props.onConfirm}>
          {props.action}
        </Button>
      </div>
    </div>
  );
}

/** One call: how it ended, its size, Teste when Testar sent it, and the agent's message of the run it went into. */
function HookCallItem({ call: c, run }: { call: RoutineHookCall; run: RoutineRun | undefined }) {
  const { t, i18n } = useTranslation();
  const refused = isRefusedHookCall(c.outcome);
  return (
    <li className="routine-runs__item">
      <span className={`routine-runs__node routine-runs__node--${refused ? "failed" : "ok"}`}>
        <Icon name={refused ? "close" : "check"} size={14} />
      </span>
      <span>
        <b>
          {[
            t(`routines.webhook.outcome.${c.outcome}`),
            ...(c.bytes > 0 ? [formatBytes(i18n.language, c.bytes)] : []),
            ...(c.test ? [t("routines.webhook.callTest")] : []),
          ].join(" · ")}
        </b>
        {run && <RunChatLink run={run} />}
      </span>
      <time dateTime={c.at}>{whenAt(t, i18n.language, c.at)}</time>
    </li>
  );
}

const TARGET_DM = "dm";
const TARGET_ARTIFACT = "artifact";
/** Editing a routine made in the chat (a thread or DM): keep where it delivers. */
const TARGET_KEEP = "keep";
/** A part of a routine its page's aside opens in the form: when it runs, or where it delivers. */
type RoutinePart = "when" | "where";
const PART_FIELDS: Record<RoutinePart, (keyof RoutinePatch)[]> = { when: ["trigger"], where: ["target"] };

/** Where a routine delivers, as the form's select value. */
function targetChoice(target: RoutineTarget | undefined): string {
  if (!target) return "";
  if (target.type === "channel") return target.channelId;
  if (target.type === "dm") return TARGET_DM;
  if (target.type === "artifact") return TARGET_ARTIFACT;
  return TARGET_KEEP;
}

/** A target picked from the form's or the aside's select (a channel by its id). */
const targetInputOf = (v: string): RoutineTargetInput =>
  v === TARGET_DM ? { type: "dm" } : v === TARGET_ARTIFACT ? { type: "artifact" } : { type: "channel", channelId: v };

/** The phrase the routine was written with, as the person wrote it (made with the picker, or new: none). */
const phraseOf = (r: Routine | undefined) => (r?.trigger.type === "schedule" ? (r.trigger.phrase ?? "") : "");

/** The rule a routine runs on, in `zone` (new, or an old cron-only routine: Mondays at 09:00). */
function ruleOf(r: Routine | undefined, zone: string): RecurrenceRule {
  const base = defaultRule(zone);
  if (r?.trigger.type === "once") return onceRule(r.trigger.at, zone);
  if (r?.trigger.type === "schedule" && r.trigger.rule)
    return { ...fromApiRule(r.trigger.rule, base.start), timezone: zone };
  if (r?.trigger.type === "schedule") return base;
  const { timezone, start } = base;
  return {
    freq: "weekly",
    interval: 1,
    byWeekday: ["MO"],
    times: ["09:00"],
    timezone,
    start,
    until: null,
    count: null,
  };
}
const zoneOf = (r: Routine | undefined) =>
  r && (r.trigger.type === "schedule" || r.trigger.type === "once") ? r.trigger.timezone || "UTC" : "";

/** The email trigger a routine has (new, or another kind: none picked yet, the inbox). */
const emailDraftOf = (r: Routine | undefined): EmailTriggerDraft =>
  r?.trigger.type === "email"
    ? { accountId: r.trigger.accountId, folder: r.trigger.folder, filter: r.trigger.filter ?? {} }
    : { accountId: "", folder: "", filter: {} };
const isUtc = (z: string) => z === "UTC" || z === "Etc/UTC";

/**
 * "Nova rotina", and one part of a routine opened from its page's aside ("Quando": the trigger and the schedule;
 * "Onde entrega": the target). A part starts from the routine and saves only what
 * changed in it; a routine still read in UTC (made before time zones) starts in my zone, with a hint to keep UTC.
 */
function RoutineDialog({
  open,
  onClose,
  routine,
  part,
  onSaved,
  onWebhook,
}: {
  open: boolean;
  onClose: () => void;
  routine?: Routine;
  /** With `routine`: only this part of the form. */
  part?: RoutinePart;
  /** A part was saved. */
  onSaved?: () => void;
  /** It just became a webhook routine (made, or switched to one): its address is on its page, which opens. */
  onWebhook?: (routine: Routine) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const channels = useChannels(org.id);
  const targetLabel = useTargetLabel();
  const action = useRoutineAction(org.id);
  const agents = actors.dir.agents;
  const editing = Boolean(routine);
  const shows = (p: RoutinePart) => !part || part === p;
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "America/Sao_Paulo";
  const savedZone = zoneOf(routine);
  const wasUtc = editing && routine !== undefined && !isEventDriven(routine) && isUtc(savedZone);
  const [agentId, setAgentId] = useState(routine?.agentId ?? "");
  const [target, setTarget] = useState(targetChoice(routine?.target));
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  // The starting point picked, and one waiting for the person's ok to write over their words.
  const [template, setTemplate] = useState<RoutineTemplateOption>();
  const [replacing, setReplacing] = useState<RoutineTemplateOption>();
  const [kind, setKind] = useState<"schedule" | "event" | "email" | "webhook" | "connector">(
    routine?.trigger.type === "event" ||
      routine?.trigger.type === "email" ||
      routine?.trigger.type === "webhook" ||
      routine?.trigger.type === "connector"
      ? routine.trigger.type
      : "schedule",
  );
  // "Email no MillionSend" (ADR 0130): shown where the workspace connected MillionSend (or the routine uses it).
  const [connector, setConnector] = useState<ConnectorTriggerDraft>(() =>
    routine?.trigger.type === "connector"
      ? { connectionId: routine.trigger.connectionId, filter: routine.trigger.filter }
      : { connectionId: "", filter: {} },
  );
  const eventConnections = useEmailEventConnections(org.id);
  const hasMillionSend = kind === "connector" || eventConnections.length > 0;
  // "Quando chegar um email": the mailbox, folder and filters.
  const [email, setEmail] = useState<EmailTriggerDraft>(() => emailDraftOf(routine));
  const mailboxes = useMailAccounts(org.id);
  // "Quando chegar um email" shows where the organization has mailboxes (or the routine already uses one).
  const hasMail = kind === "email" || (mailboxes.data?.length ?? 0) > 0;
  // What the person typed, in any language: the server reads it (never the browser) and fills the picker.
  const [phrase, setPhrase] = useState(phraseOf(routine));
  const [event, setEvent] = useState<RoutineEvent>(
    routine?.trigger.type === "event" ? routine.trigger.event : "sentry.issue_created",
  );
  // When it posts.
  const [report, setReport] = useState<RoutineReport>(routine?.report ?? "when_new");
  const say = useSay();
  const [touched, setTouched] = useState(false);
  // One source of truth for "when": the rule (the picker), with the phrase kept in step.
  const [rule, setRule] = useState<RecurrenceRule>(() => ruleOf(routine, wasUtc ? myZone : savedZone || myZone));
  // What the routine had, to tell whether "when" changed.
  const [savedRule] = useState(() => JSON.stringify(toApiRule(ruleOf(routine, savedZone || myZone))));
  const zone = rule.timezone;
  // My zone may arrive after the form opens (the people list loads): follow it until a zone is picked.
  const [zoneTouched, setZoneTouched] = useState(false);
  const setZone = (z: string) => {
    setZoneTouched(true);
    setRule((r) => ({ ...r, timezone: z }));
  };
  const followsMyZone = !routine || wasUtc;
  useEffect(() => {
    if (followsMyZone && !zoneTouched) setRule((r) => (r.timezone === myZone ? r : { ...r, timezone: myZone }));
  }, [myZone, followsMyZone, zoneTouched]);
  // The phrase was typed (its parse fills the picker); picking in the picker clears it.
  const [phraseTyped, setPhraseTyped] = useState(false);
  const pickRule = (next: RecurrenceRule) => {
    setRule(next);
    setPhrase("");
    setPhraseTyped(false);
  };
  const typePhrase = (text: string) => {
    setPhrase(text);
    setPhraseTyped(true);
  };
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);
  useEffect(() => {
    if (!target && channels.data?.[0]) setTarget(channels.data[0].id);
  }, [target, channels.data]);
  const typed = useDeferredValue(phrase.trim());
  const once = rule.freq === "once";
  const parsed = useRuleParse(org.id, typed, open && kind === "schedule" && phraseTyped && typed.length > 0, zone);
  // A phrase the server understood fills the picker (one source of truth: the rule).
  const parsedRule = parsed.data?.ok ? parsed.data.rule : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply each new parse once
  useEffect(() => {
    if (parsedRule && phraseTyped) setRule((r) => ({ ...fromApiRule(parsedRule, r.start), timezone: r.timezone }));
  }, [parsedRule]);
  const apiRule = kind === "schedule" && !once ? toApiRule(rule) : null;
  const described = useRuleDescribe(org.id, open ? apiRule : null);
  const info = described.data?.ok ? described.data : null;
  // The picker opens on demand ("Ajustar"); the sentence and next runs always show.
  const [pickerOpen, setPickerOpen] = useState(false);
  const unsaved = useEdited(open, [prompt, name, phrase]);
  const upcoming = info?.nextRuns.length
    ? info.nextRuns.slice(0, 3).map((iso) => runLabel(i18n.language, iso, rule.timezone))
    : upcomingLabels(i18n.language, rule);
  const phraseFailed = phraseTyped && typed.length > 0 && parsed.data?.ok === false;
  const shownZone = zone;
  const scheduleOk =
    kind === "event" ||
    kind === "webhook" ||
    (kind === "connector"
      ? Boolean(connector.connectionId)
      : kind === "email"
        ? Boolean(email.accountId)
        : once || !phraseFailed);
  const targetValue = (): RoutineTargetInput =>
    target === TARGET_DM
      ? { type: "dm" }
      : target === TARGET_ARTIFACT
        ? { type: "artifact" }
        : { type: "channel", channelId: target };
  const emailTrigger = () => ({
    type: "email" as const,
    accountId: email.accountId,
    folder: email.folder || INBOX,
    filter: cleanFilter(email.filter),
  });
  const connectorTrigger = () => ({
    type: "connector" as const,
    connectionId: connector.connectionId,
    event: MILLIONSEND_EMAIL,
    inboxId: null,
    filter: cleanConnectorFilter(connector.filter),
  });
  const trigger = (): RoutineInput["trigger"] =>
    kind === "connector"
      ? connectorTrigger()
      : kind === "webhook"
        ? { type: "webhook" }
        : kind === "email"
          ? emailTrigger()
          : kind === "event"
            ? { type: "event", event }
            : once
              ? {
                  type: "once",
                  at: zonedInstant(rule.start, rule.times[0] ?? "09:00", rule.timezone).toISOString(),
                  timezone: rule.timezone,
                }
              : { type: "schedule", rule: toApiRule(rule) };
  /** What changed against the routine (`PATCH` sends only this). */
  const changes = (r: Routine): RoutinePatch => {
    const patch: RoutinePatch = {};
    if (name.trim() && name.trim() !== r.name) patch.name = name.trim();
    if (r.prompt !== null && prompt.trim() !== r.prompt) patch.prompt = prompt.trim();
    if (agentId !== r.agentId) patch.agentId = agentId;
    if (target !== TARGET_KEEP && target !== targetChoice(r.target)) patch.target = targetValue();
    const triggerChanged =
      kind === "connector"
        ? r.trigger.type !== "connector" ||
          JSON.stringify(connectorTrigger()) !==
            JSON.stringify({
              type: "connector",
              connectionId: r.trigger.connectionId,
              event: r.trigger.event,
              inboxId: null,
              filter: cleanConnectorFilter(r.trigger.filter),
            })
        : kind === "webhook"
          ? r.trigger.type !== "webhook"
          : kind === "email"
            ? r.trigger.type !== "email" ||
              JSON.stringify(emailTrigger()) !==
                JSON.stringify({
                  type: "email",
                  accountId: r.trigger.accountId,
                  folder: r.trigger.folder,
                  filter: cleanFilter(r.trigger.filter ?? {}),
                })
            : kind === "event"
              ? r.trigger.type !== "event" || r.trigger.event !== event
              : once
                ? r.trigger.type !== "once" ||
                  JSON.stringify(trigger()) !== JSON.stringify({ type: "once", at: r.trigger.at, timezone: savedZone })
                : r.trigger.type !== "schedule" || JSON.stringify(toApiRule(rule)) !== savedRule;
    if (triggerChanged) patch.trigger = trigger();
    if (report !== r.report) patch.report = report;
    return patch;
  };
  // A routine on someone's computer that runs hourly or more often: say how often it wakes that computer.
  const brain = actors.dir.agentById.get(agentId)?.brain;
  const selfHost = useComputerEdition(org.id) === "selfhost";
  const namesComputer = useNamesComputers(org.id);
  const busy =
    kind === "schedule" && !once && brain
      ? busyOnComputer({ kind: brain.kind, machineName: brain.computer ?? null }, runsPerDay(toApiRule(rule)), {
          selfHost,
          namesComputer,
        })
      : null;
  // Only a phrase that wasn't understood says something here; the sentence above already says what was.
  const phraseError = () => {
    if (phraseFailed && parsed.data && !parsed.data.ok) {
      const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
      const code = parsed.data.code;
      return code
        ? tt(`routines.form.parseError.${code.replace(/\./g, "_")}`, { defaultValue: parsed.data.error })
        : parsed.data.error;
    }
    return undefined;
  };
  /** A starting point fills the form; everything in it stays the person's to change. */
  const applyTemplate = (o: RoutineTemplateOption) => {
    setTemplate(o);
    setPrompt(o.prompt);
    setName(o.label);
    setReport(o.report);
    setKind(o.template.kind);
    if (o.template.kind === "event") setEvent(o.template.event);
    if (o.template.kind === "schedule") pickRule(templateRule(o.template, rule));
  };
  const unfilled = blankLeft(prompt, template);
  const becameWebhook = (saved: Routine | undefined) => {
    if (saved?.trigger.type === "webhook") onWebhook?.(saved);
  };
  const submit = () => {
    setTouched(true);
    if ((!part && !prompt.trim()) || unfilled || !agentId || !scheduleOk) return;
    if (routine) {
      const all = changes(routine);
      // A part sends only its own fields (a prompt stored with spaces around it is not a change of "Quando").
      const patch: RoutinePatch = part
        ? Object.fromEntries(Object.entries(all).filter(([k]) => PART_FIELDS[part].includes(k as keyof RoutinePatch)))
        : all;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      action.mutate(
        { type: "update", id: routine.id, patch },
        {
          onSuccess: (saved) => {
            const next = (saved as Routine | undefined)?.nextRunAt;
            toast.show(
              next
                ? t("routines.form.saved", { next: t("routines.next", { when: nextLabel(i18n.language, next) }) })
                : t("routines.form.savedNoNext"),
            );
            onSaved?.();
            onClose();
            if (routine.trigger.type !== "webhook") becameWebhook(saved as Routine);
          },
        },
      );
      return;
    }
    action.mutate(
      {
        type: "create",
        input: {
          name: name.trim() || undefined,
          agentId,
          prompt: prompt.trim(),
          target: targetValue(),
          trigger: trigger(),
          report,
        },
      },
      {
        onSuccess: (created) => {
          toast.show(t("routines.form.created"));
          setTemplate(undefined);
          setPrompt("");
          setName("");
          setTouched(false);
          onClose();
          becameWebhook(created as Routine);
        },
      },
    );
  };
  const targetField = (
    <Field label={t("routines.form.target")} id="nr-target">
      <Select
        value={target || undefined}
        onValueChange={setTarget}
        options={[
          ...(routine && target === TARGET_KEEP ? [{ value: TARGET_KEEP, label: targetLabel(routine.target) }] : []),
          ...(channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` })),
          { value: TARGET_DM, label: t("routines.target.dm") },
          { value: TARGET_ARTIFACT, label: t("routines.target.artifact") },
        ]}
      />
    </Field>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={part ? t(part === "when" ? "routines.panel.when" : "routines.panel.where") : t("routines.new")}
      closeLabel={t("common.close")}
      unsaved={unsaved}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            {!part && agents.length === 0 && <p className="small muted">{t("routines.form.noAgents")}</p>}
            {!editing && (
              <RoutineTemplateSelect
                value={template?.value}
                onPick={(o) => (ownWords(prompt, template) ? setReplacing(o) : applyTemplate(o))}
              />
            )}
            {!part ? (
              <div className="grid-fields">
                <Field label={t("routines.form.agent")} id="nr-agent">
                  <Select
                    value={agentId || undefined}
                    onValueChange={setAgentId}
                    options={agents.map((a) => ({
                      value: a.id,
                      label: a.name,
                      description: a.role || undefined,
                      leading: actors.avatar({ type: "agent", id: a.id }, "sm"),
                    }))}
                  />
                </Field>
                {targetField}
              </div>
            ) : (
              part === "where" && targetField
            )}
            {!part && (
              <>
                <Field
                  label={t("routines.form.what")}
                  id="nr-what"
                  error={
                    !touched
                      ? undefined
                      : !prompt.trim()
                        ? t("routines.form.required")
                        : unfilled
                          ? t("routines.presets.fillBlank")
                          : undefined
                  }
                >
                  <Textarea
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={t("routines.form.whatPlaceholder")}
                  />
                </Field>
                <Field label={t("routines.form.name")} id="nr-name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </>
            )}
            {shows("when") && (
              <>
                <Field label={t("routines.form.when")} group>
                  <Segmented
                    label={t("routines.form.when")}
                    value={kind}
                    onValueChange={setKind}
                    options={[
                      { value: "schedule" as const, label: t("routines.form.kind.schedule") },
                      { value: "event" as const, label: t("routines.form.kind.event") },
                      ...(hasMail ? [{ value: "email" as const, label: t("routines.form.kind.email") }] : []),
                      ...(hasMillionSend
                        ? [{ value: "connector" as const, label: t("routines.form.kind.connector") }]
                        : []),
                      { value: "webhook" as const, label: t("routines.form.kind.webhook") },
                    ]}
                  />
                </Field>
                {kind === "email" && <EmailTriggerFields value={email} onChange={setEmail} agentId={agentId} />}
                {kind === "connector" && (
                  <ConnectorTriggerFields value={connector} onChange={setConnector} agentId={agentId} />
                )}
                {kind === "webhook" &&
                  (routine?.trigger.type === "webhook" ? (
                    <WebhookPanel routine={routine} runs={routine.recentRuns} />
                  ) : (
                    <p className="routine-note small ac-iconline">
                      <Icon name="link" size={14} />
                      <span>{t("routines.webhook.newNote")}</span>
                    </p>
                  ))}
                {kind === "schedule" && (
                  <div className="routine-when">
                    <div className="routine-when__head">
                      <span className="routine-when__sentence" aria-live="polite">
                        {ruleSentence(t, i18n.language, rule, new Date(), false)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        icon="repeat"
                        aria-expanded={pickerOpen}
                        onClick={() => setPickerOpen((o) => !o)}
                      >
                        {t("routines.form.adjust")}
                      </Button>
                    </div>
                    {!pickerOpen && upcoming.length > 0 && (
                      <div className="ac-recur__upcoming">
                        <span className="ac-recur__label">{t("routines.form.next")}</span>
                        <ol>
                          {upcoming.map((label) => (
                            <li key={label} className="tabular">
                              {label}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {pickerOpen && (
                      <RecurrencePicker
                        value={rule}
                        onChange={pickRule}
                        labels={recurrenceLabels(t, i18n.language, rule)}
                        locale={i18n.language}
                        upcoming={upcoming}
                        hideTimezone
                      />
                    )}
                  </div>
                )}
                {kind === "schedule" && (
                  <>
                    {!once && (
                      <Field label={t("routines.form.frequency")} id="nr-when" error={phraseError()}>
                        <Input
                          value={phrase}
                          onChange={(e) => typePhrase(e.target.value)}
                          placeholder={t("recurrence.phrasePlaceholder")}
                        />
                      </Field>
                    )}
                    <Field label={t("routines.form.timezone")} id="nr-zone">
                      <ZoneSelect value={zone} onChange={setZone} />
                    </Field>
                  </>
                )}
                {kind === "schedule" && wasUtc && !isUtc(shownZone) && (
                  <p className="routine-utc-hint small ac-iconline">
                    <Icon name="waiting" size={14} />
                    <span>{t("routines.form.utcHint", { zone: timezoneName(shownZone, i18n.language) })}</span>
                    <button type="button" className="ac-link" onClick={() => setZone("UTC")}>
                      {t("routines.form.keepUtc")}
                    </button>
                  </p>
                )}
                {kind !== "event" ? null : (
                  <Field
                    label={t("routines.form.event")}
                    id="nr-event"
                    hint={{
                      name: t("common.about", { label: t("routines.form.event") }),
                      text: t("routines.form.eventHelp", { org: org.name }),
                    }}
                  >
                    <Select
                      value={event}
                      onValueChange={(v) => setEvent(v as RoutineEvent)}
                      options={ROUTINE_EVENTS.map((e) => ({ value: e, label: t(`routines.event.${e}`) }))}
                    />
                  </Field>
                )}
                {kind === "event" && eventWebhook(event) && (
                  <EventWebhookSetup provider={eventWebhook(event) ?? "github"} />
                )}
                {busy && (
                  <p className="routine-note small ac-iconline" role="status">
                    <Icon name="computer" size={14} />
                    <span>{say(busy)}</span>
                  </p>
                )}
              </>
            )}
            {!part && (
              <>
                <Field
                  label={t("routines.form.report")}
                  group
                  hint={{
                    name: t("common.about", { label: t("routines.form.report") }),
                    text: t("routines.report.hint"),
                  }}
                >
                  <Segmented
                    label={t("routines.form.report")}
                    value={report}
                    onValueChange={setReport}
                    options={(["always", "when_new"] as const).map((v) => ({
                      value: v,
                      label: t(`routines.report.${v}`),
                    }))}
                  />
                </Field>
                <div className="ac-field">
                  <span className="ac-field__label">{t("routines.panel.ownActions")}</span>
                  <OwnActions routine={routine} />
                </div>
                <RoutineReachWarnings
                  prompt={prompt}
                  agentId={agentId || null}
                  creatorUserId={routine?.createdByUserId}
                />
              </>
            )}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("routines.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!agentId || !scheduleOk} loading={action.isPending}>
            {editing ? t("routines.form.save") : t("routines.form.create")}
          </Button>
        </DialogFooter>
      </form>
      <Dialog
        open={replacing !== undefined}
        onOpenChange={(o) => !o && setReplacing(undefined)}
        title={t("routines.presets.replaceTitle")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setReplacing(undefined)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (replacing) applyTemplate(replacing);
              setReplacing(undefined);
            }}
          >
            {t("routines.presets.replaceConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Dialog>
  );
}

/** What a routine does in connected apps without asking (the job its creator set it up for), or that it asks for each. */
function OwnActions({ routine }: { routine: Routine | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useRoutineAction(org.id);
  const own = routine?.ownActions ?? [];
  if (own.length === 0) return <p className="small muted">{t("routines.ownActions.none")}</p>;
  return (
    <>
      <ul className="routine-own" aria-label={t("routines.panel.ownActions")}>
        {own.map((name) => (
          <li key={name} title={name}>
            {ownActionName(t, name)}
            {routine?.canManage && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t("routines.ownActions.remove", { action: ownActionName(t, name) })}
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({
                    type: "update",
                    id: routine.id,
                    patch: { ownActions: own.filter((a) => a !== name) },
                  })
                }
              />
            )}
          </li>
        ))}
      </ul>
      <p className="small muted">{t("routines.ownActions.hint")}</p>
    </>
  );
}

/** A one-off routine's moment as a rule ("Uma vez", that day and time in its zone). */
function onceRule(at: string, timezone: string): RecurrenceRule {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    freq: "once",
    interval: 1,
    times: [`${get("hour")}:${get("minute")}`],
    timezone,
    start: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** A next run ("seg, 20 out · 09:00") in the rule's zone. */
function runLabel(locale: string, iso: string, timeZone: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");
  const time = new Intl.DateTimeFormat(locale, {
    hour: clockHour(locale),
    minute: "2-digit",
    timeZone,
  }).format(d);
  return `${date} · ${time}`;
}
