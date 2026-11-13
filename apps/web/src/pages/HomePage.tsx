import type { Agent, AppNotification, Mission, Routine } from "@agenteschat/client";
import {
  useAiStatus,
  useChannels,
  useDms,
  useMissionList,
  useNotificationAction,
  useNotifications,
  useRoutines,
  useSendDm,
  useSetStart,
  useWorkingRuns,
} from "@agenteschat/client";
import { canTalk, listsAgent } from "@agenteschat/client/lib/audience";
import { firstName, relativeTime, timeLeft, upcomingAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  HOME_ROWS,
  homeDone,
  homeMentions,
  homeWaiting,
  homeWidgetFailures,
  upcomingRoutines,
} from "@agenteschat/client/lib/home";
import { latestText } from "@agenteschat/client/lib/message-body";
import { waitingParts, waitingText } from "@agenteschat/client/lib/missions";
import { allItems, waitingCardOf, widgetNoticeOf } from "@agenteschat/client/lib/notifications";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayPart } from "@agenteschat/client/lib/welcome";
import { WORKING_POLL_MS, type WorkItem, workByAgent, workingNow } from "@agenteschat/client/lib/working";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Composer, EmptyState, GroupHeading, Icon, PageHeader, Select } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useFirstRun } from "@/components/FirstRun";
import { useMissionsWaitingYou } from "@/components/missions/MissionWaiting";
import { useNotificationOpener } from "@/components/NotificationOpen";
import { Face, Headline, SystemFace } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { HomeMural } from "@/components/widgets/HomeMural";
import { WidgetNoticeActions, widgetNoticeLine } from "@/components/widgets/WidgetNotice";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { agentLine, useAgentPresence } from "@/hooks/usePresence";
import { TYPED_VALUES } from "@/i18n";
import { lookOf } from "@/lib/look";
import "./home.css";
// Its "Para você" draws the inbox's rows (Face, SystemFace, the calm card).
import "./notifications.css";

/*
 * Início (ADR 0108): what waits on me, what my agents are doing, what got done and what comes next, from the lists
 * the inbox, Threads and Rotinas already read. A section shows only with something in it; a new workspace starts
 * with its first steps.
 */

type Dir = ReturnType<typeof useDirectory>;

export function HomePage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const now = useNow(60_000);
  const waitingList = useNotifications(org.id, "waiting");
  const inbox = useNotifications(org.id, "all");
  const { list: missionList, missions: mine } = useMissionsWaitingYou();
  const runs = useWorkingRuns(org.id, true, WORKING_POLL_MS);
  const active = useMissionList(org.id, { status: "active" });
  const routines = useRoutines(org.id);
  const dms = useDms(org.id);
  const composer = useRef<HTMLTextAreaElement>(null);

  const listed = (id: string) => listsAgent(org, dir.agentById.get(id));
  const waiting = homeWaiting(allItems(waitingList.data), now);
  // My widgets that stopped updating wait on me too (ADR 0135), with Resolve.
  const failures = homeWidgetFailures(allItems(inbox.data), now);
  const missions = mine.filter((m) => waitingParts(m).length > 0);
  const mentions = homeMentions(allItems(inbox.data), now);
  const done = homeDone(allItems(inbox.data), now);
  // A run stopped on my ok or my answer waits on me: it is in "Esperando você", not working.
  const working = workByAgent(
    workingNow(runs.data, active.data?.missions).filter((w) => !w.waiting && listed(w.agentId)),
  );
  // Being deleted, its routines' slots pass: none is ahead (the server says so too, once the list is read again).
  const upcoming = org.deletion ? [] : upcomingRoutines(routines.data ?? [], now);
  const waitingCount = waiting.length + failures.length + missions.length + mentions.length;

  // Who I may ask, the one I talked to last first.
  const lastTalk = new Map((dms.data ?? []).map((d) => [d.with.id, d.lastMessage?.createdAt ?? ""]));
  const askable = dir.agents
    .filter((a) => listsAgent(org, a) && canTalk(a))
    .sort((a, b) => (lastTalk.get(b.id) ?? "").localeCompare(lastTalk.get(a.id) ?? ""));

  // The right hand's first-run checklist (ADR 0155 §6), while a row is left: one line back to it, never a second list.
  const lodi = dir.agents.find(isRightHand);
  const firstRun = useFirstRun(lodi);
  const showSteps = firstRun.ready && firstRun.state === "open";
  const loaded = waitingList.isSuccess && inbox.isSuccess && missionList.isSuccess && !runs.isLoading;
  const calm = loaded && !showSteps && waitingCount === 0 && working.length === 0 && done.length === 0;

  const summary =
    waitingCount === 0 && working.length === 0
      ? t(showSteps ? modeKey(org, "home.summary.new") : "home.summary.calm")
      : [
          waitingCount > 0 ? t("home.summary.waiting", { count: waitingCount }) : "",
          working.length > 0 ? t("sky.working", { count: working.length }) : "",
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="page page--list home">
      <PageHeader
        title={t(`home.greeting.${dayPart(new Date(now).getHours())}`, { name: firstName(me.user.name) })}
        meta={loaded && summary}
        actions={<StartChoice />}
      />

      {showSteps && lodi && (
        <Link
          className="home-continue ac-mediarow ac-mediarow--row"
          to="/org/$orgId/dm/agent/$agentId"
          params={{ orgId: org.id, agentId: lodi.id }}
        >
          <span className="ac-mediarow__face">
            <AgentAvatar agentId={lodi.id} name={lodi.name} size="sm" />
          </span>
          <span className="ac-mediarow__head">
            {t("home.firstRun", {
              done: firstRun.steps.filter((s) => firstRun.done.has(s)).length,
              total: firstRun.steps.length,
            })}
          </span>
          <span className="ac-mediarow__end">
            <Icon name="chevronRight" size={16} />
          </span>
        </Link>
      )}

      {/* Being deleted, the workspace takes no message: the line on top says why. */}
      {askable.length > 0 && !org.deletion && <AskAgent agents={askable} composer={composer} />}

      <HomeMural
        orgId={org.id}
        waiting={{
          title: t("home.waiting.title"),
          count: waitingCount,
          action:
            waitingCount > HOME_ROWS ? (
              <Link className="home-sec__more" to="/org/$orgId/notifications" params={{ orgId: org.id }}>
                {t("home.seeAll")}
              </Link>
            ) : null,
          body:
            waitingCount > 0 ? (
              <ul className="home-list">
                {[
                  ...waiting.map((n) =>
                    widgetNoticeOf(n) ? (
                      <WidgetNoticeRow key={n.id} n={n} dir={dir} now={now} />
                    ) : (
                      <InboxRow key={n.id} n={n} dir={dir} now={now} />
                    ),
                  ),
                  ...failures.map((n) => <WidgetNoticeRow key={n.id} n={n} dir={dir} now={now} />),
                  ...missions.map((m) => <MissionRow key={m.id} m={m} dir={dir} />),
                  ...mentions.map((n) => <InboxRow key={n.id} n={n} dir={dir} now={now} />),
                ].slice(0, HOME_ROWS)}
              </ul>
            ) : calm ? (
              <EmptyState
                size="panel"
                agent={lookOf(askable[0] ?? dir.agents[0]) ?? true}
                mood="deal"
                title={t("home.calm.title")}
              >
                {t("home.calm.text")}
              </EmptyState>
            ) : loaded ? (
              <p className="wg__empty">{t("home.summary.calm")}</p>
            ) : null,
          horizon: !(waitingCount === 0 && calm),
        }}
        working={{
          title: t("home.working.title"),
          count: working.length,
          action: (
            <Link className="home-sec__more" to="/org/$orgId/task-manager" params={{ orgId: org.id }}>
              {t("taskManager.actions.openManager")}
            </Link>
          ),
          body:
            working.length > 0 ? (
              <ul className="home-list">
                {working.slice(0, HOME_ROWS).map((w) => (
                  <WorkRow key={w.key} w={w} dir={dir} now={now} />
                ))}
              </ul>
            ) : (
              <p className="wg__empty">{t("home.working.none")}</p>
            ),
        }}
      />

      {done.length > 0 && (
        <Section title={t("home.done.title")} count={done.length} more={done.length > HOME_ROWS}>
          {done.slice(0, HOME_ROWS).map((n) => (
            <InboxRow key={n.id} n={n} dir={dir} now={now} />
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={t("home.routines.title")} to="routines">
          {upcoming.map((r) => (
            <RoutineRow key={r.id} r={r} dir={dir} now={now} />
          ))}
        </Section>
      )}
    </div>
  );
}

/** "Ao abrir o app": Início, where I left off, or one of my channels (ADR 0108). */
function StartChoice() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const set = useSetStart(org.id);
  const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
  const options = [
    { value: "home", label: t("home.start.home") },
    { value: "last", label: t("home.start.last") },
    ...(channels.data ?? [])
      .filter((c) => c.isMember && !dmIds.has(c.id))
      .map((c) => ({ value: `c:${c.id}`, label: `#${c.name}`, group: t("home.start.channels") })),
  ];
  const start = org.start;
  const chosen = start?.page === "channel" ? `c:${start.channelId}` : (start?.page ?? "home");
  // A channel I'm no longer in opens Início: the choice says so.
  const value = options.some((o) => o.value === chosen) ? chosen : "home";
  return (
    <div className="home-start">
      <span className="home-start__label" aria-hidden="true">
        {t("home.start.label")}
      </span>
      <Select
        size="sm"
        align="end"
        aria-label={t("home.start.label")}
        value={value}
        options={options}
        onValueChange={(v) =>
          set.mutate(
            v.startsWith("c:")
              ? { page: "channel", channelId: v.slice(2) }
              : { page: v === "last" ? "last" : "home", channelId: null },
          )
        }
      />
    </div>
  );
}

/** "Peça a um agente": the message goes to the agent's DM, which opens with it sent. */
function AskAgent({ agents, composer }: { agents: Agent[]; composer: RefObject<HTMLTextAreaElement | null> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const ask = useSendDm(org.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const agent = agents.find((a) => a.id === picked) ?? agents[0];
  if (!agent) return null;
  const g = agentGrammar(agent.name);
  return (
    <section className="home-ask" aria-label={t("home.ask.title")}>
      <Composer
        value={text}
        onChange={setText}
        label={t("home.ask.label", g)}
        placeholder={t("home.ask.placeholder", g)}
        sendLabel={t("home.ask.send")}
        textareaRef={composer}
        sendBlocked={ask.isPending}
        onSend={(body) =>
          ask.mutate(
            { agentId: agent.id, body },
            {
              onSuccess: () => {
                setText("");
                void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: agent.id } });
              },
            },
          )
        }
        pills={
          <Select
            size="sm"
            aria-label={t("home.ask.agent")}
            value={agent.id}
            onValueChange={setPicked}
            options={agents.map((a) => ({
              value: a.id,
              label: a.name,
              leading: <AgentAvatar agentId={a.id} name={a.name} size="sm" />,
            }))}
            renderValue={(o) => (
              <span className="home-ask__agent">
                <AgentAvatar agentId={o.value} name={o.label} size="xs" />
                {o.label}
              </span>
            )}
          />
        }
      />
    </section>
  );
}

function Section({
  title,
  count,
  more,
  to,
  children,
}: {
  title: string;
  count?: number;
  /** More than the rows shown: "Ver tudo" opens the inbox. */
  more?: boolean;
  /** "Ver tudo" opens this page instead; the agents at work, "Abrir no gerenciador" (the task manager, ADR 0128). */
  to?: "routines" | "taskManager";
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <section className="home-sec" aria-label={title}>
      <GroupHeading
        title={title}
        count={count}
        aside={
          to === "taskManager" ? (
            <Link className="home-sec__more" to="/org/$orgId/task-manager" params={{ orgId: org.id }}>
              {t("taskManager.actions.openManager")}
            </Link>
          ) : to === "routines" ? (
            <Link className="home-sec__more" to="/org/$orgId/routines" params={{ orgId: org.id }}>
              {t("home.seeAll")}
            </Link>
          ) : more ? (
            <Link className="home-sec__more" to="/org/$orgId/notifications" params={{ orgId: org.id }}>
              {t("home.seeAll")}
            </Link>
          ) : null
        }
      />
      <ul className="list-card home-list">{children}</ul>
    </section>
  );
}

/** One row: the face on top, who and what, the exact thing, where and when, and its one button. */
function RowBody({
  face,
  title,
  sub,
  meta,
  action,
}: {
  face: ReactNode;
  title: ReactNode;
  sub?: string | null;
  meta?: string | null;
  action?: string;
}) {
  return (
    <>
      <span className="ac-mediarow__face">{face}</span>
      <span className="ac-mediarow__head">
        <span className="home-row__title">{title}</span>
      </span>
      {(sub || meta) && (
        <span className="ac-mediarow__body home-row__body">
          {sub && <span className="home-row__sub">{sub}</span>}
          {meta && <span className="home-row__meta">{meta}</span>}
        </span>
      )}
      {action && (
        <span className="ac-mediarow__end ac-mediarow__end--wrap">
          <span className="home-row__act ac-btn ac-btn--sm">{action}</span>
        </span>
      )}
    </>
  );
}

/** An inbox item: what waits on me, a mention, or what an agent finished. It opens where the inbox would. */
function InboxRow({ n, dir, now }: { n: AppNotification; dir: Dir; now: number }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const read = useNotificationAction(org.id);
  const opener = useNotificationOpener();
  const ai = useAiStatus(org.id);
  const card = n.waiting ? waitingCardOf(n) : null;
  const left = card?.expiresAt ? timeLeft(t, card.expiresAt, new Date(now)) : null;
  const sub = card
    ? card.title
    : n.kind === "agent_reply" || n.kind === "mention"
      ? latestText(t, n.latest)
      : (n.source.label ?? n.latest.title ?? n.latest.text);
  const meta = [
    left ? t("approvals.left", { time: left }) : "",
    relativeTime(t, i18n.language, n.updatedAt, new Date(now)),
  ]
    .filter(Boolean)
    .join(" · ");
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const open = () => {
    if (n.readAt === null) read.mutate({ type: "read", item: n, read: true });
    opener(n, org.id, { ai: ai.data });
  };
  const actor = n.actors[0];
  return (
    <li>
      <button type="button" className="home-row ac-mediarow ac-mediarow--row" onClick={open}>
        <RowBody
          face={
            actor ? <Face actor={actor} dir={dir} state={n.waiting ? "waiting" : undefined} /> : <SystemFace n={n} />
          }
          title={<Headline n={n} dir={dir} channelName={channelName} />}
          sub={sub}
          meta={meta}
          action={card ? t(`home.action.${card.action}`) : t("home.action.open")}
        />
      </button>
    </li>
  );
}

/**
 * A board's notice (ADR 0135): an agent's alert on a widget, a widget that stopped updating, a request to publish a
 * board. Who and what, the agent's words (or why), and what can be done right here: Open widget, Resolve, Publish or
 * Keep only for me.
 */
function WidgetNoticeRow({ n, dir, now }: { n: AppNotification; dir: Dir; now: number }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const read = useNotificationAction(org.id);
  const opener = useNotificationOpener();
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const open = () => {
    if (n.readAt === null) read.mutate({ type: "read", item: n, read: true });
    opener(n, org.id);
  };
  const actor = n.actors[0];
  // One action sits at the row's end like every other row's ("Review"): an alert opens its widget (the row's own
  // press), a failure has Resolve there. A request to publish keeps its choices under the text.
  const kind = widgetNoticeOf(n)?.kind;
  return (
    <li className={kind === "proposal" ? "home-wrow" : "home-wrow home-wrow--side"}>
      <button type="button" className="home-row ac-mediarow ac-mediarow--row" onClick={open}>
        <RowBody
          action={kind === "alert" ? t("widgets.notice.openWidget") : undefined}
          face={
            actor ? <Face actor={actor} dir={dir} state={n.waiting ? "waiting" : undefined} /> : <SystemFace n={n} />
          }
          title={<Headline n={n} dir={dir} channelName={channelName} />}
          sub={widgetNoticeLine(t, n, dir)}
          meta={relativeTime(t, i18n.language, n.updatedAt, new Date(now))}
        />
      </button>
      {kind === "proposal" ? (
        <div className="home-row__acts">
          <WidgetNoticeActions n={n} onOpen={open} />
        </div>
      ) : kind === "failed" ? (
        <div className="home-row__acts home-row__acts--side">
          <WidgetNoticeActions n={n} onOpen={open} open={false} quiet />
        </div>
      ) : null}
    </li>
  );
}

/** A mission with a decision, a review or a command for me: its thread. */
function MissionRow({ m, dir }: { m: Mission; dir: Dir }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const name = dir.anyAgent(m.agentId)?.name ?? t("channel.unknownAgent");
  return (
    <li>
      <Link
        className="home-row ac-mediarow ac-mediarow--row"
        to="/org/$orgId/threads/$threadId"
        params={{ orgId: org.id, threadId: m.threadId }}
      >
        <RowBody
          face={<AgentAvatar agentId={m.agentId} name={name} state="waiting" />}
          title={<Trans i18nKey="home.mission" values={{ name }} components={{ b: <b /> }} {...TYPED_VALUES} />}
          sub={m.title}
          meta={waitingText(t, m)}
          action={t("home.action.open")}
        />
      </Link>
    </li>
  );
}

/** An agent at work: its line (ADR 0084), else what it is on, where and since when. It opens the conversation. */
function WorkRow({ w, dir, now }: { w: WorkItem; dir: Dir; now: number }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const agent = dir.agentById.get(w.agentId);
  const shown = useAgentPresence(w.agentId);
  const line = agentLine(t, shown?.line ?? null, i18n.language);
  const name = agent?.name ?? t("channel.unknownAgent");
  const where =
    w.kind === "mission" && w.plan
      ? t("home.working.mission", { done: w.plan.done, total: w.plan.total })
      : w.where.kind === "dm"
        ? t("home.working.dm")
        : w.where.name
          ? t("home.working.in", { channel: w.where.name })
          : "";
  const meta = [where, relativeTime(t, i18n.language, w.since, new Date(now))].filter(Boolean).join(" · ");
  const body = (
    <RowBody
      face={<AgentAvatar agentId={w.agentId} name={name} channelId={w.channelId} />}
      title={<b>{name}</b>}
      sub={line ? [line.emoji, line.text].filter(Boolean).join(" ") : w.what}
      meta={meta}
    />
  );
  return (
    <li>
      {w.threadId ? (
        <Link
          className="home-row ac-mediarow ac-mediarow--row"
          to="/org/$orgId/threads/$threadId"
          params={{ orgId: org.id, threadId: w.threadId }}
        >
          {body}
        </Link>
      ) : w.where.kind === "dm" ? (
        <Link
          className="home-row ac-mediarow ac-mediarow--row"
          to="/org/$orgId/dm/agent/$agentId"
          params={{ orgId: org.id, agentId: w.agentId }}
        >
          {body}
        </Link>
      ) : (
        <Link
          className="home-row ac-mediarow ac-mediarow--row"
          to="/org/$orgId/c/$channelId"
          params={{ orgId: org.id, channelId: w.channelId }}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/** A routine's next run: its agent, its name, when. It opens the routine in Rotinas. */
function RoutineRow({ r, dir, now }: { r: Routine; dir: Dir; now: number }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const name = dir.anyAgent(r.agentId)?.name ?? t("channel.unknownAgent");
  return (
    <li>
      <Link
        className="home-row ac-mediarow ac-mediarow--row"
        to="/org/$orgId/routines"
        params={{ orgId: org.id }}
        search={{ open: r.id }}
      >
        <RowBody
          face={<AgentAvatar agentId={r.agentId} name={name} />}
          title={<b>{r.name}</b>}
          sub={name}
          meta={r.nextRunAt ? upcomingAt(t, i18n.language, r.nextRunAt, new Date(now)) : null}
        />
      </Link>
    </li>
  );
}
